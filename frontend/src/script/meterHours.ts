/* Consumption per hour from the readings of a meter (every 30 min, in 0.1 kWh steps). Only
 * rises above the highest value so far count: the meter sometimes reports a lower value for
 * a while (a misread), which is no negative consumption and must not count twice when it
 * comes back. A rise is spread over the time since the reading before, so a step that spans
 * an hour boundary is shared by both hours. */

const HOUR_MS = 3600_000;

export interface HourBucket {
    start: number; // the hour's start, local time
    consumption: number;
}

export function hourlyConsumption(readings: { at: number; value: number | null }[], hours: number, now = Date.now()): HourBucket[] {
    const end = new Date(now);
    end.setMinutes(0, 0, 0);
    const first = end.getTime() - (hours - 1) * HOUR_MS;
    const buckets: HourBucket[] = Array.from({ length: hours }, (_, i) => ({ start: first + i * HOUR_MS, consumption: 0 }));

    let top: number | undefined; // the highest value so far
    let topAt = 0;
    for (const r of [...readings].sort((a, b) => a.at - b.at)) {
        if (r.value === null) continue;
        if (top === undefined) {
            top = r.value;
            topAt = r.at;
            continue;
        }
        if (r.value <= top) continue;
        const rise = r.value - top;
        // spread over (topAt, r.at]
        const span = r.at - topAt;
        for (const b of buckets) {
            const overlap = Math.min(r.at, b.start + HOUR_MS) - Math.max(topAt, b.start);
            if (overlap > 0) b.consumption += (rise * overlap) / span;
        }
        top = r.value;
        topAt = r.at;
    }
    return buckets;
}
