import { quantile } from './activityStats';

/* Numbers for the health page that are worth a test: trends, the quantile bands of the
 * sleep stages (whoofit's sleep fan) and the thinning of a day of heart rate. */

export interface SeriesPoint {
    date: string;
    value: number | null;
}

export type Direction = 'up' | 'down' | 'flat';

/* The latest value against the mean of the 7 before it. Whether a change is good depends
 * on the metric: a lower resting heart rate is, a higher HRV is; breathing should not move. */
export function trend(series: SeriesPoint[], good: Direction) {
    const values = series.filter((p): p is { date: string; value: number } => typeof p.value === 'number');
    if (!values.length) return undefined;
    const latest = values[values.length - 1];
    const before = values.slice(-8, -1).map((p) => p.value);
    if (!before.length) return { latest, average: null, delta: null, verdict: 'neutral' as const };
    const average = before.reduce((s, v) => s + v, 0) / before.length;
    const delta = latest.value - average;
    // within 2 % of the average is no change worth a colour
    const small = Math.abs(delta) <= Math.abs(average) * 0.02;
    let verdict: 'good' | 'bad' | 'neutral' = 'neutral';
    if (!small) {
        if (good === 'flat') verdict = 'bad';
        else verdict = delta > 0 === (good === 'up') ? 'good' : 'bad';
    }
    return { latest, average, delta, verdict };
}

/* ----------------------------------------------------------------------- */

export const SLEEP_BIN = 30; // minutes per bin of the sleep quantile bands

export interface SleepNight {
    date: string;
    seg?: { st: string; s: number; e: number }[]; // minutes since 18:00
}

export interface StageQuantiles {
    bin: number; // minutes since 18:00
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    nights: number;
}

/* Minutes of one sleep stage per 30-minute bin of the night, as quantiles over the
 * nights that were asleep in that bin. A bin needs 3 nights, else it is left out. */
export function sleepStageQuantiles(nights: SleepNight[], stage: string, bin = SLEEP_BIN): StageQuantiles[] {
    const perNight: { start: number; end: number; bins: Map<number, number> }[] = [];
    let first = Infinity;
    let last = -Infinity;
    for (const n of nights) {
        if (!n.seg?.length) continue;
        const start = Math.min(...n.seg.map((s) => s.s));
        const end = Math.max(...n.seg.map((s) => s.e));
        first = Math.min(first, start);
        last = Math.max(last, end);
        const bins = new Map<number, number>();
        for (const s of n.seg.filter((x) => x.st === stage)) {
            for (let b = Math.floor(s.s / bin) * bin; b < s.e; b += bin) {
                const overlap = Math.max(0, Math.min(s.e, b + bin) - Math.max(s.s, b));
                if (overlap > 0) bins.set(b, (bins.get(b) ?? 0) + overlap);
            }
        }
        perNight.push({ start, end, bins });
    }
    if (last < first) return [];

    const out: StageQuantiles[] = [];
    for (let b = Math.floor(first / bin) * bin; b < Math.ceil(last / bin) * bin; b += bin) {
        // only the nights asleep during this bin: a night that ended counts as nothing, not zero
        const values = perNight.filter((n) => b + bin > n.start && b < n.end).map((n) => n.bins.get(b) ?? 0);
        if (values.length < 3) continue;
        values.sort((x, y) => x - y);
        out.push({
            bin: b,
            p10: quantile(values, 0.1),
            p25: quantile(values, 0.25),
            p50: quantile(values, 0.5),
            p75: quantile(values, 0.75),
            p90: quantile(values, 0.9),
            nights: values.length,
        });
    }
    return out;
}

// minutes since 18:00 as a clock time
export function clockLabel(minutesFrom18: number) {
    const m = Math.round(minutesFrom18 + 1080) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ----------------------------------------------------------------------- */

export function secondsOfDay(t: string) {
    const [h, m, s] = t.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

/* A day of heart rate (a sample every few seconds, ~37 000) as one point per minute
 * with that minute's lowest, mean and highest value: a chart stays quick, a short peak
 * still shows in the range. */
export function perMinute(points: { t: string; value: number }[]) {
    const minutes = new Map<number, { sum: number; n: number; min: number; max: number }>();
    for (const p of points) {
        const minute = Math.floor(secondsOfDay(p.t) / 60);
        const m = minutes.get(minute) ?? { sum: 0, n: 0, min: Infinity, max: -Infinity };
        m.sum += p.value;
        m.n++;
        m.min = Math.min(m.min, p.value);
        m.max = Math.max(m.max, p.value);
        minutes.set(minute, m);
    }
    return [...minutes.keys()]
        .sort((a, b) => a - b)
        .map((minute) => {
            const m = minutes.get(minute)!;
            return { minute, mean: Math.round((m.sum / m.n) * 10) / 10, min: m.min, max: m.max };
        });
}
