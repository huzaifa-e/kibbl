import { dayKeys, degreeDay, nextDay, used } from './estimate';

/*
 * What the heat data says about the radiators and rooms, as pure functions for the tests
 * (insights.ts gathers the data and words the findings). The thresholds are deliberately
 * coarse: a finding is a hint to look at a radiator or a window, not a measurement.
 */

const HOUR_MS = 3600_000;
const SAMPLE_MAX_MS = 30 * 60_000; // a reading stands for the time until the next one, at most this long

export interface Interval {
    from: string; // the first day it covers
    to: string; // the day of the second reading
    days: number;
    use: number; // in the meter's unit, without its factor
    degreeDays?: number; // undefined when the weather of a day is missing
}

// the use between consecutive readings with the degree days of the same days
export function intervals(readings: { date: string; value: number }[], outside: Map<string, number>): Interval[] {
    const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date));
    const out: Interval[] = [];
    for (let i = 1; i < sorted.length; i++) {
        const days = dayKeys(nextDay(sorted[i - 1].date), sorted[i].date);
        const temps = days.map((d) => outside.get(d));
        out.push({
            from: days[0],
            to: sorted[i].date,
            days: days.length,
            use: used(sorted[i - 1].value, sorted[i].value),
            degreeDays: temps.every((t) => t !== undefined) ? temps.reduce((s, t) => s + degreeDay(t!), 0) : undefined,
        });
    }
    return out;
}

const MIN_DEGREE_DAYS = 20; // an interval colder than this tells how a radiator follows the weather
const UNUSUAL_RATIO = 1.4;

const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* The latest interval's use per degree day against the usual of the earlier ones: a radiator
 * that needs much more for the same cold (a thermostat turned up, a window left tilted, a valve
 * that no longer closes). */
export function weatherIntensity(list: Interval[]) {
    const cold = list.filter((i) => i.degreeDays !== undefined && i.degreeDays >= MIN_DEGREE_DAYS);
    if (cold.length < 3) return undefined;
    const rate = (i: Interval) => i.use / i.degreeDays!;
    const latest = cold[cold.length - 1];
    const usual = median(cold.slice(0, -1).map(rate));
    if (usual <= 0) return undefined;
    return { latest, ratio: rate(latest) / usual, unusual: rate(latest) / usual >= UNUSUAL_RATIO };
}

const WARM_DEGREE_DAYS_PER_DAY = 1; // a day this warm needs no heating
const WARM_USE_PER_DAY = 0.5;
const WARM_MIN_DAYS = 7;

/* An interval of warm weather in which the radiator still counted: its valve may not close (a
 * stuck valve pin) or its thermostat is set to heat anyway. */
export function warmUse(list: Interval[]) {
    return [...list]
        .reverse()
        .find(
            (i) =>
                i.days >= WARM_MIN_DAYS && i.degreeDays !== undefined && i.degreeDays / i.days < WARM_DEGREE_DAYS_PER_DAY && i.use / i.days >= WARM_USE_PER_DAY,
        );
}

/* ----------------------------------------------------------------------- */

export interface Span {
    from: number;
    to: number;
}

// the time each sample stands for: until the next one, at most SAMPLE_MAX_MS
function eachSample<T extends { at: number }>(samples: T[], fn: (s: T, from: number, to: number) => void) {
    const sorted = [...samples].sort((a, b) => a.at - b.at);
    sorted.forEach((s, i) => fn(s, s.at, Math.min(sorted[i + 1]?.at ?? s.at + SAMPLE_MAX_MS, s.at + SAMPLE_MAX_MS)));
}

const overlap = (a: Span, from: number, to: number) => Math.max(0, Math.min(a.to, to) - Math.max(a.from, from));

// hours tado heated (power above 0) while a window of the room was open
export function heatingWhileOpen(open: Span[], tado: { at: number; heating: number }[]) {
    let ms = 0;
    eachSample(tado, (s, from, to) => {
        if (s.heating > 0) for (const o of open) ms += overlap(o, from, to);
    });
    return ms / HOUR_MS;
}

const COLD_OUTSIDE = 12; // °C, a day's mean below this: an open window costs heat

// hours a window stood open on cold days
export function openOnColdDays(open: Span[], outside: Map<string, number>, dayOf: (t: number) => string) {
    let ms = 0;
    for (const o of open) {
        const t = outside.get(dayOf(o.from));
        if (t !== undefined && t < COLD_OUTSIDE) ms += o.to - o.from;
    }
    return ms / HOUR_MS;
}

const FULL_POWER = 60; // % heating power
const BELOW_TARGET = 1; // °C

/* Hours tado heated hard while the room stayed well below what it heats to: air in the
 * radiator (it wants bleeding), a valve that does not open fully, or a radiator too small
 * for the room. */
export function heatingButCold(tado: { at: number; heating: number; temperature?: number; target?: number | null }[]) {
    let ms = 0;
    eachSample(tado, (s, from, to) => {
        if (s.heating >= FULL_POWER && typeof s.target === 'number' && typeof s.temperature === 'number' && s.temperature <= s.target - BELOW_TARGET) {
            ms += to - from;
        }
    });
    return ms / HOUR_MS;
}

/* ----------------------------------------------------------------------- */

const NIGHT_FROM = 0;
const NIGHT_TO = 5; // hours of the night measured, when nobody opens a window or cooks
const MIN_DIFFERENCE = 3; // °C inside above the day's mean outside (the night is colder), for the loss to show
const MIN_SAMPLES = 60;

/* How fast a room loses heat at night: the fall of its temperature per hour over the difference
 * to outside (1/h), a value per night, the median of them. Nights with an open window are left
 * out. A room heated at night looks tighter than it is, never leakier, so a room that loses heat
 * clearly faster than the others is worth a look at its windows and doors. */
export function nightLoss(
    samples: { at: number; temperature: number }[],
    outside: Map<string, number>,
    open: Span[],
    local: (t: number) => { day: string; hour: number },
) {
    const nights = new Map<string, { at: number; temperature: number }[]>();
    for (const s of samples) {
        const l = local(s.at);
        if (l.hour < NIGHT_FROM || l.hour >= NIGHT_TO) continue;
        if (!nights.has(l.day)) nights.set(l.day, []);
        nights.get(l.day)!.push(s);
    }
    const values: number[] = [];
    for (const [day, list] of nights) {
        const out = outside.get(day);
        if (out === undefined || list.length < MIN_SAMPLES) continue;
        const from = Math.min(...list.map((s) => s.at));
        const to = Math.max(...list.map((s) => s.at));
        if (open.some((o) => overlap(o, from, to) > 0)) continue;
        // least squares slope in °C per hour
        const n = list.length;
        const mx = list.reduce((s, p) => s + p.at, 0) / n;
        const my = list.reduce((s, p) => s + p.temperature, 0) / n;
        const sxx = list.reduce((s, p) => s + (p.at - mx) ** 2, 0);
        if (!sxx) continue;
        const slope = (list.reduce((s, p) => s + (p.at - mx) * (p.temperature - my), 0) / sxx) * HOUR_MS;
        if (my - out < MIN_DIFFERENCE) continue;
        values.push(Math.max(0, -slope) / (my - out));
    }
    return values.length >= 3 ? { perHour: median(values), nights: values.length } : undefined;
}
