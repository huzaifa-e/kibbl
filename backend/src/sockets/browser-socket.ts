import crypto from 'node:crypto';
import { Server as HttpServer } from 'node:http';
import { Server, Socket } from 'socket.io';
import {
    type ActivityBucket,
    type AirEvent,
    type DeviceSummary,
    type DeviceTelemetry,
    type MotionEvent,
    type MotionSettings,
    type NightSchedule,
    type SetupInfo,
} from '../../../shared/protocol';
import { removeAirData, setNightSchedule } from '../core/air';
import { applyMotionSettings, runDeviceCommand } from '../core/control';
import { AUTH_COOKIE, checkAuthToken, readCookie } from '../core/auth';
import { Device, Meter, MotionEventModel } from '../core/db';
import { closeConnection, getSummaries, publishDevice, updateDemand, type DeviceResponse } from '../core/devices';
import { forgetFrames } from '../core/frames';
import { hub } from '../core/hub';
import { logger } from '../core/logger';
import { canUse, deviceOwner, forgetOwner, isAdmin, maySetUp, ownedDeviceIds, visibleDeviceFilter } from '../core/owners';

const log = logger('app');
import { dropCurrentPicture, endMotion, toMotionEvent } from '../core/motion';
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
    heatUpdate: () => void;
    petkitUpdate: () => void;
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
        cb(doc ? await runDeviceCommand(doc, command, socket.data.session.email) : { ok: false, error: 'command not allowed for this device' });
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
        await applyMotionSettings(doc, settings, socket.data.session.email);
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
    hub.on('heatUpdate', (userID) => io.to(`user:${userID}`).emit('heatUpdate'));
    hub.on('petkitUpdate', (userID) => io.to(`user:${userID}`).emit('petkitUpdate'));
    hub.on('meterUpdate', (meterId) => {
        Meter.findById(meterId, { ownerID: 1 })
            .lean()
            .then((meter) => meter?.ownerID && io.to(roomOf(meter.ownerID)).emit('meterUpdate', meterId))
            .catch((err) => log.warn('meter update not sent', { meter: meterId }, err));
    });
}
