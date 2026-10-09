import type { AirEvent } from '../../../shared/protocol';
import type { HeatingCommand, HeatingRoom, HeatingStatus, PairedRoom } from '../../../shared/heating';
import { Device, TadoLink, TadoReading } from '../core/db';
import { hub } from '../core/hub';
import { roomByName } from '../core/rooms';
import { logger } from '../core/logger';
import { HOPS_API, MY_API, TadoError, forgetTokens, pollDeviceLogin, startDeviceLogin, tadoRequest, type DeviceLogin } from './client';

/*
 * Heating through tado for each account that connected it (Devices). The server reads all
 * rooms in one request, as often as what is left of tado's daily budget allows (POLL_STEPS):
 * every 2 minutes with hundreds left (an account with 1000 a day), so a change made in tado's
 * own app shows here soon; every 20 minutes with 100 a day (no Auto-Assist, 72 reads), the
 * rest kept for what the person and the kibbl. air ask for. With less left than LOW_BUDGET
 * it reads every hour, below RESERVE only commands go out.
 *
 * tado's rooms stand in the rooms of the home (core/rooms.ts), made from their names when tado
 * connects. A kibbl. air in the same room shows tado's temperature and humidity; when it
 * sees a window open while the room heats, the heating is switched off for at most
 * WINDOW_OFF_MIN minutes and back to its schedule when the window closes.
 */

const log = logger('tado');

// minutes between reads by the requests left today: 720 reads a day at 2 minutes, leaving 280 of 1000
const POLL_STEPS = [
    { left: 300, minutes: 2 },
    { left: 150, minutes: 5 },
];
const POLL_MINUTES = 20;
const SLOW_POLL_MINUTES = 60;
const LOW_BUDGET = 20;
const RESERVE = 8;
const WINDOW_OFF_MIN = 30;
const TICK_MS = 60_000;

interface Session {
    rooms: Map<number, HeatingRoom>;
    nextPoll: number;
    pending?: DeviceLogin;
    error?: string;
}

const sessions = new Map<string, Session>();
let rawLogged = false;
// the rooms the server switched off for an open window: back to the schedule when it closes
const windowOff = new Map<string, number>(); // userID|roomId -> until

function session(userID: string) {
    let s = sessions.get(userID);
    if (!s) {
        s = { rooms: new Map(), nextPoll: 0 };
        sessions.set(userID, s);
    }
    return s;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const round1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);

/* ----------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
// a zone state of a classic home (zoneStates.zoneStates[id])
export function classicRoom(id: number, name: string, z: any): HeatingRoom {
    const power = z?.setting?.power === 'ON' ? 'ON' : 'OFF';
    return {
        id,
        name,
        temperature: round1(num(z?.sensorDataPoints?.insideTemperature?.celsius)),
        humidity: round1(num(z?.sensorDataPoints?.humidity?.percentage)),
        target: power === 'ON' ? (num(z?.setting?.temperature?.celsius) ?? null) : null,
        power,
        heating: num(z?.activityDataPoints?.heatingPower?.percentage) ?? 0,
        openWindow: !!z?.openWindow || !!z?.openWindowDetected,
        manual: !!z?.overlay,
        manualUntil: z?.overlay?.termination?.projectedExpiry ? Date.parse(z.overlay.termination.projectedExpiry) : null,
        at: Date.now(),
    };
}

// a room of a tado X home (hops.tado.com/homes/{id}/rooms)
export function xRoom(r: any): HeatingRoom {
    const power = r?.setting?.power === 'ON' ? 'ON' : 'OFF';
    const until = r?.manualControlTermination?.projectedExpiry ?? r?.boostMode?.projectedExpiry;
    return {
        id: Number(r?.id),
        name: String(r?.name ?? `Room ${r?.id}`),
        temperature: round1(num(r?.sensorDataPoints?.insideTemperature?.value)),
        humidity: round1(num(r?.sensorDataPoints?.humidity?.percentage)),
        target: power === 'ON' ? (num(r?.setting?.temperature?.value) ?? null) : null,
        power,
        heating: num(r?.heatingPower?.percentage) ?? 0,
        openWindow: !!r?.openWindow?.activated,
        manual: !!r?.manualControlTermination || !!r?.boostMode,
        manualUntil: until ? Date.parse(until) : null,
        at: Date.now(),
    };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ----------------------------------------------------------------------- */

// after the sign-in: the home, whether it is a tado X, and its rooms (2-3 requests, once)
async function setUpHome(userID: string) {
    const me = await tadoRequest<{ homes?: { id: number; name: string }[] }>(userID, 'GET', `${MY_API}/me`);
    const home = me.data.homes?.[0];
    if (!home) throw new TadoError('This tado account has no home.');
    const info = await tadoRequest<{ generation?: string }>(userID, 'GET', `${MY_API}/homes/${home.id}`);
    const generation = info.data.generation === 'LINE_X' ? 'x' : 'classic';
    let rooms: { id: number; name: string }[];
    if (generation === 'x') {
        // tado X: the rooms come with their names in the regular read
        rooms = [];
    } else {
        const zones = await tadoRequest<{ id: number; name: string; type: string }[]>(userID, 'GET', `${MY_API}/homes/${home.id}/zones`);
        rooms = zones.data.filter((z) => z.type === 'HEATING').map((z) => ({ id: z.id, name: z.name }));
    }
    await TadoLink.updateOne({ _id: userID }, { homeId: home.id, homeName: home.name, generation, rooms: await placeRooms(userID, rooms) });
    log.info('tado home', { user: userID, home: home.name, generation, rooms: rooms.length });
}

/* tado's rooms in the rooms of the home: where they stood before, else in the room of their
 * name (made when there is none) */
async function placeRooms(userID: string, rooms: { id: number; name: string }[]) {
    const before = new Map(((await TadoLink.findById(userID, { rooms: 1 }).lean())?.rooms ?? []).map((r) => [r.id, r.roomId]));
    const placed: { id: number; name: string; roomId?: string }[] = [];
    for (const r of rooms) placed.push({ ...r, roomId: before.get(r.id) ?? (await roomByName(userID, r.name)) });
    return placed;
}

async function storeReadings(userID: string, rooms: HeatingRoom[]) {
    const at = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await Promise.all(
        rooms.map((r) =>
            TadoReading.updateOne(
                { userID, roomId: r.id, at },
                { $set: { temperature: r.temperature, humidity: r.humidity, target: r.target, heating: r.heating } },
                { upsert: true },
            ),
        ),
    );
}

/* All rooms in one request. The devices paired with them are published again, so the app
 * shows the new values. */
async function poll(userID: string) {
    const link = await TadoLink.findById(userID).lean();
    if (!link?.homeId) return;
    const s = session(userID);
    let rooms: HeatingRoom[];
    if (link.generation === 'x') {
        const res = await tadoRequest<unknown[]>(userID, 'GET', `${HOPS_API}/homes/${link.homeId}/rooms`);
        const raw = Array.isArray(res.data) ? res.data : [];
        // what tado X sends for a room, once per start: for when a value is not where it is expected
        if (!rawLogged) {
            rawLogged = true;
            log.info('tado X room as sent', { first: JSON.stringify(raw[0] ?? null).slice(0, 800) });
        }
        rooms = raw.map(xRoom);
        // tado X brings its rooms with every read: new ones are placed, the names kept for a failed read
        const known = new Set(link.rooms.map((r) => r.id));
        if (rooms.some((r) => !known.has(r.id)) || rooms.length !== link.rooms.length) {
            link.rooms = await placeRooms(
                userID,
                rooms.map((r) => ({ id: r.id, name: r.name })),
            );
            await TadoLink.updateOne({ _id: userID }, { rooms: link.rooms });
        }
    } else {
        const res = await tadoRequest<{ zoneStates?: Record<string, unknown> }>(userID, 'GET', `${MY_API}/homes/${link.homeId}/zoneStates`);
        const states = res.data.zoneStates ?? {};
        rooms = link.rooms.filter((r) => states[String(r.id)]).map((r) => classicRoom(r.id, r.name, states[String(r.id)]));
    }
    const place = new Map(link.rooms.map((r) => [r.id, r.roomId]));
    for (const r of rooms) r.roomId = place.get(r.id);
    s.rooms = new Map(rooms.map((r) => [r.id, r]));
    s.error = undefined;
    await TadoLink.updateOne({ _id: userID }, { lastPoll: Date.now(), $unset: { lastError: 1 } });
    await storeReadings(userID, rooms);
    hub.emit('heatingUpdate', userID);
}

export function pollMinutes(remaining: number | undefined) {
    if (remaining === undefined) return POLL_MINUTES;
    if (remaining < LOW_BUDGET) return SLOW_POLL_MINUTES;
    return POLL_STEPS.find((s) => remaining >= s.left)?.minutes ?? POLL_MINUTES;
}

async function tick() {
    const links = await TadoLink.find({}, { _id: 1, rateRemaining: 1, rateResetAt: 1, homeId: 1 }).lean();
    for (const link of links) {
        const s = session(link._id);
        if (!link.homeId || Date.now() < s.nextPoll) continue;
        const paused = link.rateRemaining !== undefined && link.rateRemaining <= RESERVE && (!link.rateResetAt || link.rateResetAt > Date.now());
        if (paused) {
            s.nextPoll = Date.now() + SLOW_POLL_MINUTES * 60_000;
            continue;
        }
        s.nextPoll = Date.now() + pollMinutes(link.rateRemaining) * 60_000;
        try {
            await poll(link._id);
        } catch (err) {
            s.error = (err as Error).message;
            await TadoLink.updateOne({ _id: link._id }, { lastError: s.error }).catch(() => undefined);
            log.warn('rooms not read', { user: link._id }, err);
        }
    }
}

/* ----------------------------------------------------------------------- */

// starts a sign-in: the person opens the address and confirms the code; the server waits for it
export async function connect(userID: string) {
    const s = session(userID);
    const login = await startDeviceLogin();
    s.pending = login;
    s.error = undefined;
    void waitForLogin(userID, login);
    return { userCode: login.userCode, url: login.url, expiresAt: login.expiresAt };
}

async function waitForLogin(userID: string, login: DeviceLogin) {
    const s = session(userID);
    let interval = login.interval;
    while (s.pending === login && Date.now() < login.expiresAt) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (s.pending !== login) return;
        try {
            const result = await pollDeviceLogin(login.deviceCode);
            if (result === 'pending') continue;
            if (result === 'slow_down') {
                interval += 5;
                continue;
            }
            forgetTokens(userID);
            await TadoLink.updateOne(
                { _id: userID },
                { $set: { tokens: result, connectedAt: Date.now() }, $setOnInsert: { rooms: [] }, $unset: { lastError: 1, rateRemaining: 1, rateResetAt: 1 } },
                { upsert: true },
            );
            s.pending = undefined;
            log.info('tado connected', { user: userID });
            await setUpHome(userID);
            s.nextPoll = 0;
            await poll(userID);
            await publishPaired(userID);
            return;
        } catch (err) {
            s.pending = undefined;
            s.error = (err as Error).message;
            log.warn('tado sign-in failed', { user: userID }, err);
            hub.emit('heatingUpdate', userID);
            return;
        }
    }
    if (s.pending === login) {
        s.pending = undefined;
        s.error = 'The code expired before it was confirmed.';
        hub.emit('heatingUpdate', userID);
    }
}

export async function disconnect(userID: string) {
    sessions.delete(userID);
    forgetTokens(userID);
    // the rooms of the home and the devices in them stay
    await Promise.all([TadoLink.deleteOne({ _id: userID }), TadoReading.deleteMany({ userID })]);
    log.info('tado disconnected', { user: userID });
}

export async function status(userID: string): Promise<HeatingStatus> {
    const link = await TadoLink.findById(userID).lean();
    const s = session(userID);
    // after a restart of the server: the last readings until the next poll
    if (link?.homeId && !s.rooms.size) await loadLastReadings(userID, link);
    return {
        connected: !!link?.homeId,
        pending: s.pending ? { userCode: s.pending.userCode, url: s.pending.url, expiresAt: s.pending.expiresAt } : undefined,
        home: link?.homeId ? { id: link.homeId, name: link.homeName ?? 'Home', generation: link.generation ?? 'classic' } : undefined,
        rooms: [...s.rooms.values()].sort((a, b) => a.name.localeCompare(b.name)),
        budget: link
            ? {
                  remaining: link.rateRemaining,
                  pollMinutes: pollMinutes(link.rateRemaining),
                  paused: link.rateRemaining !== undefined && link.rateRemaining <= RESERVE,
              }
            : undefined,
        lastPoll: link?.lastPoll,
        error: s.error ?? link?.lastError,
    };
}

async function loadLastReadings(userID: string, link: TadoLinkDoc) {
    const s = session(userID);
    for (const room of link.rooms) {
        const last = await TadoReading.findOne({ userID, roomId: room.id }).sort({ at: -1 }).lean();
        if (!last) continue;
        s.rooms.set(room.id, {
            id: room.id,
            name: room.name,
            roomId: room.roomId,
            temperature: last.temperature,
            humidity: last.humidity,
            target: last.target ?? null,
            power: last.target === null || last.target === undefined ? 'OFF' : 'ON',
            heating: last.heating ?? 0,
            openWindow: false,
            manual: false,
            at: last.at.getTime(),
        });
    }
}

// the tado room in this room of the home, as a kibbl. air there shows it; undefined when there is none
export function pairedRoom(ownerID: string | undefined, homeRoomId: string | undefined): PairedRoom | undefined {
    if (!ownerID || !homeRoomId) return undefined;
    const room = [...(sessions.get(ownerID)?.rooms.values() ?? [])].find((r) => r.roomId === homeRoomId);
    return room ? { ...room, source: 'tado' } : undefined;
}

function tadoRoomIn(ownerID: string, homeRoomId: string | undefined) {
    return pairedRoom(ownerID, homeRoomId);
}

// moves one of tado's rooms to another room of the home (null: none)
export async function placeTadoRoom(userID: string, tadoRoomId: number, homeRoomId: string | null) {
    const res = await TadoLink.updateOne(
        { _id: userID, 'rooms.id': tadoRoomId },
        homeRoomId ? { $set: { 'rooms.$.roomId': homeRoomId } } : { $unset: { 'rooms.$.roomId': 1 } },
    );
    const room = sessions.get(userID)?.rooms.get(tadoRoomId);
    if (room) room.roomId = homeRoomId ?? undefined;
    hub.emit('heatingUpdate', userID);
    await publishPaired(userID);
    return res.matchedCount > 0;
}

export async function readings(userID: string, roomId: number, from: Date, to: Date) {
    const docs = await TadoReading.find({ userID, roomId, at: { $gte: from, $lte: to } }, { _id: 0, at: 1, temperature: 1, humidity: 1, target: 1, heating: 1 })
        .sort({ at: 1 })
        .lean();
    return docs.map((d) => ({ at: d.at.getTime(), temperature: d.temperature, humidity: d.humidity, target: d.target ?? null, heating: d.heating ?? 0 }));
}

/* ----------------------------------------------------------------------- */

/* A command for a room: one request. The room is shown with it at once (a read would cost
 * another request); the next poll confirms it. */
export async function command(userID: string, roomId: number, cmd: HeatingCommand) {
    const link = await TadoLink.findById(userID).lean();
    if (!link?.homeId) throw new TadoError('tado is not connected');
    if (link.rateRemaining !== undefined && link.rateRemaining <= 0) throw new TadoError('tado allows no more requests today', 429);
    const x = link.generation === 'x';
    const termination = (until: 'next' | 'manual' | 'timer', minutes?: number) => {
        const type = until === 'next' ? 'NEXT_TIME_BLOCK' : until === 'timer' ? 'TIMER' : 'MANUAL';
        const t: Record<string, unknown> = x ? { type } : { typeSkillBasedApp: type };
        if (until === 'timer') t.durationInSeconds = Math.round((minutes ?? 60) * 60);
        return t;
    };

    let answer: unknown;
    if (cmd.mode === 'schedule') {
        if (x) answer = (await tadoRequest(userID, 'POST', `${HOPS_API}/homes/${link.homeId}/rooms/${roomId}/resumeSchedule`, {})).data;
        else answer = (await tadoRequest(userID, 'DELETE', `${MY_API}/homes/${link.homeId}/zones/${roomId}/overlay`)).data;
    } else {
        const on = cmd.mode === 'temperature';
        const setting: Record<string, unknown> = x ? { power: on ? 'ON' : 'OFF' } : { type: 'HEATING', power: on ? 'ON' : 'OFF' };
        if (on) setting.temperature = x ? { value: cmd.celsius, valueRaw: cmd.celsius, precision: 0.1 } : { celsius: cmd.celsius };
        const body = { setting, termination: termination(cmd.until, cmd.minutes) };
        if (x) answer = (await tadoRequest(userID, 'POST', `${HOPS_API}/homes/${link.homeId}/rooms/${roomId}/manualControl`, body)).data;
        else answer = (await tadoRequest(userID, 'PUT', `${MY_API}/homes/${link.homeId}/zones/${roomId}/overlay`, body)).data;
    }

    const room = session(userID).rooms.get(roomId);
    if (room) {
        room.manual = cmd.mode !== 'schedule';
        if (cmd.mode === 'temperature') {
            room.power = 'ON';
            room.target = cmd.celsius;
        } else if (cmd.mode === 'off') {
            room.power = 'OFF';
            room.target = null;
            room.heating = 0;
        }
        // the schedule's own setting is known only from the next read: soon
        if (cmd.mode === 'schedule') session(userID).nextPoll = Math.min(session(userID).nextPoll, Date.now() + 2 * 60_000);
    }
    // what tado answered: a refusal throws in tadoRequest, an accepted command may still differ
    log.info('heating command', { user: userID, room: roomId, ...cmd, answer: JSON.stringify(answer ?? null).slice(0, 300) });
    hub.emit('heatingUpdate', userID);
    await publishPaired(userID);
    confirmSoon(userID, link.rateRemaining);
}

/* After a command the room is read again in a while, so the app shows what tado really does
 * instead of what was asked; only with requests to spare (an account with 100 a day waits
 * for the regular read). */
const CONFIRM_MS = 60_000; // a radiator thermostat of tado X reports its new setting with a delay
function confirmSoon(userID: string, remaining: number | undefined) {
    if (remaining === undefined || remaining < 200) return;
    setTimeout(() => {
        poll(userID)
            .then(() => publishPaired(userID))
            .catch((err) => log.warn('room not read after a command', { user: userID }, err));
    }, CONFIRM_MS);
}

/* ----------------------------------------------------------------------- */

// the devices that stand in a room show its tado values: they are sent to the app again
export async function publishPaired(userID: string) {
    const devices = await Device.find({ ownerID: userID, roomId: { $exists: true } }, { _id: 1 }).lean();
    for (const d of devices) hub.emit('devicePublish', d._id);
}

/* The window of a paired kibbl. air: while it is open a heating room is switched off (for at
 * most WINDOW_OFF_MIN, in case the closing is missed), back to its schedule when it closes.
 * Nothing is sent when the room does not heat: no request spent. */
async function onAirEvent(event: AirEvent) {
    // found open right after a restart (firmware before 1.2.1): not seen opening, the heating stays
    if (event.kind !== 'window' || event.atStart || Date.now() - event.at > 10 * 60_000) return;
    const device = await Device.findById(event.deviceId, { ownerID: 1, roomId: 1 }).lean();
    if (!device?.ownerID) return;
    const room = tadoRoomIn(device.ownerID, device.roomId);
    if (!room) return; // no tado in its room
    const key = `${device.ownerID}|${room.id}`;
    try {
        if (event.state === 'open' && room.power === 'ON' && !room.manual) {
            await command(device.ownerID, room.id, { mode: 'off', until: 'timer', minutes: WINDOW_OFF_MIN });
            windowOff.set(key, Date.now() + WINDOW_OFF_MIN * 60_000);
            log.info('heating off for an open window', { device: event.deviceId, room: room.name });
        } else if (event.state === 'closed' && (windowOff.get(key) ?? 0) > Date.now()) {
            windowOff.delete(key);
            await command(device.ownerID, room.id, { mode: 'schedule' });
            log.info('heating back to its schedule, the window closed', { device: event.deviceId, room: room.name });
        }
    } catch (err) {
        log.warn('heating not switched for the window', { device: event.deviceId }, err);
    }
}

export function initTado() {
    setInterval(() => void tick().catch((err) => log.warn('poll round failed', undefined, err)), TICK_MS);
    void tick().catch(() => undefined);
    hub.on('airEvent', (event) => void onAirEvent(event));
}
