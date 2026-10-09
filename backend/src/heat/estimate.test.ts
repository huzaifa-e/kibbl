import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayKeys, degreeDay, spread } from './estimate';

const round = (m: Map<string, number>) => Object.fromEntries([...m].map(([k, v]) => [k, Math.round(v * 100) / 100]));

test('the days between two dates, both included, across a month', () => {
    assert.deepEqual(dayKeys('2026-01-30', '2026-02-02'), ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
    assert.deepEqual(dayKeys('2026-03-28', '2026-03-30'), ['2026-03-28', '2026-03-29', '2026-03-30']); // the clocks change in between
});

test('degree days count only days below 15 °C', () => {
    assert.equal(degreeDay(5), 15);
    assert.equal(degreeDay(16), 0);
});

test('without tado or weather, the use is the same each day after the first reading', () => {
    const s = spread([
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-04', value: 130 },
    ]);
    assert.deepEqual(round(s.use), { '2026-01-02': 10, '2026-01-03': 10, '2026-01-04': 10 });
    assert.equal(s.how.get('2026-01-02'), 'even');
});

test("tado's heating hours share out the use when they cover every day", () => {
    const tado = new Map([
        ['2026-01-02', 1],
        ['2026-01-03', 3],
    ]);
    const s = spread(
        [
            { date: '2026-01-01', value: 0 },
            { date: '2026-01-03', value: 40 },
        ],
        tado,
    );
    assert.deepEqual(round(s.use), { '2026-01-02': 10, '2026-01-03': 30 });
    assert.equal(s.how.get('2026-01-03'), 'tado');
});

test('the weather stands in where tado misses a day, and a warm day gets nothing', () => {
    const tado = new Map([['2026-01-03', 2]]);
    const outside = new Map([
        ['2026-01-02', 16],
        ['2026-01-03', 10],
    ]);
    const s = spread(
        [
            { date: '2026-01-01', value: 0 },
            { date: '2026-01-03', value: 5 },
        ],
        tado,
        outside,
    );
    assert.deepEqual(round(s.use), { '2026-01-02': 0, '2026-01-03': 5 });
    assert.equal(s.how.get('2026-01-02'), 'weather');
});

test('a lower reading is a reset: counted from 0', () => {
    const s = spread([
        { date: '2026-01-01', value: 900 },
        { date: '2026-01-02', value: 7 },
    ]);
    assert.deepEqual(round(s.use), { '2026-01-02': 7 });
});
