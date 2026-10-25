import { printStateLabels, type PrintState, type PrinterState, type PrinterTray } from '../../../shared/protocol';
import { Device } from './db';
import { logger } from './logger';
import { notifyOwner } from './notify';

/* A Bambu Lab printer as a kibbl. cam on its network reports it (docs/printer.md): its state
 * checked field by field, and an alert to the owner when a print ends or stops. */

const log = logger('printer');

const states = Object.keys(printStateLabels) as PrintState[];

export function parsePrinterState(v: unknown): PrinterState | undefined {
    if (typeof v !== 'object' || v === null) return undefined;
    const p = v as Record<string, unknown>;
    if (typeof p.configured !== 'boolean') return undefined;
    if (!p.configured) return { configured: false };
    const int = (x: unknown, min: number, max: number) => (typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : undefined);
    const temp = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > -50 && x < 500 ? Math.round(x * 10) / 10 : undefined);
    const text = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : undefined);
    return {
        configured: true,
        host: text(p.host, 63),
        serial: text(p.serial, 23),
        connected: p.connected === true,
        error: text(p.error, 64),
        state: states.includes(p.state as PrintState) ? (p.state as PrintState) : p.state === undefined ? undefined : 'unknown',
        percent: int(p.percent, 0, 100),
        remainingMin: int(p.remainingMin, 0, 100000),
        layer: int(p.layer, 0, 100000),
        layers: int(p.layers, 0, 100000),
        job: text(p.job, 128),
        nozzle: temp(p.nozzle),
        nozzleTarget: temp(p.nozzleTarget),
        bed: temp(p.bed),
        bedTarget: temp(p.bedTarget),
        chamber: temp(p.chamber),
        speed: int(p.speed, 1, 4),
        light: typeof p.light === 'boolean' ? p.light : undefined,
        printError: int(p.printError, 1, 0xffffffff),
        hms: Array.isArray(p.hms) ? p.hms.filter((h): h is string => typeof h === 'string' && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(h)).slice(0, 8) : undefined,
        ams: Array.isArray(p.ams)
            ? p.ams
                  .map(parseTray)
                  .filter((t): t is PrinterTray => !!t)
                  .slice(0, 16)
            : undefined,
        trayNow: int(p.trayNow, 0, 255),
    };
}

function parseTray(v: unknown): PrinterTray | undefined {
    if (typeof v !== 'object' || v === null) return undefined;
    const t = v as Record<string, unknown>;
    if (typeof t.slot !== 'number' || !Number.isInteger(t.slot) || t.slot < 0 || t.slot > 15) return undefined;
    return {
        slot: t.slot,
        type: typeof t.type === 'string' && /^[\w+ -]{1,16}$/.test(t.type) ? t.type : undefined,
        color: typeof t.color === 'string' && /^[0-9A-Fa-f]{6}$/.test(t.color) ? t.color.toUpperCase() : undefined,
        remain: typeof t.remain === 'number' && Number.isInteger(t.remain) && t.remain >= 0 && t.remain <= 100 ? t.remain : undefined,
    };
}

// what redraws the app at once; temperatures and the time left follow with the telemetry
export function printerShown(p: PrinterState | undefined) {
    if (!p) return '';
    return JSON.stringify({ ...p, nozzle: undefined, bed: undefined, chamber: undefined, remainingMin: undefined });
}

/* An ended print, once: the state went from printing (or paused) to finished or failed. A
 * printer seen first in its end state (the camera restarted) says nothing. */
export function printEnded(before: PrinterState | undefined, after: PrinterState): 'finish' | 'failed' | undefined {
    if (!before?.state || !after.state || before.state === after.state) return undefined;
    if (before.state !== 'running' && before.state !== 'pause') return undefined;
    return after.state === 'finish' || after.state === 'failed' ? after.state : undefined;
}

export async function printerChanged(deviceId: string, before: PrinterState | undefined, after: PrinterState) {
    if (before?.state !== after.state && after.state) {
        log.info('print state', { device: deviceId, from: before?.state, to: after.state, job: after.job, layer: after.layer });
    }
    if (before?.connected !== after.connected && before) {
        log.info(after.connected ? 'printer connected' : 'printer disconnected', { device: deviceId, host: after.host, error: after.error });
    }
    const ended = printEnded(before, after);
    if (!ended) return;
    const job = after.job ? `“${after.job}”` : 'The print';
    const name = (await Device.findById(deviceId, { name: 1 }).lean())?.name ?? 'the camera';
    await notifyOwner(deviceId, {
        title: ended === 'finish' ? 'Print finished' : 'Print failed',
        text:
            ended === 'finish'
                ? `${job} is done on the printer at ${name}.`
                : `${job} stopped at layer ${after.layer ?? '?'} of ${after.layers ?? '?'} on the printer at ${name}.${after.hms?.length ? ` The printer reports ${after.hms.join(', ')}.` : ''}`,
        tag: ended === 'finish' ? 'white_check_mark' : 'warning',
        path: `/camera/${deviceId}`,
    });
}
