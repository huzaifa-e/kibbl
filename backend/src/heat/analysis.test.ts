import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heatingButCold, heatingWhileOpen, intervals, nightLoss, openOnColdDays, warmUse, weatherIntensity } from './analysis';

const HOUR = 3600_000;
const cold = (from: string, to: string, t = 5) => {
    const m = new Map<string, number>();
    for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 24 * HOUR) m.set(new Date(d).toISOString().slice(0, 10), t);
    return m;
};

test('intervals carry their degree days', () => {
    const list = intervals(
        [
            { date: '2026-01-01', value: 0 },
            { date: '2026-01-11', value: 30 },
        ],
        cold('2026-01-01', '2026-01-31'),
    );
    assert.deepEqual(list, [{ from: '2026-01-02', to: '2026-01-11', days: 10, use: 30, degreeDays: 150 }]);
});

test('a radiator that needs much more for the same cold is named', () => {
    const outside = cold('2026-01-01', '2026-03-31');
    const readings = [0, 30, 60, 90, 150].map((value, i) => ({
        date: `2026-0${1 + Math.floor((i * 14) / 31)}-${String(1 + ((i * 14) % 31)).padStart(2, '0')}`,
        value,
    }));
    const r = weatherIntensity(intervals(readings, outside))!;
    assert.ok(r.unusual);
    assert.equal(Math.round(r.ratio * 10) / 10, 2);
    const steady = weatherIntensity(
        intervals(
            readings.map((x, i) => ({ ...x, value: i * 30 })),
            outside,
        ),
    )!;
    assert.equal(steady.unusual, false);
});

test('counting through warm weeks points at a valve that does not close', () => {
    const warm = cold('2026-06-01', '2026-06-30', 22);
    assert.equal(
        warmUse(
            intervals(
                [
                    { date: '2026-06-01', value: 0 },
                    { date: '2026-06-15', value: 14 },
                ],
                warm,
            ),
        )?.use,
        14,
    );
    assert.equal(
        warmUse(
            intervals(
                [
                    { date: '2026-06-01', value: 0 },
                    { date: '2026-06-15', value: 2 },
                ],
                warm,
            ),
        ),
        undefined,
    );
});

test('heating while a window is open, counted by the time of each tado reading', () => {
    const t0 = Date.UTC(2026, 0, 1, 12);
    const tado = [0, 1, 2, 3].map((i) => ({ at: t0 + i * 20 * 60_000, heating: i < 2 ? 50 : 0 }));
    assert.equal(heatingWhileOpen([{ from: t0, to: t0 + HOUR }], tado), 40 / 60);
});

test('open windows on cold days only', () => {
    const t = Date.UTC(2026, 0, 1, 12);
    const outside = new Map([
        ['2026-01-01', 3],
        ['2026-06-01', 20],
    ]);
    const day = (x: number) => new Date(x).toISOString().slice(0, 10);
    assert.equal(
        openOnColdDays(
            [
                { from: t, to: t + 2 * HOUR },
                { from: Date.UTC(2026, 5, 1, 12), to: Date.UTC(2026, 5, 1, 15) },
            ],
            outside,
            day,
        ),
        2,
    );
});

test('heating hard but staying cold', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const tado = [0, 1, 2, 3, 4, 5].map((i) => ({ at: t0 + i * 30 * 60_000, heating: 90, temperature: 17, target: 21 }));
    assert.equal(heatingButCold(tado), 3);
    assert.equal(heatingButCold(tado.map((s) => ({ ...s, temperature: 20.5 }))), 0);
});

test('heat loss at night: a leaky room cools faster for the same difference to outside', () => {
    const local = (t: number) => ({ day: new Date(t).toISOString().slice(0, 10), hour: new Date(t).getUTCHours() });
    const nights = (rate: number) =>
        [1, 2, 3].flatMap((d) => Array.from({ length: 300 }, (_, m) => ({ at: Date.UTC(2026, 0, d, 0, m), temperature: 20 - (rate * m) / 60 })));
    const outside = cold('2026-01-01', '2026-01-03', 5);
    const tight = nightLoss(nights(0.15), outside, [], local)!;
    const leaky = nightLoss(nights(0.45), outside, [], local)!;
    assert.equal(tight.nights, 3);
    assert.ok(leaky.perHour > 2.5 * tight.perHour);
    // a night with an open window does not count
    assert.equal(nightLoss(nights(0.15), outside, [{ from: Date.UTC(2026, 0, 2, 1), to: Date.UTC(2026, 0, 2, 2) }], local), undefined);
});
