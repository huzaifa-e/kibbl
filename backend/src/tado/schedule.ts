import { SCHEDULE_LAYOUTS, type HeatingSchedule, type ScheduleBlock, type ScheduleDay, type ScheduleLayout } from '../../../shared/heating';
import { TadoLink } from '../core/db';
import { logger } from '../core/logger';
import { HOPS_API, MY_API, TadoError, tadoRequest } from './client';
import { readSoon } from './service';

/*
 * The weekly schedules of tado's rooms (PyTado: zones/{id}/schedule on my.tado.com, rooms/{id}/schedule
 * on hops.tado.com). Classic homes keep three timetables per room and use one (activeTimetable);
 * a day is changed by sending all its blocks, ending at 00:00. tado X sends the whole schedule
 * in one request and takes a day at a time, ending at 24:00.
 *
 * A schedule costs 1 (tado X) or 2 (classic) requests of the daily budget: it is kept for
 * CACHE_MS, so a change made in tado's own app shows here after that at the latest. Changing days
 * costs one request each, and on classic one more (which timetable is active).
 */

const log = logger('tado');

const CACHE_MS = 15 * 60_000;
const CLASSIC_TIMETABLE: Record<ScheduleLayout, number> = { one_day: 0, three_day: 1, seven_day: 2 };
const MIN_C = 5;
const MAX_C = 25;

const cache = new Map<string, { at: number; schedule: HeatingSchedule }>(); // userID|roomId

/* eslint-disable @typescript-eslint/no-explicit-any */
// tado's blocks, classic or tado X, as days in the order of the layout
export function scheduleOf(layout: ScheduleLayout, raw: any[]): HeatingSchedule {
    const days = SCHEDULE_LAYOUTS[layout].map((day) => ({
        day: day as ScheduleDay,
        blocks: raw
            .filter((b) => b?.dayType === day)
            .map((b) => {
                const on = b?.setting?.power === 'ON';
                const t = b?.setting?.temperature;
                const celsius = on ? (typeof t?.celsius === 'number' ? t.celsius : typeof t?.value === 'number' ? t.value : null) : null;
                return { start: String(b.start), end: b.end === '00:00' ? '24:00' : String(b.end), celsius };
            })
            .sort((a, b) => a.start.localeCompare(b.start)),
    }));
    return { layout, days };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// the layout of a tado X schedule, from the days it has
export function layoutOf(dayTypes: string[]): ScheduleLayout {
    const has = new Set(dayTypes);
    const fits = (l: ScheduleLayout) => SCHEDULE_LAYOUTS[l].length === has.size && SCHEDULE_LAYOUTS[l].every((d) => has.has(d));
    return (Object.keys(SCHEDULE_LAYOUTS) as ScheduleLayout[]).find(fits) ?? 'seven_day';
}

const clock = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
};

/* A day from when each block starts: the first at 00:00, each until the next starts, the last
 * until midnight. Throws a TadoError naming what is wrong. */
export function dayBlocks(starts: { from: string; celsius: number | null }[]): ScheduleBlock[] {
    if (!starts.length) throw new TadoError('A day needs at least one block, from 00:00.');
    const blocks: ScheduleBlock[] = [];
    for (const s of starts) {
        const start = clock(s.from);
        if (!start) throw new TadoError(`"${s.from}" is not a time (HH:MM, 00:00-23:59).`);
        const prev = blocks[blocks.length - 1];
        if (!prev && start !== '00:00') throw new TadoError('The first block starts at 00:00.');
        if (prev && start <= prev.start) throw new TadoError(`The blocks go in order of time: ${start} comes after ${prev.start}.`);
        if (s.celsius !== null && (s.celsius < MIN_C || s.celsius > MAX_C)) throw new TadoError(`${s.celsius} °C is outside ${MIN_C}-${MAX_C} °C.`);
        if (prev) prev.end = start;
        blocks.push({ start, end: '24:00', celsius: s.celsius === null ? null : Math.round(s.celsius * 2) / 2 });
    }
    return blocks;
}

// a day's blocks as tado takes them
export function tadoBlocks(day: ScheduleDay, blocks: ScheduleBlock[], x: boolean) {
    return blocks.map((b) => {
        const on = b.celsius !== null;
        const temperature = on ? (x ? { value: b.celsius } : { celsius: b.celsius }) : null;
        return {
            dayType: day,
            start: b.start,
            end: !x && b.end === '24:00' ? '00:00' : b.end,
            geolocationOverride: false,
            setting: x ? { power: on ? 'ON' : 'OFF', temperature } : { type: 'HEATING', power: on ? 'ON' : 'OFF', temperature },
        };
    });
}

/* ----------------------------------------------------------------------- */

async function linkFor(userID: string, roomId: number, spend = true) {
    const link = await TadoLink.findById(userID, { homeId: 1, generation: 1, rooms: 1, rateRemaining: 1 }).lean();
    if (!link?.homeId) throw new TadoError('tado is not connected');
    if (!link.rooms.some((r) => r.id === roomId)) throw new TadoError('no such tado room', 404);
    if (spend && link.rateRemaining !== undefined && link.rateRemaining <= 0) throw new TadoError('tado allows no more requests today', 429);
    return { homeId: link.homeId, x: link.generation === 'x' };
}

async function activeLayout(userID: string, homeId: number, roomId: number): Promise<ScheduleLayout> {
    const res = await tadoRequest<{ id?: number }>(userID, 'GET', `${MY_API}/homes/${homeId}/zones/${roomId}/schedule/activeTimetable`);
    const layout = (Object.keys(CLASSIC_TIMETABLE) as ScheduleLayout[]).find((l) => CLASSIC_TIMETABLE[l] === res.data.id);
    if (!layout) throw new TadoError(`tado sent an unknown timetable (${String(res.data.id)})`);
    return layout;
}

// a room's schedule, from the cache when it is fresh
export async function getSchedule(userID: string, roomId: number, fresh = false): Promise<HeatingSchedule> {
    const key = `${userID}|${roomId}`;
    const hit = cache.get(key);
    const cached = !fresh && hit && Date.now() - hit.at < CACHE_MS;
    const { homeId, x } = await linkFor(userID, roomId, !cached);
    if (cached) return hit.schedule;
    let schedule: HeatingSchedule;
    if (x) {
        const res = await tadoRequest<{ schedule?: unknown[] }>(userID, 'GET', `${HOPS_API}/homes/${homeId}/rooms/${roomId}/schedule`);
        const raw = Array.isArray(res.data.schedule) ? (res.data.schedule as { dayType?: string }[]) : [];
        schedule = scheduleOf(layoutOf([...new Set(raw.map((b) => String(b.dayType)))]), raw);
    } else {
        const layout = await activeLayout(userID, homeId, roomId);
        const res = await tadoRequest<unknown[]>(
            userID,
            'GET',
            `${MY_API}/homes/${homeId}/zones/${roomId}/schedule/timetables/${CLASSIC_TIMETABLE[layout]}/blocks`,
        );
        schedule = scheduleOf(layout, Array.isArray(res.data) ? res.data : []);
    }
    cache.set(key, { at: Date.now(), schedule });
    return schedule;
}

/* Gives days of a room's schedule these blocks (days of its layout: MONDAY_TO_FRIDAY with
 * three_day), one request each. layout switches a classic home's room to another of its
 * timetables first; on tado X the layout is the one its app made. Answers the schedule as it
 * is then. */
export async function setScheduleDays(userID: string, roomId: number, days: ScheduleDay[], blocks: ScheduleBlock[], layout?: ScheduleLayout) {
    const { homeId, x } = await linkFor(userID, roomId);
    let current: ScheduleLayout;
    if (x) {
        current = (await getSchedule(userID, roomId)).layout;
        if (layout && layout !== current) throw new TadoError(`tado X keeps the layout of its app (${current}); change it there.`);
    } else {
        current = layout ?? (await activeLayout(userID, homeId, roomId));
    }
    const allowed: readonly string[] = SCHEDULE_LAYOUTS[current];
    const wrong = days.filter((d) => !allowed.includes(d));
    if (wrong.length) throw new TadoError(`The schedule is ${current}: its days are ${allowed.join(', ')} (not ${wrong.join(', ')}).`);

    // not kept while it changes: a request that fails part way leaves it to be read again
    const key = `${userID}|${roomId}`;
    const hit = cache.get(key);
    cache.delete(key);
    if (!x && layout) {
        await tadoRequest(userID, 'PUT', `${MY_API}/homes/${homeId}/zones/${roomId}/schedule/activeTimetable`, { id: CLASSIC_TIMETABLE[layout] });
    }
    for (const day of days) {
        const body = tadoBlocks(day, blocks, x);
        if (x) await tadoRequest(userID, 'POST', `${HOPS_API}/homes/${homeId}/rooms/${roomId}/schedule`, { dayType: day, daySchedule: body });
        else
            await tadoRequest(userID, 'PUT', `${MY_API}/homes/${homeId}/zones/${roomId}/schedule/timetables/${CLASSIC_TIMETABLE[current]}/blocks/${day}`, body);
    }
    log.info('schedule changed', { user: userID, room: roomId, layout: current, days: days.join(','), blocks: blocks.length });

    // what the room heats to now may follow from the new schedule
    readSoon(userID);
    if (hit && hit.schedule.layout === current) {
        const schedule = { layout: current, days: hit.schedule.days.map((d) => (days.includes(d.day) ? { day: d.day, blocks } : d)) };
        cache.set(key, { at: Date.now(), schedule });
        return schedule;
    }
    return getSchedule(userID, roomId);
}
