import { exerciseKey, guessExercise, trackerKind, type GymExerciseLog, type GymSet, type SetKind, type WeightUnit, type WorkoutKind } from '../../../shared/gym';

/*
 * The export of the Strong app (Settings → Export Strong Data, a CSV file): one row per set, the
 * workout's date and name on every row. Two layouts exist:
 *   new  Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
 *   old  Date;Workout Name;Exercise Name;Set Order;Weight;Weight Unit;Reps;RPE;Distance;Distance Unit;Seconds;Notes;Workout Notes;Workout Duration
 * The columns are found by their names, so their order does not matter. Set Order is a number,
 * or W (warm-up), D (drop set), F (to failure); a "Rest Timer" row is the rest after a set.
 *
 * The new layout has no unit: Strong writes each exercise in the unit set for it, kg for one,
 * lbs for another. So the units are given per exercise (`units`, by exerciseKey), else `unit`.
 * `detectUnits` finds what the file proves: a set logged before the exercise's unit changed
 * comes out odd in the new one (25 kg as 55.12 lbs, 40 lb as 18.14 kg).
 */

export interface ImportedWorkout {
    name: string;
    kind: WorkoutKind;
    start: number;
    end: number | null;
    notes?: string;
    exercises: GymExerciseLog[];
}

export interface StrongImport {
    workouts: ImportedWorkout[];
    rows: number;
    skipped: number;
    unit: WeightUnit;
    exercises: string[]; // every exercise name met
    corrected: { name: string; from: number; to: number; sets: number }[]; // typos of a decimal point
}

/* A weight about ten times an exercise's usual one, whose tenth is usual, is a decimal point
 * missed (1254 for 125.4); Strong copies a session's numbers into the next, so one typo can stand
 * in dozens of sessions. Such sets get the tenth. */
function fixDecimalTypos(workouts: ImportedWorkout[]) {
    const weights = new Map<string, number[]>();
    for (const w of workouts) for (const e of w.exercises) for (const s of e.sets) if (s.weight) weights.set(e.name, [...(weights.get(e.name) ?? []), s.weight]);
    const fixes = new Map<string, { name: string; from: number; to: number; sets: number }>();
    for (const [name, ws] of weights) {
        const sorted = [...ws].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (sorted.length < 5 || !median) continue;
        for (const w of workouts)
            for (const e of w.exercises) {
                if (e.name !== name) continue;
                for (const s of e.sets) {
                    if (!s.weight || s.weight < median * 4) continue;
                    const tenth = Math.round(s.weight) / 10;
                    if (tenth < median * 0.4 || tenth > median * 2.5) continue;
                    const key = `${name}|${s.weight}`;
                    const f = fixes.get(key) ?? { name, from: s.weight, to: tenth, sets: 0 };
                    f.sets++;
                    fixes.set(key, f);
                    s.weight = tenth;
                }
            }
    }
    return [...fixes.values()];
}

export interface ExerciseUnits {
    name: string;
    sets: number;
    weights: number[]; // the values as written, the most frequent first
    detected: WeightUnit | null; // what the file proves, null where every value is round
    evidence: number[];
}

const LB = 0.45359237; // as in shared/gym.ts
const MILE = 1.609344;

// fields of one CSV line, with quotes ("" inside a quoted field is a quote)
function splitLine(text: string, sep: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            } else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === sep) {
            row.push(field);
            field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else field += c;
    }
    if (field || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => r.some((v) => v.trim()));
}

// "1h 5m", "45m", "52s", "1:05:00" or seconds
export function parseDuration(v: string): number | null {
    const t = v.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const clock = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (clock) return clock[3] !== undefined ? +clock[1] * 3600 + +clock[2] * 60 + +clock[3] : +clock[1] * 60 + +clock[2];
    let s = 0;
    let found = false;
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)) {
        found = true;
        s += Number(m[1]) * (m[2].toLowerCase() === 'h' ? 3600 : m[2].toLowerCase() === 'm' ? 60 : 1);
    }
    return found ? s : null;
}

// "2026-10-13 17:30:12" as the home's local time
function parseDate(v: string): number | null {
    const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) {
        const t = Date.parse(v);
        return Number.isNaN(t) ? null : t;
    }
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime();
}

/* The kind of a workout from its exercises: cardio alone makes its activity, else strength. */
function kindOf(name: string, exercises: GymExerciseLog[]): WorkoutKind {
    const infos = exercises.map((e) => guessExercise(e.name));
    if (infos.length && infos.every((i) => i.kind === 'cardio')) return infos[0].activity ?? 'cardio';
    if (/pilates/i.test(name)) return 'pilates';
    if (/yoga|mobility|stretch/i.test(name) || (infos.length && infos.every((i) => i.kind === 'mobility'))) return 'yoga';
    if (/hiit|circuit/i.test(name)) return 'hiit';
    const k = trackerKind(name);
    return k && k !== 'cardio' && k !== 'strength' && infos.every((i) => i.kind === 'cardio') ? k : 'strength';
}

export function parseStrongCsv(text: string, unit: WeightUnit = 'kg', units: Record<string, WeightUnit> = {}): StrongImport {
    const { rows, c, num } = readTable(text);
    return build(rows, c, num, unit, units);
}

// the rows and the columns by name; numbers as the layout writes them
function readTable(text: string) {
    const body = text.replace(/^\uFEFF/, '');
    const head = body.slice(0, body.search(/\r?\n/) >>> 0);
    const sep = (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ';' : ',';
    const rows = splitLine(body, sep);
    if (!rows.length) throw new Error('the file is empty');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const c = {
        date: col('date'),
        workout: col('workout name'),
        duration: col('duration', 'workout duration'),
        exercise: col('exercise name'),
        order: col('set order'),
        weight: col('weight'),
        weightUnit: col('weight unit'),
        reps: col('reps'),
        distance: col('distance'),
        distanceUnit: col('distance unit'),
        seconds: col('seconds'),
        notes: col('notes'),
        workoutNotes: col('workout notes'),
        rpe: col('rpe'),
    };
    if (c.date < 0 || c.exercise < 0 || c.workout < 0) throw new Error('not a Strong export: no Date, Workout Name and Exercise Name columns');

    // the old layout writes decimals with a comma where the separator is a semicolon
    const num = (v: string | undefined) => {
        if (v === undefined) return null;
        const t = v.trim().replace(sep === ';' ? ',' : /^$/, '.');
        if (!t) return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
    };
    return { rows, c, num };
}

type Table = ReturnType<typeof readTable>;

const isRound = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 0.02;

/* Each exercise's weights, and its unit where the file proves it: a value that is not round
 * but is a round weight of the other unit (55.12 = 25 kg in lbs: the exercise is in lbs; 18.14 =
 * 40 lb in kg: it is in kg). With a unit column the column says it. */
export function detectUnits(text: string): ExerciseUnits[] {
    const { rows, c, num } = readTable(text);
    type Seen = { name: string; sets: number; values: Map<number, number>; lbs: number[]; kg: number[]; column?: WeightUnit };
    const by = new Map<string, Seen>();
    for (const r of rows.slice(1)) {
        const name = (r[c.exercise] ?? '').trim();
        const w = num(r[c.weight]);
        if (!name) continue;
        const e: Seen = by.get(exerciseKey(name)) ?? { name, sets: 0, values: new Map(), lbs: [], kg: [] };
        by.set(exerciseKey(name), e);
        e.sets++;
        if (c.weightUnit >= 0) e.column = /lb/i.test(r[c.weightUnit] ?? '') ? 'lbs' : 'kg';
        if (!w || w <= 0) continue;
        e.values.set(w, (e.values.get(w) ?? 0) + 1);
        if (isRound(w, 0.25)) continue;
        if (isRound(w * LB, 0.25)) e.lbs.push(w);
        else if (isRound(w / LB, 0.5)) e.kg.push(w);
    }
    return [...by.values()]
        .map((e) => ({
            name: e.name,
            sets: e.sets,
            weights: [...e.values.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 8),
            detected: e.column ?? (e.lbs.length > e.kg.length ? 'lbs' : e.kg.length > e.lbs.length ? 'kg' : null),
            evidence: [...new Set(e.lbs.length >= e.kg.length ? e.lbs : e.kg)].slice(0, 4),
        }))
        .sort((a, b) => b.sets - a.sets);
}

function build(rows: Table['rows'], c: Table['c'], num: Table['num'], unit: WeightUnit, units: Record<string, WeightUnit>): StrongImport {
    const byStart = new Map<string, ImportedWorkout & { exerciseIndex: Map<string, GymExerciseLog> }>();
    const names = new Set<string>();
    let skipped = 0;
    for (const r of rows.slice(1)) {
        const start = parseDate(r[c.date] ?? '');
        const exercise = (r[c.exercise] ?? '').trim();
        if (start === null || !exercise) {
            skipped++;
            continue;
        }
        const name = (r[c.workout] ?? '').trim() || 'Workout';
        const key = `${start}|${name}`;
        let w = byStart.get(key);
        if (!w) {
            const duration = c.duration >= 0 ? parseDuration(r[c.duration] ?? '') : null;
            const notes = c.workoutNotes >= 0 ? (r[c.workoutNotes] ?? '').trim() : '';
            w = { name, kind: 'strength', start, end: duration ? start + duration * 1000 : null, exercises: [], exerciseIndex: new Map(), ...(notes ? { notes } : {}) };
            byStart.set(key, w);
        }
        names.add(exercise);
        let e = w.exerciseIndex.get(exercise);
        if (!e) {
            e = { name: exercise, sets: [] };
            w.exerciseIndex.set(exercise, e);
            w.exercises.push(e);
        }
        const order = (r[c.order] ?? '').trim();
        const seconds = num(r[c.seconds]);
        if (/rest/i.test(order)) {
            if (seconds) e.restSeconds = seconds;
            continue;
        }
        const note = c.notes >= 0 ? (r[c.notes] ?? '').trim() : '';
        if (note && !e.notes) e.notes = note;
        const kind: SetKind = /^w/i.test(order) ? 'warmup' : /^d/i.test(order) ? 'drop' : /^f/i.test(order) ? 'failure' : 'normal';
        const rowUnit = c.weightUnit >= 0 ? (r[c.weightUnit] ?? '').trim().toLowerCase() : (units[exerciseKey(exercise)] ?? unit);
        let weight = num(r[c.weight]);
        if (weight !== null && /lb/.test(rowUnit)) weight = Math.round(weight * LB * 100) / 100;
        let distance = c.distance >= 0 ? num(r[c.distance]) : null;
        const distUnit = c.distanceUnit >= 0 ? (r[c.distanceUnit] ?? '').trim().toLowerCase() : 'km';
        if (distance !== null && /mi/.test(distUnit)) distance = Math.round(distance * MILE * 1000) / 1000;
        if (distance !== null && distUnit === 'm') distance = distance / 1000;
        const reps = num(r[c.reps]);
        const rpe = c.rpe >= 0 ? num(r[c.rpe]) : null;
        const set: GymSet = { kind, done: true };
        if (weight) set.weight = weight;
        if (reps) set.reps = reps;
        if (seconds) set.seconds = seconds;
        if (distance) set.distance = distance;
        if (rpe) set.rpe = rpe;
        e.sets.push(set);
    }

    const workouts = [...byStart.values()]
        .map((w) => ({ name: w.name, kind: w.kind, start: w.start, end: w.end, ...(w.notes ? { notes: w.notes } : {}), exercises: w.exercises.filter((e) => e.sets.length) }))
        .filter((w) => w.exercises.length)
        .map((w) => ({ ...w, kind: kindOf(w.name, w.exercises) }))
        .sort((a, b) => a.start - b.start);
    const corrected = fixDecimalTypos(workouts);
    return { workouts, rows: rows.length - 1, skipped, unit, exercises: [...names].sort(), corrected };
}
