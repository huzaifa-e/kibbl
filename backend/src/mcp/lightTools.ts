import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
    daysText,
    hexOf,
    rgbOfHex,
    type LightTimer,
    type Rgb,
} from '../../../shared/light';
import { RGB_FADE_MAX_MS, rgbPresets } from '../../../shared/protocol';
import { Device } from '../core/db';
import { logger } from '../core/logger';
import {
    cleanAlerts,
    cleanTimer,
    flash,
    liveRgb,
    nextStart,
    planOf,
    runAction,
    saveAlerts,
    saveTimers,
    setMood,
    showOf,
    startEffect,
    stopShow,
} from '../core/lightShow';

/*
 * The kibbl. light beyond one colour through the MCP endpoint (core/lightShow.ts): moods,
 * effects the server plays, flashes to tell the person something, the weekly timers and the
 * alerts that flash it. Every change is logged "via assistant".
 */

const log = logger('mcp');
const VIA = 'assistant';

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const lower = (s: string) => s.trim().toLowerCase();

const moodNames = Object.keys(LIGHT_MOODS) as [string, ...string[]];
const moodList = moodNames.map((m) => `${m}${LIGHT_MOODS[m].effect ? ` (${LIGHT_MOODS[m].effect})` : ''}`).join(', ');
const effectList = LIGHT_EFFECTS.map((e) => `${e}: ${EFFECT_INFO[e].text}`).join('; ');

const lightRef = z.string().default('').describe('the kibbl. light by name or id; the only one if left empty');
const colorArg = z.string().describe(`#rrggbb or a name (${Object.keys(rgbPresets).join(', ')})`);

async function findLight(userID: string, ref: string) {
    const docs = await Device.find({ ownerID: userID, status: 'approved', caps: 'rgb' }).lean();
    const r = lower(ref);
    return docs.find((d) => d._id.toLowerCase() === r) ?? docs.find((d) => lower(d.name) === r) ?? (r ? undefined : docs.length === 1 ? docs[0] : undefined);
}

const colorOf = (value: string): Rgb | undefined => rgbPresets[lower(value)] ?? rgbOfHex(value);

const timerOut = (t: LightTimer) => ({
    id: t.id,
    name: t.name,
    enabled: t.enabled,
    days: t.days,
    when: `${daysText(t.days)} ${t.at}`,
    at: t.at,
    action: t.action,
    does: actionText(t.action),
    fade_ms: t.fadeMs,
    next: nextStart(t) ? new Date(nextStart(t)!).toLocaleString('sv-SE').slice(0, 16) : null,
});

export function registerLightTools(server: McpServer, session: SessionInfo) {
    const who = session.email;
    const noLight = (ref: string) => fail(`No kibbl. light "${ref}". kibbl_light lists them.`);

    server.registerTool(
        'kibbl_light_mood',
        {
            title: 'Light mood',
            description:
                `Sets a kibbl. light to a mood: ${moodList}. ` +
                'movie is a dim neutral bias light behind the screen, night a faint red without blue; the ones with an effect in brackets play it until the light is changed. ' +
                'brightness (%) instead of the mood’s own.',
            inputSchema: {
                light: lightRef,
                mood: z.enum(moodNames),
                brightness: z.number().int().min(1).max(100).optional(),
                fade_ms: z.number().int().min(0).max(RGB_FADE_MAX_MS).optional().describe('1500 ms unless given'),
            },
            annotations: writes,
        },
        async ({ light, mood, brightness, fade_ms }) => {
            const doc = await findLight(session.userID, light);
            if (!doc) return noLight(light);
            const r = await setMood(doc._id, mood, who, VIA, brightness, fade_ms);
            return r.ok ? json({ ok: true, light: doc.name, mood, playing: r.show ?? null }) : fail(r.error);
        },
    );

    server.registerTool(
        'kibbl_light_effect',
        {
            title: 'Light effect',
            description:
                `Plays an effect on a kibbl. light, run by the server until the light is changed in the app or by kibbl_light_set / kibbl_light_mood, or another effect: ${effectList}. ` +
                `sunrise and sunset take minutes (${RAMP_MINUTES.default} unless given, ${RAMP_MINUTES.min}-${RAMP_MINUTES.max}): a wake-up light now, or a sleep timer that ends with the light off; ` +
                'any other effect with minutes ends after them and puts the light back as it was. effect stop ends what plays and leaves the light as it is. ' +
                'color is the colour of candle, breathe and the end of a sunrise; brightness the top brightness (%).',
            inputSchema: {
                light: lightRef,
                effect: z.enum([...LIGHT_EFFECTS, 'stop']),
                color: colorArg.optional(),
                brightness: z.number().int().min(1).max(100).optional(),
                speed: z.enum(LIGHT_SPEEDS).default('normal'),
                minutes: z.number().int().min(RAMP_MINUTES.min).max(RAMP_MINUTES.max).optional(),
            },
            annotations: writes,
        },
        async ({ light, effect, color, brightness, speed, minutes }) => {
            const doc = await findLight(session.userID, light);
            if (!doc) return noLight(light);
            if (effect === 'stop') {
                const stopped = stopShow(doc._id);
                if (stopped) log.info('light effect stopped', { device: doc._id, user: who, via: VIA });
                return json({ ok: true, light: doc.name, stopped });
            }
            if (!liveRgb(doc._id)) return fail(`${doc.name} is offline.`);
            const rgb = color === undefined ? undefined : colorOf(color);
            if (color !== undefined && !rgb) return fail(`Colour "${color}" is no #rrggbb and none of ${Object.keys(rgbPresets).join(', ')}.`);
            const state = startEffect(doc._id, EFFECT_INFO[effect].label, effect, { color: rgb, brightness, speed, minutes }, who, VIA);
            return json({ ok: true, light: doc.name, playing: state });
        },
    );

    server.registerTool(
        'kibbl_light_flash',
        {
            title: 'Flash the light',
            description:
                'Flashes a kibbl. light in a colour a few times, then puts it back as it was (an effect goes on afterwards): a sign for the person in the room, ' +
                `e.g. that something they asked to be told about happened. Cyan unless given; the alerts of kibbl. use ${LIGHT_ALERT_KINDS.map((k) => `${k} ${hexOf(ALERT_INFO[k].color)}`).join(', ')}. ` +
                'Shows even when the light was off, and in quiet hours.',
            inputSchema: {
                light: lightRef,
                color: colorArg.optional(),
                flashes: z.number().int().min(1).max(10).default(3),
            },
            annotations: writes,
        },
        async ({ light, color, flashes }) => {
            const doc = await findLight(session.userID, light);
            if (!doc) return noLight(light);
            if (!liveRgb(doc._id)) return fail(`${doc.name} is offline.`);
            const rgb = color === undefined ? ALERT_INFO.assistant.color : colorOf(color);
            if (!rgb) return fail(`Colour "${color}" is no #rrggbb and none of ${Object.keys(rgbPresets).join(', ')}.`);
            log.info('light flash', { device: doc._id, color: hexOf(rgb), flashes, user: who, via: VIA });
            await flash(doc._id, rgb, flashes);
            return json({ ok: true, light: doc.name, flashed: flashes });
        },
    );

    server.registerTool(
        'kibbl_light_plan',
        {
            title: 'Light timers and alerts',
            description:
                'The weekly timers of a kibbl. light (each: days 0 Monday..6 Sunday, at HH:MM home time, what it does, the next time it runs; a sunrise is bright at its time and starts its minutes before), ' +
                'which alerts of kibbl. flash it (each kind in its colour, quiet hours in which only a fire flashes, only while it is on) and the effect playing now.',
            inputSchema: { light: lightRef },
            annotations: readOnly,
        },
        async ({ light }) => {
            const doc = await findLight(session.userID, light);
            if (!doc) return noLight(light);
            const plan = planOf(doc);
            return json({
                light: doc.name,
                playing: showOf(doc._id) ?? null,
                timers: plan.timers.map(timerOut),
                alerts: {
                    ...plan.alerts,
                    colors: Object.fromEntries(LIGHT_ALERT_KINDS.map((k) => [k, { color: hexOf(ALERT_INFO[k].color), what: ALERT_INFO[k].label }])),
                },
            });
        },
    );

    server.registerTool(
        'kibbl_light_timer_set',
        {
            title: 'Set a light timer',
            description:
                `Adds, changes or removes a weekly timer of a kibbl. light (at most ${LIGHT_TIMERS_MAX}). Without id a new one; with id the fields given change; remove true deletes it. ` +
                'do: off, mood (mood), color (color, brightness) or effect (effect, color, brightness, speed, minutes; a sunrise is bright at "at" and starts its minutes before, ' +
                'a sunset starts at "at" and ends with the light off). days 0 Monday..6 Sunday, at HH:MM home time. run_now runs what it does once now as a test. Answers all timers.',
            inputSchema: {
                light: lightRef,
                id: z.string().optional(),
                remove: z.boolean().optional(),
                name: z.string().max(40).optional(),
                enabled: z.boolean().optional(),
                days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
                at: z.string().optional().describe('HH:MM, 24 h'),
                do: z.enum(['off', 'mood', 'color', 'effect']).optional(),
                mood: z.enum(moodNames).optional(),
                color: colorArg.optional(),
                brightness: z.number().int().min(1).max(100).optional(),
                effect: z.enum(LIGHT_EFFECTS).optional(),
                speed: z.enum(LIGHT_SPEEDS).optional(),
                minutes: z.number().int().min(RAMP_MINUTES.min).max(RAMP_MINUTES.max).optional(),
                fade_ms: z.number().int().min(0).max(RGB_FADE_MAX_MS).optional(),
                run_now: z.boolean().optional(),
            },
            annotations: writes,
        },
        async (args) => {
            const doc = await findLight(session.userID, args.light);
            if (!doc) return noLight(args.light);
            const timers = [...planOf(doc).timers];
            const index = args.id ? timers.findIndex((t) => t.id === args.id) : -1;
            if (args.id && index < 0) return fail(`No timer "${args.id}". kibbl_light_plan lists them.`);
            if (args.remove) {
                if (index < 0) return fail('remove needs the id of a timer.');
                const [gone] = timers.splice(index, 1);
                await saveTimers(doc._id, timers);
                log.info('light timer removed', { device: doc._id, timer: gone.name ?? gone.at, user: who, via: VIA });
                return json({ ok: true, light: doc.name, timers: timers.map(timerOut) });
            }
            const old = index >= 0 ? timers[index] : undefined;
            const rgb = args.color === undefined ? undefined : colorOf(args.color);
            if (args.color !== undefined && !rgb) return fail(`Colour "${args.color}" is no #rrggbb and none of ${Object.keys(rgbPresets).join(', ')}.`);
            const kind = args.do ?? old?.action.kind;
            if (!kind) return fail('A new timer needs do (off, mood, color or effect), days and at.');
            const prev = (old?.action.kind === kind ? old.action : {}) as Record<string, unknown>;
            const action = {
                ...prev,
                kind,
                ...(args.mood !== undefined && { mood: args.mood }),
                ...(rgb && { color: rgb }),
                ...(args.brightness !== undefined && { brightness: args.brightness }),
                ...(args.effect !== undefined && { effect: args.effect }),
                ...(args.speed !== undefined && { speed: args.speed }),
                ...(args.minutes !== undefined && { minutes: args.minutes }),
            };
            const t = cleanTimer(
                {
                    name: args.name ?? old?.name,
                    enabled: args.enabled ?? old?.enabled ?? true,
                    days: args.days ?? old?.days,
                    at: args.at ?? old?.at,
                    fadeMs: args.fade_ms ?? old?.fadeMs,
                    action,
                },
                old?.id ?? crypto.randomBytes(4).toString('hex'),
            );
            if (typeof t === 'string') return fail(t);
            if (old) timers[index] = t;
            else if (timers.length >= LIGHT_TIMERS_MAX) return fail(`At most ${LIGHT_TIMERS_MAX} timers.`);
            else timers.push(t);
            await saveTimers(doc._id, timers);
            log.info(old ? 'light timer changed' : 'light timer added', {
                device: doc._id,
                timer: `${daysText(t.days)} ${t.at} ${actionText(t.action)}`,
                user: who,
                via: VIA,
            });
            const ran = args.run_now ? await runAction(doc._id, t.action, who, VIA, t.fadeMs) : undefined;
            return json({ ok: true, light: doc.name, timer: timerOut(t), ran_now: ran, timers: timers.map(timerOut) });
        },
    );

    server.registerTool(
        'kibbl_light_alerts_set',
        {
            title: 'Light alerts',
            description:
                `Which alerts of kibbl. flash a kibbl. light, each in its colour: ${LIGHT_ALERT_KINDS.map((k) => `${k} (${ALERT_INFO[k].label})`).join(', ')}. ` +
                'kinds replaces the list; quiet hours from-to (home time, equal: never quiet) in which only a fire flashes; only_when_on: no flash while the light is off (a fire always). ' +
                'enabled false: no flashes at all. Only the fields given change.',
            inputSchema: {
                light: lightRef,
                enabled: z.boolean().optional(),
                kinds: z.array(z.enum(LIGHT_ALERT_KINDS)).optional(),
                quiet_from: z.number().int().min(0).max(23).optional(),
                quiet_to: z.number().int().min(0).max(23).optional(),
                only_when_on: z.boolean().optional(),
            },
            annotations: { ...writes, idempotentHint: true },
        },
        async (args) => {
            const doc = await findLight(session.userID, args.light);
            if (!doc) return noLight(args.light);
            const alerts = cleanAlerts(
                { enabled: args.enabled, kinds: args.kinds, quietFrom: args.quiet_from, quietTo: args.quiet_to, onlyWhenOn: args.only_when_on },
                planOf(doc).alerts,
            );
            if (typeof alerts === 'string') return fail(alerts);
            await saveAlerts(doc._id, alerts);
            log.info('light alerts set', { device: doc._id, enabled: alerts.enabled, kinds: alerts.kinds.join(','), user: who, via: VIA });
            return json({ ok: true, light: doc.name, alerts });
        },
    );
}
