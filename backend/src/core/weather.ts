import type { HomeLocation, Weather } from '../../../shared/climate';
import { User } from './db';
import { logger } from './logger';

/*
 * The weather outside a home, for the climate hints of a kibbl. air (shared/climate.ts):
 * temperature and humidity from OpenWeather (OPENWEATHER_API_KEY) or else Open-Meteo (free,
 * no account) at the location each account
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

// the sky as a tabler icon, from OpenWeather's icon code ("04n") or Open-Meteo's WMO code
function owmIcon(code: string) {
    const night = code.endsWith('n');
    switch (code.slice(0, 2)) {
        case '01':
            return night ? 'moon' : 'sun';
        case '02':
            return night ? 'moon' : 'cloud'; // partly cloudy (the icon font has no cloud-sun)
        case '09':
        case '10':
            return 'cloud-rain';
        case '11':
            return 'cloud-storm';
        case '13':
            return 'cloud-snow';
        case '50':
            return 'mist';
        default:
            return 'cloud';
    }
}

function wmoIcon(code: number, day: boolean) {
    if (code === 0) return day ? 'sun' : 'moon';
    if (code <= 2) return day ? 'cloud' : 'moon';
    if (code === 45 || code === 48) return 'mist';
    if (code >= 95) return 'cloud-storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'cloud-snow';
    if (code >= 51) return 'cloud-rain';
    return 'cloud';
}

/* OpenWeather (OPENWEATHER_API_KEY, the free current weather): its values come from stations
 * near the place, the ones a person sees in other weather apps. Open-Meteo, from weather
 * models, without a key, when there is none. */
async function fetchOpenWeather(lat: number, lon: number, key: string): Promise<Weather> {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&lang=en&appid=${encodeURIComponent(key)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenWeather: HTTP ${res.status}`);
    const body = (await res.json()) as { main?: { temp?: number; humidity?: number }; weather?: { icon?: string; description?: string }[] };
    if (typeof body.main?.temp !== 'number' || typeof body.main.humidity !== 'number') throw new Error('OpenWeather: no current values');
    const sky = body.weather?.[0];
    return {
        temperature: body.main.temp,
        humidity: body.main.humidity,
        at: Date.now(),
        source: 'openweather',
        icon: sky?.icon ? owmIcon(sky.icon) : 'cloud',
        description: sky?.description,
    };
}

async function fetchOpenMeteo(lat: number, lon: number): Promise<Weather> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,is_day`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Open-Meteo: HTTP ${res.status}`);
    const body = (await res.json()) as { current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number; is_day?: number } };
    const c = body.current;
    if (typeof c?.temperature_2m !== 'number' || typeof c.relative_humidity_2m !== 'number') throw new Error('Open-Meteo: no current values');
    return {
        temperature: c.temperature_2m,
        humidity: c.relative_humidity_2m,
        at: Date.now(),
        source: 'open-meteo',
        icon: wmoIcon(c.weather_code ?? 3, c.is_day !== 0),
    };
}

async function fetchWeather(lat: number, lon: number): Promise<Weather | null> {
    const key = process.env.OPENWEATHER_API_KEY?.trim();
    if (key) {
        try {
            return await fetchOpenWeather(lat, lon, key);
        } catch (err) {
            log.warn('OpenWeather failed, Open-Meteo instead', { lat, lon }, err);
        }
    }
    try {
        return await fetchOpenMeteo(lat, lon);
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
    log.info('weather outside from', { source: process.env.OPENWEATHER_API_KEY?.trim() ? 'OpenWeather' : 'Open-Meteo' });
    if (!serverHome()) log.info('no HOME_LATITUDE/HOME_LONGITUDE: accounts without a home location go without the weather outside');
}
