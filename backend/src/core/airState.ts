import type { AirLevel, AirState, NightSchedule } from '../../../shared/protocol';
import db from './db';

/* What a kibbl. air reports, as the device core and core/air.ts both read it. */

const levels: AirLevel[] = ['none', 'green', 'yellow', 'red'];

// the air fields of a hello or telemetry message, undefined when it has none
export function parseAirState(msg: Record<string, unknown>): AirState | undefined {
    if (typeof msg.level !== 'string') return undefined;
    const num = (key: string) => (typeof msg[key] === 'number' && Number.isFinite(msg[key]) ? (msg[key] as number) : undefined);
    return {
        co2: num('co2'),
        temperature: num('temperature'),
        humidity: num('humidity'),
        level: levels.includes(msg.level as AirLevel) ? (msg.level as AirLevel) : 'none',
        fan: num('fan') ?? 0,
        window: msg.window === 'open' || msg.window === 'learning' || msg.window === 'paused' ? msg.window : 'closed',
        night: msg.night === true,
        calibrating: msg.calibrating === true,
        puffs: num('puffs') ?? 0,
        fire: msg.fire === true,
        sensorError: typeof msg.sensorError === 'string' ? msg.sensorError : undefined,
    };
}

export function nightSchedule(doc: DeviceDoc): NightSchedule {
    return { ...db.nightDefaults, ...(doc.night ?? {}) };
}
