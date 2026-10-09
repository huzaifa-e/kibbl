import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseLoad, dayVsUsual, recentVsUsual, thermometerGap } from './checks';

const days = (n: number, end: string, value: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({
        date: new Date(Date.parse(`${end}T12:00:00Z`) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
        value: value(i),
    }));

test('the last week against the four weeks before', () => {
    const series = days(35, '2026-10-09', (i) => (i >= 28 ? 62 : 55));
    assert.deepEqual(recentVsUsual(series, '2026-10-09'), { recent: 62, usual: 55, days: 7 });
    assert.equal(recentVsUsual(series.slice(-5), '2026-10-09'), undefined);
});

test("yesterday's use against the usual day, today left out", () => {
    const list = days(30, '2026-10-09', (i) => (i === 28 ? 9 : 6)).map((d) => ({ key: d.date, consumption: d.value }));
    const r = dayVsUsual(list, '2026-10-09')!;
    assert.equal(r.day, '2026-10-08');
    assert.equal(r.ratio, 1.5);
});

test('the base load from the night readings', () => {
    const local = (t: number) => ({ day: new Date(t).toISOString().slice(0, 10), hour: new Date(t).getUTCHours() });
    const readings = [1, 2, 3].flatMap((d) => Array.from({ length: 9 }, (_, i) => ({ at: Date.UTC(2026, 9, d, 1, i * 30), value: 1000 + d * 10 + i * 0.075 })));
    assert.deepEqual(baseLoad(readings, local), { watts: 150, nights: 3 });
});

test('two thermometers in one room that disagree', () => {
    const t0 = Date.UTC(2026, 9, 9);
    const tado = Array.from({ length: 8 }, (_, i) => ({ at: t0 + i * 20 * 60_000, temperature: 18 }));
    const air = Array.from({ length: 160 }, (_, i) => ({ at: t0 + i * 60_000, temperature: 26.5 }));
    assert.deepEqual(thermometerGap(air, tado), { gap: 8.5, samples: 8 });
    assert.equal(thermometerGap(air.slice(0, 10), tado), undefined);
});
