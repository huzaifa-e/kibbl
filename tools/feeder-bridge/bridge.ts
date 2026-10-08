/*
 * The kibbl. feeder while its controller is an Arduino Nano on USB (firmware/feeder-motor):
 * this connects the Nano to the server as a device, as its own Wi-Fi would.
 *
 *   cd tools/feeder-bridge && npm install
 *   npx tsx bridge.ts [ws(s)://server/device/socket] [/dev/cu.usbserial-…]
 *
 * The server url defaults to KIBBL_DEVICE_URL, else wss://kibbl.tail529b44.ts.net/device/socket.
 * Without a port it takes the only /dev/cu.usbserial-* there is; with several it asks for
 * one, because opening a port resets the board on it (a kibbl. cam too). The feeder is
 * online while the Nano answers: unplugged, the bridge disconnects and waits for it.
 * The id and secret are kept in .feeder-bridge.json; a new one shows up for the admin to approve.
 * Its own package (serialport is native): kept out of the server's image.
 */
import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { ReadlineParser, SerialPort } from 'serialport';
import { WebSocket } from 'ws';

const url = process.argv[2] ?? process.env.KIBBL_DEVICE_URL ?? 'wss://kibbl.tail529b44.ts.net/device/socket';
const portArg = process.argv[3];
const identityFile = '.feeder-bridge.json';
const BAUD = 115200;
const MIN_MM = 2.5; // at or below: close, the iris stops short of its closed stop
const ACCEPT_MS = 300; // the Nano refuses at once (busy, out of range); silence means it started

const identity: { id: string; secret: string } = existsSync(identityFile)
    ? JSON.parse(readFileSync(identityFile, 'utf-8'))
    : { id: crypto.randomBytes(6).toString('hex').toUpperCase(), secret: crypto.randomBytes(16).toString('hex') };
writeFileSync(identityFile, JSON.stringify(identity));

type Json = Record<string, unknown>;
interface Feeder {
    opening: number;
    busy: boolean;
    job?: string;
    position?: number;
    speed?: number;
    accel?: number;
    closedPos?: number;
}

let feeder: Feeder = { opening: 0, busy: false };
let nanoInfo: Json = {};
const start = Date.now();

/* ------------------------------ the Nano ------------------------------ */

let port: SerialPort | undefined;
let nextNanoID = 1;
const waiting = new Map<number, (msg: Json) => void>();
let onNanoLine: ((msg: Json) => void) | undefined;

function findPort() {
    if (portArg) return existsSync(portArg) ? portArg : undefined;
    const ports = readdirSync('/dev').filter((p) => p.startsWith('cu.usbserial-'));
    if (ports.length > 1) {
        console.log(`several serial ports (${ports.join(', ')}): name the Nano's as the second argument`);
        process.exit(1);
    }
    return ports.length ? `/dev/${ports[0]}` : undefined;
}

function nanoSend(cmd: Json, timeoutMs = 60000) {
    return new Promise<Json>((resolve) => {
        if (!port) {
            resolve({ ok: false, error: 'feeder controller not connected' });
            return;
        }
        const id = nextNanoID++;
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve({ ok: false, error: 'feeder controller did not answer' });
        }, timeoutMs);
        waiting.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        port.write(JSON.stringify({ ...cmd, id }) + '\n');
    });
}

function stateFrom(msg: Json): Feeder | undefined {
    if (typeof msg.opening !== 'number') return undefined;
    const config = (typeof msg.feeder === 'object' && msg.feeder !== null ? msg.feeder : {}) as Json;
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    return {
        opening: msg.opening,
        busy: msg.busy === true,
        job: typeof msg.job === 'string' ? msg.job : undefined,
        position: num(msg.position),
        speed: num(config.speed),
        accel: num(config.accel),
        closedPos: num(config.closedPos),
    };
}

function openNano(path: string) {
    return new Promise<boolean>((resolve) => {
        // opening the port may reset the Nano (DTR): its bootloader waits about 2 s
        const p = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
        p.open((err) => {
            if (err) {
                console.log(`cannot open ${path}: ${err.message}`);
                resolve(false);
            }
        });
        port = p;
        p.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (raw: string) => {
            const line = raw.trim();
            if (!line.startsWith('{')) return;
            try {
                const msg = JSON.parse(line) as Json;
                if (msg.type === 'response' && typeof msg.id === 'number' && waiting.has(msg.id)) {
                    const done = waiting.get(msg.id)!;
                    waiting.delete(msg.id);
                    done(msg);
                }
                onNanoLine?.(msg);
            } catch {
                // a line cut by the reset at the start
            }
        });
        // on macOS (Node 26, serialport 12) bytes from the Nano wait in the driver until something
        // else happens on the port: asking for its line state every 50 ms brings them in
        const wake = setInterval(() => p.isOpen && p.get(() => undefined), 50);
        p.on('close', () => {
            clearInterval(wake);
            closeNano('unplugged');
        });
        p.on('error', (e) => console.log(`serial: ${e.message}`));

        // a reset on opening (DTR) is not certain: after the bootloader's 2 s it is asked
        onNanoLine = undefined;
        setTimeout(async () => {
            if (port !== p) return;
            const info = await nanoSend({ cmd: 'info' }, 3000);
            if (port !== p) return;
            if (info.model !== 'kibbl-feeder') {
                console.log(info.ok === false ? `no kibbl. feeder on ${path}` : `${path} is a ${String(info.model)}, not a kibbl. feeder`);
                closeNano('no feeder');
                resolve(false);
                return;
            }
            nanoInfo = info;
            feeder = stateFrom(info) ?? feeder;
            onNanoLine = watchNano;
            console.log(`kibbl. feeder on ${path}, ${feeder.opening} mm open`);
            resolve(true);
        }, 2500);
    });
}

// after the start: every answer of the Nano tells where the iris is
function watchNano(msg: Json) {
    const state = msg.type === 'response' ? stateFrom(msg) : undefined;
    if (state) {
        feeder = state;
        sendState();
    }
    if (msg.type === 'event' && msg.event === 'fed') console.log(`fed ${String(msg.portions)} portion(s)`);
}

function closeNano(why: string) {
    if (!port) return;
    console.log(`feeder controller ${why}`);
    const p = port;
    port = undefined;
    p.removeAllListeners('close');
    if (p.isOpen) p.close(() => undefined);
    for (const done of waiting.values()) done({ ok: false, error: 'feeder controller not connected' });
    waiting.clear();
    socket?.close();
}

/* ------------------------------ the server ------------------------------ */

let socket: WebSocket | undefined;

function sendState() {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'telemetry', uptime: Math.round((Date.now() - start) / 1000), heap: 0, psram: 0, cameraFps: 0, fps: 0, frameBytes: 0, feeder }));
    }
}

// a server command as the Nano's; the answer once the Nano has started or refused it
async function run(msg: Json): Promise<Json> {
    let cmd: Json;
    if (msg.cmd === 'feed') {
        cmd = { cmd: 'feed', portions: msg.portions, opening: msg.opening, openMs: msg.openMs };
    } else if (msg.cmd === 'iris') {
        const mm = Number(msg.opening);
        cmd = mm <= MIN_MM ? { cmd: 'close' } : { cmd: 'open', mm };
    } else if (msg.cmd === 'feeder_config') {
        cmd = { cmd: 'feeder_config', speed: msg.speed, accel: msg.accel };
    } else if (msg.cmd === 'feeder_move') {
        cmd = { cmd: 'move', steps: msg.steps };
    } else if (msg.cmd === 'feeder_home') {
        cmd = { cmd: 'home' };
    } else if (msg.cmd === 'feeder_run') {
        cmd = { cmd: 'run', dir: msg.direction };
    } else if (msg.cmd === 'feeder_stop') {
        cmd = { cmd: 'stop' };
    } else if (msg.cmd === 'feeder_release') {
        cmd = { cmd: 'release', ms: msg.ms };
    } else if (msg.cmd === 'info') {
        return { ok: true, ...hello() };
    } else if (msg.cmd === 'reboot') {
        setTimeout(() => closeNano('restarting'), 500);
        return { ok: true };
    } else {
        return { ok: false, error: 'not on the feeder' };
    }
    const job = String(cmd.cmd);
    const done = nanoSend(cmd);
    const first = await Promise.race([done, new Promise<undefined>((r) => setTimeout(r, ACCEPT_MS))]);
    if (first) {
        if (first.ok === false) return { ok: false, error: String(first.error ?? 'refused') };
        return { ok: true, feeder: stateFrom(first) ?? feeder };
    }
    // moving: the app hears where the iris is when it is done
    feeder = { ...feeder, busy: true, job };
    sendState();
    return { ok: true, feeder };
}

function hello() {
    return {
        type: 'hello',
        fw: 'KIBBL-FEEDER-BRIDGE',
        deviceId: identity.id,
        model: 'kibbl-feeder',
        board: 'arduino-nano',
        hostname: os.hostname(),
        caps: ['feeder'],
        feeder,
        feederConfig: nanoInfo.feeder,
    };
}

function connect() {
    if (!port) return;
    const ws = new WebSocket(url, { headers: { 'X-Device-Id': identity.id, Authorization: `Bearer ${identity.secret}`, 'User-Agent': 'KibblHW' } });
    socket = ws;
    let telemetry: NodeJS.Timeout | undefined;
    ws.on('open', () => {
        console.log(`connected to ${url} as ${identity.id}`);
        ws.send(JSON.stringify(hello()));
        telemetry = setInterval(sendState, 10000);
    });
    ws.on('message', async (data) => {
        let msg: Json;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (typeof msg.id !== 'number') return;
        console.log('command', msg);
        const answer = await run(msg);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'response', id: msg.id, ...answer }));
    });
    ws.on('unexpected-response', (_req, res) => console.log(`refused by the server: ${res.statusCode}`));
    ws.on('error', (err) => console.log(err.message));
    ws.on('close', () => {
        clearInterval(telemetry);
        if (socket === ws) socket = undefined;
        if (port) {
            console.log('disconnected, again in 3 s');
            setTimeout(connect, 3000);
        }
    });
}

async function main() {
    for (;;) {
        if (!port) {
            const path = findPort();
            if (path && (await openNano(path))) connect();
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
}

void main();
