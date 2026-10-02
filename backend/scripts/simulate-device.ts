/*
 * A device without hardware, for developing the server and the app:
 *
 *   npx tsx backend/scripts/simulate-device.ts ws://localhost:8790/device/socket [caps]
 *
 * caps defaults to "camera,light,ota". A camera sends generated frames with a box
 * that wanders through the picture every 30 s (motion), "feeder" or "switch" answer
 * their commands. The id and secret are kept in .simulated-device.json, so a restart
 * is the same device.
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { WebSocket } from 'ws';

const url = process.argv[2] ?? 'ws://localhost:8790/device/socket';
const caps = (process.argv[3] ?? 'camera,light,ota').split(',');
const identityFile = '.simulated-device.json';

const identity: { id: string; secret: string } = existsSync(identityFile)
    ? JSON.parse(readFileSync(identityFile, 'utf-8'))
    : { id: crypto.randomBytes(6).toString('hex').toUpperCase(), secret: crypto.randomBytes(16).toString('hex') };
writeFileSync(identityFile, JSON.stringify(identity));

const camera = { framesize: 'VGA', quality: 12, vflip: false, hmirror: false, brightness: 0, contrast: 0, saturation: 0 };
let light = 0;
let ssid = 'home';
let wifiChangeFailed: string | undefined;
let fps = 0;
let sent = 0;
const start = Date.now();

async function frame() {
    const t = (Date.now() - start) / 1000;
    const width = 640;
    const height = 480;
    // 10 s of a box crossing the room, then 20 s of an empty room
    const phase = t % 30;
    const box =
        phase < 10
            ? `<rect x="${40 + phase * 50}" y="${200 + Math.sin(phase * 2) * 40}" width="110" height="140" rx="20" fill="#3b2a1a"/>`
            : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="rgb(${150 + light / 2},${145 + light / 2},${135 + light / 2})"/>
        <rect x="0" y="360" width="${width}" height="120" fill="#6b5a48"/>
        <rect x="420" y="250" width="160" height="110" fill="#4a5568"/>
        ${box}
        <text x="16" y="32" font-family="monospace" font-size="20" fill="#fff">${identity.id} ${new Date().toLocaleTimeString()}</text>
    </svg>`;
    return sharp(Buffer.from(svg))
        .jpeg({ quality: 100 - camera.quality })
        .toBuffer();
}

function connect() {
    const ws = new WebSocket(url, {
        headers: { 'X-Device-Id': identity.id, Authorization: `Bearer ${identity.secret}`, 'User-Agent': 'HomeMonitorHW' },
    });
    let timer: NodeJS.Timeout | undefined;
    let telemetry: NodeJS.Timeout | undefined;

    const schedule = () => {
        clearTimeout(timer);
        if (fps > 0) {
            timer = setTimeout(async () => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(await frame(), { binary: true });
                    sent++;
                }
                schedule();
            }, 1000 / fps);
        }
    };

    ws.on('open', () => {
        console.log(`connected as ${identity.id} with ${caps.join(', ')}`);
        ws.send(
            JSON.stringify({
                type: 'hello',
                fw: 'HM-SIMULATED',
                id: identity.id,
                model: 'simulator',
                board: 'none',
                sensor: caps.includes('camera') ? 'SIM' : undefined,
                hostname: 'simulator',
                ip: '127.0.0.1',
                ssid,
                wifiChangeFailed,
                caps,
                camera: caps.includes('camera') ? camera : undefined,
                light,
            }),
        );
        telemetry = setInterval(() => {
            ws.send(
                JSON.stringify({
                    type: 'telemetry',
                    uptime: Math.round((Date.now() - start) / 1000),
                    rssi: -55 - Math.round(Math.random() * 10),
                    heap: 150000,
                    psram: 3400000,
                    cameraFps: fps,
                    fps: Math.round(sent / 10),
                    frameBytes: 30000,
                }),
            );
            sent = 0;
        }, 10000);
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        const reply = (extra: object = {}) => ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, ...extra }));
        console.log('command', msg);
        switch (msg.cmd) {
            case 'stream':
                fps = msg.fps;
                schedule();
                reply();
                break;
            case 'camera':
                Object.assign(camera, msg);
                delete (camera as Record<string, unknown>).cmd;
                delete (camera as Record<string, unknown>).id;
                reply({ camera });
                break;
            case 'light':
                light = msg.level;
                reply({ light });
                break;
            case 'wifi_scan':
                setTimeout(
                    () =>
                        reply({
                            networks: [
                                { ssid: 'home', rssi: -52, secure: true },
                                { ssid: 'home-guest', rssi: -67, secure: true },
                                { ssid: 'cafe', rssi: -84, secure: false },
                            ],
                        }),
                    2000,
                );
                break;
            case 'wifi':
                // as the firmware: answer, drop the connection, come back on the new network
                // or, with the password "wrong-password", on the old one
                reply({ pending: true, fallbackSeconds: 30 });
                setTimeout(() => {
                    const ok = msg.password !== 'wrong-password';
                    wifiChangeFailed = ok ? undefined : msg.ssid;
                    if (ok) ssid = msg.ssid;
                    console.log(ok ? `switched to ${ssid}` : `could not join ${msg.ssid}, back on ${ssid}`);
                    ws.terminate();
                }, 1000);
                break;
            case 'feed':
                console.log(`feeding ${msg.portions} portion(s)`);
                reply();
                break;
            default:
                reply();
        }
    });

    ws.on('unexpected-response', (_req, res) => console.log(`refused: ${res.statusCode}`));
    ws.on('close', () => {
        clearTimeout(timer);
        clearInterval(telemetry);
        console.log('disconnected, again in 3 s');
        setTimeout(connect, 3000);
    });
    ws.on('error', (err) => console.log(err.message));
}

connect();
