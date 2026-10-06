import type { ActivityBucket } from '../../../shared/protocol';
import { localDayKey } from './utils';

// fewer days than this make no "usual" day: the bands would only repeat those days
export const MIN_BASELINE_DAYS = 3;

export interface HourQuantiles {
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
}

/* Quantile of sorted values, linear between the two closest ranks (the default of R,
 * NumPy and spreadsheets), so 3 days of 0, 2 and 4 events have a median of 2. */
export function quantile(sorted: number[], q: number) {
    if (sorted.length === 0) return 0;
    const pos = (sorted.length - 1) * q;
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

// the local day keys of the last `days` days up to today, oldest first
export function windowDays(days: number, now = Date.now()) {
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - i);
        keys.push(localDayKey(d.getTime()));
    }
    return keys;
}

/* The days a selected day is compared with: the days of the window from the first one
 * with any motion (before it the camera did not exist yet, those zeros are no routine),
 * without the selected day itself and without today, which is not over yet. */
export function baselineDays(buckets: ActivityBucket[], windowDays: string[], selectedDay: string, today: string) {
    const withData = new Set(buckets.filter((b) => b.count > 0).map((b) => b.day));
    const sorted = [...windowDays].sort();
    const first = sorted.findIndex((day) => withData.has(day));
    if (first < 0) return [];
    return sorted.slice(first).filter((day) => day !== selectedDay && day !== today);
}

// per hour of the day: how many motion events the baseline days had, as quantiles
export function hourlyQuantiles(buckets: ActivityBucket[], days: string[]): HourQuantiles[] {
    const counts = new Map(buckets.map((b) => [`${b.day} ${b.hour}`, b.count]));
    return Array.from({ length: 24 }, (_, hour) => {
        const values = days.map((day) => counts.get(`${day} ${hour}`) ?? 0).sort((a, b) => a - b);
        return {
            p10: quantile(values, 0.1),
            p25: quantile(values, 0.25),
            p50: quantile(values, 0.5),
            p75: quantile(values, 0.75),
            p90: quantile(values, 0.9),
        };
    });
}
