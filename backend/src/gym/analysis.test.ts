import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    exerciseWindows,
    heartRateStats,
    restsOf,
    workoutMinutes,
    buildName,
    buildWorkout,
    e1rm,
    exerciseSessions,
    guessExercise,
    gymInsights,
    isIsolation,
    records,
    setsPerGroup,
    suggestNext,
    suggestTemplates,
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

test('a typo far above the usual weight is no record', () => {
    const t = Date.now() - 20 * DAY;
    const ws = [0, 1, 2, 3, 4].map((i) => workout(t + i * DAY, 'B', [['Face Pull (Cable)', [set(110, 10), set(i === 4 ? 1254 : 115, 10)]]]));
    assert.equal(records(exerciseSessions(ws, 'Face Pull (Cable)')).weight!.value, 115);
});

test('suggested templates: the routine, focused days, a leg day', () => {
    const now = Date.now();
    const ws: GymWorkout[] = [];
    const push: [string, GymSet[]][] = ['Bench Press (Barbell)', 'Incline Bench Press (Dumbbell)', 'Chest Press (Machine)', 'Chest Fly (Machine)', 'Pec Deck (Machine)', 'Cable Crossover', 'Lat Pulldown (Cable)', 'Seated Row (Cable)', 'Triceps Rope Pushdown'].map((n) => [n, [set(50, 10), set(50, 10), set(50, 10), set(50, 10)]]);
    const pull: [string, GymSet[]][] = ['Lat Pulldown (Cable)', 'Seated Row (Cable)', 'Bent Over Row (Barbell)', 'Pull Up (Assisted)', 'T Bar Row', 'Bicep Curl (Cable)', 'Chest Fly (Machine)', 'Pec Deck (Machine)'].map((n) => [n, [set(50, 10), set(50, 10), set(50, 10), set(50, 10)]]);
    for (let i = 0; i < 10; i++) {
        ws.push(workout(now - (70 - i * 7) * DAY, 'Chest/Tri', push));
        ws.push(workout(now - (68 - i * 7) * DAY, 'Back/Biceps', pull));
    }
    const r = suggestTemplates(ws, guessExercise, [], now);
    const names = r.suggestions.map((s) => s.name);
    assert.deepEqual(names, ['Chest/Tri', 'Back/Biceps', 'Legs']);
    const chest = r.suggestions[0];
    assert.equal(chest.exercises.filter((e) => guessExercise(e.name).primary.some((m) => m.startsWith('chest'))).length, 4);
    assert.equal(chest.exercises.filter((e) => ['Lat Pulldown (Cable)', 'Seated Row (Cable)'].includes(e.name)).length, 1); // back on the chest day: one
    const back = r.suggestions[1];
    assert.equal(back.exercises.filter((e) => ['Chest Fly (Machine)', 'Pec Deck (Machine)'].includes(e.name)).length, 1);
    const legs = r.suggestions[2];
    assert.equal(legs.sessions, 0);
    for (const g of ['quads', 'hamstrings', 'glutes', 'calves'] as const) assert.ok(r.after[g] > r.before[g], g);
    assert.ok(r.after.chest < r.before.chest);
    assert.ok(chest.changes.length > 0);
});

test('isolation lifts', () => {
    assert.ok(isIsolation(guessExercise('Lateral Raise (Machine)')));
    assert.ok(isIsolation(guessExercise('Bicep Curl (Cable)')));
    assert.ok(!isIsolation(guessExercise('Bench Press (Barbell)')));
    assert.ok(!isIsolation(guessExercise('Squat (Barbell)')));
});

test('a workout for the muscles chosen: the ones done most, compound first, none twice', () => {
    const t = Date.now() - 10 * DAY;
    const ws = [0, 1, 2].map((i) => workout(t + i * DAY, 'X', [['Lateral Raise (Cable)', [set(10, 12), set(10, 12), set(10, 12), set(10, 12)]], ['Incline Bench Press (Dumbbell)', [set(20, 8), set(20, 9)]]]));
    const ex = buildWorkout(['chest_upper', 'delts_side', 'biceps'], ws, guessExercise, 'normal');
    const names = ex.map((e) => e.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('Incline Bench Press (Dumbbell)'));
    assert.ok(names.includes('Lateral Raise (Cable)'));
    assert.ok(names.some((n) => guessExercise(n).primary.includes('biceps')));
    // compound before isolation
    assert.ok(names.indexOf('Incline Bench Press (Dumbbell)') < names.indexOf('Lateral Raise (Cable)'));
    // as it was done: 4 sets of 12
    assert.deepEqual(ex.find((e) => e.name === 'Lateral Raise (Cable)'), { name: 'Lateral Raise (Cable)', sets: 4, repsLow: 12, repsHigh: 14, restSeconds: 75 });
    assert.equal(buildName(['chest_upper', 'chest_mid', 'biceps']), 'Chest + Biceps');
});

test('rests and the times of the exercises: from the ticks, else shared out', () => {
    const t0 = Date.UTC(2026, 9, 10, 17, 0);
    const w: GymWorkout = {
        _id: 'w',
        name: 'A',
        kind: 'strength',
        start: t0,
        end: t0 + 30 * 60_000,
        source: 'app',
        exercises: [
            { name: 'Bench Press (Barbell)', sets: [{ kind: 'normal', weight: 80, reps: 8, done: true, at: t0 + 3 * 60_000 }, { kind: 'normal', weight: 80, reps: 8, done: true, at: t0 + 6 * 60_000 }] },
            { name: 'Chest Fly (Machine)', sets: [{ kind: 'normal', weight: 40, reps: 12, done: true, at: t0 + 10 * 60_000 }] },
        ],
    };
    assert.deepEqual(restsOf(w.exercises[0]), [180]);
    const [a, b] = exerciseWindows(w);
    assert.deepEqual([a.from, a.to, a.estimated], [t0, t0 + 6 * 60_000, false]);
    assert.deepEqual([b.from, b.to], [t0 + 6 * 60_000, t0 + 10 * 60_000]);
    // without times: 30 minutes over 3 sets
    const bare = { ...w, exercises: w.exercises.map((e) => ({ ...e, sets: e.sets.map(({ at: _at, ...s }) => s) })) };
    const est = exerciseWindows(bare);
    assert.equal(est[0].to - est[0].from, 20 * 60_000);
    assert.ok(est[1].estimated);
    assert.deepEqual(heartRateStats([{ at: t0 + 60_000, bpm: 120 }, { at: t0 + 120_000, bpm: 140 }, { at: t0 + 11 * 60_000, bpm: 100 }], t0, t0 + 6 * 60_000), { avg: 130, max: 140, min: 120, samples: 2 });
    // a pause is not training time
    assert.equal(workoutMinutes({ ...w, pausedMs: 10 * 60_000 }), 20);
});
