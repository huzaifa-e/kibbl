import { HealthLink, HealthPoint } from '../core/db';
import { logger } from '../core/logger';
import { CATALOG, PARSERS, type FilterKind } from './extract';
import { GoogleHealth, HealthError, day } from './google';
import { forEachLimited } from './limiter';
import { saveHeartRateDay, storeWindow, storedHeartRateDates } from './store';

/*
 * The health history: fetched from Google once, back to the first day with data, then
 * kept current with only the latest days after each sync of the tracker.
 */

const log = logger('health');

const CHUNK_DAYS = 30; // one request window of the one-time fetch
const EMPTY_CHUNKS_TO_STOP = 3; // 90 days without any data: the history begins after them
const MAX_YEARS = 10;
export const RECENT_DAYS = 2; // re-read on every sync: Google revises the latest days (sleep is reprocessed)
const HR_MAX_PAGES = 12; // up to a sample a second: 86 400 points, 10 000 a page
const HR_DAYS_AT_ONCE = 3; // heart rate days fetched side by side; the limiter in google.ts caps the requests

// every type that is stored as data points: whoofit's series and the intraday ones
const BASE_TYPES: [string, FilterKind][] = [
    ...Object.values(PARSERS).map((p) => [p.dataType, p.kind] as [string, FilterKind]),
    ['sleep', 'sleep'],
    ['exercise', 'interval'],
    ['active-zone-minutes', 'interval'],
    ['sedentary-period', 'interval'],
    ['daily-heart-rate-zones', 'daily'],
    ['respiratory-rate-sleep-summary', 'sample'],
    ['steps', 'interval'],
    ['oxygen-saturation', 'sample'],
    ['distance', 'interval'],
];

// heart rate is stored by the day in binary (store.ts), never as points
export const HEART_RATE = 'heart-rate';

/* Google computes heart rate zones from the age for every day there is, also years
 * before any tracker: they are no sign of recorded data, and are fetched only for days
 * that have some. */
const DERIVED_TYPES = new Set(['daily-heart-rate-zones']);

export function storedTypes(discovered: string[] = []): [string, FilterKind][] {
    const base = new Set(BASE_TYPES.map(([t]) => t));
    const extra = discovered.filter((t) => !base.has(t) && t !== HEART_RATE && CATALOG[t]).map((t) => [t, CATALOG[t]] as [string, FilterKind]);
    return [...BASE_TYPES, ...extra];
}

function addDays(date: string, days: number) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* The days before the tracker's last sync are complete: the data of the day it synced
 * on may still grow. In the server's time zone, the home's. */
export function lastCompleteDay(lastSync: string | null | undefined) {
    if (!lastSync) return null;
    const t = new Date(Date.parse(lastSync));
    const syncDay = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    return addDays(syncDay, -1);
}

// one type over [start, end): every page, then stored in place of what was there
async function fetchAndStore(gh: GoogleHealth, userID: string, type: string, kind: FilterKind, start: string, end: string) {
    const { status, points } = await gh.dataPointsAll(type, kind, start, end);
    if (status === 400 || status === 404) return 0; // a type this account or device does not offer
    if (status !== 200) throw new HealthError(`${type}: HTTP ${status}`);
    return storeWindow(userID, type, kind, start, end, points);
}

async function fetchHeartRateDay(gh: GoogleHealth, userID: string, date: string) {
    const { status, rows, meta } = await gh.heartRateDay(date, HR_MAX_PAGES);
    if (status !== 200) throw new HealthError(`heart rate ${date}: HTTP ${status}`);
    // a day without heart rate (before the tracker, not worn) is stored empty: it is not asked for again
    await saveHeartRateDay(userID, date, rows, meta);
    return rows.length;
}

/* Every type over [start, end) side by side (the limiter caps the requests), the points
 * stored. The first error is thrown once all have stopped. */
async function fetchTypes(gh: GoogleHealth, userID: string, types: [string, FilterKind][], start: string, end: string) {
    let points = 0;
    await forEachLimited(types, types.length, async ([type, kind]) => {
        points += await fetchAndStore(gh, userID, type, kind, start, end);
    });
    return points;
}

/* ----------------------------------------------------------------------- */

// after a sync of the tracker: the latest days of every type again, nothing older
export async function refreshRecent(userID: string, discovered: string[]) {
    const gh = new GoogleHealth(userID);
    const start = day(RECENT_DAYS);
    const end = day(-1); // today included
    return fetchTypes(gh, userID, storedTypes(discovered), start, end);
}

/* Heart rate of the days that became complete since the last time: normally the day
 * before, after the first sync past midnight. Only days after the stored history, the
 * one-time fetch fills the older ones. */
export async function storeCompletedHeartRate(userID: string, lastSync: string | null) {
    const last = lastCompleteDay(lastSync);
    if (!last) return 0;
    const stored = await storedHeartRateDates(userID);
    if (!stored.size) return 0; // the one-time fetch has not reached heart rate yet
    const newest = [...stored].sort().pop()!;
    const gh = new GoogleHealth(userID);
    const dates: string[] = [];
    for (let date = addDays(newest, 1); date <= last; date = addDays(date, 1)) dates.push(date);
    await forEachLimited(dates, HR_DAYS_AT_ONCE, (date) => fetchHeartRateDay(gh, userID, date).then(() => undefined));
    return dates.length;
}

/* ----------------------------------------------------------------------- */

const running = new Set<string>();

async function saveProgress(userID: string, backfill: HealthBackfill) {
    await HealthLink.updateOne({ _id: userID }, { $set: { backfill } });
}

/* The one-time fetch of everything Google has, newest first so the recent months show
 * up first: every point type in 30-day windows back until 90 days in a row bring
 * nothing, then the heart rate of every complete day of that history at full
 * resolution. Resumable: it goes on from where it stopped (a restart, an error). */
export async function backfill(userID: string, lastSync: string | null) {
    if (running.has(userID)) return;
    const link = await HealthLink.findById(userID).lean();
    if (!link || link.backfill?.state === 'done') return;
    running.add(userID);

    const progress: HealthBackfill = { ...(link.backfill ?? {}), state: 'running', startedAt: link.backfill?.startedAt ?? Date.now(), error: undefined };
    const started = Date.now();
    log.info('history fetch started', { user: userID, from: progress.reachedDay ?? 'today' });
    try {
        const gh = new GoogleHealth(userID);
        const types = storedTypes(link.discoveredTypes);
        const limit = addDays(day(0), -365 * MAX_YEARS);

        // points: back from where it stopped (or tomorrow) in windows of 30 days
        let end = progress.reachedDay ?? day(-1);
        let empty = 0;
        while (!progress.pointsDone && empty < EMPTY_CHUNKS_TO_STOP && end > limit) {
            // disconnected and deleted meanwhile: nothing more is written for this user
            if (!(await HealthLink.exists({ _id: userID }))) throw new HealthError('disconnected');
            const start = addDays(end, -CHUNK_DAYS);
            const found = await fetchTypes(
                gh,
                userID,
                types.filter(([t]) => !DERIVED_TYPES.has(t)),
                start,
                end,
            );
            if (found) {
                await fetchTypes(
                    gh,
                    userID,
                    types.filter(([t]) => DERIVED_TYPES.has(t)),
                    start,
                    end,
                );
            }
            empty = found ? 0 : empty + 1;
            if (found) progress.oldestDay = (await oldestStoredDay(userID)) ?? progress.oldestDay;
            progress.reachedDay = start;
            await saveProgress(userID, progress);
            log.info('history fetched', { user: userID, from: start, to: end, points: found });
            end = start;
        }

        progress.pointsDone = true;
        await saveProgress(userID, progress);

        /* heart rate: every complete day from the oldest day with data on, newest first,
         * a few side by side. The progress is written one save after the other, so an
         * older count never lands after a newer one. */
        const last = lastCompleteDay(lastSync) ?? day(1);
        const oldest = progress.oldestDay ?? last;
        const stored = await storedHeartRateDates(userID);
        const missing: string[] = [];
        for (let date = last; date >= oldest; date = addDays(date, -1)) if (!stored.has(date)) missing.push(date);
        progress.heartRateDaysTotal = stored.size + missing.length;
        progress.heartRateDays = stored.size;
        let saving = Promise.resolve();
        await forEachLimited(missing, HR_DAYS_AT_ONCE, async (date) => {
            if (!(await HealthLink.exists({ _id: userID }))) throw new HealthError('disconnected');
            await fetchHeartRateDay(gh, userID, date);
            progress.heartRateDays = (progress.heartRateDays ?? 0) + 1;
            saving = saving.then(() => saveProgress(userID, progress));
            await saving;
        });

        progress.state = 'done';
        progress.finishedAt = Date.now();
        await saveProgress(userID, progress);
        log.info('history complete', {
            user: userID,
            oldest: progress.oldestDay,
            heartRateDays: progress.heartRateDays,
            minutes: Math.round((Date.now() - started) / 60000),
        });
    } catch (err) {
        progress.state = 'failed';
        progress.error = (err as Error).message;
        await saveProgress(userID, progress).catch(() => undefined);
        log.warn('history fetch stopped, it goes on later', { user: userID, reached: progress.reachedDay }, err);
    } finally {
        running.delete(userID);
    }
}

export function backfillRunning(userID: string) {
    return running.has(userID);
}

async function oldestStoredDay(userID: string) {
    const doc = await HealthPoint.findOne({ userID, type: { $nin: [...DERIVED_TYPES] } }, { day: 1 })
        .sort({ day: 1 })
        .lean();
    return doc?.day;
}

/* A data type that started to return data (discovery): its own history fetched once,
 * the same way, and from then on it is part of every refresh. */
export async function addDiscoveredType(userID: string, type: string) {
    if (!CATALOG[type] || type === HEART_RATE) return false;
    const updated = await HealthLink.updateOne({ _id: userID, discoveredTypes: { $ne: type } }, { $push: { discoveredTypes: type } });
    if (!updated.modifiedCount) return false;
    log.info('new data type, fetching its history', { user: userID, type });
    const gh = new GoogleHealth(userID);
    const kind = CATALOG[type];
    let end = day(-1);
    let empty = 0;
    while (empty < EMPTY_CHUNKS_TO_STOP) {
        const start = addDays(end, -CHUNK_DAYS);
        empty = (await fetchAndStore(gh, userID, type, kind, start, end)) ? 0 : empty + 1;
        end = start;
    }
    return true;
}
