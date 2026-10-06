import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import {
    framesizes,
    type ActivityBucket,
    type DeviceSummary,
    type DeviceTelemetry,
    type MotionEvent,
    type MotionSettings,
    type SetupInfo,
} from '../../../shared/protocol';
import { AUTH_COOKIE, checkAuthToken, readCookie } from '../core/auth';
import { Device, MotionEventModel } from '../core/db';
import { applyCommandResult, closeConnection, commandAllowed, getSummaries, publishDevice, sendCommand, updateDemand, type DeviceResponse } from '../core/devices';
import { forgetFrames } from '../core/frames';
import { hub } from '../core/hub';
import { log } from '../core/logger';
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
    renameDevice: (deviceId: string, name: string, cb: Callback<Result>) => void;
    removeDevice: (deviceId: string, cb: Callback<Result>) => void;
    setMotionSettings: (deviceId: string, settings: Partial<MotionSettings>, cb: Callback<Result>) => void;
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
            return int(command.count ?? 2, 1, 10) && int(command.level ?? 30, 1, 100) ? { cmd, count: command.count ?? 2, level: command.level ?? 30 } : undefined;
        case 'thermostat':
            return typeof command.target === 'number' && command.target >= 5 && command.target <= 30 ? { cmd, target: command.target } : undefined;
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
        cb(await getSummaries());
    });

    socket.on('deviceCommand', async (deviceId, command, cb) => {
        if (!isCallback(cb)) return;
        const doc = isDeviceID(deviceId) ? await Device.findById(deviceId).lean() : null;
        const clean = cleanCommand(command);
        if (!doc || doc.status !== 'approved' || !clean || !commandAllowed(doc, clean.cmd as string)) {
            cb({ ok: false, error: 'command not allowed for this device' });
            return;
        }
        // a scan holds the radio for a few seconds, longer than other commands
        const resp = await sendCommand(deviceId, clean, clean.cmd === 'wifi_scan' ? 15000 : undefined);
        await applyCommandResult(deviceId, clean.cmd as string, resp);
        log('info', `${socket.data.session.email}: ${deviceId} ${clean.cmd} -> ${resp.ok ? 'ok' : resp.error}`);
        cb(resp);
    });

    socket.on('approveDevice', async (deviceId, cb) => {
        if (!isCallback(cb) || !isDeviceID(deviceId)) return;
        const res = await Device.updateOne({ _id: deviceId, status: 'pending' }, { status: 'approved' });
        if (res.modifiedCount === 0) {
            cb({ ok: false, error: 'no pending device with this id' });
            return;
        }
        log('info', `${socket.data.session.email}: approved ${deviceId}`);
        setDeviceApproved(deviceId);
        await updateDemand(deviceId);
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    socket.on('renameDevice', async (deviceId, name, cb) => {
        if (!isCallback(cb)) return;
        if (!isDeviceID(deviceId) || !isString(name?.trim?.(), 40)) {
            cb({ ok: false, error: 'the name needs 1 to 40 characters' });
            return;
        }
        await Device.updateOne({ _id: deviceId }, { name: name.trim() });
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    socket.on('removeDevice', async (deviceId, cb) => {
        if (!isCallback(cb) || !isDeviceID(deviceId)) return;
        await endMotion(deviceId);
        closeConnection(deviceId);
        forgetFrames(deviceId);
        await Device.deleteOne({ _id: deviceId });
        await MotionEventModel.deleteMany({ deviceId });
        await deleteDeviceImages(deviceId);
        log('info', `${socket.data.session.email}: removed ${deviceId} with its events`);
        hub.emit('deviceRemoved', deviceId);
        cb({ ok: true });
    });

    socket.on('setMotionSettings', async (deviceId, settings, cb) => {
        if (!isCallback(cb)) return;
        const doc = isDeviceID(deviceId) ? await Device.findById(deviceId).lean() : null;
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
        invalidateMotionSettings(deviceId);
        await updateDemand(deviceId);
        await publishDevice(deviceId);
        cb({ ok: true });
    });

    socket.on('getEvents', async (query, cb) => {
        if (!isCallback(cb)) return;
        const filter: Record<string, unknown> = {};
        if (isDeviceID(query?.deviceId)) filter.deviceId = query.deviceId;
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
        const doc = await MotionEventModel.findByIdAndDelete(eventId).lean();
        await deleteSnapshot(doc?.snapshot);
        cb({ ok: !!doc });
    });

    socket.on('countEventPictures', async (deviceId, cb) => {
        if (!isCallback(cb)) return;
        if (!isDeviceID(deviceId)) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        cb({ ok: true, count: await MotionEventModel.countDocuments({ deviceId, snapshot: { $exists: true } }) });
    });

    /* The pictures of a camera's events, not the events: the activity log stays as it
     * was, only what the camera saw is gone. */
    socket.on('deleteEventPictures', async (deviceId, cb) => {
        if (!isCallback(cb)) return;
        if (!isDeviceID(deviceId)) {
            cb({ ok: false, error: 'device not found' });
            return;
        }
        dropCurrentPicture(deviceId);
        const withPictures = await MotionEventModel.find({ deviceId, snapshot: { $exists: true } }, { snapshot: 1 }).lean();
        for (const event of withPictures) {
            await deleteSnapshot(event.snapshot);
        }
        await MotionEventModel.updateMany({ _id: { $in: withPictures.map((e) => e._id) } }, { $unset: { snapshot: 1 } });
        log('info', `${socket.data.session.email}: deleted ${withPictures.length} pictures of ${deviceId}, the events stay`);
        cb({ ok: true, deleted: withPictures.length });
    });

    socket.on('getActivity', async (query, cb) => {
        if (!isCallback(cb)) return;
        const days = Math.min(Math.max(Number(query?.days) || 7, 1), 31);
        const from = new Date();
        from.setHours(0, 0, 0, 0);
        from.setDate(from.getDate() - (days - 1));
        const filter: Record<string, unknown> = { start: { $gte: from.getTime() } };
        if (isDeviceID(query?.deviceId)) filter.deviceId = query.deviceId;

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

    socket.on('expectDevice', (deviceId, name, cb) => {
        if (!isCallback(cb)) return;
        if (!isDeviceID(deviceId) || !isString(name?.trim?.(), 40)) {
            cb({ ok: false, error: 'device id or name invalid' });
            return;
        }
        expectDevice(deviceId, name.trim());
        log('info', `${socket.data.session.email}: setting up ${deviceId} over USB`);
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

    io.on('connection', (socket) => {
        socket.join('users');
        registerEvents(socket);
        registerSetupEvents(socket);
    });

    hub.on('deviceUpdate', (device) => io.to('users').emit('deviceUpdate', device));
    hub.on('deviceRemoved', (deviceId) => io.to('users').emit('deviceRemoved', deviceId));
    hub.on('telemetry', (deviceId, telemetry) => io.to('users').emit('telemetry', deviceId, telemetry));
    hub.on('motionEvent', (event) => io.to('users').emit('motionEvent', event));
}
