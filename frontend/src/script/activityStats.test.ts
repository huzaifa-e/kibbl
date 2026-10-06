import { describe, expect, test } from 'vitest';
import type { ActivityBucket } from '../../../shared/protocol';
import { baselineDays, hourlyQuantiles, quantile } from './activityStats';

const bucket = (day: string, hour: number, count: number): ActivityBucket => ({ day, hour, count, seconds: 0 });

describe('quantile', () => {
    test('interpolates between ranks', () => {
        expect(quantile([0, 2, 4], 0.5)).toBe(2);
        expect(quantile([0, 2, 4], 0.25)).toBe(1);
        expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
        expect(quantile([0, 10], 0.9)).toBe(9);
    });
    test('ends and edge cases', () => {
        expect(quantile([3, 5, 9], 0)).toBe(3);
        expect(quantile([3, 5, 9], 1)).toBe(9);
        expect(quantile([7], 0.75)).toBe(7);
        expect(quantile([], 0.5)).toBe(0);
    });
});

describe('baselineDays', () => {
    const window = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06'];

    test('starts at the first day with motion, without the selected day and today', () => {
        const buckets = [bucket('2026-10-03', 7, 2), bucket('2026-10-05', 9, 1)];
        expect(baselineDays(buckets, window, '2026-10-04', '2026-10-06')).toEqual(['2026-10-03', '2026-10-05']);
    });
    test('a day without motion after the first one is part of it, as a zero', () => {
        const buckets = [bucket('2026-10-02', 7, 2)];
        expect(baselineDays(buckets, window, '2026-10-06', '2026-10-06')).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    });
    test('no motion at all, no baseline', () => {
        expect(baselineDays([], window, '2026-10-06', '2026-10-06')).toEqual([]);
    });
});

describe('hourlyQuantiles', () => {
    test('counts the days without events in an hour as zero', () => {
        const days = ['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
        const buckets = [bucket('2026-10-02', 7, 4), bucket('2026-10-03', 7, 2), bucket('2026-10-04', 7, 6), bucket('2026-10-05', 20, 1)];
        const q = hourlyQuantiles(buckets, days);
        expect(q).toHaveLength(24);
        // 7:00 on the four days: 0 (Oct 5), 2, 4, 6
        expect(q[7].p50).toBe(3);
        expect(q[7].p25).toBe(1.5);
        expect(q[7].p90).toBeCloseTo(5.4);
        expect(q[20].p50).toBe(0);
        expect(q[3]).toEqual({ p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 });
    });
    test('buckets of other days are ignored', () => {
        const q = hourlyQuantiles([bucket('2026-09-01', 7, 50)], ['2026-10-02']);
        expect(q[7].p90).toBe(0);
    });
});
