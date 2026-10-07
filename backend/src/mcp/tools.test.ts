import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dayRange, localDay, thinSamples } from './tools';

test('a range of days includes both ends, also across a clock change', () => {
    const r = dayRange('2026-10-24', '2026-10-26', 7);
    assert.equal(r.start, new Date(2026, 9, 24).getTime());
    assert.equal(r.end, new Date(2026, 9, 27).getTime());
    assert.equal(localDay(r.end - 1), '2026-10-26');
});

test('a range without ends is the last days up to today', () => {
    const r = dayRange(undefined, undefined, 7);
    assert.equal(r.to, localDay(Date.now()));
    assert.equal(r.from, localDay(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 6).getTime()));
    assert.deepEqual(dayRange(undefined, '2026-03-31', 30).from, '2026-03-02');
});

test('samples are thinned to runs with mean, lowest and highest', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ t: `00:0${i}`, value: i }));
    assert.equal(thinSamples(points, 10), points);
    const thinned = thinSamples(points, 4);
    assert.equal(thinned.length, 4);
    assert.deepEqual(thinned[0], { t: '00:00', value: 1, min: 0, max: 2 });
    assert.deepEqual(thinned[3], { t: '00:09', value: 9, min: 9, max: 9 });
});
