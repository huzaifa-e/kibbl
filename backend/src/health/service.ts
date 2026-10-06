import { HealthLink } from '../core/db';
import { logger } from '../core/logger';
import {
    BLOCK_TYPES,
    CATALOG,
    INTRADAY,
    KNOWN,
    PARSERS,
    blocksFromPoints,
    datasourceMeta,
    dateStr,
    genericSeries,
    intradayFromPoints,
    intradayFromRows,
    intradayRows,
    num,
    parseAzm,
    parseBreathingStages,
    parseExercise,
    parseHrZones,
    parseSedentary,
    parseSleep,
    sedentaryGranularFromRows,
} from './extract';
import { GoogleHealth, HealthError, configured, day, nextDay } from './google';
import { HEART_RATE, addDiscoveredType, backfill, backfillRunning, refreshRecent, storeCompletedHeartRate, storedTypes } from './history';
import { loadHeartRateDay, loadPoints, storageStats } from './store';

/*
 * whoofit's server.py, with the data kept here: every minute one cheap call asks for
 * the tracker's last sync, and only a new sync fetches anything: the latest days of
 * every type, stored. Everything older was fetched once (history.ts). The page reads
 * the stored history, for any range, also while Google does not answer.
 */

const log = logger('health');

const POLL_MS = 60_000;
const DISCOVERY_MS = 30 * 60_000;
const PROFILE_MS = 6 * 3600_000;
const BACKFILL_RETRY_MS = 10 * 60_000;
const INTRADAY_CACHE_MS = 5 * 60_000;
const HR_CACHE_MS = 8000;

export interface Tracker {
    id: string;
    name: string;
    type: string;
    battery: number | null;
    batteryStatus: string | null;
    lastSync: string | null;
}

interface UserState {
    trackers: Tracker[];
    devices?: unknown;
    profile?: Record<string, unknown>;
    profileAt?: number;
    lastCheck?: number;
    lastUpdate?: number;
    lastSyncTime?: string | null;
    checks: number;
    error?: string;
    reconnect: boolean; // only connecting Google again helps
    discoveredAt?: number;
    backfillTriedAt?: number;
    summaries: Map<string, Record<string, unknown>>; // built from the stored data, cleared when it changes
    busy: boolean;
}

const states = new Map<string, UserState>();
const intradayCache = new Map<string, { at: number; data: unknown }>();
const hrCache = new Map<string, { at: number; data: unknown }>();

function state(userID: string) {
    let s = states.get(userID);
    if (!s) {
        s = { trackers: [], checks: 0, reconnect: false, busy: false, summaries: new Map() };
        states.set(userID, s);
    }
    return s;
}

function changed(s: UserState) {
    s.summaries.clear();
    s.lastUpdate = Date.now();
}

/* ----------------------------------------------------------------------- */

// the paired devices without their mac addresses: the app needs name, battery and sync
function trackersFrom(body: unknown): Tracker[] {
    const list = (body as { pairedDevices?: Record<string, unknown>[] })?.pairedDevices ?? [];
    return list.map((d) => ({
        id:
            String(d.name ?? '')
                .split('/')
                .pop() ?? '',
        name: String(d.deviceVersion ?? 'Tracker'),
        type: String(d.deviceType ?? ''),
        battery: num(d.batteryLevel),
        batteryStatus: typeof d.batteryStatus === 'string' ? d.batteryStatus : null,
        lastSync: typeof d.lastSyncTime === 'string' ? d.lastSyncTime : null,
    }));
}

/* Probes every data type that is not stored yet: one that started to return data gets
 * its history fetched and is stored from then on. */
async function discover(userID: string, stored: Set<string>) {
    const gh = new GoogleHealth(userID);
    const start = day(30);
    const end = day(-1);
    for (const [dataType, kind] of Object.entries(CATALOG)) {
        if (KNOWN.has(dataType) || stored.has(dataType) || dataType === HEART_RATE) continue;
        try {
            const { status, body } = await gh.dataPoints(dataType, kind, start, end, 5);
            if (status === 200 && ((body as { dataPoints?: unknown[] })?.dataPoints ?? []).length) {
                await addDiscoveredType(userID, dataType);
            }
        } catch {
            // one type that fails is no reason to stop discovering the others
        }
    }
}

/* ----------------------------------------------------------------------- */

async function pollUser(userID: string) {
    const s = state(userID);
    if (s.busy) return;
    s.busy = true;
    s.checks++;
    s.lastCheck = Date.now();
    try {
        const link = await HealthLink.findById(userID, { discoveredTypes: 1, backfill: 1 }).lean();
        if (!link) return;
        const gh = new GoogleHealth(userID);
        const devices = await gh.pairedDevices();
        if (devices.status !== 200) throw new HealthError(`paired devices: HTTP ${devices.status}`);
        s.devices = devices.body;
        s.trackers = trackersFrom(devices.body);
        const syncTime = s.trackers[0]?.lastSync ?? null;

        if (!s.profileAt || Date.now() - s.profileAt > PROFILE_MS) {
            const profile = await gh.profile();
            if (profile.status === 200 && profile.body && typeof profile.body === 'object') {
                const p = profile.body as Record<string, unknown>;
                s.profile = { age: p.age ?? null, member_since: dateStr(p.membershipStartDate) };
                s.profileAt = Date.now();
            }
        }

        // only what is new: the latest days of every type, and heart rate of days now complete
        if (syncTime !== s.lastSyncTime) {
            const started = Date.now();
            const points = await refreshRecent(userID, link.discoveredTypes);
            const hrDays = await storeCompletedHeartRate(userID, syncTime);
            s.lastSyncTime = syncTime;
            intradayCache.clear(); // today's day views have new points
            changed(s);
            log.info('synced', {
                user: userID,
                tracker: s.trackers[0]?.name,
                lastSync: syncTime ?? undefined,
                points,
                heartRateDays: hrDays,
                ms: Date.now() - started,
            });
        }

        // the one-time fetch of the whole history, in the background; after an error again later
        const bf = link.backfill;
        const retryDue = !s.backfillTriedAt || Date.now() - s.backfillTriedAt > BACKFILL_RETRY_MS;
        if (bf?.state !== 'done' && !backfillRunning(userID) && (bf?.state !== 'failed' || retryDue)) {
            s.backfillTriedAt = Date.now();
            void backfill(userID, syncTime).then(() => changed(s));
        }

        if (!s.discoveredAt || Date.now() - s.discoveredAt > DISCOVERY_MS) {
            s.discoveredAt = Date.now();
            discover(userID, new Set(storedTypes(link.discoveredTypes).map(([t]) => t)))
                .then(() => changed(s))
                .catch((err) => log.warn('discovery failed', { user: userID }, err));
        }

        if (s.error) log.info('working again', { user: userID });
        s.error = undefined;
        s.reconnect = false;
    } catch (err) {
        const message = (err as Error).message;
        if (s.error !== message) log.warn('sync failed', { user: userID }, err);
        s.error = message;
        s.reconnect = err instanceof HealthError && err.reconnect;
    } finally {
        s.busy = false;
    }
}

async function pollAll() {
    if (!configured()) return;
    const links = await HealthLink.find({}, { _id: 1 }).lean();
    await Promise.all(links.map((l) => pollUser(l._id)));
}

export function initHealthSync() {
    if (!configured()) {
        log.info('Google Health not configured, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to show health data');
        return;
    }
    const run = () => pollAll().catch((err) => log.error('poll failed', undefined, err));
    run();
    setInterval(run, POLL_MS);
}

// right after connecting: no need to wait for the next minute
export function syncNow(userID: string) {
    void pollUser(userID);
}

export function forget(userID: string) {
    states.delete(userID);
    for (const k of [...intradayCache.keys()]) if (k.startsWith(`${userID} `)) intradayCache.delete(k);
    hrCache.delete(userID);
}

/* ----------------------------------------------------------------------- */

export async function syncStatus(userID: string) {
    const s = state(userID);
    const link = await HealthLink.findById(userID, { backfill: 1 }).lean();
    return {
        last_check: s.lastCheck ?? null,
        last_update: s.lastUpdate ?? null,
        checks: s.checks,
        poll_seconds: POLL_MS / 1000,
        tracker_last_sync: s.lastSyncTime ?? null,
        error: s.error ?? null,
        reconnect: s.reconnect,
        history: link?.backfill ?? null,
        server_time: Date.now(),
    };
}

export const RANGES: Record<string, number | null> = { '30': 30, '90': 90, '365': 365, all: null };

/* The page's summary, read from the stored history: whoofit's series for the range,
 * built once per change of the stored data. */
export async function summary(userID: string, range = '30') {
    const s = state(userID);
    const days = range in RANGES ? RANGES[range] : 30;
    const key = String(days);
    let data = s.summaries.get(key);
    if (!data) {
        const stats = await storageStats(userID);
        if (!stats.points) return undefined; // nothing stored yet: the first sync is still running
        const link = await HealthLink.findById(userID, { discoveredTypes: 1 }).lean();
        const from = days ? day(days) : undefined;

        const series: Record<string, unknown> = {};
        for (const [name, p] of Object.entries(PARSERS)) series[name] = p.parse(await loadPoints(userID, p.dataType, from));
        series.sleep = parseSleep(await loadPoints(userID, 'sleep', from));
        series.exercise = parseExercise(await loadPoints(userID, 'exercise', from));
        series.active_zone_minutes = parseAzm(await loadPoints(userID, 'active-zone-minutes', from));
        series.sedentary = parseSedentary(await loadPoints(userID, 'sedentary-period', from));
        series.hr_zones = parseHrZones(await loadPoints(userID, 'daily-heart-rate-zones', from));
        series.breathing_stages = parseBreathingStages(await loadPoints(userID, 'respiratory-rate-sleep-summary', from));

        // the other recorded types, one value a day (genericSeries keeps a day's last)
        const discovered: Record<string, unknown> = {};
        for (const [type] of storedTypes(link?.discoveredTypes ?? [])) {
            if (KNOWN.has(type) || !CATALOG[type]) continue;
            const g = genericSeries(type, await loadPoints(userID, type, from));
            if (g.length) discovered[type] = g;
        }

        const first = (s.devices as { pairedDevices?: Record<string, unknown>[] })?.pairedDevices?.[0];
        data = {
            window: { start: from ?? stats.oldestDay, end: day(0) },
            range: days ? String(days) : 'all',
            series,
            discovered,
            device: first
                ? {
                      name: first.deviceVersion ?? null,
                      type: first.deviceType ?? null,
                      battery: first.batteryLevel ?? null,
                      last_sync: first.lastSyncTime ?? null,
                  }
                : null,
            profile: s.profile ?? null,
            storage: stats,
            errors: {},
        };
        s.summaries.set(key, data);
    }
    return { ...data, sync: await syncStatus(userID) };
}

export function trackers(userID: string) {
    return state(userID).trackers;
}

export const INTRADAY_TYPES = new Set([...Object.keys(INTRADAY), ...BLOCK_TYPES, 'sedentary-granular']);

// heart rate of a day: stored once the day is complete, else straight from Google
async function heartRateRows(userID: string, date: string) {
    const stored = await loadHeartRateDay(userID, date);
    if (stored) return { ...stored, source: 'stored' };
    const res = await new GoogleHealth(userID).dataPointsAll(HEART_RATE, 'sample', date, nextDay(date), 120);
    if (res.status !== 200) throw new HealthError(`heart rate: HTTP ${res.status}`);
    return { rows: intradayRows(HEART_RATE, res.points), meta: datasourceMeta(res.points), source: 'google' };
}

/* One metric of one day at high resolution, from the stored history; a day not stored
 * (today's heart rate, a day the one-time fetch has not reached) comes from Google. */
export async function intraday(userID: string, type: string, date: string) {
    const cacheKey = `${userID} ${type} ${date}`;
    const hit = intradayCache.get(cacheKey);
    if (hit && Date.now() - hit.at < INTRADAY_CACHE_MS) return hit.data;

    const end = nextDay(date);
    const pointsOf = async (t: string) => {
        const stored = await loadPoints(userID, t, date, end);
        if (stored.length) return stored;
        const res = await new GoogleHealth(userID).dataPointsAll(t, INTRADAY[t]?.kind ?? 'interval', date, end);
        return res.status === 200 ? res.points : [];
    };

    let data: unknown;
    if (type === HEART_RATE) {
        const hr = await heartRateRows(userID, date);
        data = { ...intradayFromRows(HEART_RATE, date, hr.rows, hr.meta, { raw: true }), source: hr.source };
    } else if (type === 'sedentary-granular') {
        const hr = await heartRateRows(userID, date);
        data = sedentaryGranularFromRows(date, hr.rows, await pointsOf('steps'));
    } else if (BLOCK_TYPES.has(type)) {
        data = blocksFromPoints(type, date, await pointsOf(type));
    } else {
        data = intradayFromPoints(type, date, await pointsOf(type));
    }
    intradayCache.set(cacheKey, { at: Date.now(), data });
    if (intradayCache.size > 200) intradayCache.delete(intradayCache.keys().next().value as string);
    return data;
}

// the newest heart rate sample and its age, live from Google; cached 8 s
export async function latestHeartRate(userID: string) {
    const hit = hrCache.get(userID);
    if (hit && Date.now() - hit.at < HR_CACHE_MS) return hit.data;
    const gh = new GoogleHealth(userID);
    const { status, body } = await gh.dataPoints(HEART_RATE, 'sample', day(0), day(-1), 1);
    const point = (body as { dataPoints?: { heartRate?: Record<string, unknown> }[] })?.dataPoints?.[0]?.heartRate;
    let data: unknown = { bpm: null };
    if (status === 200 && point) {
        const at = (point.sampleTime as { physicalTime?: string })?.physicalTime ?? null;
        data = { bpm: num(point.beatsPerMinute), at, age_sec: at ? Math.trunc((Date.now() - Date.parse(at)) / 1000) : null };
    }
    hrCache.set(userID, { at: Date.now(), data });
    return data;
}

// the stored history was deleted: nothing may still show it from memory
export function dropCached(userID: string) {
    const s = states.get(userID);
    if (s) changed(s);
    for (const k of [...intradayCache.keys()]) if (k.startsWith(`${userID} `)) intradayCache.delete(k);
}
