import crypto from 'node:crypto';
import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import {
    fanModes,
    framesizes,
    lampColors,
    lampModes,
    type ActivityBucket,
    type AirEvent,
    type DeviceSummary,
    type DeviceTelemetry,
    type MotionEvent,
    type MotionSettings,
    type NightSchedule,
    type SetupInfo,
} from '../../../shared/protocol';
import { removeAirData, setNightOverride, setNightSchedule } from '../core/air';
import { AUTH_COOKIE, checkAuthToken, readCookie } from '../core/auth';
import { Device, Meter, MotionEventModel } from '../core/db';
import {
    applyCommandResult,
    closeConnection,
    commandAllowed,
    getSummaries,
    publishDevice,
    sendCommand,
    updateDemand,
    type DeviceResponse,
} from '../core/devices';
import { forgetFrames } from '../core/frames';
import { hub } from '../core/hub';
import { logger } from '../core/logger';
import { canUse, deviceOwner, forgetOwner, isAdmin, maySetUp, ownedDeviceIds, visibleDeviceFilter } from '../core/owners';

const log = logger('app');
import { dropCurrentPicture, endMotion, invalidateMotionSettings, toMotionEvent } from '../core/motion';
import { deleteDeviceImages, deleteSnapshot } from '../core/storage';
import { expectDevice, setDeviceApproved } from './device-socket';

type Callback<T> = (result: T) => void;
type Result = { ok: boolean; error?: string };

interface ServerToClientEvents {
    deviceUpdate: (device: DeviceSummary) => void;
    deviceRemoved: (deviceId: string) => void;
    telemetry: (deviceId: string, telemetry: DeviceTelemetry) => void;
    motionEvent: (event: MotionEvent) => void;
    meterUpdate: (meterId: string) => void;
    airEvent: (event: AirEvent) => void;
    heatingUpdate: () => void;
}

interface EventQuery {
    deviceId?: string;
    from?: number;
    to?: number;
    limit?: number;
}

interface ClientToServerEvents {
    getDevices: (cb: Callback<DeviceSummary[]>) => void;
    deviceCommand: (deviceId: string, command: Record<string, unknown>, cb: Callback<DeviceResponse>) => void;
    approveDevice: (deviceId: string, cb: Callback<Result>) => void;
    claimDevice: (code: string, name: string, cb: Callback<Result & { deviceId?: string }>) => void;
    renameDevice: (deviceId: string, name: string, cb: Callback<Result>) => void;
    removeDevice: (deviceId: string, cb: Callback<Result>) => void;
    setMotionSettings: (deviceId: string, settings: Partial<MotionSettings>, cb: Callback<Result>) => void;
    setNightSchedule: (deviceId: string, schedule: NightSchedule, cb: Callback<Result>) => void;
    getEvents: (query: EventQuery, cb: Callback<MotionEvent[]>) => void;
    deleteEvent: (eventId: string, cb: Callback<Result>) => void;
    countEventPictures: (deviceId: string, cb: Callback<Result & { count?: number }>) => void;
    deleteEventPictures: (deviceId: string, cb: Callback<Result & { deleted?: number }>) => void;
    getActivity: (query: { deviceId?: string; days: number }, cb: Callback<ActivityBucket[]>) => void;
    getSetupInfo: (cb: Callback<SetupInfo>) => void;
    expectDevice: (deviceId: string, name: string, cb: Callback<Result>) => void;
}

type BrowserSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { session: SessionInfo }>;

const isString = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isDeviceID = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-F]{12}$/.test(v);
const isUUID = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
const isCallback = (cb: unknown): cb is Callback<never> => typeof cb === 'function';

// pairing codes typed per account: a few wrong ones are typos, many are guessing
const CLAIM_TRIES = 10;
const CLAIM_WINDOW_MS = 10 * 60_000;
const claimTries = new Map<string, number[]>();

// the device, when this user may use it (their own, or for the admin a pending one nobody owns)
async function usableDevice(socket: BrowserSocket, deviceId: unknown) {
    const doc = isDeviceID(deviceId) ? await Device.findById(deviceId).lean() : null;
    return (await canUse(socket.data.session.userID, doc)) ? doc : null;
}

/* What the app may send per command: the device range-checks the values again,
 * this keeps anything else from reaching it. */
function cleanCommand(command: Record<string, unknown>): Record<string, unknown> | undefined {
    const cmd = command?.cmd;
    if (!isString(cmd, 32)) {
        return undefined;
    }
    const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    switch (cmd) {
        case 'info':
        case 'reboot':
        case 'wifi_scan':
            return { cmd };
        case 'wifi': {
            // the password passes through to the device and is neither stored nor logged
            const ssid = command.ssid;
            const password = command.password ?? '';
            if (typeof ssid !== 'string' || ssid.length < 1 || ssid.length > 32 || typeof password !== 'string') return undefined;
            if (password.length !== 0 && (password.length < 8 || password.length > 63)) return undefined;
            return { cmd, ssid, password };
        }
        case 'light':
            return int(command.level, 0, 100) ? { cmd, level: command.level } : undefined;
        case 'camera': {
            const out: Record<string, unknown> = { cmd };
            if (command.framesize !== undefined) {
                if (!framesizes.includes(command.framesize as never)) return undefined;
                out.framesize = command.framesize;
            }
            if (command.quality !== undefined) {
                if (!int(command.quality, 4, 63)) return undefined;
                out.quality = command.quality;
            }
            for (const key of ['brightness', 'contrast', 'saturation']) {
                if (command[key] !== undefined) {
                    if (!int(command[key], -2, 2)) return undefined;
                    out[key] = command[key];
                }
            }
            for (const key of ['vflip', 'hmirror']) {
                if (command[key] !== undefined) {
                    if (typeof command[key] !== 'boolean') return undefined;
                    out[key] = command[key];
                }
            }
            return out;
        }
        // future devices (docs/protocol.md)
        case 'switch':
            return isString(command.channel, 16) && typeof command.on === 'boolean' ? { cmd, channel: command.channel, on: command.on } : undefined;
        case 'feed':
            return int(command.portions, 1, 10) ? { cmd, portions: command.portions } : undefined;
        case 'blink':
            return int(command.count ?? 2, 1, 10) && int(command.level ?? 30, 1, 100)
                ? { cmd, count: command.count ?? 2, level: command.level ?? 30 }
                : undefined;
        case 'thermostat':
            return typeof command.target === 'number' && command.target >= 5 && command.target <= 30 ? { cmd, target: command.target } : undefined;
        // kibbl. air: only the keys present go to the device, each in its range
        case 'air_config': {
            const ranges: Record<string, [number, number]> = {
                yellow: [400, 5000],
                red: [400, 10000],
                altitude: [0, 3000],
                puffRise: [30, 2000],
                nightFan: [0, 100],
            };
            const out: Record<string, unknown> = { cmd };
            for (const [key, [min, max]] of Object.entries(ranges)) {
                if (command[key] === undefined) continue;
                if (!int(command[key], min, max)) return undefined;
                out[key] = command[key];
            }
            for (const key of ['buzzer', 'asc', 'smoke']) {
                if (command[key] === undefined) continue;
                if (typeof command[key] !== 'boolean') return undefined;
                out[key] = command[key];
            }
            // °C on top of the warmth correction, to match a thermometer the person trusts
            if (command.tempAdjust !== undefined) {
                const v = command.tempAdjust;
                if (typeof v !== 'number' || !Number.isFinite(v) || v < -5 || v > 5) return undefined;
                out.tempAdjust = Math.round(v * 10) / 10;
            }
            // the reminder to air: a beep every so many minutes from yellow or red
            if (command.remindMinutes !== undefined) {
                if (!int(command.remindMinutes, 0, 60)) return undefined;
                out.remindMinutes = command.remindMinutes;
            }
            if (command.remindFrom !== undefined) {
                if (command.remindFrom !== 'yellow' && command.remindFrom !== 'red') return undefined;
                out.remindFrom = command.remindFrom;
            }
            // a factor on the humidity, to match a hygrometer the person trusts
            if (command.humidityFactor !== undefined) {
                const v = command.humidityFactor;
                if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.7 || v > 1.3) return undefined;
                out.humidityFactor = Math.round(v * 1000) / 1000;
            }
            return out;
        }
        case 'fan': {
            const out: Record<string, unknown> = { cmd };
            if (command.mode !== undefined) {
                if (!fanModes.includes(command.mode as never)) return undefined;
                out.mode = command.mode;
            }
            const ranges: Record<string, [number, number]> = { level: [1, 100], onSeconds: [1, 3600], offSeconds: [1, 3600] };
            for (const [key, [min, max]] of Object.entries(ranges)) {
                if (command[key] === undefined) continue;
                if (!int(command[key], min, max)) return undefined;
                out[key] = command[key];
            }
            return out;
        }
        case 'lamp': {
            const out: Record<string, unknown> = { cmd };
            if (command.mode !== undefined) {
                if (!lampModes.includes(command.mode as never)) return undefined;
                out.mode = command.mode;
            }
            if (command.colors !== undefined) {
                if (!Array.isArray(command.colors) || command.colors.length > 4 || !command.colors.every((c) => lampColors.includes(c))) return undefined;
                out.colors = [...new Set(command.colors)];
            }
            if (command.fade !== undefined) {
                if (typeof command.fade !== 'boolean') return undefined;
                out.fade = command.fade;
            }
            return out;
        }
        case 'night':
            return typeof command.on === 'boolean' ? { cmd, on: command.on } : undefined;
        case 'calibrate':
            return int(command.ppm ?? 420, 400, 2000) ? { cmd, ppm: command.ppm ?? 420 } : undefined;
        default:
            return undefined;
    }
}

function localDay(time: number) {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function registerEvents(socket: BrowserSocket) {
    socket.on('getDevices', async (cb) => {
        if (!isCallback(cb)) return;
        cb(await getSummaries(await visibleDeviceFilter(socket.data.session.userID)));
    });

    socket.on('deviceCommand', async (deviceId, command, cb) => {
        if (!isCallback(cb)) return;
        const doc = await usableDevice(socket, deviceId);
        const clean = cleanCommand(command);
        if (!doc || doc.status !== 'approved' || !clean || !commandAllowed(doc, clean.cmd as string)) {
            cb({ ok: false, error: 'command not allowed for this device' });
            return;
        }
        // a scan holds the radio for a few seconds, longer than other commands
        const resp = await sendCommand(deviceId, clean, clean.cmd === 'wifi_scan' ? 15000 : undefined);
        await applyCommandResult(deviceId, clean.cmd as string, resp);
        // switched by hand: the night schedule leaves it until it changes next
        if (clean.cmd === 'night' && resp.ok) setNightOverride(deviceId, clean.on as boolean);
        log.info('command', { device: deviceId, cmd: String(clean.cmd), result: resp.ok ? 'ok' : resp.error, user: socket.data.session.email });
        cb(resp);
    });

    socket.on('approveDevice', async (deviceId, cb) => {
        if (!isCallback(cb) || !isDeviceID(deviceId)) return;
        // a pending device nobody owns: only the admin approves it, and owns it then
        if (!(await isAdmin(socket.data.session.userID))) {
            cb({ ok: false, error: 'only the admin approves devices that were not set up over USB' });
            return;
        }
        const res = await Device.updateOne(
            { _id: deviceId, status: 'pending', ownerID: { $exists: false } },
            { status: 'approved', ownerID: socket.data.session.userID },
        );
        forgetOwner(deviceId);
        if (res.modifiedCount === 0) {
            cb({ ok: false, error: 'no pending device with this id' });
            return;
        }
        log.info('device approved', { device: deviceId, user: socket.data.session.email });
        setDeviceApproved(deviceId);
        await updateDemand(deviceId);
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    /* A device set up over its own Wi-Fi (the setup page) is pending without an owner: the
     * pairing code its page showed takes it into the account of who types it. */
    socket.on('claimDevice', async (code, name, cb) => {
        if (!isCallback(cb)) return;
        const userID = socket.data.session.userID;
        const tries = (claimTries.get(userID) ?? []).filter((t) => Date.now() - t < CLAIM_WINDOW_MS);
        if (tries.length >= CLAIM_TRIES) {
            cb({ ok: false, error: 'Too many codes tried. Wait a few minutes.' });
            return;
        }
        tries.push(Date.now());
        claimTries.set(userID, tries);

        const clean = typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
        if (clean.length !== 8 || !isString(name?.trim?.(), 40)) {
            cb({ ok: false, error: 'The code has 8 letters and digits, the name 1 to 40 characters.' });
            return;
        }
        const claimHash = crypto.createHash('sha256').update(clean).digest('hex');
        const doc = await Device.findOneAndUpdate(
            { claimHash, status: 'pending', ownerID: { $exists: false } },
            { $set: { status: 'approved', ownerID: userID, name: name.trim() }, $unset: { claimHash: 1 } },
        ).lean();
        if (!doc) {
            log.warn('pairing code not matched', { user: socket.data.session.email });
            cb({
                ok: false,
                error: 'No device waits with this code. Is it online (the setup page said connected)? A device that already has an owner has to be removed by them first.',
            });
            return;
        }
        claimTries.delete(userID);
        forgetOwner(doc._id);
        log.info('device paired with its code', { device: doc._id, user: socket.data.session.email });
        hub.emit('deviceRemoved', doc._id, null); // gone from the admin's waiting list
        setDeviceApproved(doc._id);
        await updateDemand(doc._id);
        await publishDevice(doc._id);
        cb({ ok: true, deviceId: doc._id });
    });

    socket.on('renameDevice', async (deviceId, name, cb) => {
        if (!isCallback(cb)) return;
        if (!isString(name?.trim?.(), 40)) {
            cb({ ok: false, error: 'the name needs 1 to 40 characters' });
            return;
        }
        if (!(await usableDevice(socket, deviceId))) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        await Device.updateOne({ _id: deviceId }, { name: name.trim() });
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    socket.on('removeDevice', async (deviceId, cb) => {
        if (!isCallback(cb)) return;
        const doc = await usableDevice(socket, deviceId);
        if (!doc) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        await endMotion(deviceId);
        closeConnection(deviceId);
        forgetFrames(deviceId);
        await Device.deleteOne({ _id: deviceId });
        await MotionEventModel.deleteMany({ deviceId });
        await deleteDeviceImages(deviceId);
        await removeAirData(deviceId);
        log.info('device removed with its events', { device: deviceId, user: socket.data.session.email });
        forgetOwner(deviceId);
        hub.emit('deviceRemoved', deviceId, doc.ownerID ?? null);
        cb({ ok: true });
    });

    socket.on('setMotionSettings', async (deviceId, settings, cb) => {
        if (!isCallback(cb)) return;
        const doc = await usableDevice(socket, deviceId);
        if (!doc) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        const motion = { ...doc.motion };
        const hour = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23;
        if (typeof settings?.enabled === 'boolean') motion.enabled = settings.enabled;
        if (settings?.sensitivity && ['low', 'medium', 'high'].includes(settings.sensitivity)) motion.sensitivity = settings.sensitivity;
        if (hour(settings?.quietFrom)) motion.quietFrom = settings.quietFrom as number;
        if (hour(settings?.quietTo)) motion.quietTo = settings.quietTo as number;
        if (typeof settings?.blink === 'boolean') motion.blink = settings.blink;
        if (typeof settings?.keepPictures === 'boolean') motion.keepPictures = settings.keepPictures;
        await Device.updateOne({ _id: deviceId }, { motion });
        log.info('motion settings changed', {
            device: deviceId,
            enabled: motion.enabled,
            sensitivity: motion.sensitivity,
            quiet: motion.quietFrom === motion.quietTo ? 'off' : `${motion.quietFrom}-${motion.quietTo}h`,
            pictures: motion.keepPictures ? 'kept' : 'none',
            user: socket.data.session.email,
        });
        invalidateMotionSettings(deviceId);
        await updateDemand(deviceId);
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    socket.on('setNightSchedule', async (deviceId, schedule, cb) => {
        if (!isCallback(cb)) return;
        const doc = await usableDevice(socket, deviceId);
        if (!doc || !doc.caps.includes('night')) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        const hour = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23;
        if (typeof schedule?.enabled !== 'boolean' || !hour(schedule.from) || !hour(schedule.to)) {
            cb({ ok: false, error: 'hours 0 to 23' });
            return;
        }
        await setNightSchedule(deviceId, { enabled: schedule.enabled, from: schedule.from, to: schedule.to });
        log.info('night schedule', { device: deviceId, night: schedule.enabled ? `${schedule.from}-${schedule.to}h` : 'off', user: socket.data.session.email });
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    socket.on('getEvents', async (query, cb) => {
        if (!isCallback(cb)) return;
        const own = await ownedDeviceIds(socket.data.session.userID);
        const filter: Record<string, unknown> = { deviceId: { $in: own } };
        if (isDeviceID(query?.deviceId)) filter.deviceId = own.includes(query.deviceId) ? query.deviceId : '';
        const start: Record<string, number> = {};
        if (typeof query?.from === 'number') start.$gte = query.from;
        if (typeof query?.to === 'number') start.$lt = query.to;
        if (Object.keys(start).length) filter.start = start;
        const limit = Math.min(Math.max(Number(query?.limit) || 50, 1), 500);
        const docs = await MotionEventModel.find(filter).sort({ start: -1 }).limit(limit).lean();
        cb(docs.map(toMotionEvent));
    });

    socket.on('deleteEvent', async (eventId, cb) => {
        if (!isCallback(cb) || !isUUID(eventId)) return;
        const doc = await MotionEventModel.findOneAndDelete({ _id: eventId, deviceId: { $in: await ownedDeviceIds(socket.data.session.userID) } }).lean();
        await deleteSnapshot(doc?.snapshot);
        cb({ ok: !!doc });
    });

    socket.on('countEventPictures', async (deviceId, cb) => {
        if (!isCallback(cb)) return;
        if (!(await usableDevice(socket, deviceId))) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        cb({ ok: true, count: await MotionEventModel.countDocuments({ deviceId, snapshot: { $exists: true } }) });
    });

    /* The pictures of a camera's events, not the events: the activity log stays as it
     * was, only what the camera saw is gone. */
    socket.on('deleteEventPictures', async (deviceId, cb) => {
        if (!isCallback(cb)) return;
        if (!(await usableDevice(socket, deviceId))) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        dropCurrentPicture(deviceId);
        const withPictures = await MotionEventModel.find({ deviceId, snapshot: { $exists: true } }, { snapshot: 1 }).lean();
        for (const event of withPictures) {
            await deleteSnapshot(event.snapshot);
        }
        await MotionEventModel.updateMany({ _id: { $in: withPictures.map((e) => e._id) } }, { $unset: { snapshot: 1 } });
        log.info('pictures deleted, events kept', { device: deviceId, pictures: withPictures.length, user: socket.data.session.email });
        cb({ ok: true, deleted: withPictures.length });
    });

    socket.on('getActivity', async (query, cb) => {
        if (!isCallback(cb)) return;
        const days = Math.min(Math.max(Number(query?.days) || 7, 1), 31);
        const from = new Date();
        from.setHours(0, 0, 0, 0);
        from.setDate(from.getDate() - (days - 1));
        const own = await ownedDeviceIds(socket.data.session.userID);
        const filter: Record<string, unknown> = { start: { $gte: from.getTime() }, deviceId: { $in: own } };
        if (isDeviceID(query?.deviceId)) filter.deviceId = own.includes(query.deviceId) ? query.deviceId : '';

        // grouped here, in the server's time zone, which is the home's
        const docs = await MotionEventModel.find(filter, { start: 1, end: 1 }).lean();
        const buckets = new Map<string, ActivityBucket>();
        for (const e of docs) {
            const day = localDay(e.start);
            const hour = new Date(e.start).getHours();
            const key = `${day} ${hour}`;
            const bucket = buckets.get(key) ?? { day, hour, count: 0, seconds: 0 };
            bucket.count++;
            bucket.seconds += Math.round(((e.end ?? e.start) - e.start) / 1000);
            buckets.set(key, bucket);
        }
        cb([...buckets.values()]);
    });
}

/* The url devices connect to: DEVICE_SOCKET_URL, else derived from DEVICE_BASE_URL.
 * Never the address the browser used: localhost or a tunnel name may not be what a
 * device on the home network reaches. */
function deviceSocketUrl() {
    if (process.env.DEVICE_SOCKET_URL) {
        return process.env.DEVICE_SOCKET_URL;
    }
    const base = process.env.DEVICE_BASE_URL?.replace(/\/+$/, '');
    return base ? base.replace(/^http/, 'ws') + '/device/socket' : undefined;
}

function registerSetupEvents(socket: BrowserSocket) {
    socket.on('getSetupInfo', (cb) => {
        if (!isCallback(cb)) return;
        cb({ deviceSocketUrl: deviceSocketUrl() });
    });

    socket.on('expectDevice', async (deviceId, name, cb) => {
        if (!isCallback(cb)) return;
        if (!isDeviceID(deviceId) || !isString(name?.trim?.(), 40)) {
            cb({ ok: false, error: 'device id or name invalid' });
            return;
        }
        if (!(await maySetUp(socket.data.session.userID, deviceId))) {
            log.warn('setup refused, the device belongs to another account', { device: deviceId, user: socket.data.session.email });
            cb({ ok: false, error: 'This device belongs to another kibbl. account. Its owner has to remove it in their app before it can be set up again.' });
            return;
        }
        expectDevice(deviceId, name.trim(), socket.data.session.userID);
        log.info('setting up over USB', { device: deviceId, user: socket.data.session.email });
        cb({ ok: true });
    });
}

export function initBrowserSocket(http: HttpServer) {
    const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { session: SessionInfo }>(http, {
        path: '/browser/socket',
        transports: ['websocket'],
        serveClient: false,
        // the device socket shares the server: leave upgrades of other paths alone
        destroyUpgrade: false,
    });

    io.use(async (socket, next) => {
        let session: SessionInfo | undefined;
        try {
            session = await checkAuthToken(readCookie(socket.handshake.headers.cookie, AUTH_COOKIE));
        } catch (err) {
            next(new Error('Server unavailable')); // the database is away: refused, the app retries
            return;
        }
        if (!session) {
            next(new Error('Unauthorized'));
            return;
        }
        socket.data.session = session;
        next();
    });

    /* Every browser is in its user's room, the admin's also in 'admins': what a device
     * reports reaches its owner only, a pending device nobody owns the admin. */
    io.on('connection', async (socket) => {
        registerEvents(socket);
        registerSetupEvents(socket);
        socket.join(`user:${socket.data.session.userID}`);
        if (await isAdmin(socket.data.session.userID).catch(() => false)) socket.join('admins');
    });

    const roomOf = (owner: string | null) => (owner ? `user:${owner}` : 'admins');
    const toOwner = (deviceId: string, send: (room: string) => void) => {
        deviceOwner(deviceId)
            .then((owner) => send(roomOf(owner)))
            .catch((err) => log.warn('update not sent, owner unknown', { device: deviceId }, err));
    };

    hub.on('deviceUpdate', (device) => toOwner(device._id, (room) => io.to(room).emit('deviceUpdate', device)));
    hub.on('deviceRemoved', (deviceId, owner) => io.to(roomOf(owner)).emit('deviceRemoved', deviceId));
    hub.on('telemetry', (deviceId, telemetry) => toOwner(deviceId, (room) => io.to(room).emit('telemetry', deviceId, telemetry)));
    hub.on('motionEvent', (event) => toOwner(event.deviceId, (room) => io.to(room).emit('motionEvent', event)));
    hub.on('airEvent', (event) => toOwner(event.deviceId, (room) => io.to(room).emit('airEvent', event)));
    hub.on('heatingUpdate', (userID) => io.to(`user:${userID}`).emit('heatingUpdate'));
    hub.on('meterUpdate', (meterId) => {
        Meter.findById(meterId, { ownerID: 1 })
            .lean()
            .then((meter) => meter?.ownerID && io.to(roomOf(meter.ownerID)).emit('meterUpdate', meterId))
            .catch((err) => log.warn('meter update not sent', { meter: meterId }, err));
    });
}
