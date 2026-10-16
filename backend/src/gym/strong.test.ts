import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseStrongCsv } from './strong';

const NEW = `Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
2026-10-13 17:30:12,"Chest & Triceps",1h 5m,"Bench Press (Barbell)",W,40,10,0,0,"","",
2026-10-13 17:30:12,"Chest & Triceps",1h 5m,"Bench Press (Barbell)",1,80,8,0,0,"felt good","",8
2026-10-13 17:30:12,"Chest & Triceps",1h 5m,"Bench Press (Barbell)",Rest Timer,0,0,0,120,"","",
2026-10-13 17:30:12,"Chest & Triceps",1h 5m,"Bench Press (Barbell)",2,80,7,0,0,"","",
2026-10-13 17:30:12,"Chest & Triceps",1h 5m,"Triceps Rope Pushdown",1,25,12,0,0,"","",
2026-10-14 07:00:00,"Morning run",32m,"Running",1,0,0,5.2,1900,"","",
`;

test('the new layout: workouts, warm-ups, rest, notes', () => {
    const r = parseStrongCsv(NEW);
    assert.equal(r.workouts.length, 2);
    const [chest, run] = r.workouts;
    assert.equal(chest.name, 'Chest & Triceps');
    assert.equal(chest.kind, 'strength');
    assert.equal(chest.end! - chest.start, 65 * 60_000);
    assert.equal(chest.exercises.length, 2);
    const bench = chest.exercises[0];
    assert.equal(bench.sets.length, 3);
    assert.equal(bench.sets[0].kind, 'warmup');
    assert.deepEqual(bench.sets[1], { kind: 'normal', done: true, weight: 80, reps: 8, rpe: 8 });
    assert.equal(bench.restSeconds, 120);
    assert.equal(bench.notes, 'felt good');
    assert.equal(run.kind, 'running');
    assert.deepEqual(run.exercises[0].sets[0], { kind: 'normal', done: true, seconds: 1900, distance: 5.2 });
});

test('the old layout: semicolons, decimal commas, pounds', () => {
    const csv = `Date;Workout Name;Exercise Name;Set Order;Weight;Weight Unit;Reps;RPE;Distance;Distance Unit;Seconds;Notes;Workout Notes;Workout Duration
2021-03-01 18:00:00;Legs;Squat (Barbell);1;225;lbs;5;;;;0;;;3600
2021-03-01 18:00:00;Legs;Squat (Barbell);2;102,5;kg;5;;;;0;;;3600
`;
    const r = parseStrongCsv(csv);
    const sets = r.workouts[0].exercises[0].sets;
    assert.equal(sets[0].weight, 102.06);
    assert.equal(sets[1].weight, 102.5);
    assert.equal(r.workouts[0].end! - r.workouts[0].start, 3600_000);
});

test('durations', () => {
    assert.equal(parseDuration('1h 5m'), 3900);
    assert.equal(parseDuration('45m'), 2700);
    assert.equal(parseDuration('1:02:03'), 3723);
    assert.equal(parseDuration('90'), 90);
    assert.equal(parseDuration(''), null);
});

test('not a Strong file', () => {
    assert.throws(() => parseStrongCsv('a,b\n1,2\n'), /not a Strong export/);
});
