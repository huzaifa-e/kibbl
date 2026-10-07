import type { HomeLocation, Weather } from '../../../shared/climate';
import { User } from './db';
import { logger } from './logger';

/*
 * The weather outside a home, for the climate hints of a kibbl. air (shared/climate.ts):
 * temperature and humidity from Open-Meteo (free, no account) at the location each account
 * chose in its settings; HOME_LATITUDE and HOME_LONGITUDE of the server stand in for an
 * account without one. Fetched when asked for and kept 15 minutes per place.
 */

const log = logger('weather');

const REFRESH_MS = 15 * 60_000;
const STALE_MS = 2 * 3600_000; // an older value is not "outside now", also when the fetch fails
const HOME_CACHE_MS = 5 * 60_000;

const cache = new Map<string, Weather>();
const fetching = new Map<string, Promise<Weather | null>>();
const homes = new Map<string, { home: HomeLocation | null; at: number }>();

function serverHome(): HomeLocation | null {
    const lat = Number(process.env.HOME_LATITUDE);
    const lon = Number(process.env.HOME_LONGITUDE);
    if (!process.env.HOME_LATITUDE || !process.env.HOME_LONGITUDE || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { latitude: lat, longitude: lon, name: 'set on the server' };
}

async function fetchWeather(lat: number, lon: number): Promise<Weather | null> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { current?: { temperature_2m?: number; relative_humidity_2m?: number } };
        const c = body.current;
        if (typeof c?.temperature_2m !== 'number' || typeof c.relative_humidity_2m !== 'number') throw new Error('no current values');
        return { temperature: c.temperature_2m, humidity: c.relative_humidity_2m, at: Date.now() };
    } catch (err) {
        log.warn('outdoor weather not fetched', { lat, lon }, err);
        return null;
    }
}

// the weather at a place now: from the cache while it is fresh, a stale one only while a new one fails
export async function weatherAt(lat: number, lon: number): Promise<Weather | null> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`; // about 1 km: one fetch for neighbours
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < REFRESH_MS) return cached;
    let pending = fetching.get(key);
    if (!pending) {
        pending = fetchWeather(lat, lon).finally(() => fetching.delete(key));
        fetching.set(key, pending);
    }
    const fresh = await pending;
    if (fresh) {
        cache.set(key, fresh);
        return fresh;
    }
    return cached && Date.now() - cached.at < STALE_MS ? cached : null;
}

export async function homeOf(userID: string): Promise<HomeLocation | null> {
    const known = homes.get(userID);
    if (known && Date.now() - known.at < HOME_CACHE_MS) return known.home;
    const user = await User.findById(userID, { home: 1 }).lean();
    const home = user?.home && typeof user.home.latitude === 'number' ? user.home : serverHome();
    homes.set(userID, { home, at: Date.now() });
    return home;
}

export function forgetHome(userID: string) {
    homes.delete(userID);
}

// the weather outside the user's home, null without a location
export async function weatherForUser(userID: string): Promise<Weather | null> {
    const home = await homeOf(userID);
    return home ? weatherAt(home.latitude, home.longitude) : null;
}

export interface Place extends HomeLocation {
    country?: string;
}

// places by name, for the settings (Open-Meteo geocoding)
export async function searchPlaces(query: string): Promise<Place[]> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`geocoding: HTTP ${res.status}`);
    const body = (await res.json()) as { results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] };
    return (body.results ?? []).map((r) => ({
        latitude: r.latitude,
        longitude: r.longitude,
        name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
        country: r.country,
    }));
}

export function initWeather() {
    if (!serverHome()) log.info('no HOME_LATITUDE/HOME_LONGITUDE: accounts without a home location go without the weather outside');
}
