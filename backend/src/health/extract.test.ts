import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    PARSERS,
    blocksFromPoints,
    camel,
    firstNumber,
    genericSeries,
    hhmm,
    intradayFromPoints,
    num,
    parseAzm,
    parseExercise,
    parseHrZones,
    parseSleep,
    pyRound,
    sedentaryGranularFromPoints,
} from './extract';

/* Small made-up points in the shapes the Google Health API v4 sends. The port was checked
 * against whoofit's Python output on a month of real data; these keep the details that
 * made it match. */

const date = (y: number, m: number, d: number) => ({ year: y, month: m, day: d });

test('rounding is Python round(): half to even, on the exact value of the float', () => {
    assert.equal(pyRound(0.5), 0);
    assert.equal(pyRound(1.5), 2);
    assert.equal(pyRound(2.5), 2);
    assert.equal(pyRound(2.675, 2), 2.67); // the float is 2.67499...
    assert.equal(pyRound(0.125, 2), 0.12); // exactly representable: a tie, to even
    assert.equal(pyRound(-1.5), -2);
    assert.equal(pyRound(97.25, 1), 97.2);
});

test('numbers arrive as strings, NaN is no value, booleans count as in Python', () => {
    assert.equal(num('73'), 73);
    assert.equal(num('NaN'), null);
    assert.equal(num(''), null);
    assert.equal(num({ a: 1 }), null);
    assert.equal(num(true), 1);
    assert.equal(num(61.006), 61.01);
});

test('a daily series, sorted by date, a missing heart rate left out', () => {
    const points = [
        { dailyRestingHeartRate: { date: date(2026, 10, 2), beatsPerMinute: '62' } },
        { dailyRestingHeartRate: { date: date(2026, 10, 1), beatsPerMinute: 60 } },
        { dailyRestingHeartRate: { date: date(2026, 10, 3) } },
    ];
    assert.deepEqual(PARSERS.resting_hr.parse(points), [
        { date: '2026-10-01', value: 60 },
        { date: '2026-10-02', value: 62 },
    ]);
});

test('a night: hours, minutes per stage, segments as minutes since 18:00 in local time', () => {
    const [night] = parseSleep([
        {
            sleep: {
                interval: { startTime: '2026-10-05T21:30:00Z', endTime: '2026-10-06T05:00:00Z' },
                stages: [
                    { type: 'LIGHT', startTime: '2026-10-05T21:30:00Z', endTime: '2026-10-05T23:00:00Z', startUtcOffset: '7200s', endUtcOffset: '7200s' },
                    { type: 'DEEP', startTime: '2026-10-05T23:00:00Z', endTime: '2026-10-05T23:45:30Z', startUtcOffset: '7200s', endUtcOffset: '7200s' },
                ],
            },
        },
    ]);
    assert.equal(night.date, '2026-10-06'); // the UTC date the night ended
    assert.equal(night.value, 7.5);
    assert.deepEqual(night.stages, { DEEP: 46, LIGHT: 90, REM: 0, AWAKE: 0 }); // 45.5 min rounds to even
    // 23:30 local is 330 min after 18:00; 01:45:30 is 465.5
    assert.deepEqual(night.seg, [
        { st: 'LIGHT', s: 330, e: 420 },
        { st: 'DEEP', s: 420, e: 465.5 },
    ]);
});

test('active zone minutes summed per day from their intervals', () => {
    const p = (d: number, v: number) => ({ activeZoneMinutes: { interval: { civilStartTime: { date: date(2026, 10, d) } }, activeZoneMinutes: v } });
    assert.deepEqual(parseAzm([p(2, 3), p(1, 2.5), p(2, 4)]), [
        { date: '2026-10-01', value: 2 },
        { date: '2026-10-02', value: 7 },
    ]);
});

test('the latest heart rate zones, names in title case', () => {
    const zones = (d: number, max: number) => ({
        dailyHeartRateZones: { date: date(2026, 10, d), heartRateZones: [{ heartRateZoneType: 'LIGHT', minBeatsPerMinute: 30, maxBeatsPerMinute: max }] },
    });
    assert.deepEqual(parseHrZones([zones(5, 118), zones(6, 117), zones(4, 120)]), [{ date: '2026-10-06', zones: [{ zone: 'Light', min: 30, max: 117 }] }]);
});

test('a workout type as words', () => {
    const [w] = parseExercise([
        { exercise: { exerciseType: 'STRENGTH_TRAINING', interval: { startTime: '2026-10-04T16:00:00Z' }, metricsSummary: { caloriesKcal: '547' } } },
    ]);
    assert.deepEqual(w, { date: '2026-10-04', type: 'Strength Training', calories: 547, avg_hr: null, azm: null });
});

test('the first number of a data point skips dates and times at every level', () => {
    assert.deepEqual(firstNumber({ sampleTime: { civilTime: { date: date(2026, 1, 1) } }, weightGrams: '72000' }), [72000, 'weightGrams']);
    assert.deepEqual(firstNumber({ interval: { x: 5 }, stats: { mean: 3 } }), [3, 'stats.mean']);
    assert.equal(camel('daily-vo2-max'), 'dailyVo2Max');
    assert.deepEqual(genericSeries('vo2-max', [{ vo2Max: { sampleTime: { civilTime: { date: date(2026, 10, 1) } }, vo2Max: 44.2 } }]), [
        { date: '2026-10-01', value: 44.2, label: 'vo2Max' },
    ]);
});

test('a dense day is averaged per bucket, a sparse one kept point by point', () => {
    const sample = (sec: number, bpm: number) => ({
        heartRate: {
            sampleTime: { civilTime: { time: { hours: Math.floor(sec / 3600), minutes: Math.floor(sec / 60) % 60, seconds: sec % 60 } } },
            beatsPerMinute: bpm,
        },
    });
    const dense = Array.from({ length: 1000 }, (_, i) => sample(i * 60, 60 + (i % 2)));
    const day = intradayFromPoints('heart-rate', '2026-10-06', dense) as { bucket_min: number; points: { t: string; value: number }[] };
    assert.equal(day.bucket_min, 4); // 999 min over 320 points
    assert.deepEqual(day.points[0], { t: '00:00', value: 60.5 });
    const raw = intradayFromPoints('heart-rate', '2026-10-06', [sample(3725, 70)], { raw: true }) as { points: { t: string; value: number }[] };
    assert.deepEqual(raw.points, [{ t: '01:02:05', value: 70 }]);
    assert.equal(hhmm(90.5), '01:30'); // half a minute rounds to even
});

test('a sedentary block past midnight ends at 24:00', () => {
    const block = blocksFromPoints('sedentary-period', '2026-10-05', [
        {
            sedentaryPeriod: {
                interval: { civilStartTime: { time: { hours: 23, minutes: 30 } }, startTime: '2026-10-05T21:30:00Z', endTime: '2026-10-05T22:45:00Z' },
            },
        },
    ]);
    assert.deepEqual(block.blocks, [{ sm: 1410, em: 1440, s: '23:30', e: '24:00', dur: 75 }]);
});

test('worn minutes without steps are sedentary, minutes without heart rate not worn', () => {
    const hr = [7 * 60, 7 * 60 + 1, 7 * 60 + 2].map((m) => ({
        heartRate: { sampleTime: { civilTime: { time: { hours: Math.floor(m / 60), minutes: m % 60 } } } },
    }));
    const steps = [{ steps: { interval: { civilStartTime: { time: { hours: 7, minutes: 1 } } }, count: '12' } }];
    const day = sedentaryGranularFromPoints('2026-10-06', hr, steps);
    assert.deepEqual(day.totals, { sedentary: 2, active: 1, off: 1437 });
    assert.deepEqual(
        day.runs.filter((r) => r.state !== 'off').map((r) => [r.s, r.state]),
        [
            ['07:00', 'sedentary'],
            ['07:01', 'active'],
            ['07:02', 'sedentary'],
        ],
    );
});
