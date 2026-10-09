/*
 * The checks of the analysis that work on series, pure for the tests (service.ts reads the
 * data and words the findings). Each compares the latest days with the person's own usual,
 * never with a population norm.
 */

const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined);
const median = (v: number[]) => {
    if (!v.length) return undefined;
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/* The mean of the last `recent` days against the `baseline` days before them, of a daily
 * series ({ date, value }); undefined without enough of either. */
export function recentVsUsual(series: { date: string | null; value?: unknown }[], today: string, recent = 7, baseline = 28) {
    const day = (offset: number) => new Date(Date.parse(`${today}T12:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
    const recentFrom = day(recent - 1);
    const baseFrom = day(recent + baseline - 1);
    const values = (from: string, to: string) =>
        series.filter((p) => p.date && p.date >= from && p.date <= to && typeof p.value === 'number').map((p) => p.value as number);
    const r = values(recentFrom, today);
    const b = values(baseFrom, day(recent));
    if (r.length < Math.ceil(recent / 2) || b.length < Math.ceil(baseline / 3)) return undefined;
    return { recent: mean(r)!, usual: mean(b)!, days: r.length };
}

/* A meter's latest complete day against the median of the 4 weeks before it. */
export function dayVsUsual(days: { key: string; consumption: number | null }[], today: string) {
    const done = days.filter((d) => d.key < today && typeof d.consumption === 'number');
    if (done.length < 15) return undefined;
    const last = done[done.length - 1];
    const usual = median(done.slice(-29, -1).map((d) => d.consumption as number))!;
    if (usual <= 0) return undefined;
    return { day: last.key, use: last.consumption as number, usual, ratio: (last.consumption as number) / usual };
}

/* What runs all the time (standby, fridge, router): the mean power from 01:00 to 05:00, when
 * little else does, the median over the nights; W. A meter counting in 0.1 kWh steps shows it
 * well over a few nights. */
export function baseLoad(readings: { at: number; value: number | null }[], local: (t: number) => { day: string; hour: number }) {
    const nights = new Map<string, { at: number; value: number }[]>();
    for (const r of readings) {
        if (r.value === null) continue;
        const l = local(r.at);
        if (l.hour < 1 || l.hour >= 5) continue;
        if (!nights.has(l.day)) nights.set(l.day, []);
        nights.get(l.day)!.push({ at: r.at, value: r.value });
    }
    const watts: number[] = [];
    for (const list of nights.values()) {
        list.sort((a, b) => a.at - b.at);
        const first = list[0];
        const last = list[list.length - 1];
        const hours = (last.at - first.at) / 3_600_000;
        if (hours < 3 || last.value < first.value) continue;
        watts.push(((last.value - first.value) / hours) * 1000);
    }
    return watts.length >= 3 ? { watts: Math.round(median(watts)!), nights: watts.length } : undefined;
}

/* Two thermometers in one room (a kibbl. air and tado's) over the same hours: the mean
 * difference, air minus tado; undefined without enough of both. */
export function thermometerGap(air: { at: number; temperature: number }[], tado: { at: number; temperature?: number }[]) {
    const t = tado.filter((x) => typeof x.temperature === 'number').sort((a, b) => a.at - b.at);
    const diffs: number[] = [];
    for (const p of t) {
        const near = air.filter((a) => Math.abs(a.at - p.at) <= 5 * 60_000);
        const m = mean(near.map((a) => a.temperature));
        if (m !== undefined) diffs.push(m - p.temperature!);
    }
    return diffs.length >= 6 ? { gap: median(diffs)!, samples: diffs.length } : undefined;
}
