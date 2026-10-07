import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import {
    capabilityCommands,
    commonCommands,
    type AirDevice,
    type AirSettings,
    type CameraSettings,
    type FanSettings,
    type LampSettings,
    type DeviceSummary,
    type DeviceTelemetry,
    type MotionSettings,
} from '../../../shared/protocol';
import { nightSchedule, parseAirState } from './airState';
import db, { Device } from './db';
import { hub } from './hub';
import { logger } from './logger';

const log = logger('device');

const COMMAND_TIMEOUT_MS = 8000;
export const MAX_PENDING_DEVICES = 5;

interface LiveDevice {
    ws: WebSocket;
    info: Record<string, unknown>; // the hello message
    telemetry?: DeviceTelemetry;
    requestedFps: number;
    lastFrame?: Buffer;
    lastFrameTime?: number;
    pending: Map<number, { resolve: (resp: DeviceResponse) => void; timer: NodeJS.Timeout }>;
}

export interface DeviceResponse {
    ok: boolean;
    error?: string;
    [key: string]: unknown;
}

const live = new Map<string, LiveDevice>();
let nextCommandID = 1;

/* Kept apart from the connection: someone watching a device that reconnects is still
 * watching, and the new connection must stream to them at once. */
const viewers = new Map<string, number>();
const snapshotWaiters = new Map<string, number>();

export function viewFps() {
    return Number(process.env.STREAM_FPS) || 30;
}

export function motionFps() {
    return Number(process.env.MOTION_FPS) || 2;
}

export function hashSecret(secret: string) {
    return crypto.createHash('sha256').update(secret).digest('hex');
}

export function getLive(deviceId: string) {
    return live.get(deviceId);
}

/* ----------------------------------------------------------------------- */

// what the app shows of a kibbl. air: the live state, the settings it reported, the schedule
function airSummary(doc: DeviceDoc, dev: LiveDevice | undefined): AirDevice | undefined {
    if (!doc.caps?.includes('air')) return undefined;
    const info = dev?.info ?? {};
    return {
        state: dev ? (dev.telemetry?.air ?? parseAirState(info)) : undefined,
        settings: doc.air,
        fan: doc.fanSettings,
        lamp: doc.lamp,
        sensorError: typeof info.sensorError === 'string' ? info.sensorError : undefined,
        schedule: nightSchedule(doc),
    };
}

export function summarize(doc: DeviceDoc): DeviceSummary {
    const dev = live.get(doc._id);
    const info = dev?.info ?? {};
    const str = (key: string) => (typeof info[key] === 'string' ? (info[key] as string) : undefined);
    return {
        _id: doc._id,
        name: doc.name,
        status: doc.status,
        online: !!dev,
        model: doc.model,
        board: doc.board,
        sensor: doc.sensor,
        fw: doc.fw,
        ip: str('ip'),
        ssid: str('ssid'),
        hostname: str('hostname'),
        caps: doc.caps ?? [],
        camera: doc.camera,
        cameraError: str('cameraError'),
        wifiChangeFailed: str('wifiChangeFailed'),
        light: typeof info.light === 'number' ? info.light : undefined,
        motion: { ...db.motionDefaults, ...(doc.motion ?? {}) } as MotionSettings,
        air: airSummary(doc, dev),
        telemetry: dev?.telemetry,
        viewers: viewers.get(doc._id) ?? 0,
        lastSeen: dev ? Date.now() : doc.lastSeen,
        createdAt: doc.createdAt,
    };
}

export async function getSummaries(filter: Record<string, unknown> = {}) {
    const docs = await Device.find(filter).sort({ createdAt: 1 }).lean();
    return docs.map(summarize);
}

/* Called without waiting from connects, disconnects and viewers: a database that is
 * away for a moment must not end the process, the next update brings the app up to date. */
export async function publishDevice(deviceId: string) {
    try {
        const doc = await Device.findById(deviceId).lean();
        if (doc) {
            hub.emit('deviceUpdate', summarize(doc));
        }
    } catch (err) {
        log.warn('device update not sent to the app', { device: deviceId }, err);
    }
}

/* ----------------------------------------------------------------------- */

/* Frames cost the device's uplink and the home wifi, so it sends only what is needed:
 * the live rate while someone watches or waits for a snapshot, a slow rate for motion
 * detection, nothing otherwise. Called whenever one of these inputs changes. */
export async function updateDemand(deviceId: string) {
    const dev = live.get(deviceId);
    if (!dev) {
        return;
    }
    let doc: DeviceDoc | null;
    try {
        doc = await Device.findById(deviceId).lean();
    } catch (err) {
        log.warn('stream rate not updated', { device: deviceId }, err);
        return; // the next change asks again
    }
    if (!doc?.caps.includes('camera')) {
        return; // only a camera sends frames
    }
    let fps = 0;
    if (doc?.status === 'approved' && doc.caps.includes('camera')) {
        if ((viewers.get(deviceId) ?? 0) > 0 || (snapshotWaiters.get(deviceId) ?? 0) > 0) {
            fps = viewFps();
        } else if (doc.motion?.enabled) {
            fps = motionFps();
        }
    }
    if (fps !== dev.requestedFps) {
        dev.requestedFps = fps;
        const resp = await sendCommand(deviceId, { cmd: 'stream', fps });
        if (!resp.ok) {
            log.warn('stream rate not taken', { device: deviceId, fps, error: resp.error });
            dev.requestedFps = -1; // asked again on the next change
        }
    }
}

function change(map: Map<string, number>, deviceId: string, delta: number) {
    const count = Math.max(0, (map.get(deviceId) ?? 0) + delta);
    if (count === 0) {
        map.delete(deviceId);
    } else {
        map.set(deviceId, count);
    }
}

export function changeViewers(deviceId: string, delta: number) {
    change(viewers, deviceId, delta);
    updateDemand(deviceId);
    publishDevice(deviceId);
}

export function changeSnapshotWaiters(deviceId: string, delta: number) {
    change(snapshotWaiters, deviceId, delta);
    updateDemand(deviceId);
}

/* ----------------------------------------------------------------------- */

export function registerConnection(deviceId: string, ws: WebSocket) {
    const old = live.get(deviceId);
    if (old) {
        // a reconnect before the old socket timed out: the new one wins
        old.ws.terminate();
        dropConnection(deviceId, old.ws);
    }
    live.set(deviceId, { ws, info: {}, requestedFps: -1, pending: new Map() });
}

export function dropConnection(deviceId: string, ws: WebSocket) {
    const dev = live.get(deviceId);
    if (!dev || dev.ws !== ws) {
        return; // already replaced by a newer connection
    }
    for (const { resolve, timer } of dev.pending.values()) {
        clearTimeout(timer);
        resolve({ ok: false, error: 'device disconnected' });
    }
    live.delete(deviceId);
    Device.updateOne({ _id: deviceId }, { lastSeen: Date.now() }).catch(() => undefined);
    publishDevice(deviceId);
}

export async function handleHello(deviceId: string, msg: Record<string, unknown>) {
    const dev = live.get(deviceId);
    if (!dev) {
        return;
    }
    dev.info = msg;

    const str = (key: string) => (typeof msg[key] === 'string' ? (msg[key] as string).slice(0, 64) : undefined);
    const caps = Array.isArray(msg.caps) ? msg.caps.filter((c): c is string => typeof c === 'string' && c.length <= 32).slice(0, 16) : [];
    await Device.updateOne(
        { _id: deviceId },
        {
            model: str('model'),
            board: str('board'),
            sensor: str('sensor'),
            fw: str('fw'),
            caps,
            camera: typeof msg.camera === 'object' ? (msg.camera as CameraSettings) : undefined,
            // a kibbl. air: the settings it has stored
            air: typeof msg.air === 'object' ? (msg.air as AirSettings) : undefined,
            fanSettings: typeof msg.fanSettings === 'object' ? (msg.fanSettings as FanSettings) : undefined,
            lamp: typeof msg.lamp === 'object' ? (msg.lamp as LampSettings) : undefined,
            claimHash: typeof msg.claimHash === 'string' && /^[0-9a-f]{64}$/.test(msg.claimHash) ? msg.claimHash : undefined,
            lastSeen: Date.now(),
        },
    );
    log.info('hello', { device: deviceId, model: str('model'), fw: str('fw'), ip: str('ip'), ssid: str('ssid') });
    await updateDemand(deviceId);
    await publishDevice(deviceId);
}

export function handleTelemetry(deviceId: string, msg: Record<string, unknown>) {
    const dev = live.get(deviceId);
    if (!dev) {
        return;
    }
    const num = (key: string) => (typeof msg[key] === 'number' ? (msg[key] as number) : 0);
    dev.telemetry = {
        uptime: num('uptime'),
        rssi: typeof msg.rssi === 'number' ? msg.rssi : undefined,
        heap: num('heap'),
        psram: num('psram'),
        cameraFps: num('cameraFps'),
        fps: num('fps'),
        frameBytes: num('frameBytes'),
        air: parseAirState(msg),
        time: Date.now(),
    };
    hub.emit('telemetry', deviceId, dev.telemetry);

    // while it streams, once a minute: what a slow live view is down to (camera, link or size)
    const t = dev.telemetry;
    if (t.fps > 0 && Date.now() - (streamLogged.get(deviceId) ?? 0) >= STREAM_LOG_MS) {
        streamLogged.set(deviceId, Date.now());
        log.info('streaming', { device: deviceId, fps: t.fps, cameraFps: t.cameraFps, frameBytes: t.frameBytes, rssi: t.rssi, asked: viewFps() });
    }
}

const STREAM_LOG_MS = 60_000;
const streamLogged = new Map<string, number>();

export function handleResponse(deviceId: string, msg: Record<string, unknown>) {
    const dev = live.get(deviceId);
    if (!dev || typeof msg.id !== 'number') {
        return;
    }
    const waiting = dev.pending.get(msg.id);
    if (!waiting) {
        return;
    }
    dev.pending.delete(msg.id);
    clearTimeout(waiting.timer);
    waiting.resolve(msg as DeviceResponse);
}

/* ----------------------------------------------------------------------- */

export function sendCommand(deviceId: string, command: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS) {
    return new Promise<DeviceResponse>((resolve) => {
        const dev = live.get(deviceId);
        if (!dev || dev.ws.readyState !== WebSocket.OPEN) {
            resolve({ ok: false, error: 'device offline' });
            return;
        }
        const id = nextCommandID++;
        const timer = setTimeout(() => {
            dev.pending.delete(id);
            resolve({ ok: false, error: 'device did not answer' });
        }, timeoutMs);
        dev.pending.set(id, { resolve, timer });
        dev.ws.send(JSON.stringify({ ...command, id }));
    });
}

/* The app may send a device only the commands its capabilities allow, with the
 * fields of that command; the device checks the values once more. */
export function commandAllowed(doc: DeviceDoc, cmd: string) {
    if (commonCommands.includes(cmd)) {
        return true;
    }
    return doc.caps.some((cap) => capabilityCommands[cap]?.includes(cmd));
}

export async function applyCommandResult(deviceId: string, cmd: string, resp: DeviceResponse) {
    if (!resp.ok) {
        return;
    }
    const dev = live.get(deviceId);
    if (cmd === 'camera' && typeof resp.camera === 'object') {
        await Device.updateOne({ _id: deviceId }, { camera: resp.camera as CameraSettings });
        if (dev) dev.info.camera = resp.camera;
    } else if (cmd === 'light' && typeof resp.light === 'number' && dev) {
        dev.info.light = resp.light;
    } else if ((cmd === 'air_config' || cmd === 'fan' || cmd === 'lamp') && typeof resp.air === 'object') {
        // the device answers with all its settings
        await Device.updateOne(
            { _id: deviceId },
            { air: resp.air as AirSettings, fanSettings: resp.fanSettings as FanSettings, lamp: resp.lamp as LampSettings },
        );
    } else if (cmd === 'night' && typeof resp.night === 'boolean' && dev) {
        // shown at once, not only with the next telemetry
        dev.info.night = resp.night;
        if (dev.telemetry?.air) dev.telemetry.air.night = resp.night;
    }
    await publishDevice(deviceId);
}

export function closeConnection(deviceId: string) {
    const dev = live.get(deviceId);
    if (dev) {
        dev.ws.close(4001, 'removed');
        dropConnection(deviceId, dev.ws);
    }
}
