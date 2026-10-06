import { HealthLink } from '../core/db';
import { logger } from '../core/logger';
import {
    BLOCK_TYPES,
    CATALOG,
    INTRADAY,
    KNOWN,
    type FilterKind,
    PARSERS,
    blocksFromPoints,
    dateStr,
    genericSeries,
    intradayFromPoints,
    num,
    parseAzm,
    parseBreathingStages,
    parseExercise,
    parseHrZones,
    parseSedentary,
    parseSleep,
    sedentaryGranularFromPoints,
} from './extract';
import { GoogleHealth, HealthError, configured, day, nextDay } from './google';

/*
 * whoofit's server.py: every minute one cheap call asks for the tracker's last sync, and
 * only a new sync (or the half-hourly discovery of new data types) fetches the 30 days
 * again. Per user who connected Google Health; kept in memory, Google keeps the data.
 */

const log = logger('health');

const POLL_MS = 60_000;
const DISCOVERY_MS = 30 * 60_000;
const DAYS = 30;
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
    data?: Record<string, unknown>;
    trackers: Tracker[];
    lastCheck?: number;
    lastUpdate?: number;
    lastSyncTime?: string | null;
    checks: number;
    error?: string;
    reconnect: boolean; // only connecting Google again helps
    discoveredAt?: number;
    busy: boolean;
}

const states = new Map<string, UserState>();
const intradayCache = new Map<string, { at: number; data: unknown }>();
const hrCache = new Map<string, { at: number; data: unknown }>();

function state(userID: string) {
    let s = states.get(userID);
    if (!s) {
        s = { trackers: [], checks: 0, reconnect: false, busy: false };
        states.set(userID, s);
    }
    return s;
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

async function discover(gh: GoogleHealth, start: string, end: string) {
    const found: Record<string, unknown> = {};
    for (const [dataType, kind] of Object.entries(CATALOG)) {
        if (KNOWN.has(dataType)) continue;
        try {
            const { status, body } = await gh.dataPoints(dataType, kind, start, end, 50);
            if (status === 200 && body && typeof body === 'object') {
                const series = genericSeries(dataType, (body as { dataPoints?: unknown[] }).dataPoints ?? []);
                if (series.length) found[dataType] = series;
            }
        } catch {
            // one type that fails is no reason to stop discovering the others
        }
    }
    return found;
}

// every working series, normalized; whoofit's extractor.collect()
async function collect(gh: GoogleHealth, days: number, withDiscovery: boolean, devices: unknown) {
    const start = day(days);
    const end = day(-1); // end exclusive: today included
    const result: Record<string, unknown> & { series: Record<string, unknown>; errors: Record<string, number> } = {
        window: { start, end: day(0) },
        series: {},
        device: null,
        errors: {},
    };

    const profile = await gh.profile();
    if (profile.status === 200 && profile.body && typeof profile.body === 'object') {
        const p = profile.body as Record<string, unknown>;
        result.profile = { age: p.age ?? null, member_since: dateStr(p.membershipStartDate) };
    }
    const first = (devices as { pairedDevices?: Record<string, unknown>[] })?.pairedDevices?.[0];
    if (first) {
        result.device = {
            name: first.deviceVersion ?? null,
            type: first.deviceType ?? null,
            battery: first.batteryLevel ?? null,
            last_sync: first.lastSyncTime ?? null,
        };
    }

    /* Every type is read to its last page. whoofit read one page for most of them, and
     * Google pages sleep and workouts by count: it showed 12 of 31 nights, 25 of 90 workouts. */
    const types: [string, string, FilterKind, (pts: unknown[]) => unknown][] = [
        ...Object.entries(PARSERS).map(([key, p]) => [key, p.dataType, p.kind, p.parse] as [string, string, FilterKind, (pts: unknown[]) => unknown]),
        ['sleep', 'sleep', 'sleep', parseSleep],
        ['exercise', 'exercise', 'interval', parseExercise],
        ['active_zone_minutes', 'active-zone-minutes', 'interval', parseAzm],
        ['sedentary', 'sedentary-period', 'interval', parseSedentary],
        ['hr_zones', 'daily-heart-rate-zones', 'daily', parseHrZones],
        ['breathing_stages', 'respiratory-rate-sleep-summary', 'sample', parseBreathingStages],
    ];
    for (const [key, dataType, kind, parse] of types) {
        const { status, points } = await gh.dataPointsAll(dataType, kind, start, end);
        result.series[key] = status === 200 ? parse(points) : [];
        if (status !== 200) result.errors[key] = status;
    }

    if (withDiscovery) result.discovered = await discover(gh, start, end);
    return result;
}

/* ----------------------------------------------------------------------- */

async function pollUser(userID: string) {
    const s = state(userID);
    if (s.busy) return;
    s.busy = true;
    s.checks++;
    s.lastCheck = Date.now();
    try {
        const gh = new GoogleHealth(userID);
        const devices = await gh.pairedDevices();
        if (devices.status !== 200) throw new HealthError(`paired devices: HTTP ${devices.status}`);
        s.trackers = trackersFrom(devices.body);
        const syncTime = s.trackers[0]?.lastSync ?? null;

        const discoveryDue = !s.discoveredAt || Date.now() - s.discoveredAt > DISCOVERY_MS;
        if (!s.data || syncTime !== s.lastSyncTime || discoveryDue) {
            const started = Date.now();
            s.data = await collect(gh, DAYS, discoveryDue, devices.body);
            s.lastUpdate = Date.now();
            if (discoveryDue) s.discoveredAt = Date.now();
            if (syncTime !== s.lastSyncTime) intradayCache.clear(); // today's drill-downs have new points
            s.lastSyncTime = syncTime;
            log.info('synced', {
                user: userID,
                tracker: s.trackers[0]?.name,
                lastSync: syncTime ?? undefined,
                ms: Date.now() - started,
                discovery: discoveryDue,
            });
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

export function syncStatus(userID: string) {
    const s = state(userID);
    return {
        last_check: s.lastCheck ?? null,
        last_update: s.lastUpdate ?? null,
        checks: s.checks,
        poll_seconds: POLL_MS / 1000,
        tracker_last_sync: s.lastSyncTime ?? null,
        error: s.error ?? null,
        reconnect: s.reconnect,
        server_time: Date.now(),
    };
}

export function summary(userID: string) {
    const s = state(userID);
    return s.data ? { ...s.data, sync: syncStatus(userID) } : undefined;
}

export function trackers(userID: string) {
    return state(userID).trackers;
}

export const INTRADAY_TYPES = new Set([...Object.keys(INTRADAY), ...BLOCK_TYPES, 'sedentary-granular']);

// one metric of one day at high resolution; 5 min cache, cleared when the tracker syncs
export async function intraday(userID: string, type: string, date: string) {
    const cacheKey = `${userID} ${type} ${date}`;
    const hit = intradayCache.get(cacheKey);
    if (hit && Date.now() - hit.at < INTRADAY_CACHE_MS) return hit.data;

    const gh = new GoogleHealth(userID);
    const end = nextDay(date);
    let data: unknown;
    if (type === 'sedentary-granular') {
        const hr = await gh.dataPointsAll('heart-rate', 'sample', date, end);
        const steps = await gh.dataPointsAll('steps', 'interval', date, end);
        data = hr.status === 200 ? sedentaryGranularFromPoints(date, hr.points, steps.points) : { error: `heart-rate HTTP ${hr.status}`, runs: [] };
    } else if (BLOCK_TYPES.has(type)) {
        const res = await gh.dataPointsAll(type, 'interval', date, end);
        data = res.status === 200 ? blocksFromPoints(type, date, res.points) : { error: `HTTP ${res.status}`, blocks: [] };
    } else {
        const spec = INTRADAY[type];
        const res = await gh.dataPointsAll(type, spec.kind, date, end);
        // heart rate at its native resolution (about a sample a second), the others bucketed
        data = res.status === 200 ? intradayFromPoints(type, date, res.points, { raw: type === 'heart-rate' }) : { error: `HTTP ${res.status}`, points: [] };
    }
    intradayCache.set(cacheKey, { at: Date.now(), data });
    // drill-downs of long gone days need not stay in memory
    if (intradayCache.size > 200) intradayCache.delete(intradayCache.keys().next().value as string);
    return data;
}

// the newest heart rate sample and its age; cached 8 s so polling cards stay one call
export async function latestHeartRate(userID: string) {
    const hit = hrCache.get(userID);
    if (hit && Date.now() - hit.at < HR_CACHE_MS) return hit.data;
    const gh = new GoogleHealth(userID);
    const { status, body } = await gh.dataPoints('heart-rate', 'sample', day(0), day(-1), 1);
    const point = (body as { dataPoints?: { heartRate?: Record<string, unknown> }[] })?.dataPoints?.[0]?.heartRate;
    let data: unknown = { bpm: null };
    if (status === 200 && point) {
        const at = (point.sampleTime as { physicalTime?: string })?.physicalTime ?? null;
        data = { bpm: num(point.beatsPerMinute), at, age_sec: at ? Math.trunc((Date.now() - Date.parse(at)) / 1000) : null };
    }
    hrCache.set(userID, { at: Date.now(), data });
    return data;
}
