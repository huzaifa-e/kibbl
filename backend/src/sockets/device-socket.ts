import crypto from 'node:crypto';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { handleAirEvent } from '../core/air';
import { Device } from '../core/db';
import {
    MAX_PENDING_DEVICES,
    dropConnection,
    handleHello,
    handleResponse,
    handleTelemetry,
    hashSecret,
    publishDevice,
    registerConnection,
} from '../core/devices';
import { onFrame } from '../core/frames';
import { logger } from '../core/logger';
import { forgetOwner } from '../core/owners';

const log = logger('device');
import { endMotion } from '../core/motion';

export const DEVICE_SOCKET_PATH = '/device/socket';
const MAX_FRAME_BYTES = 1024 * 1024; // a UXGA jpeg at the best quality stays well below
const SILENT_TIMEOUT_MS = 35_000; // the device pings every 10 s

type DeviceSocket = WebSocket & { deviceId: string; lastSeen: number; approved: boolean };

let wss: WebSocketServer;

/* Devices being set up over USB in the app right now. The person doing it holds the
 * device and is logged in: its first connection is approved without a second step and
 * belongs to them, and a device that was reset (new secret) is paired again instead of
 * refused. */
const EXPECT_MS = 15 * 60 * 1000;
const expected = new Map<string, { name: string; ownerID: string; until: number }>();

export function expectDevice(deviceId: string, name: string, ownerID: string) {
    expected.set(deviceId, { name, ownerID, until: Date.now() + EXPECT_MS });
}

function takeExpected(deviceId: string) {
    const e = expected.get(deviceId);
    expected.delete(deviceId);
    return e && e.until > Date.now() ? e : undefined;
}

function reject(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

function sameHash(a: string, b: string) {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/* Pairing is trust on first use: an unknown id is stored with its secret as a
 * pending device, which streams nothing until it is approved in the app. From then
 * on the id is refused with any other secret. Only the hash of the secret is kept. */
async function authenticate(req: IncomingMessage): Promise<{ deviceId: string; approved: boolean } | { status: number; text: string }> {
    const deviceId = String(req.headers['x-device-id'] ?? '').toUpperCase();
    const auth = String(req.headers.authorization ?? '');
    const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

    if (!/^[0-9A-F]{12}$/.test(deviceId) || !/^[0-9a-f]{32}$/.test(secret)) {
        return { status: 400, text: 'Bad Request' };
    }

    const hash = hashSecret(secret);
    const doc = await Device.findById(deviceId).lean();
    // set up over USB: new, reset or already known, it is approved with the name given there
    let setUp = takeExpected(deviceId);
    // the expectation of another account than the owner's changes nothing: owned stays owned
    if (setUp && doc?.ownerID && doc.ownerID !== setUp.ownerID) {
        log.warn('setup by another account than the owner ignored', { device: deviceId });
        setUp = undefined;
    }
    if (setUp) {
        forgetOwner(deviceId);
        await Device.updateOne(
            { _id: deviceId },
            { $set: { secretHash: hash, status: 'approved', name: setUp.name, ownerID: setUp.ownerID }, $setOnInsert: { caps: [], createdAt: Date.now() } },
            { upsert: true },
        );
        log.info('set up over USB, approved', { device: deviceId, name: setUp.name, owner: setUp.ownerID });
        return { deviceId, approved: true };
    }
    if (doc) {
        if (!sameHash(doc.secretHash, hash)) {
            log.warn('refused, secret does not match (factory reset or a copied id)', { device: deviceId });
            return { status: 401, text: 'Unauthorized' };
        }
        return { deviceId, approved: doc.status === 'approved' };
    }

    // nobody can fill the database with devices: a few pending ones at a time
    if ((await Device.countDocuments({ status: 'pending' })) >= MAX_PENDING_DEVICES) {
        log.warn('refused, too many devices wait for approval', { device: deviceId, waiting: MAX_PENDING_DEVICES });
        return { status: 429, text: 'Too Many Requests' };
    }
    await Device.create({
        _id: deviceId,
        name: `Device ${deviceId.slice(-4)}`,
        secretHash: hash,
        status: 'pending',
        caps: [],
        createdAt: Date.now(),
    });
    log.info('new device, waiting for approval in the app', { device: deviceId });
    return { deviceId, approved: false };
}

async function onMessage(ws: DeviceSocket, data: Buffer, isBinary: boolean) {
    ws.lastSeen = Date.now();
    if (isBinary) {
        if (!ws.approved) {
            return; // a pending device shows nothing to anybody
        }
        if (data.length > MAX_FRAME_BYTES) {
            log.warn('frame dropped', { device: ws.deviceId, bytes: data.length });
            return;
        }
        onFrame(ws.deviceId, data);
        return;
    }

    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(data.toString('utf-8'));
    } catch {
        log.warn('text message is no json', { device: ws.deviceId });
        return;
    }
    if (typeof msg !== 'object' || msg === null) {
        return;
    }
    switch (msg.type) {
        case 'hello':
            await handleHello(ws.deviceId, msg);
            break;
        case 'telemetry':
            handleTelemetry(ws.deviceId, msg);
            break;
        case 'response':
            handleResponse(ws.deviceId, msg);
            break;
        case 'event':
            await handleAirEvent(ws.deviceId, ws.approved, msg);
            break;
        default:
            log.debug('unknown message type', { device: ws.deviceId, type: String(msg.type) });
    }
}

export function setDeviceApproved(deviceId: string) {
    for (const client of wss.clients) {
        const ws = client as DeviceSocket;
        if (ws.deviceId === deviceId) {
            ws.approved = true;
        }
    }
}

export function initDeviceSocket(http: Server) {
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

    http.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== DEVICE_SOCKET_PATH) {
            return; // socket.io handles its own path
        }
        authenticate(req)
            .then((result) => {
                if ('status' in result) {
                    reject(socket, result.status, result.text);
                    return;
                }
                wss.handleUpgrade(req, socket, head, (client) => {
                    const ws = client as DeviceSocket;
                    ws.deviceId = result.deviceId;
                    ws.approved = result.approved;
                    ws.lastSeen = Date.now();
                    wss.emit('connection', ws, req);
                });
            })
            .catch((err) => {
                log.error('connection upgrade failed', undefined, err);
                reject(socket, 500, 'Internal Server Error');
            });
    });

    wss.on('connection', (ws: DeviceSocket, req: IncomingMessage) => {
        log.info('connected', { device: ws.deviceId, ip: req.socket.remoteAddress });
        registerConnection(ws.deviceId, ws);
        publishDevice(ws.deviceId);

        ws.on('message', (data, isBinary) => {
            onMessage(ws, data as Buffer, isBinary).catch((err) => log.error('message not handled', { device: ws.deviceId }, err));
        });
        ws.on('ping', () => {
            ws.lastSeen = Date.now();
        });
        ws.on('close', () => {
            log.info('disconnected', { device: ws.deviceId });
            dropConnection(ws.deviceId, ws);
            endMotion(ws.deviceId).catch(() => undefined);
        });
        ws.on('error', (err) => log.warn('connection error', { device: ws.deviceId }, err));
    });

    // a device that lost its wifi never closes its socket: it is ended after 35 s of silence
    setInterval(() => {
        const now = Date.now();
        for (const client of wss.clients) {
            const ws = client as DeviceSocket;
            if (now - ws.lastSeen > SILENT_TIMEOUT_MS) {
                log.info('silent, closing', { device: ws.deviceId, after: `${SILENT_TIMEOUT_MS / 1000}s` });
                ws.terminate();
            }
        }
    }, 5000);
}
