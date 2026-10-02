import crypto from 'node:crypto';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { Device } from '../core/db';
import { MAX_PENDING_DEVICES, dropConnection, handleHello, handleResponse, handleTelemetry, hashSecret, publishDevice, registerConnection } from '../core/devices';
import { onFrame } from '../core/frames';
import { log } from '../core/logger';
import { endMotion } from '../core/motion';

export const DEVICE_SOCKET_PATH = '/device/socket';
const MAX_FRAME_BYTES = 1024 * 1024; // a UXGA jpeg at the best quality stays well below
const SILENT_TIMEOUT_MS = 35_000; // the device pings every 10 s

type DeviceSocket = WebSocket & { deviceId: string; lastSeen: number; approved: boolean };

let wss: WebSocketServer;

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
    if (doc) {
        if (!sameHash(doc.secretHash, hash)) {
            log('warn', `${deviceId}: refused, the secret does not match (factory reset or a copied id)`);
            return { status: 401, text: 'Unauthorized' };
        }
        return { deviceId, approved: doc.status === 'approved' };
    }

    // nobody can fill the database with devices: a few pending ones at a time
    if ((await Device.countDocuments({ status: 'pending' })) >= MAX_PENDING_DEVICES) {
        log('warn', `${deviceId}: refused, ${MAX_PENDING_DEVICES} devices already wait for approval`);
        return { status: 429, text: 'Too Many Requests' };
    }
    await Device.create({
        _id: deviceId,
        name: `Camera ${deviceId.slice(-4)}`,
        secretHash: hash,
        status: 'pending',
        caps: [],
        createdAt: Date.now(),
    });
    log('info', `${deviceId}: new device, waiting for approval in the app`);
    return { deviceId, approved: false };
}

async function onMessage(ws: DeviceSocket, data: Buffer, isBinary: boolean) {
    ws.lastSeen = Date.now();
    if (isBinary) {
        if (!ws.approved) {
            return; // a pending device shows nothing to anybody
        }
        if (data.length > MAX_FRAME_BYTES) {
            log('warn', `${ws.deviceId}: frame of ${data.length} bytes dropped`);
            return;
        }
        onFrame(ws.deviceId, data);
        return;
    }

    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(data.toString('utf-8'));
    } catch {
        log('warn', `${ws.deviceId}: text message is no json`);
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
        default:
            log('debug', `${ws.deviceId}: unknown message type ${String(msg.type)}`);
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
                log('error', `Device upgrade failed: ${err.message}`);
                reject(socket, 500, 'Internal Server Error');
            });
    });

    wss.on('connection', (ws: DeviceSocket, req: IncomingMessage) => {
        log('info', `${ws.deviceId}: connected from ${req.socket.remoteAddress}`);
        registerConnection(ws.deviceId, ws);
        publishDevice(ws.deviceId);

        ws.on('message', (data, isBinary) => {
            onMessage(ws, data as Buffer, isBinary).catch((err) => log('error', `${ws.deviceId}: ${err.message}`));
        });
        ws.on('ping', () => {
            ws.lastSeen = Date.now();
        });
        ws.on('close', () => {
            log('info', `${ws.deviceId}: disconnected`);
            dropConnection(ws.deviceId, ws);
            endMotion(ws.deviceId).catch(() => undefined);
        });
        ws.on('error', (err) => log('warn', `${ws.deviceId}: ${err.message}`));
    });

    // a device that lost its wifi never closes its socket: it is ended after 35 s of silence
    setInterval(() => {
        const now = Date.now();
        for (const client of wss.clients) {
            const ws = client as DeviceSocket;
            if (now - ws.lastSeen > SILENT_TIMEOUT_MS) {
                log('info', `${ws.deviceId}: silent for ${SILENT_TIMEOUT_MS / 1000} s, closing`);
                ws.terminate();
            }
        }
    }, 5000);
}
