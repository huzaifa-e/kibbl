import {
    PETKIT_PORTION_AMOUNT,
    PETKIT_PORTIONS,
    dayProblem,
    mealTime,
    type PetkitFeeder,
    type PetkitMeal,
    type PetkitPlan,
    type PetkitPlanMeal,
    type PetkitStatus,
} from '../../../shared/petkit';
import { Device, PetkitLink } from '../core/db';
import { hub } from '../core/hub';
import { logger } from '../core/logger';
import { notifyUser } from '../core/notify';
import { PetkitError, forgetSession, login, petkitRequest, seal } from './client';

/*
 * PetKit feeders of each account that connected PetKit (Devices). The server reads every
 * feeder once a minute (its state and today's meals, two requests), every few seconds for a
 * minute after a command, so a feed from the app shows when it is given. PetKit's own
 * schedule keeps running on the feeder; kibbl. feeds now, skips or restores a meal of today,
 * pauses the plan and resets the desiccant.
 *
 * The hopper running low, an error of the feeder and a meal that was not given are told to
 * the person (core/notify.ts), once each when they start. A kibbl. cam can be set to watch a
 * feeder: a cat it sees is then at the feeder (core/visits.ts) and its page shows the feeder.
 *
 * The Fresh Element Solo is PetKit's d4; the d4h (Solo with a camera) answers the same.
 */

const log = logger('petkit');

const POLL_MS = 60_000;
const FAST_POLL_MS = 5_000; // after a command, for FAST_FOR_MS
const FAST_FOR_MS = 90_000;
const DEVICES_EVERY_MS = 6 * 3600_000; // the list of feeders, for renamed, added or removed ones
const TICK_MS = 5_000;
const MISSED_AFTER_S = 600; // a meal of the plan without a result this long after its time was not given
const SUPPORTED = ['d4', 'd4h'];

interface Session {
    feeders: Map<number, PetkitFeeder>;
    nextPoll: number;
    fastUntil: number;
    devicesAt: number;
    polling: boolean;
    error?: string;
    // what was told already, per feeder: no second message while it lasts
    told: Map<number, { low: boolean; error?: string; failed: Set<string> }>;
    zones: Map<number, number | undefined>; // each feeder's offset from UTC, hours: its day
    factors: Map<number, number>; // what PetKit counts per portion, per feeder
    plans: Map<number, { plan: PetkitPlan; at: number }>; // read on demand
    first: boolean; // the first read after a start tells nothing: it only learns what is
}

const sessions = new Map<string, Session>();

function session(userID: string) {
    let s = sessions.get(userID);
    if (!s) {
        s = {
            feeders: new Map(),
            nextPoll: 0,
            fastUntil: 0,
            devicesAt: 0,
            polling: false,
            told: new Map(),
            zones: new Map(),
            factors: new Map(),
            plans: new Map(),
            first: true,
        };
        sessions.set(userID, s);
    }
    return s;
}

/* ----------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const DISPENSED = new Set([0, 1, 2, 4, 5, 6, 9, 10, 11, 12, 13]);

// a time PetKit sends as an ISO string, seconds or ms
function timeOf(v: unknown) {
    if (typeof v === 'string' && v) {
        const t = Date.parse(v);
        return Number.isNaN(t) ? undefined : t;
    }
    const n = num(v);
    return n === undefined ? undefined : n < 1e12 ? n * 1000 : n;
}

/* A meal of today's records, as PetKit's app shows it (the same reading as Home Assistant's
 * PetKit integration): status 3 is being given, 1 skipped, 2 did not start; with a state its
 * result says whether it was given (7: cancelled). nowS is the time of day on the feeder. */
export function mealFrom(item: any, nowS: number, factor = PETKIT_PORTION_AMOUNT): PetkitMeal {
    const time = num(item?.time) ?? 0;
    const status = num(item?.status) ?? 0;
    const state = item?.state;
    const portions = (num(item?.amount) ?? 0) / factor;
    const real = state ? ((num(state.realAmount) ?? 0) + (num(state.realAmount1) ?? 0) + (num(state.realAmount2) ?? 0)) / factor : undefined;
    let s: PetkitMeal['state'];
    if (status === 3) s = 'feeding';
    else if (status === 1) s = 'skipped';
    else if (status === 2) s = 'missed';
    else if (!state) s = time > nowS ? 'planned' : nowS - time > MISSED_AFTER_S ? 'missed' : 'feeding';
    else {
        const result = num(state.result) ?? -1;
        if (result === 7) s = 'skipped';
        else if (DISPENSED.has(result) && (real ?? 0) > 0) s = 'given';
        else s = 'failed';
    }
    return {
        id: String(item?.id ?? `s${time}`),
        time,
        name: typeof item?.name === 'string' ? item.name : '',
        portions: Math.round(portions * 10) / 10,
        given: real === undefined ? undefined : Math.round(real * 10) / 10,
        state: s,
        manual: (num(item?.src) ?? 1) !== 1,
        at: timeOf(state?.completedAt),
    };
}

// the feeder's clock: PetKit reports its offset from UTC in hours
export function feederClock(offsetHours: number | undefined, now = Date.now()) {
    const local = new Date(now + (offsetHours ?? -new Date(now).getTimezoneOffset() / 60) * 3600_000);
    const day = `${local.getUTCFullYear()}${String(local.getUTCMonth() + 1).padStart(2, '0')}${String(local.getUTCDate()).padStart(2, '0')}`;
    return { day, seconds: local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds() };
}

// a feeder from its device_detail and today's records (d4/dailyFeeds)
export function feederFrom(entry: { id: number; type: string; name: string; cameraId?: string }, detail: any, records: any, now = Date.now()): PetkitFeeder {
    const state = detail?.state ?? {};
    const factor = num(detail?.settings?.factor) || PETKIT_PORTION_AMOUNT;
    const clock = feederClock(num(detail?.timezone), now);
    const days: any[] = Array.isArray(records?.feed) ? records.feed : Array.isArray(records) ? records : [];
    const today = days.find((d) => String(d?.day) === clock.day) ?? (days.length === 1 ? days[0] : undefined);
    const meals = ((today?.items ?? []) as any[]).map((i) => mealFrom(i, clock.seconds, factor)).sort((a, b) => a.time - b.time);
    const plan: any[] = detail?.multiFeedItem?.feedDailyList ?? [];
    const power = num(state.batteryStatus);
    const food = num(state.food);
    return {
        id: entry.id,
        type: entry.type,
        name: (typeof detail?.name === 'string' && detail.name) || entry.name,
        online: num(state.pim) !== 0,
        food: food === undefined ? null : food === 0 ? 'low' : 'enough',
        feeding: (num(state.feeding) ?? 0) > 0,
        error: typeof state.errorMsg === 'string' && state.errorMsg ? state.errorMsg : undefined,
        desiccantDays: num(state.desiccantLeftDays),
        battery: power === 0 ? 'mains' : power === 1 ? 'battery' : power === 2 ? 'low' : undefined,
        wifi: num(state.wifi?.rsq),
        firmware: detail?.firmware !== undefined ? String(detail.firmware) : undefined,
        planPaused: plan.length > 0 && plan.every((d) => num(d?.suspended) === 1),
        meals,
        givenToday: Math.round(meals.reduce((sum, m) => sum + (m.given ?? 0), 0) * 10) / 10,
        plannedToday: Math.round(meals.filter((m) => !m.manual && m.state !== 'skipped').reduce((sum, m) => sum + m.portions, 0) * 10) / 10,
        cameraId: entry.cameraId,
        at: now,
    };
}

// the feeders of an account: its own (family list), else those shared with it (device roster)
async function listFeeders(userID: string) {
    const groups = await petkitRequest<any[]>(userID, 'group/family/list', {});
    const found: { id: number; type: string; typeId?: number; name: string }[] = [];
    for (const g of Array.isArray(groups) ? groups : []) {
        let list: any[] = (g?.deviceList ?? []).map((d: any) => ({ id: d.deviceId, type: d.deviceType, typeId: d.type, name: d.deviceName }));
        if (!list.length && g?.groupId !== undefined) {
            const today = feederClock(undefined).day;
            const roster = await petkitRequest<{ devices?: any[] }>(userID, 'discovery/device_roster_v2', { form: { day: today, groupId: g.groupId } }).catch(
                () => ({ devices: [] }),
            );
            list = (roster.devices ?? []).map((d: any) => ({ id: d.id, type: d.type, typeId: d.deviceTypeId, name: d.name ?? d.deviceName }));
        }
        for (const d of list) {
            const type = String(d.type ?? '').toLowerCase();
            if (!SUPPORTED.includes(type)) {
                if (type) log.debug('PetKit device not taken', { user: userID, type });
                continue;
            }
            if (!found.some((f) => f.id === Number(d.id)))
                found.push({ id: Number(d.id), type, typeId: num(d.typeId), name: String(d.name || 'PetKit feeder') });
        }
    }
    return found;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ----------------------------------------------------------------------- */

async function refreshDevices(userID: string) {
    const link = await PetkitLink.findById(userID, { feeders: 1 }).lean();
    if (!link) return;
    const before = new Map(link.feeders.map((f) => [f.id, f.cameraId]));
    const feeders = (await listFeeders(userID)).map((f) => ({ ...f, cameraId: before.get(f.id) }));
    await PetkitLink.updateOne({ _id: userID }, { feeders });
    session(userID).devicesAt = Date.now();
    log.info('PetKit feeders', { user: userID, feeders: feeders.map((f) => `${f.name} (${f.type})`).join(', ') || 'none' });
}

async function poll(userID: string) {
    const s = session(userID);
    if (Date.now() - s.devicesAt > DEVICES_EVERY_MS) await refreshDevices(userID);
    const link = await PetkitLink.findById(userID, { feeders: 1 }).lean();
    if (!link) return;
    const seen = new Set<number>();
    for (const entry of link.feeders) {
        const detail = await petkitRequest(userID, `${entry.type}/device_detail`, { query: { id: entry.id } });
        const zone = (detail as { timezone?: unknown })?.timezone;
        s.zones.set(entry.id, typeof zone === 'number' ? zone : undefined);
        const factor = (detail as { settings?: { factor?: unknown } })?.settings?.factor;
        s.factors.set(entry.id, typeof factor === 'number' && factor > 0 ? factor : PETKIT_PORTION_AMOUNT);
        const clock = feederClock(s.zones.get(entry.id));
        const records = await petkitRequest(userID, `${entry.type}/${entry.type === 'd4' ? 'dailyFeeds' : 'getDeviceRecord'}`, {
            query: { days: clock.day, deviceId: entry.id },
        });
        const feeder = feederFrom(entry, detail, records);
        tell(userID, s, feeder);
        s.feeders.set(entry.id, feeder);
        seen.add(entry.id);
    }
    for (const id of [...s.feeders.keys()]) if (!seen.has(id)) s.feeders.delete(id);
    s.first = false;
    s.error = undefined;
    // while one gives food it is followed closely
    if ([...s.feeders.values()].some((f) => f.feeding)) s.fastUntil = Math.max(s.fastUntil, Date.now() + 15_000);
    await PetkitLink.updateOne({ _id: userID }, { lastPoll: Date.now(), $unset: { lastError: 1 } });
    hub.emit('petkitUpdate', userID);
}

// what changed for the worse since the last read is told to the person, once
function tell(userID: string, s: Session, f: PetkitFeeder) {
    let told = s.told.get(f.id);
    if (!told) {
        told = { low: f.food === 'low', error: f.error, failed: new Set(f.meals.filter((m) => m.state === 'failed' || m.state === 'missed').map((m) => m.id)) };
        s.told.set(f.id, told);
        if (s.first) return;
    }
    const send = (title: string, text: string, email = true) =>
        void notifyUser(userID, { title, text, email, tag: 'bowl_with_spoon', path: f.cameraId ? `/camera/${f.cameraId}` : '/' }).catch((err) =>
            log.warn('feeder alert not sent', { user: userID, feeder: f.id }, err),
        );
    if (f.food === 'low' && !told.low) send(`${f.name}: food is running low`, `The hopper of ${f.name} is nearly empty. Fill it up before the next meal.`);
    told.low = f.food === 'low';
    if (f.error && f.error !== told.error) send(`${f.name}: ${f.error}`, `${f.name} reports a problem: ${f.error}.`);
    told.error = f.error;
    for (const m of f.meals) {
        if ((m.state === 'failed' || m.state === 'missed') && !told.failed.has(m.id)) {
            told.failed.add(m.id);
            send(
                `${f.name}: a meal was not given`,
                `The meal of ${mealTime(m.time)}${m.name ? ` (${m.name})` : ''} was not given${m.state === 'missed' ? ', the feeder did not start it' : ''}.`,
            );
        }
    }
}

async function tick() {
    const links = await PetkitLink.find({}, { _id: 1 }).lean();
    const now = Date.now();
    for (const { _id: userID } of links) {
        const s = session(userID);
        if (s.polling || now < s.nextPoll) continue;
        s.polling = true;
        s.nextPoll = now + (now < s.fastUntil ? FAST_POLL_MS : POLL_MS);
        poll(userID)
            .catch(async (err) => {
                s.error = (err as Error).message;
                log.warn('PetKit not read', { user: userID }, err);
                await PetkitLink.updateOne({ _id: userID }, { lastError: s.error }).catch(() => undefined);
                hub.emit('petkitUpdate', userID);
            })
            .finally(() => (s.polling = false));
    }
    for (const userID of sessions.keys()) if (!links.some((l) => l._id === userID)) sessions.delete(userID);
}

/* ----------------------------------------------------------------------- */

export async function connect(userID: string, email: string, password: string, region: string) {
    const creds = await login(email, password, region);
    const now = Date.now();
    await PetkitLink.updateOne(
        { _id: userID },
        { $set: { credentials: seal(creds), account: email, connectedAt: now }, $unset: { lastError: 1 }, $setOnInsert: { feeders: [] } },
        { upsert: true },
    );
    forgetSession(userID);
    sessions.delete(userID);
    const s = session(userID);
    s.first = false; // connected now: what is wrong already is told
    await refreshDevices(userID);
    await poll(userID).catch((err) => {
        s.error = (err as Error).message;
    });
    log.info('PetKit connected', { user: userID, region, feeders: s.feeders.size });
    return status(userID);
}

export async function disconnect(userID: string) {
    await PetkitLink.deleteOne({ _id: userID });
    forgetSession(userID);
    sessions.delete(userID);
    log.info('PetKit disconnected', { user: userID });
    hub.emit('petkitUpdate', userID);
}

export async function status(userID: string): Promise<PetkitStatus> {
    const link = await PetkitLink.findById(userID, { account: 1, feeders: 1, lastPoll: 1, lastError: 1 }).lean();
    if (!link) return { connected: false, feeders: [] };
    const s = session(userID);
    return {
        connected: true,
        account: link.account,
        // the camera as set now, also before the next read
        feeders: link.feeders.map((e) => s.feeders.get(e.id)).flatMap((f, i) => (f ? [{ ...f, cameraId: link.feeders[i].cameraId }] : [])),
        error: s.error ?? link.lastError,
        lastPoll: link.lastPoll,
    };
}

async function feederOf(userID: string, feederId: number) {
    const link = await PetkitLink.findById(userID, { feeders: 1 }).lean();
    const entry = link?.feeders.find((f) => f.id === feederId);
    if (!entry) throw new PetkitError('no such PetKit feeder', 404);
    return entry;
}

// after a command: read soon and often for a while, so the app shows what the feeder does
function soon(userID: string) {
    const s = session(userID);
    s.fastUntil = Date.now() + FAST_FOR_MS;
    s.nextPoll = Math.min(s.nextPoll, Date.now() + 2000);
}

// the day on the feeder's clock, as PetKit names a day's meals
const today = (userID: string, feederId: number) => feederClock(session(userID).zones.get(feederId)).day;

export async function feed(userID: string, feederId: number, portions: number, who: string, via = 'app') {
    if (!Number.isInteger(portions) || portions < PETKIT_PORTIONS.min || portions > PETKIT_PORTIONS.max) {
        throw new PetkitError(`${PETKIT_PORTIONS.min} to ${PETKIT_PORTIONS.max} portions`, 400);
    }
    const f = await feederOf(userID, feederId);
    await petkitRequest(userID, `${f.type}/saveDailyFeed`, {
        form: { day: today(userID, feederId), deviceId: f.id, name: '', time: '-1', amount: portions * PETKIT_PORTION_AMOUNT },
    });
    log.info('fed', { user: who, feeder: f.name, portions, via });
    soon(userID);
}

export async function cancelFeed(userID: string, feederId: number, who: string, via = 'app') {
    const f = await feederOf(userID, feederId);
    await petkitRequest(userID, `${f.type}/cancelRealtimeFeed`, { form: { day: today(userID, feederId), deviceId: f.id } });
    log.info('feed cancelled', { user: who, feeder: f.name, via });
    soon(userID);
}

// a meal of today's plan skipped, or given again after all
export async function skipMeal(userID: string, feederId: number, mealId: string, skip: boolean, who: string, via = 'app') {
    const f = await feederOf(userID, feederId);
    const meal = session(userID)
        .feeders.get(feederId)
        ?.meals.find((m) => m.id === mealId);
    if (!meal || meal.manual) throw new PetkitError('no such meal of the plan today', 404);
    if (skip ? meal.state !== 'planned' : meal.state !== 'skipped')
        throw new PetkitError(skip ? 'only a meal still to come can be skipped' : 'this meal is not skipped', 409);
    await petkitRequest(userID, `${f.type}/${skip ? 'removeDailyFeed' : 'restoreDailyFeed'}`, {
        form: { deviceId: f.id, day: today(userID, feederId), id: mealId },
    });
    log.info(skip ? 'meal skipped' : 'meal restored', { user: who, feeder: f.name, meal: mealTime(meal.time), via });
    soon(userID);
}

export async function pausePlan(userID: string, feederId: number, paused: boolean, who: string, via = 'app') {
    const f = await feederOf(userID, feederId);
    await petkitRequest(userID, `${f.type}/${paused ? 'suspendFeed' : 'restoreFeed'}`, { form: { deviceId: f.id } });
    log.info(paused ? 'plan paused' : 'plan resumed', { user: who, feeder: f.name, via });
    session(userID).plans.delete(feederId);
    soon(userID);
}

export async function resetDesiccant(userID: string, feederId: number, who: string) {
    const f = await feederOf(userID, feederId);
    await petkitRequest(userID, `${f.type}/desiccantReset`, { form: { deviceId: f.id } });
    log.info('desiccant reset', { user: who, feeder: f.name });
    soon(userID);
}

// the kibbl. cam that watches a feeder, or none; a camera watches one feeder at most
export async function watchWith(userID: string, feederId: number, cameraId: string | null) {
    await feederOf(userID, feederId);
    if (cameraId) {
        const cam = await Device.findOne({ _id: cameraId, ownerID: userID, status: 'approved', caps: 'camera' }, { _id: 1 }).lean();
        if (!cam) throw new PetkitError('no such camera', 404);
    }
    const link = await PetkitLink.findById(userID, { feeders: 1 }).lean();
    const feeders = link!.feeders.map((f) => ({
        ...f,
        cameraId: f.id === feederId ? (cameraId ?? undefined) : f.cameraId === cameraId ? undefined : f.cameraId,
    }));
    await PetkitLink.updateOne({ _id: userID }, { feeders });
    log.info('feeder camera', { user: userID, feeder: feederId, camera: cameraId ?? 'none' });
    hub.emit('petkitUpdate', userID);
}

/* ----------------------------------------------------------------------- */
/* The feeding plan. PetKit's d4 keeps seven days ({prefix}/feed: feedDailyList), each with
 * its weekday in repeats (1 is Sunday), its meals (time in seconds, amount in PetKit's units)
 * and suspended. A save sends all seven back ({prefix}/saveFeed) with the meals shaped as
 * PetKit's app writes them; what else a day carries is kept. */

const PLAN_FRESH_MS = 5 * 60_000;
const FAMILY_IDS: Record<string, number> = { d4: 11, d4h: 26 };
let planLogged = false;

// PetKit's weekday (1 Sunday) and ours (index 0 Monday)
const toIndex = (oem: number) => (oem + 5) % 7;
const toOem = (index: number) => ((index + 1) % 7) + 1;

/* eslint-disable @typescript-eslint/no-explicit-any */
function rawDays(raw: any): any[] {
    if (Array.isArray(raw?.feedDailyList)) return raw.feedDailyList;
    if (Array.isArray(raw)) return raw;
    return [];
}

function weekdaysOf(day: any): number[] {
    return String(day?.repeats ?? '')
        .split(',')
        .map((t) => Number(t.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
}

// the plan as kibbl. shows it, from what {prefix}/feed answers
export function planFrom(feederId: number, raw: any, factor = PETKIT_PORTION_AMOUNT): PetkitPlan {
    const days: PetkitPlanMeal[][] = Array.from({ length: 7 }, () => []);
    const list = rawDays(raw);
    for (const day of list) {
        const meals = ((day?.items ?? []) as any[])
            .map((i) => ({
                time: num(i?.time) ?? 0,
                portions: Math.max(1, Math.round((num(i?.amount) ?? 0) / factor)),
                name: typeof i?.name === 'string' ? i.name : '',
            }))
            .sort((a, b) => a.time - b.time);
        for (const oem of weekdaysOf(day)) days[toIndex(oem)] = meals;
    }
    return { feederId, paused: list.length > 0 && list.every((d) => num(d?.suspended) === 1), days };
}

// the seven days to save: the meals of each in PetKit's shape, the rest of a day as it was
export function feedDailyListFor(raw: any, days: PetkitPlanMeal[][], deviceId: number, typeId: number, factor = PETKIT_PORTION_AMOUNT) {
    const before = rawDays(raw);
    const paused = before.length > 0 && before.every((d) => num(d?.suspended) === 1);
    return days.map((meals, index) => {
        const oem = toOem(index);
        const old = before.find((d) => weekdaysOf(d).length === 1 && weekdaysOf(d)[0] === oem);
        const ids = new Map<number, unknown>(((old?.items ?? []) as any[]).map((i) => [num(i?.time) ?? -1, i?.id]));
        const items = [...meals]
            .sort((a, b) => a.time - b.time)
            .map((m) => ({
                amount: m.portions * factor,
                amount1: 0,
                amount2: 0,
                deviceId,
                deviceType: typeId,
                id: ids.get(m.time) || m.time,
                name: m.name,
                petAmount: [],
                time: m.time,
            }));
        return {
            ...(old ?? { repeats: String(oem), suspended: paused ? 1 : 0 }),
            items,
            count: items.length,
            totalAmount: items.reduce((sum, i) => sum + i.amount, 0),
        };
    });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function rawPlan(userID: string, entry: { id: number; type: string }) {
    const raw = await petkitRequest<unknown>(userID, `${entry.type}/feed`, { query: { deviceId: entry.id } });
    // what PetKit sends for a plan, once per start: for when a value is not where it is expected
    if (!planLogged) {
        planLogged = true;
        log.info('PetKit plan as sent', { first: JSON.stringify(raw ?? null).slice(0, 1500) });
    }
    return raw;
}

export async function getPlan(userID: string, feederId: number, fresh = false) {
    const s = session(userID);
    const cached = s.plans.get(feederId);
    if (!fresh && cached && Date.now() - cached.at < PLAN_FRESH_MS) return cached.plan;
    const entry = await feederOf(userID, feederId);
    const plan = planFrom(feederId, await rawPlan(userID, entry), s.factors.get(feederId));
    s.plans.set(feederId, { plan, at: Date.now() });
    return plan;
}

// the meals of all seven days, Monday first; a day's meals are checked as PetKit's app does
export async function savePlan(userID: string, feederId: number, days: PetkitPlanMeal[][], who: string, via = 'app') {
    if (!Array.isArray(days) || days.length !== 7) throw new PetkitError('seven days, Monday first', 400);
    for (const [i, meals] of days.entries()) {
        const problem = Array.isArray(meals) ? dayProblem(meals) : 'a list of meals';
        if (problem) throw new PetkitError(`${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]}: ${problem}`, 400);
    }
    const entry = await feederOf(userID, feederId);
    const s = session(userID);
    const factor = s.factors.get(feederId) ?? PETKIT_PORTION_AMOUNT;
    const raw = await rawPlan(userID, entry);
    const list = feedDailyListFor(raw, days, entry.id, entry.typeId ?? FAMILY_IDS[entry.type] ?? 0, factor);
    await petkitRequest(userID, `${entry.type}/saveFeed`, { form: { deviceId: entry.id, feedDailyList: JSON.stringify(list) } });
    s.plans.delete(feederId);
    log.info('plan saved', {
        user: who,
        feeder: entry.name,
        meals: days.map((d) => d.map((m) => `${mealTime(m.time)}×${m.portions}`).join(' ') || '-').join(' | '),
        via,
    });
    soon(userID);
    return getPlan(userID, feederId, true);
}

// the PetKit feeder a camera watches
export async function feederWatchedBy(deviceId: string) {
    const link = await PetkitLink.findOne({ 'feeders.cameraId': deviceId }, { feeders: 1 }).lean();
    const entry = link?.feeders.find((f) => f.cameraId === deviceId);
    return link && entry ? { userID: link._id, feeder: session(link._id).feeders.get(entry.id), name: entry.name } : undefined;
}

export function initPetkit() {
    setInterval(() => void tick().catch((err) => log.warn('PetKit round failed', undefined, err)), TICK_MS);
    void tick().catch(() => undefined);
}
