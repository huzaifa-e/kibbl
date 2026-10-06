import { describe, expect, test } from 'vitest';
import { clockLabel, perMinute, sleepStageQuantiles, trend } from './healthStats';

const series = (...values: number[]) => values.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value }));

describe('trend', () => {
    test('a lower resting heart rate is good, a higher one bad', () => {
        expect(trend(series(60, 60, 60, 60, 55), 'down')?.verdict).toBe('good');
        expect(trend(series(60, 60, 60, 60, 66), 'down')?.verdict).toBe('bad');
    });
    test('within 2 % of the week is no change', () => {
        expect(trend(series(50, 50, 50, 50.5), 'up')?.verdict).toBe('neutral');
    });
    test('a metric that should stay flat is bad when it moves either way', () => {
        expect(trend(series(15, 15, 15, 17), 'flat')?.verdict).toBe('bad');
        expect(trend(series(15, 15, 15, 13), 'flat')?.verdict).toBe('bad');
    });
    test('compares with the mean of the 7 values before the latest, nulls skipped', () => {
        const t = trend([...series(1, 10, 10, 10, 10, 10, 10, 10), { date: '2026-10-20', value: null }, { date: '2026-10-21', value: 12 }], 'up')!;
        expect(t.average).toBe(10);
        expect(t.latest.value).toBe(12);
        expect(t.delta).toBe(2);
    });
    test('one value has no trend, none has nothing', () => {
        expect(trend(series(7), 'up')?.verdict).toBe('neutral');
        expect(trend([], 'up')).toBeUndefined();
    });
});

describe('sleepStageQuantiles', () => {
    // three nights 23:00-07:00 (300-780 min after 18:00) with deep sleep 00:00-01:00, 00:30-01:00 and none
    const night = (date: string, deep: [number, number][]) => ({
        date,
        seg: [{ st: 'LIGHT', s: 300, e: 780 }, ...deep.map(([s, e]) => ({ st: 'DEEP', s, e }))],
    });
    const nights = [night('a', [[360, 420]]), night('b', [[390, 420]]), night('c', [])];

    test('minutes of the stage per 30-minute bin, as quantiles over the nights', () => {
        const q = sleepStageQuantiles(nights, 'DEEP');
        const at = (bin: number) => q.find((x) => x.bin === bin)!;
        // 00:00-00:30: 30, 0, 0 minutes
        expect(at(360)).toMatchObject({ p50: 0, p90: 24, nights: 3 });
        // 00:30-01:00: 30, 30, 0
        expect(at(390)).toMatchObject({ p10: 6, p50: 30, p90: 30 });
        expect(at(300).p90).toBe(0);
        expect(q[0].bin).toBe(300);
        expect(q[q.length - 1].bin).toBe(750);
    });
    test('a bin with fewer than 3 nights asleep is left out', () => {
        const q = sleepStageQuantiles([night('a', [[360, 420]]), night('b', [])], 'DEEP');
        expect(q).toEqual([]);
    });
    test('a night that ended early does not count as zero later on', () => {
        const short = { date: 'd', seg: [{ st: 'LIGHT', s: 300, e: 420 }] };
        const q = sleepStageQuantiles([...nights, short], 'DEEP');
        expect(q.find((x) => x.bin === 390)!.nights).toBe(4);
        expect(q.find((x) => x.bin === 600)!.nights).toBe(3);
    });
});

describe('clockLabel', () => {
    test('minutes since 18:00 as a clock time, past midnight too', () => {
        expect(clockLabel(0)).toBe('18:00');
        expect(clockLabel(360)).toBe('00:00');
        expect(clockLabel(780)).toBe('07:00');
    });
});

describe('perMinute', () => {
    test('one point per minute with its mean, lowest and highest value', () => {
        const day = perMinute([
            { t: '07:00:05', value: 60 },
            { t: '07:00:40', value: 70 },
            { t: '07:01:10', value: 65 },
        ]);
        expect(day).toEqual([
            { minute: 420, mean: 65, min: 60, max: 70 },
            { minute: 421, mean: 65, min: 65, max: 65 },
        ]);
    });
});
