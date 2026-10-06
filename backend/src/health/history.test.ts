import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pointDay } from './extract';
import { lastCompleteDay, storedTypes } from './history';

test('a point belongs to the civil day the api filters it by', () => {
    assert.equal(pointDay('daily-resting-heart-rate', 'daily', { dailyRestingHeartRate: { date: { year: 2026, month: 10, day: 5 } } }), '2026-10-05');
    assert.equal(
        pointDay('steps', 'interval', {
            steps: { interval: { civilStartTime: { date: { year: 2026, month: 10, day: 5 } }, startTime: '2026-10-04T22:30:00Z' } },
        }),
        '2026-10-05',
    );
    assert.equal(
        pointDay('respiratory-rate-sleep-summary', 'sample', {
            respiratoryRateSleepSummary: { sampleTime: { civilTime: { date: { year: 2026, month: 10, day: 6 } } } },
        }),
        '2026-10-06',
    );
});

test('sleep belongs to the local day the night ended, exercise to the local day it started', () => {
    // 23:30 UTC + 2 h is 01:30 the next day
    const night = { sleep: { interval: { startTime: '2026-10-05T20:00:00Z', endTime: '2026-10-05T23:30:00Z', endUtcOffset: '7200s' } } };
    assert.equal(pointDay('sleep', 'sleep', night), '2026-10-06');
    const run = { exercise: { interval: { startTime: '2026-10-05T22:30:00Z', startUtcOffset: '7200s' } } };
    assert.equal(pointDay('exercise', 'interval', run), '2026-10-06');
    assert.equal(pointDay('sleep', 'sleep', { sleep: {} }), null);
});

test('the days before the tracker last synced are complete', () => {
    assert.equal(lastCompleteDay(null), null);
    assert.equal(lastCompleteDay('2026-10-06T10:03:17Z'), '2026-10-05');
});

test('discovered types are stored besides the base types, heart rate never as points', () => {
    const types = storedTypes(['vo2-max', 'heart-rate', 'steps', 'not-a-type']).map(([t]) => t);
    assert.ok(types.includes('vo2-max'));
    assert.ok(!types.includes('heart-rate'));
    assert.equal(types.filter((t) => t === 'steps').length, 1);
    assert.ok(!types.includes('not-a-type'));
});
