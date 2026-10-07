import type { Weather } from '../../../shared/climate';
import { logger } from './logger';

/*
 * The weather outside the home, for the climate hints of a kibbl. air (shared/climate.ts):
 * temperature and humidity from Open-Meteo (free, no account) for HOME_LATITUDE and
 * HOME_LONGITUDE, every 15 minutes. Without them there is no outdoor value and the hints
 * that need one are left out.
 */

const log = logger('weather');

const REFRESH_MS = 15 * 60_000;
const STALE_MS = 2 * 3600_000; // older than this is not shown as "outside now"

let current: Weather | null = null;

function location() {
    const lat = Number(process.env.HOME_LATITUDE);
    const lon = Number(process.env.HOME_LONGITUDE);
    return Number.isFinite(lat) && Number.isFinite(lon) && process.env.HOME_LATITUDE && process.env.HOME_LONGITUDE ? { lat, lon } : undefined;
}

async function refresh() {
    const loc = location();
    if (!loc) return;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { current?: { time?: string; temperature_2m?: number; relative_humidity_2m?: number } };
        const c = body.current;
        if (typeof c?.temperature_2m !== 'number' || typeof c.relative_humidity_2m !== 'number') throw new Error('no current values');
        current = { temperature: c.temperature_2m, humidity: c.relative_humidity_2m, at: Date.now() };
    } catch (err) {
        log.warn('outdoor weather not fetched', undefined, err);
    }
}

// the weather outside now, null when unknown or too old
export function outdoorWeather(): Weather | null {
    return current && Date.now() - current.at < STALE_MS ? current : null;
}

export function initWeather() {
    if (!location()) {
        log.info('no HOME_LATITUDE/HOME_LONGITUDE: the climate hints go without the weather outside');
        return;
    }
    void refresh();
    setInterval(() => void refresh(), REFRESH_MS);
}
