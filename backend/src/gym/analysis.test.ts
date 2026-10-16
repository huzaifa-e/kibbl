import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    e1rm,
    exerciseSessions,
    guessExercise,
    gymInsights,
    records,
    setsPerGroup,
    suggestNext,
    templatesFromHistory,
    trackerKind,
    weeklyActivity,
    type GymSet,
    type GymWorkout,
} from '../../../shared/gym';

const DAY = 24 * 3600_000;
const set = (weight: number, reps: number, kind: GymSet['kind'] = 'normal'): GymSet => ({ kind, weight, reps, done: true });
let n = 0;
const workout = (start: number, name: string, exercises: [string, GymSet[]][], kind: GymWorkout['kind'] = 'strength'): GymWorkout => ({
    _id: String(++n),
    name,
    kind,
    start,
    end: start + 3600_000,
    source: 'app',
    exercises: exercises.map(([name, sets]) => ({ name, sets })),
});

test('estimated 1RM: Epley, reps past 12 count as 12', () => {
    assert.equal(e1rm(100, 1), 100);
    assert.equal(Math.round(e1rm(100, 10) * 10) / 10, 133.3);
    assert.equal(e1rm(100, 20), e1rm(100, 12));
    assert.equal(e1rm(0, 10), 0);
});

test('sets per group: a bench press is one set of chest, half of triceps and shoulders', () => {
    const w = workout(Date.now(), 'Push', [['Bench Press (Barbell)', [set(60, 10, 'warmup'), set(80, 8), set(80, 8), set(80, 7)]]]);
    const g = setsPerGroup([w], guessExercise);
    assert.equal(g.chest, 3);
    assert.equal(g.triceps, 1.5);
    assert.equal(g.shoulders, 1.5);
    assert.equal(g.back, 0);
});

test('stretches and cardio count no hard sets', () => {
    const w = workout(Date.now(), 'Flow', [['Pigeon Pose', [{ kind: 'normal', seconds: 60, done: true }]], ['Running', [{ kind: 'normal', seconds: 1800, distance: 5, done: true }]]], 'yoga');
    const g = setsPerGroup([w], guessExercise);
    assert.equal(Object.values(g).reduce((a, b) => a + b, 0), 0);
});

test('sessions and records of an exercise', () => {
    const t = Date.now() - 10 * DAY;
    const ws = [workout(t, 'A', [['Squat (Barbell)', [set(100, 5), set(100, 5)]]]), workout(t + 3 * DAY, 'A', [['Squat (Barbell)', [set(105, 5), set(90, 10)]]])];
    const s = exerciseSessions(ws, 'squat (barbell)');
    assert.equal(s.length, 2);
    assert.equal(s[1].topWeight, 105);
    const r = records(s);
    assert.equal(r.weight!.value, 105);
    assert.equal(r.reps!.value, 10);
    assert.equal(r.volume!.value, 1425);
});

test('double progression', () => {
    const info = guessExercise('Bench Press (Barbell)');
    const at = (reps: number[]) => exerciseSessions([workout(Date.now(), 'A', [['Bench Press (Barbell)', reps.map((r) => set(80, r))]])], 'Bench Press (Barbell)')[0];
    assert.deepEqual(suggestNext(at([10, 10, 10]), info, 6, 10)?.weight, 82.5);
    const same = suggestNext(at([8, 7, 6]), info, 6, 10)!;
    assert.equal(same.weight, 80);
    assert.equal(same.reps, 7);
    assert.equal(suggestNext(at([12, 12]), guessExercise('Squat (Barbell)'), 8, 12)?.weight, 85);
});

test('unknown exercises: muscles from the name', () => {
    assert.deepEqual(guessExercise('Incline Smith Press (Smith Machine)').primary, ['chest_upper']);
    assert.deepEqual(guessExercise('Spider Curl (Cable)').primary, ['biceps']);
    assert.equal(guessExercise('Outdoor Run').kind, 'cardio');
    assert.equal(guessExercise('Outdoor Run').activity, 'running');
});

test('tracker types', () => {
    assert.equal(trackerKind('Strength Training'), 'strength');
    assert.equal(trackerKind('Biking'), 'cycling');
    assert.equal(trackerKind('Treadmill'), 'running');
    assert.equal(trackerKind('Cleaning'), null);
    assert.equal(trackerKind('Aerobic Workout'), 'cardio');
});

test('weekly activity counts every kind', () => {
    const now = Date.now();
    const ws = [workout(now - 1000, 'Legs', []), workout(now - 2000, 'Run', [], 'running'), { ...workout(now - 3000, 'Biking', [], 'cycling'), source: 'tracker' as const }];
    const [w] = weeklyActivity(ws, 1, now);
    assert.equal(w.sessions, 3);
    assert.equal(w.byKind.running?.sessions, 1);
    assert.equal(Math.round(w.minutes), 180);
});

test('a stalled lift and too few sets are advised', () => {
    const now = Date.now();
    const ws: GymWorkout[] = [];
    for (let i = 0; i < 6; i++) ws.push(workout(now - (30 - i * 5) * DAY, 'Push', [['Bench Press (Barbell)', [set(80, 8), set(80, 8), set(80, 8)]]]));
    const advice = gymInsights(ws, guessExercise, now);
    assert.ok(advice.some((a) => a.exercise === 'Bench Press (Barbell)' && a.level === 'warn'));
    assert.ok(advice.some((a) => a.group === 'back' && a.level === 'warn'));
});

test('templates learned from history keep the latest session', () => {
    const t = Date.now() - 20 * DAY;
    const ws = [
        workout(t, 'Back & Biceps', [['Lat Pulldown (Cable)', [set(50, 10), set(50, 10)]]]),
        workout(t + 7 * DAY, 'Back & Biceps', [['Lat Pulldown (Cable)', [set(55, 8), set(55, 8), set(55, 10)]], ['Bicep Curl (Barbell)', [set(30, 10)]]]),
        workout(t + 2 * DAY, 'Once', [['Squat (Barbell)', [set(100, 5)]]]),
    ];
    const [tpl, ...rest] = templatesFromHistory(ws);
    assert.equal(rest.length, 0);
    assert.equal(tpl.name, 'Back & Biceps');
    assert.deepEqual(tpl.exercises[0], { name: 'Lat Pulldown (Cable)', sets: 3, repsLow: 8, repsHigh: 10, restSeconds: 90 });
});
