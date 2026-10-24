import { RGB_FADE_MAX_MS, type RgbState } from '../../../shared/protocol';
import {
    ALERT_INFO,
    EFFECT_INFO,
    LIGHT_ALERT_KINDS,
    LIGHT_EFFECTS,
    LIGHT_MOODS,
    LIGHT_SPEEDS,
    LIGHT_TIMERS_MAX,
    RAMP_MINUTES,
    actionText,
    lightAlertDefaults,
    timeOk,
    type LightAction,
    type LightAlertKind,
    type LightAlerts,
    type LightEffect,
    type LightPlan,
    type LightShowState,
    type LightSpeed,
    type LightTimer,
    type Rgb,
} from '../../../shared/light';
import { Device } from './db';
import { applyCommandResult, getLive, parseRgbState, publishDevice, sendCommand } from './devices';
import { logger } from './logger';

/*
 * What the server plays on a kibbl. light: moods, effects (candle, rainbow, a sunrise ...),
 * the weekly timers and flashes for alerts. The device knows one colour and a fade of up to
 * 10 s; an effect is a row of such fades sent one after the other.
 *
 * The device stores its light 3 s after it last changed, and every store erases a sector of
 * its flash. So no step of an effect lasts longer than STEP_MAX_MS: a slow fade is cut into
 * pieces, and the light is stored only once the effect is over and the light stays.
 *
 * A change in the app or by an assistant (core/control.ts) ends the effect. An alert pauses
 * it, flashes and puts the light back, then it goes on.
 */

const log = logger('light');

export const STEP_MAX_MS = 2500;
const FLASH_ON_MS = 250;
const FLASH_OFF_MS = 250;
const PUBLISH_MS = 2000; // the app sees an effect's colour this often
const FAILS_MAX = 10; // device away: the effect ends
const TIMER_TICK_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/* ----------------------------------------------------------------------- */

// the light goes to this over ms
export interface Frame {
    on: boolean;
    color: Rgb;
    brightness: number;
    ms: number;
}

export interface EffectOptions {
    color?: Rgb;
    brightness?: number;
    speed?: LightSpeed;
    minutes?: number; // a sunrise or sunset takes this long; any other effect ends after it
}

const SPEED: Record<LightSpeed, number> = { slow: 2, normal: 1, fast: 0.5 };

export function hsv(h: number, s = 1, v = 1): Rgb {
    const f = (n: number) => {
        const k = (n + h / 60) % 6;
        return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return [f(5), f(3), f(1)];
}

const PALETTES: Partial<Record<LightEffect, Rgb[]>> = {
    ocean: [
        [0, 60, 255],
        [0, 140, 255],
        [0, 210, 200],
        [0, 90, 170],
        [20, 40, 200],
    ],
    aurora: [
        [0, 255, 120],
        [0, 200, 180],
        [110, 0, 255],
        [0, 255, 60],
        [40, 120, 255],
    ],
};

/* The frames of an effect, from the light it starts at. The loops never end (the runner ends
 * them), a sunrise or sunset ends where it goes to. */
export function* effectFrames(effect: LightEffect, opts: EffectOptions, from: RgbState, random = Math.random): Generator<Frame> {
    const f = SPEED[opts.speed ?? 'normal'];
    const base = opts.brightness ?? (from.on ? from.brightness : 60);
    const at = (b: number) => clamp(Math.round(b), 1, 100);
    switch (effect) {
        case 'candle': {
            const c = opts.color ?? LIGHT_MOODS.candle.color;
            for (;;) {
                const g = clamp(c[1] + Math.round((random() - 0.5) * 30), 0, 255);
                yield { on: true, color: [c[0], g, c[2]], brightness: at(base * (0.55 + 0.45 * random())), ms: Math.round((120 + random() * 380) * f) };
            }
        }
        case 'breathe': {
            const c = opts.color ?? (from.on ? from.color : LIGHT_MOODS.relax.color);
            for (;;) {
                yield { on: true, color: c, brightness: at(base), ms: 3000 * f };
                yield { on: true, color: c, brightness: at(base * 0.15), ms: 3000 * f };
            }
        }
        case 'rainbow': {
            for (let h = 0; ; h = (h + 20) % 360) yield { on: true, color: hsv(h), brightness: at(base), ms: 2000 * f };
        }
        case 'party': {
            let last = -1;
            for (;;) {
                let h = Math.floor(random() * 12) * 30;
                if (h === last) h = (h + 150) % 360;
                last = h;
                yield { on: true, color: hsv(h), brightness: at(base * (0.6 + 0.4 * random())), ms: Math.round(400 * f) };
            }
        }
        case 'ocean':
        case 'aurora': {
            const palette = PALETTES[effect]!;
            let last = -1;
            for (;;) {
                let i = Math.floor(random() * palette.length);
                if (i === last) i = (i + 1) % palette.length;
                last = i;
                yield { on: true, color: palette[i], brightness: at(base * (0.7 + 0.3 * random())), ms: Math.round((6000 + random() * 4000) * f) };
            }
        }
        case 'sunrise': {
            const ms = (opts.minutes ?? RAMP_MINUTES.default) * 60_000;
            const end = opts.brightness ?? 100;
            yield { on: true, color: [255, 0, 0], brightness: 1, ms: 0 };
            yield { on: true, color: [255, 40, 0], brightness: at(end * 0.1), ms: ms * 0.25 };
            yield { on: true, color: [255, 110, 10], brightness: at(end * 0.35), ms: ms * 0.3 };
            yield { on: true, color: [255, 170, 70], brightness: at(end * 0.7), ms: ms * 0.25 };
            yield { on: true, color: opts.color ?? [255, 215, 160], brightness: at(end), ms: ms * 0.2 };
            return;
        }
        case 'sunset': {
            if (!from.on) return;
            const ms = (opts.minutes ?? RAMP_MINUTES.default) * 60_000;
            const b = from.brightness;
            yield { on: true, color: [255, 90, 10], brightness: at(b * 0.5), ms: ms * 0.4 };
            yield { on: true, color: [255, 40, 0], brightness: at(b * 0.15), ms: ms * 0.4 };
            yield { on: true, color: [255, 20, 0], brightness: 1, ms: ms * 0.2 };
            // off in the light it had: on again, it shows that
            yield { on: false, color: from.color, brightness: from.brightness, ms: 2000 };
            return;
        }
    }
}

/* A frame cut into steps of at most STEP_MAX_MS, each a part of the way from the light before
 * (a straight line in colour and brightness, near enough to the device's own fade). */
export function steps(from: { color: Rgb; brightness: number }, to: Frame): Frame[] {
    const n = Math.max(1, Math.ceil(to.ms / STEP_MAX_MS));
    if (n === 1 || !to.on) return [to];
    const out: Frame[] = [];
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
        out.push({
            on: true,
            color: [0, 1, 2].map((k) => mix(from.color[k], to.color[k])) as Rgb,
            brightness: clamp(mix(from.brightness, to.brightness), 1, 100),
            ms: Math.round(to.ms / n),
        });
    }
    return out;
}

/* ----------------------------------------------------------------------- */

interface Show {
    state: LightShowState;
    cancelled: boolean;
    hold?: Promise<void>; // an alert flashes: the effect waits
    last?: Frame; // what it sent last, where an alert puts the light back to
    restore?: RgbState; // a timed loop ends: the light from before
}

const shows = new Map<string, Show>();
const flashing = new Map<string, Promise<void>>(); // one flash after the other per light
const published = new Map<string, number>();

export function showOf(deviceId: string): LightShowState | undefined {
    return shows.get(deviceId)?.state;
}

export function liveRgb(deviceId: string): RgbState | undefined {
    return parseRgbState(getLive(deviceId)?.info.rgb);
}

// the effect on this light ends (a change in the app or by an assistant, another effect)
export function stopShow(deviceId: string) {
    const show = shows.get(deviceId);
    if (!show) return false;
    show.cancelled = true;
    shows.delete(deviceId);
    void publishDevice(deviceId);
    return true;
}

// a step of an effect or a flash: not logged one by one, the app sees it every PUBLISH_MS
async function send(deviceId: string, frame: Pick<Frame, 'on' | 'color' | 'brightness'>, fadeMs: number) {
    // off keeps its colour: the light comes on again in it
    const cmd = { cmd: 'rgb', on: frame.on, color: frame.color, brightness: frame.brightness, fadeMs: clamp(Math.round(fadeMs), 0, RGB_FADE_MAX_MS) };
    const resp = await sendCommand(deviceId, cmd);
    const now = Date.now();
    const publish = now - (published.get(deviceId) ?? 0) >= PUBLISH_MS;
    if (publish) published.set(deviceId, now);
    await applyCommandResult(deviceId, 'rgb', resp, { quiet: true, publish });
    return resp.ok;
}

async function play(deviceId: string, show: Show, frames: Iterable<Frame>, from: RgbState, endsAt?: number) {
    let at = { color: from.color, brightness: from.on ? from.brightness : 1 };
    let fails = 0;
    try {
        for (const frame of frames) {
            for (const step of steps(at, frame)) {
                while (show.hold) await show.hold;
                if (show.cancelled) return;
                if (endsAt && Date.now() >= endsAt) return;
                const started = Date.now();
                if (await send(deviceId, step, step.ms)) {
                    fails = 0;
                    show.last = step;
                } else if (++fails >= FAILS_MAX) {
                    log.warn('effect ended, the light does not answer', { device: deviceId, effect: show.state.name });
                    return;
                }
                // a step that switches is still given a moment, so a loop never spins
                await sleep(Math.max(step.ms - (Date.now() - started), fails ? 5000 : 50));
                at = { color: step.color, brightness: step.brightness };
            }
        }
    } catch (err) {
        log.warn('effect failed', { device: deviceId, effect: show.state.name }, err);
    } finally {
        if (shows.get(deviceId) === show) {
            shows.delete(deviceId);
            if (!show.cancelled && show.restore) await send(deviceId, show.restore, 2000);
            void publishDevice(deviceId);
        }
    }
}

export function startEffect(deviceId: string, name: string, effect: LightEffect, opts: EffectOptions, who: string, via: string): LightShowState {
    const from = liveRgb(deviceId) ?? { on: false, color: [255, 165, 0], brightness: 60 };
    stopShow(deviceId);
    const ramp = effect === 'sunrise' || effect === 'sunset';
    const minutes = opts.minutes !== undefined || ramp ? clamp(opts.minutes ?? RAMP_MINUTES.default, RAMP_MINUTES.min, RAMP_MINUTES.max) : undefined;
    const now = Date.now();
    const state: LightShowState = { effect, name, startedAt: now, endsAt: minutes ? now + minutes * 60_000 : undefined };
    // a loop for some minutes: then the light it had before
    const show: Show = { state, cancelled: false, restore: !ramp && minutes ? from : undefined };
    shows.set(deviceId, show);
    log.info('light effect', { device: deviceId, effect: name, speed: opts.speed, minutes, user: who, via });
    void play(deviceId, show, effectFrames(effect, { ...opts, minutes }, from), from, ramp ? undefined : state.endsAt);
    void publishDevice(deviceId);
    return state;
}

/* ----------------------------------------------------------------------- */

export type MoodResult = { ok: true; show?: LightShowState } | { ok: false; error: string };

// a mood: its colour and brightness, or its effect
export async function setMood(deviceId: string, mood: string, who: string, via: string, brightness?: number, fadeMs = 1500): Promise<MoodResult> {
    const m = LIGHT_MOODS[mood];
    if (!m) return { ok: false, error: `no mood "${mood}": ${Object.keys(LIGHT_MOODS).join(', ')}` };
    if (!getLive(deviceId)) return { ok: false, error: 'the light is offline' };
    const b = brightness ?? m.brightness;
    if (m.effect) return { ok: true, show: startEffect(deviceId, m.label, m.effect, { color: m.color, brightness: b }, who, via) };
    stopShow(deviceId);
    const ok = await send(deviceId, { on: true, color: m.color, brightness: b }, fadeMs);
    await publishDevice(deviceId);
    log.info('light mood', { device: deviceId, mood, brightness: b, user: who, via });
    return ok ? { ok: true } : { ok: false, error: 'the light did not answer' };
}

/* Flashes in a colour, then the light as it was; an effect waits meanwhile. Short, so the
 * light the device stored stays the same and nothing is written to its flash. */
export function flash(deviceId: string, color: Rgb, flashes: number): Promise<void> {
    const before = flashing.get(deviceId) ?? Promise.resolve();
    const run = before.then(async () => {
        const show = shows.get(deviceId);
        let release = () => undefined as void;
        if (show) show.hold = new Promise<void>((resolve) => (release = resolve));
        // where an effect waits for its step to end, the light it shows
        if (show) await sleep(100);
        try {
            const now = liveRgb(deviceId);
            if (!now) return;
            const back = show?.last ?? now;
            for (let i = 0; i < flashes; i++) {
                await send(deviceId, { on: true, color, brightness: 100 }, 0);
                await sleep(FLASH_ON_MS);
                await send(deviceId, back, 0);
                await sleep(FLASH_OFF_MS);
            }
        } catch (err) {
            log.warn('flash failed', { device: deviceId }, err);
        } finally {
            if (show) {
                show.hold = undefined;
                release();
            }
        }
    });
    const settled = run.catch(() => undefined);
    flashing.set(deviceId, settled);
    void settled.then(() => {
        if (flashing.get(deviceId) === settled) flashing.delete(deviceId);
    });
    return settled;
}

/* ----------------------------------------------------------------------- */

export function planOf(doc: Pick<DeviceDoc, 'lightPlan'>): LightPlan {
    return { timers: doc.lightPlan?.timers ?? [], alerts: { ...lightAlertDefaults, ...(doc.lightPlan?.alerts ?? {}) } };
}

const isRgb = (v: unknown): v is Rgb => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// what a timer does, checked; a string says what is wrong
export function cleanAction(raw: unknown): LightAction | string {
    const a = (raw ?? {}) as Record<string, unknown>;
    switch (a.kind) {
        case 'off':
            return { kind: 'off' };
        case 'mood':
            return typeof a.mood === 'string' && LIGHT_MOODS[a.mood] ? { kind: 'mood', mood: a.mood } : `mood is one of ${Object.keys(LIGHT_MOODS).join(', ')}`;
        case 'color':
            if (!isRgb(a.color)) return 'color is [r, g, b], 0-255 each';
            return { kind: 'color', color: [...a.color] as Rgb, brightness: isInt(a.brightness, 1, 100) ? a.brightness : 60 };
        case 'effect': {
            if (!LIGHT_EFFECTS.includes(a.effect as LightEffect)) return `effect is one of ${LIGHT_EFFECTS.join(', ')}`;
            const out: LightAction = { kind: 'effect', effect: a.effect as LightEffect };
            if (a.color !== undefined) {
                if (!isRgb(a.color)) return 'color is [r, g, b], 0-255 each';
                out.color = [...a.color] as Rgb;
            }
            if (a.brightness !== undefined) {
                if (!isInt(a.brightness, 1, 100)) return 'brightness 1-100';
                out.brightness = a.brightness;
            }
            if (a.speed !== undefined) {
                if (!LIGHT_SPEEDS.includes(a.speed as LightSpeed)) return `speed is one of ${LIGHT_SPEEDS.join(', ')}`;
                out.speed = a.speed as LightSpeed;
            }
            if (a.minutes !== undefined) {
                if (!isInt(a.minutes, RAMP_MINUTES.min, RAMP_MINUTES.max)) return `minutes ${RAMP_MINUTES.min}-${RAMP_MINUTES.max}`;
                out.minutes = a.minutes;
            }
            return out;
        }
        default:
            return 'kind is off, mood, color or effect';
    }
}

export function cleanTimer(raw: unknown, id: string): LightTimer | string {
    const t = (raw ?? {}) as Record<string, unknown>;
    if (typeof t.at !== 'string' || !timeOk(t.at)) return 'at is HH:MM, 24 h';
    const days = Array.isArray(t.days) ? [...new Set(t.days)].sort() : [];
    if (!days.length || !days.every((d) => isInt(d, 0, 6))) return 'days are 0 (Monday) to 6 (Sunday), at least one';
    const action = cleanAction(t.action);
    if (typeof action === 'string') return action;
    const out: LightTimer = { id, enabled: t.enabled !== false, days: days as number[], at: t.at, action };
    if (t.fadeMs !== undefined) {
        if (!isInt(t.fadeMs, 0, RGB_FADE_MAX_MS)) return `fadeMs 0-${RGB_FADE_MAX_MS}`;
        out.fadeMs = t.fadeMs;
    }
    if (typeof t.name === 'string' && t.name.trim()) out.name = t.name.trim().slice(0, 40);
    return out;
}

export function cleanAlerts(raw: unknown, current: LightAlerts): LightAlerts | string {
    const a = (raw ?? {}) as Record<string, unknown>;
    const out = { ...current };
    if (a.enabled !== undefined) {
        if (typeof a.enabled !== 'boolean') return 'enabled is true or false';
        out.enabled = a.enabled;
    }
    if (a.onlyWhenOn !== undefined) {
        if (typeof a.onlyWhenOn !== 'boolean') return 'onlyWhenOn is true or false';
        out.onlyWhenOn = a.onlyWhenOn;
    }
    if (a.kinds !== undefined) {
        if (!Array.isArray(a.kinds) || !a.kinds.every((k) => LIGHT_ALERT_KINDS.includes(k))) return `kinds of ${LIGHT_ALERT_KINDS.join(', ')}`;
        out.kinds = [...new Set(a.kinds as LightAlertKind[])];
    }
    for (const key of ['quietFrom', 'quietTo'] as const) {
        if (a[key] === undefined) continue;
        if (!isInt(a[key], 0, 23)) return `${key} is an hour 0-23`;
        out[key] = a[key] as number;
    }
    return out;
}

export async function saveTimers(deviceId: string, timers: LightTimer[]) {
    if (timers.length > LIGHT_TIMERS_MAX) throw new Error(`at most ${LIGHT_TIMERS_MAX} timers`);
    await Device.updateOne({ _id: deviceId }, { $set: { 'lightPlan.timers': timers } });
}

export async function saveAlerts(deviceId: string, alerts: LightAlerts) {
    await Device.updateOne({ _id: deviceId }, { $set: { 'lightPlan.alerts': alerts } });
}

/* ----------------------------------------------------------------------- */

// does what a timer or an assistant asks, as the app would
export async function runAction(deviceId: string, action: LightAction, who: string, via: string, fadeMs = 1500): Promise<MoodResult> {
    if (!getLive(deviceId)) return { ok: false, error: 'the light is offline' };
    if (action.kind === 'mood') return setMood(deviceId, action.mood, who, via, undefined, fadeMs);
    if (action.kind === 'effect') {
        const { effect, ...opts } = action;
        return { ok: true, show: startEffect(deviceId, EFFECT_INFO[effect].label, effect, opts, who, via) };
    }
    stopShow(deviceId);
    const ok =
        action.kind === 'off'
            ? await send(deviceId, { ...(liveRgb(deviceId) ?? { color: [255, 165, 0] as Rgb, brightness: 60 }), on: false }, fadeMs)
            : await send(deviceId, { on: true, color: action.color, brightness: action.brightness }, fadeMs);
    await publishDevice(deviceId);
    log.info('light set', { device: deviceId, action: actionText(action), user: who, via });
    return ok ? { ok: true } : { ok: false, error: 'the light did not answer' };
}

// the minutes a timer starts before its time: a sunrise is bright at it
const leadMinutes = (t: LightTimer) => (t.action.kind === 'effect' && t.action.effect === 'sunrise' ? (t.action.minutes ?? RAMP_MINUTES.default) : 0);

const weekday = (d: Date) => (d.getDay() + 6) % 7;

/* When a timer starts next, from now (home time). Its days are the days of its time: a sunrise
 * at 00:10 for 20 minutes starts the evening before. */
export function nextStart(t: LightTimer, now = new Date()): number | undefined {
    if (!t.enabled) return undefined;
    const [h, m] = t.at.split(':').map(Number);
    for (let i = 0; i <= 8; i++) {
        const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, m, 0, 0);
        const start = at.getTime() - leadMinutes(t) * 60_000;
        if (t.days.includes(weekday(at)) && start > now.getTime() - 60_000) return start;
    }
    return undefined;
}

// a timer is due in the minute of now
export function dueNow(t: LightTimer, now = new Date()) {
    const start = nextStart(t, now);
    return start !== undefined && Math.floor(start / 60_000) === Math.floor(now.getTime() / 60_000);
}

const fired = new Map<string, number>(); // timer id: the minute it ran

async function tick() {
    const now = new Date();
    const docs = await Device.find({ status: 'approved', caps: 'rgb', 'lightPlan.timers.0': { $exists: true } }, { lightPlan: 1 }).lean();
    for (const doc of docs) {
        for (const t of planOf(doc).timers) {
            if (!dueNow(t, now)) continue;
            const minute = Math.floor(now.getTime() / 60_000);
            if (fired.get(t.id) === minute) continue;
            fired.set(t.id, minute);
            const r = await runAction(doc._id, t.action, 'timer', 'schedule', t.fadeMs);
            log.info('light timer', { device: doc._id, timer: t.name ?? t.at, action: actionText(t.action), result: r.ok ? 'ok' : r.error });
        }
    }
}

export function initLightShow() {
    setInterval(() => void tick().catch((err) => log.warn('light timers not checked', {}, err)), TIMER_TICK_MS);
}

/* ----------------------------------------------------------------------- */

const inQuiet = (a: LightAlerts, d = new Date()) => {
    if (a.quietFrom === a.quietTo) return false;
    const h = d.getHours();
    return a.quietFrom < a.quietTo ? h >= a.quietFrom && h < a.quietTo : h >= a.quietFrom || h < a.quietTo;
};

// an alert of kibbl. for a user: the lights that flash for it (a fire also in quiet hours)
export async function alertLights(userID: string, kind: LightAlertKind) {
    const docs = await Device.find({ ownerID: userID, status: 'approved', caps: 'rgb' }, { lightPlan: 1 }).lean();
    const info = ALERT_INFO[kind];
    for (const doc of docs) {
        const a = planOf(doc).alerts;
        if (!a.enabled || !a.kinds.includes(kind)) continue;
        if (kind !== 'fire' && inQuiet(a)) continue;
        const now = liveRgb(doc._id);
        if (!now || (a.onlyWhenOn && !now.on && kind !== 'fire')) continue;
        log.info('light alert', { device: doc._id, kind });
        void flash(doc._id, info.color, info.flashes);
    }
}
