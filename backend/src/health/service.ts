import { HealthLink } from '../core/db';
import { logger } from '../core/logger';
import {
    BLOCK_TYPES,
    CATALOG,
    INTRADAY,
    KNOWN,
    PARSERS,
    blocksFromPoints,
    dateStr,
    genericSeries,
    intradayFromPoints,
    intradayFromRows,
    num,
    parseAzm,
    parseBreathingStages,
    parseExercise,
    parseHrZones,
    parseSedentary,
    parseSleep,
    sedentaryGranularFromRows,
} from './extract';
import { GoogleHealth, HealthError, configured, day, nextDay, requestQueue } from './google';
import { forEachLimited } from './limiter';
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
const DISCOVERY_MS = 24 * 3600_000; // a type a tracker starts to record is rare; a probe is ~100 requests
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
    building: Map<string, Promise<Record<string, unknown> | undefined>>; // one build per range at a time
    generation: number; // raised by every change: a build that started before it is not kept
    busy: boolean;
}

const states = new Map<string, UserState>();
const intradayCache = new Map<string, { at: number; data: unknown }>();
const hrCache = new Map<string, { at: number; data: unknown }>();

function state(userID: string) {
    let s = states.get(userID);
    if (!s) {
        s = { trackers: [], checks: 0, reconnect: false, busy: false, summaries: new Map(), building: new Map(), generation: 0 };
        states.set(userID, s);
    }
    return s;
}

function changed(s: UserState) {
    s.summaries.clear();
    s.generation++;
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

/* Probes every data type that is not stored yet, a few side by side: one that started
 * to return data gets its history fetched and is stored from then on. Returns how many
 * were added: only then has the stored data changed. */
async function discover(userID: string, stored: Set<string>) {
    const gh = new GoogleHealth(userID);
    const start = day(30);
    const end = day(-1);
    const probe = Object.entries(CATALOG).filter(([t]) => !KNOWN.has(t) && !stored.has(t) && t !== HEART_RATE);
    let added = 0;
    await forEachLimited(probe, 4, async ([dataType, kind]) => {
        try {
            const { status, body } = await gh.dataPoints(dataType, kind, start, end, 5);
            if (status === 200 && ((body as { dataPoints?: unknown[] })?.dataPoints ?? []).length) {
                if (await addDiscoveredType(userID, dataType)) added++;
            }
        } catch {
            // one type that fails is no reason to stop discovering the others
        }
    });
    return added;
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
                .then((added) => {
                    if (added) changed(s);
                })
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
        requests: requestQueue(),
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
        // several tabs (or the quiet refresh) asking at once share one build
        let build = s.building.get(key);
        if (!build) {
            const generation = s.generation;
            build = buildSummary(userID, s, days)
                .then((built) => {
                    if (built && s.generation === generation) s.summaries.set(key, built);
                    return built;
                })
                .finally(() => s.building.delete(key));
            s.building.set(key, build);
        }
        data = await build;
        if (!data) return undefined; // nothing stored yet: the first sync is still running
    }
    return { ...data, sync: await syncStatus(userID) };
}

// the stored types read side by side: the database does the waiting, not one read after another
type Points = Awaited<ReturnType<typeof loadPoints>>;

async function buildSummary(userID: string, s: UserState, days: number | null) {
    const stats = await storageStats(userID);
    if (!stats.points) return undefined;
    const link = await HealthLink.findById(userID, { discoveredTypes: 1 }).lean();
    const from = days ? day(days) : undefined;

    /* every type read and parsed in one step, three at a time: the database does the
     * waiting side by side, and the raw points of a type are let go once parsed, never
     * all of them in memory at once (the whole history is ~70 MB a year) */
    const series: Record<string, unknown> = {};
    const discovered: Record<string, unknown> = {};
    const jobs: [string, (points: Points) => void][] = [
        ...Object.entries(PARSERS).map(([name, p]) => [p.dataType, (pts: Points) => (series[name] = p.parse(pts))] as [string, (points: Points) => void]),
        ['sleep', (pts) => (series.sleep = parseSleep(pts))],
        ['exercise', (pts) => (series.exercise = parseExercise(pts))],
        ['active-zone-minutes', (pts) => (series.active_zone_minutes = parseAzm(pts))],
        ['sedentary-period', (pts) => (series.sedentary = parseSedentary(pts))],
        ['daily-heart-rate-zones', (pts) => (series.hr_zones = parseHrZones(pts))],
        ['respiratory-rate-sleep-summary', (pts) => (series.breathing_stages = parseBreathingStages(pts))],
        // the other recorded types, one value a day (genericSeries keeps a day's last)
        ...storedTypes(link?.discoveredTypes ?? [])
            .filter(([type]) => !KNOWN.has(type) && CATALOG[type])
            .map(
                ([type]) =>
                    [
                        type,
                        (pts: Points) => {
                            const g = genericSeries(type, pts);
                            if (g.length) discovered[type] = g;
                        },
                    ] as [string, (points: Points) => void],
            ),
    ];
    await forEachLimited(jobs, 3, async ([type, parse]) => parse(await loadPoints(userID, type, from)));

    const first = (s.devices as { pairedDevices?: Record<string, unknown>[] })?.pairedDevices?.[0];
    return {
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
    } as Record<string, unknown>;
}

export function trackers(userID: string) {
    return state(userID).trackers;
}

export const INTRADAY_TYPES = new Set([...Object.keys(INTRADAY), ...BLOCK_TYPES, 'sedentary-granular']);

// heart rate of a day: stored once the day is complete, else straight from Google
async function heartRateRows(userID: string, date: string) {
    const stored = await loadHeartRateDay(userID, date);
    if (stored) return { ...stored, source: 'stored' };
    const res = await new GoogleHealth(userID, true).heartRateDay(date);
    if (res.status !== 200) throw new HealthError(`heart rate: HTTP ${res.status}`);
    return { rows: res.rows, meta: res.meta, source: 'google' };
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
        const res = await new GoogleHealth(userID, true).dataPointsAll(t, INTRADAY[t]?.kind ?? 'interval', date, end);
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
    const gh = new GoogleHealth(userID, true);
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

/* The heart rate of the last minutes before the newest sample, for the home page: from today's
 * heart rate as it is read for the day (cached 5 minutes), the newest sample as late as the
 * tracker synced. Times are the server's (the home's) time zone. */
export async function recentHeartRate(userID: string, minutes = 30) {
    const date = day(0);
    const data = (await intraday(userID, HEART_RATE, date)) as { points?: { t: string; value: number }[] };
    const points = (data.points ?? []).map((p) => ({ at: new Date(`${date}T${p.t}`).getTime(), bpm: p.value }));
    if (!points.length) return { points: [], latest: null };
    const latest = points[points.length - 1];
    const from = latest.at - minutes * 60_000;
    return { points: points.filter((p) => p.at >= from), latest };
}

// the stored history was deleted: nothing may still show it from memory
export function dropCached(userID: string) {
    const s = states.get(userID);
    if (s) changed(s);
    for (const k of [...intradayCache.keys()]) if (k.startsWith(`${userID} `)) intradayCache.delete(k);
}
