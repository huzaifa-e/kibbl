import {
    FEEDER_ACCEL,
    FEEDER_MAX_MM,
    FEEDER_MIN_MM,
    FEEDER_MOVE_MAX,
    FEEDER_SPEED,
    RGB_FADE_MAX_MS,
    fanModes,
    framesizes,
    lampColors,
    lampModes,
    rgbOrders,
    ZOOM_MAX,
    type CameraView,
    type MotionSettings,
} from '../../../shared/protocol';
import { setNightOverride } from './air';
import { Device } from './db';
import { applyCommandResult, commandAllowed, publishDevice, sendCommand, updateDemand, type DeviceResponse } from './devices';
import { setFrameTransform } from './frames';
import { logger } from './logger';
import { invalidateMotionSettings } from './motion';

/* What a person may change on a device, the same whether the app or an assistant (the MCP
 * endpoint) asks: the command checked field by field, sent, its result kept. */

const log = logger('control');

const isString = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/* What the app may send per command: the device range-checks the values again,
 * this keeps anything else from reaching it. */
export function cleanCommand(command: Record<string, unknown>): Record<string, unknown> | undefined {
    const cmd = command?.cmd;
    if (!isString(cmd, 32)) {
        return undefined;
    }
    const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
    const mm = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
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
        case 'feed': {
            // a feeding level: the opening and the time of this feed, the device's own otherwise
            if (!int(command.portions, 1, 10)) return undefined;
            const out: Record<string, unknown> = { cmd, portions: command.portions };
            if (command.opening !== undefined) {
                if (!mm(command.opening, 4, FEEDER_MAX_MM)) return undefined;
                out.opening = command.opening;
            }
            if (command.openMs !== undefined) {
                if (!int(command.openMs, 100, 20000)) return undefined;
                out.openMs = command.openMs;
            }
            return out;
        }
        // tuning a feeder: its speed and acceleration, steps by hand, the zero
        case 'feeder_config': {
            const out: Record<string, unknown> = { cmd };
            if (command.speed !== undefined) {
                if (!int(command.speed, FEEDER_SPEED.min, FEEDER_SPEED.max)) return undefined;
                out.speed = command.speed;
            }
            if (command.accel !== undefined) {
                if (!int(command.accel, FEEDER_ACCEL.min, FEEDER_ACCEL.max)) return undefined;
                out.accel = command.accel;
            }
            // the closed limit in steps from the open one (0), set by hand
            if (command.closedPos !== undefined) {
                if (!int(command.closedPos, -FEEDER_MOVE_MAX, FEEDER_MOVE_MAX) || command.closedPos === 0) return undefined;
                out.closedPos = command.closedPos;
            }
            return Object.keys(out).length > 1 ? out : undefined;
        }
        case 'feeder_move':
            return int(command.steps, -FEEDER_MOVE_MAX, FEEDER_MOVE_MAX) && command.steps !== 0 ? { cmd, steps: command.steps } : undefined;
        case 'feeder_home':
            return { cmd };
        // teaching the limits under load: turning until stopped, the stop is the limit
        case 'feeder_run':
            return command.direction === 'open' || command.direction === 'close' ? { cmd, direction: command.direction } : undefined;
        case 'feeder_stop':
        case 'feeder_zero': // where the iris stands now is open (0)
            return { cmd };
        // the motor off for a while: the iris turns by hand
        case 'feeder_release':
            return int(command.ms ?? 10000, 100, 30000) ? { cmd, ms: command.ms ?? 10000 } : undefined;
        // the iris of a feeder to an opening, the closed one included
        case 'iris':
            return mm(command.opening, FEEDER_MIN_MM, FEEDER_MAX_MM) ? { cmd, opening: Math.round((command.opening as number) * 10) / 10 } : undefined;
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
            const ranges: Record<string, [number, number]> = {
                level: [1, 100],
                onSeconds: [1, 3600],
                offSeconds: [1, 3600],
                quietLevel: [10, 60],
                freqHz: [5, 30000],
            };
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
        // kibbl. light: only the keys present, at least one
        case 'rgb': {
            const out: Record<string, unknown> = { cmd };
            if (command.on !== undefined) {
                if (typeof command.on !== 'boolean') return undefined;
                out.on = command.on;
            }
            if (command.color !== undefined) {
                const c = command.color;
                if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => int(v, 0, 255))) return undefined;
                out.color = [...c];
            }
            if (command.brightness !== undefined) {
                if (!int(command.brightness, 1, 100)) return undefined;
                out.brightness = command.brightness;
            }
            if (command.fadeMs !== undefined) {
                if (!int(command.fadeMs, 0, RGB_FADE_MAX_MS)) return undefined;
                out.fadeMs = command.fadeMs;
            }
            if (command.order !== undefined) {
                if (!rgbOrders.includes(command.order as never)) return undefined;
                out.order = command.order;
            }
            if (command.vivid !== undefined) {
                if (typeof command.vivid !== 'boolean') return undefined;
                out.vivid = command.vivid;
            }
            return Object.keys(out).length > 1 ? out : undefined;
        }
        case 'calibrate':
            return int(command.ppm ?? 420, 400, 2000) ? { cmd, ppm: command.ppm ?? 420 } : undefined;
        default:
            return undefined;
    }
}

/* One command to a device of the person: checked, allowed by the device's capabilities, sent,
 * its result stored. via names who asked in the log ("app" or the assistant). */
// a zoom from the app: 1 to ZOOM_MAX, its middle inside the picture
function cleanView(v: unknown): CameraView | undefined {
    if (typeof v !== 'object' || v === null) return undefined;
    const { zoom, x, y } = v as Record<string, unknown>;
    const num = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
    if (!num(zoom, 1, ZOOM_MAX) || !num(x, 0, 1) || !num(y, 0, 1)) return undefined;
    const round = (n: number) => Math.round(n * 100) / 100;
    return { zoom: round(zoom as number), x: round(x as number), y: round(y as number) };
}

export async function runDeviceCommand(doc: DeviceDoc, command: Record<string, unknown>, who: string, via = 'app'): Promise<DeviceResponse> {
    const clean = cleanCommand(command);
    if (doc.status !== 'approved' || !clean || !commandAllowed(doc, clean.cmd as string)) {
        return { ok: false, error: 'command not allowed for this device' };
    }
    // the quarter turn and the zoom of a camera are the server's: stored and applied to its frames, not sent
    if (clean.cmd === 'camera') {
        const turn90 = typeof command.turn90 === 'boolean' ? command.turn90 : !!doc.turn90;
        const view = command.view === undefined ? doc.view : cleanView(command.view);
        if (command.view !== undefined && !view) return { ok: false, error: 'invalid view' };
        if (turn90 !== !!doc.turn90 || view !== doc.view) {
            await Device.updateOne({ _id: doc._id }, { turn90, view });
            setFrameTransform(doc._id, { turn90, view });
            await publishDevice(doc._id);
        }
        // nothing for the camera itself
        if (Object.keys(clean).length === 1 && (command.turn90 !== undefined || command.view !== undefined)) return { ok: true };
    }
    // a scan holds the radio for a few seconds, longer than other commands
    const resp = await sendCommand(doc._id, clean, clean.cmd === 'wifi_scan' ? 15000 : undefined);
    await applyCommandResult(doc._id, clean.cmd as string, resp);
    // switched by hand: the night schedule leaves it until it changes next
    if (clean.cmd === 'night' && resp.ok) setNightOverride(doc._id, clean.on as boolean);
    log.info('command', { device: doc._id, cmd: String(clean.cmd), result: resp.ok ? 'ok' : resp.error, user: who, via });
    return resp;
}

// the motion detection of a camera: the keys present, each checked
export async function applyMotionSettings(doc: DeviceDoc, settings: Partial<MotionSettings> | undefined, who: string, via = 'app') {
    const motion = { ...doc.motion };
    const hour = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23;
    if (typeof settings?.enabled === 'boolean') motion.enabled = settings.enabled;
    if (settings?.sensitivity && ['low', 'medium', 'high'].includes(settings.sensitivity)) motion.sensitivity = settings.sensitivity;
    if (hour(settings?.quietFrom)) motion.quietFrom = settings!.quietFrom as number;
    if (hour(settings?.quietTo)) motion.quietTo = settings!.quietTo as number;
    if (typeof settings?.blink === 'boolean') motion.blink = settings.blink;
    if (typeof settings?.keepPictures === 'boolean') motion.keepPictures = settings.keepPictures;
    if (typeof settings?.notify === 'boolean') motion.notify = settings.notify;
    if (typeof settings?.catOnly === 'boolean') motion.catOnly = settings.catOnly;
    await Device.updateOne({ _id: doc._id }, { motion });
    log.info('motion settings changed', {
        device: doc._id,
        enabled: motion.enabled,
        sensitivity: motion.sensitivity,
        quiet: motion.quietFrom === motion.quietTo ? 'off' : `${motion.quietFrom}-${motion.quietTo}h`,
        pictures: motion.keepPictures ? 'kept' : 'none',
        email: motion.notify ? 'on' : 'off',
        catOnly: motion.catOnly ? 'yes' : 'no',
        user: who,
        via,
    });
    invalidateMotionSettings(doc._id);
    await updateDemand(doc._id);
    await publishDevice(doc._id);
    return motion;
}
