import { logger } from '../core/logger';
import { dayKeys } from './estimate';

/*
 * The mean outside temperature of past days at the home, from Open-Meteo (free, no key): its
 * archive (ERA5, complete a few days late) and the past days of its forecast for the latest
 * ones. Kept here per place; the archive's days never change, the recent ones are fetched
 * again after an hour.
 */

const log = logger('heat');

const ARCHIVE_LAG_DAYS = 6;
const RECENT_DAYS = 31;
const RECENT_MS = 3600_000;
const RETRY_MS = 6 * 3600_000; // archive days that came without a value are asked again after this
const DAY_MS = 24 * 3600_000;

interface Place {
    temps: Map<string, number>;
    recentAt: number;
    archiveTriedAt: number;
}

const places = new Map<string, Place>();

const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

async function daily(url: string): Promise<Map<string, number>> {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`);
    const body = (await res.json()) as { daily?: { time?: string[]; temperature_2m_mean?: (number | null)[] } };
    const out = new Map<string, number>();
    body.daily?.time?.forEach((d, i) => {
        const t = body.daily?.temperature_2m_mean?.[i];
        if (typeof t === 'number') out.set(d, t);
    });
    return out;
}

// °C per day from..to (YYYY-MM-DD, the home's days); days it could not get are missing
export async function outsideMeans(latitude: number, longitude: number, from: string, to: string, today: string) {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    const place = places.get(key) ?? { temps: new Map<string, number>(), recentAt: 0, archiveTriedAt: 0 };
    places.set(key, place);
    const at = `latitude=${latitude}&longitude=${longitude}&daily=temperature_2m_mean&timezone=auto`;

    const archiveEnd = [to, shift(today, -ARCHIVE_LAG_DAYS)].sort()[0];
    const missing = from <= archiveEnd ? dayKeys(from, archiveEnd).filter((d) => !place.temps.has(d)) : [];
    if (missing.length && Date.now() - place.archiveTriedAt > RETRY_MS) {
        place.archiveTriedAt = Date.now();
        try {
            const got = await daily(`https://archive-api.open-meteo.com/v1/archive?${at}&start_date=${missing[0]}&end_date=${missing[missing.length - 1]}`);
            for (const [d, t] of got) place.temps.set(d, t);
        } catch (err) {
            log.warn('past weather not read', undefined, err);
        }
    }
    if (to >= shift(today, -RECENT_DAYS) && Date.now() - place.recentAt > RECENT_MS) {
        place.recentAt = Date.now();
        try {
            const got = await daily(`https://api.open-meteo.com/v1/forecast?${at}&past_days=${RECENT_DAYS}&forecast_days=1`);
            // the archive's value stays where there is one
            for (const [d, t] of got) if (!place.temps.has(d) || d > archiveEnd) place.temps.set(d, t);
        } catch (err) {
            log.warn('recent weather not read', undefined, err);
        }
    }

    const out = new Map<string, number>();
    for (const d of dayKeys(from, to)) {
        const t = place.temps.get(d);
        if (t !== undefined) out.set(d, Math.round(t * 10) / 10);
    }
    return out;
}
