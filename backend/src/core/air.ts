import crypto from 'node:crypto';
import type { AirEvent, AirReading, AirState, DeviceSummary, NightSchedule, SmokeDay } from '../../../shared/protocol';
import { AirEventModel, AirReading as AirReadingModel, Device } from './db';
import { sendCommand } from './devices';
import { hub } from './hub';
import { logger } from './logger';
import { notifyOwner } from './notify';
import { deviceOwner } from './owners';
import { weatherForUser } from './weather';
import { pairedRoom } from '../tado/service';
import { climateHints } from '../../../shared/climate';

/*
 * kibbl. air (the Conny CO2 traffic light): its measurements as a minute each, the events
 * it detects (cigarettes, windows, fire) and its night mode on the server's clock. The
 * device decides everything itself and works without the server; this keeps the history,
 * tells the owner and switches night mode on schedule.
 */

const log = logger('air');

const MINUTE_MS = 60_000;
const NIGHT_RETRY_MS = 30_000;
const MAX_EVENT_AGE_S = 7 * 24 * 3600; // older than a week in the queue of a device: dated as now

/* ----------------------------------------------------------------------- */

/* ----------------------------------------------------------------------- */

/* The telemetry comes every 10 s: its mean per minute is stored once the minute is over,
 * an hour of a day is 60 documents, a year about half a million per device. */
const minutes = new Map<string, { start: number; co2: number; temperature: number; humidity: number; n: number }>();

async function storeMinute(deviceId: string, m: { start: number; co2: number; temperature: number; humidity: number; n: number }) {
    const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
    await AirReadingModel.updateOne(
        { deviceId, at: new Date(m.start) },
        { $set: { co2: Math.round(m.co2 / m.n), temperature: round(m.temperature / m.n, 1), humidity: round(m.humidity / m.n, 1) } },
        { upsert: true },
    );
}

function recordState(deviceId: string, state: AirState) {
    if (state.co2 === undefined || state.temperature === undefined || state.humidity === undefined) return;
    const start = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const m = minutes.get(deviceId);
    if (m && m.start === start) {
        m.co2 += state.co2;
        m.temperature += state.temperature;
        m.humidity += state.humidity;
        m.n++;
        return;
    }
    if (m) {
        storeMinute(deviceId, m).catch((err) => log.warn('minute not stored', { device: deviceId }, err));
    }
    minutes.set(deviceId, { start, co2: state.co2, temperature: state.temperature, humidity: state.humidity, n: 1 });
}

/* ----------------------------------------------------------------------- */

function toAirEvent(doc: AirEventDoc): AirEvent {
    return { ...(doc.data as Partial<AirEvent>), _id: doc._id, deviceId: doc.deviceId, kind: doc.kind, at: doc.at };
}

const pick = (msg: Record<string, unknown>, keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        const v = msg[key];
        if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
        else if (typeof v === 'boolean') out[key] = v;
        else if (typeof v === 'string' && v.length <= 16) out[key] = v;
    }
    return out;
};

const eventFields: Record<AirEvent['kind'], string[]> = {
    smoke: ['source', 'puffs', 'durationSeconds', 'peakPpm', 'button', 'window'],
    window: ['state', 'co2', 'co2Before', 'temperatureChange', 'openSeconds', 'atStart'],
    fire: ['co2', 'co2Rise', 'temperature', 'temperatureRise'],
};

async function alertFor(deviceId: string, event: AirEvent) {
    const doc = await Device.findById(deviceId, { name: 1 }).lean();
    const name = doc?.name ?? deviceId;
    const path = `/air/${deviceId}`;
    if (event.kind === 'fire') {
        const parts = [
            event.co2Rise !== undefined ? `CO2 up ${event.co2Rise} ppm` : '',
            event.temperatureRise !== undefined ? `temperature up ${event.temperatureRise} °C` : '',
            event.temperature !== undefined ? `now ${event.temperature} °C` : '',
        ].filter(Boolean);
        await notifyOwner(deviceId, {
            title: `Possible fire: ${name}`,
            text: `${name} sees the air change as in a fire (${parts.join(', ')}). Check now. This is no certified smoke alarm.`,
            urgent: true,
            path,
        });
    } else if (event.kind === 'window' && event.state === 'open' && !event.atStart) {
        const temp = event.temperatureChange ? `, ${event.temperatureChange > 0 ? '+' : ''}${event.temperatureChange} °C` : '';
        await notifyOwner(deviceId, {
            title: `Window open: ${name}`,
            text: `${name}: a window seems open, the CO2 fell from ${event.co2Before} to ${event.co2} ppm in 3 minutes${temp}.`,
            path,
        });
    }
}

// an {"type":"event"} message of a kibbl. air: dated by its age, stored, pushed to the app
export async function handleAirEvent(deviceId: string, approved: boolean, msg: Record<string, unknown>) {
    const kind = msg.event;
    if (!approved || (kind !== 'smoke' && kind !== 'window' && kind !== 'fire')) return;
    const seconds = (key: string) => (typeof msg[key] === 'number' && (msg[key] as number) >= 0 ? (msg[key] as number) : 0);
    const age = seconds('ageSeconds') + seconds('delaySeconds');
    const at = Date.now() - (age <= MAX_EVENT_AGE_S ? age : 0) * 1000;

    const doc: AirEventDoc = { _id: crypto.randomUUID(), deviceId, kind, at, data: pick(msg, eventFields[kind]) };
    await AirEventModel.create(doc);
    const event = toAirEvent(doc);
    log.info('event', { device: deviceId, kind, ...doc.data, ageSeconds: age });
    hub.emit('airEvent', event);

    // an alert about a window opened hours ago (the device was offline) helps nobody
    if (kind === 'fire' || age < 15 * 60) {
        alertFor(deviceId, event).catch((err) => log.warn('alert failed', { device: deviceId, kind }, err));
    }
}

/* ----------------------------------------------------------------------- */

/* Night mode on the server's clock (the home's time zone). The device does not store it:
 * every telemetry says whether it is on, and when that is not what the schedule says, the
 * server sends it. A switch in the app holds until the schedule changes next. */
const schedules = new Map<string, { schedule: NightSchedule; online: boolean; approved: boolean }>();
const overrides = new Map<string, { night: boolean; until: number }>();
const lastSent = new Map<string, number>();

export function inNight(schedule: NightSchedule, date = new Date()) {
    if (!schedule.enabled || schedule.from === schedule.to) return false;
    const h = date.getHours();
    return schedule.from < schedule.to ? h >= schedule.from && h < schedule.to : h >= schedule.from || h < schedule.to;
}

// the next time the schedule switches, from now
function nextChange(schedule: NightSchedule, now = new Date()) {
    const t = new Date(now);
    t.setMinutes(0, 0, 0);
    const nightNow = inNight(schedule, now);
    for (let i = 0; i < 25; i++) {
        t.setHours(t.getHours() + 1);
        if (inNight(schedule, t) !== nightNow) return t.getTime();
    }
    return now.getTime() + 24 * 3600_000;
}

function wantedNight(deviceId: string): boolean | undefined {
    const override = overrides.get(deviceId);
    if (override && override.until > Date.now()) return override.night;
    overrides.delete(deviceId);
    const entry = schedules.get(deviceId);
    if (!entry?.schedule.enabled) return undefined; // no schedule: what the app last set stays
    return inNight(entry.schedule);
}

function reconcileNight(deviceId: string, state: AirState) {
    const wanted = wantedNight(deviceId);
    if (wanted === undefined || wanted === state.night) return;
    if (Date.now() - (lastSent.get(deviceId) ?? 0) < NIGHT_RETRY_MS) return;
    lastSent.set(deviceId, Date.now());
    sendCommand(deviceId, { cmd: 'night', on: wanted })
        .then((resp) => {
            if (resp.ok) log.info('night mode by schedule', { device: deviceId, night: wanted });
            else log.warn('night mode not taken', { device: deviceId, error: resp.error });
        })
        .catch(() => undefined);
}

// the app switched night mode by hand: it stays until the schedule switches next
export function setNightOverride(deviceId: string, night: boolean) {
    const entry = schedules.get(deviceId);
    if (entry?.schedule.enabled) {
        overrides.set(deviceId, { night, until: nextChange(entry.schedule) });
    }
}

export async function setNightSchedule(deviceId: string, schedule: NightSchedule) {
    await Device.updateOne({ _id: deviceId }, { night: schedule });
    overrides.delete(deviceId);
    lastSent.delete(deviceId);
    const entry = schedules.get(deviceId);
    schedules.set(deviceId, { schedule, online: entry?.online ?? false, approved: entry?.approved ?? true });
}

/* ----------------------------------------------------------------------- */

export async function airReadings(deviceId: string, from: Date, to: Date): Promise<AirReading[]> {
    const docs = await AirReadingModel.find({ deviceId, at: { $gte: from, $lte: to } }, { _id: 0, at: 1, co2: 1, temperature: 1, humidity: 1 })
        .sort({ at: 1 })
        .lean();
    // at most about 2000 points for a chart: means over longer steps for long windows
    const step = Math.max(1, Math.ceil(docs.length / 2000));
    const out: AirReading[] = [];
    for (let i = 0; i < docs.length; i += step) {
        const slice = docs.slice(i, i + step);
        const mean = (key: 'co2' | 'temperature' | 'humidity') => slice.reduce((s, d) => s + d[key], 0) / slice.length;
        out.push({
            at: slice[0].at.getTime(),
            co2: Math.round(mean('co2')),
            temperature: Math.round(mean('temperature') * 10) / 10,
            humidity: Math.round(mean('humidity') * 10) / 10,
        });
    }
    return out;
}

export async function airEvents(deviceId: string, from: number, limit = 200) {
    const docs = await AirEventModel.find({ deviceId, at: { $gte: from } })
        .sort({ at: -1 })
        .limit(limit)
        .lean();
    return docs.map(toAirEvent);
}

function localDay(time: number) {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* Cigarettes per day: every press of the button, and the ones the detector found that no
 * press belongs to (button: false). Days without any are there with 0. */
export async function smokeDays(deviceId: string, days: number): Promise<SmokeDay[]> {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (days - 1));
    const docs = await AirEventModel.find({ deviceId, kind: 'smoke', at: { $gte: from.getTime() } }, { at: 1, data: 1 }).lean();
    const out = new Map<string, SmokeDay>();
    for (let d = new Date(from); out.size < days; d.setDate(d.getDate() + 1)) {
        const day = localDay(d.getTime());
        out.set(day, { day, count: 0, button: 0, auto: 0 });
    }
    for (const doc of docs) {
        const day = out.get(localDay(doc.at));
        if (!day) continue;
        if (doc.data.source === 'button') day.button++;
        else if (doc.data.button !== true) day.auto++;
        day.count = day.button + day.auto;
    }
    return [...out.values()];
}

export async function removeAirData(deviceId: string) {
    minutes.delete(deviceId);
    schedules.delete(deviceId);
    overrides.delete(deviceId);
    await Promise.all([AirReadingModel.deleteMany({ deviceId }), AirEventModel.deleteMany({ deviceId })]);
}

/* ----------------------------------------------------------------------- */

/* A health hint of the climate (too cold, too hot, very dry, very humid, mould) that lasts
 * CLIMATE_LASTS_MS is sent to the owner, the same one at most every CLIMATE_REPEAT_MS, and
 * never in night mode: it can wait for the morning. */
const CLIMATE_LASTS_MS = 30 * 60_000;
const CLIMATE_REPEAT_MS = 12 * 3600_000;
const climateSince = new Map<string, number>(); // device|hint id: since when it is shown
const climateSent = new Map<string, number>();

async function checkClimate(deviceId: string, state: AirState) {
    const owner = await deviceOwner(deviceId);
    const weather = owner ? await weatherForUser(owner) : null;
    // a tado room in the same room: its temperature and humidity are the room's
    const doc = owner ? await Device.findById(deviceId, { roomId: 1 }).lean() : null;
    const room = pairedRoom(owner ?? undefined, doc?.roomId);
    const air = room ? { ...state, temperature: room.temperature ?? state.temperature, humidity: room.humidity ?? state.humidity } : state;
    const hints = climateHints(air, weather).filter((h) => h.notify && h.level !== 'good' && h.level !== 'info');
    const now = Date.now();
    const shown = new Set(hints.map((h) => `${deviceId}|${h.id}`));
    for (const key of climateSince.keys()) {
        if (key.startsWith(`${deviceId}|`) && !shown.has(key)) climateSince.delete(key);
    }
    for (const hint of hints) {
        const key = `${deviceId}|${hint.id}`;
        const since = climateSince.get(key) ?? now;
        climateSince.set(key, since);
        if (state.night || now - since < CLIMATE_LASTS_MS || now - (climateSent.get(key) ?? 0) < CLIMATE_REPEAT_MS) continue;
        climateSent.set(key, now);
        Device.findById(deviceId, { name: 1 })
            .lean()
            .then((doc) => notifyOwner(deviceId, { title: `${hint.title}: ${doc?.name ?? deviceId}`, text: hint.text, path: `/air/${deviceId}` }))
            .then(() => log.info('climate alert', { device: deviceId, hint: hint.id }))
            .catch((err) => log.warn('climate alert failed', { device: deviceId, hint: hint.id }, err));
    }
}

export function initAir() {
    hub.on('deviceUpdate', (device: DeviceSummary) => {
        if (!device.air) return;
        schedules.set(device._id, { schedule: device.air.schedule, online: device.online, approved: device.status === 'approved' });
        if (!device.online) {
            const m = minutes.get(device._id);
            minutes.delete(device._id);
            if (m) storeMinute(device._id, m).catch(() => undefined);
        } else if (device.status === 'approved' && device.air.state) {
            reconcileNight(device._id, device.air.state);
        }
    });
    hub.on('telemetry', (deviceId, telemetry) => {
        // a pending device shows nothing to anybody and keeps nothing
        if (!telemetry.air || !schedules.get(deviceId)?.approved) return;
        recordState(deviceId, telemetry.air);
        reconcileNight(deviceId, telemetry.air);
        checkClimate(deviceId, telemetry.air).catch((err) => log.warn('climate not checked', { device: deviceId }, err));
    });
}
