import type { HeatSpread } from '../../../shared/heat';

/* The consumption of a heat meter per day, from readings days or months apart: what was used
 * between two readings goes to the days after the first up to the day of the second, in the
 * share each day had of the heating. Pure, for the tests. */

const DAY_MS = 24 * 3600_000;

// YYYY-MM-DD keys from..to, both included (calendar days, no time zone)
export function dayKeys(from: string, to: string) {
    const keys: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) keys.push(new Date(t).toISOString().slice(0, 10));
    return keys;
}

export const nextDay = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/* Degree days as VDI 3807 counts them (G20/15): a day below 15 °C outside is heated, by the
 * difference of its mean to 20 °C inside. */
export function degreeDay(outside: number) {
    return outside < 15 ? 20 - outside : 0;
}

// what a device used from one reading to the next; lower than before: it was reset (a new year), counted from 0
export function used(before: number, after: number) {
    return after >= before ? after - before : after;
}

export interface Spread {
    use: Map<string, number>;
    how: Map<string, HeatSpread>;
}

/* Per day: tado's heating hours of the room when they cover every day of the interval, else
 * the degree days when the weather covers it, else the same for every day. A source whose
 * days sum to nothing (no heating at all) gives way to the next. */
export function spread(readings: { date: string; value: number }[], tado?: Map<string, number>, outside?: Map<string, number>): Spread {
    const out: Spread = { use: new Map(), how: new Map() };
    const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
        const days = dayKeys(nextDay(sorted[i - 1].date), sorted[i].date);
        const amount = used(sorted[i - 1].value, sorted[i].value);
        const candidates: [HeatSpread, number[] | undefined][] = [
            ['tado', tado && days.every((d) => tado.has(d)) ? days.map((d) => tado.get(d)!) : undefined],
            ['weather', outside && days.every((d) => outside.has(d)) ? days.map((d) => degreeDay(outside.get(d)!)) : undefined],
            ['even', days.map(() => 1)],
        ];
        const [how, weights] = candidates.find(([, w]) => w && w.reduce((s, v) => s + v, 0) > 0) as [HeatSpread, number[]];
        const total = weights.reduce((s, v) => s + v, 0);
        days.forEach((d, j) => {
            out.use.set(d, (amount * weights[j]) / total);
            out.how.set(d, how);
        });
    }
    return out;
}
