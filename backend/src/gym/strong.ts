import { guessExercise, trackerKind, type GymExerciseLog, type GymSet, type SetKind, type WorkoutKind } from '../../../shared/gym';

/*
 * The export of the Strong app (Settings → Export Strong Data, a CSV file): one row per set, the
 * workout's date and name on every row. Two layouts exist:
 *   new  Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE
 *   old  Date;Workout Name;Exercise Name;Set Order;Weight;Weight Unit;Reps;RPE;Distance;Distance Unit;Seconds;Notes;Workout Notes;Workout Duration
 * The columns are found by their names, so their order does not matter. Set Order is a number,
 * or W (warm-up), D (drop set), F (to failure); a "Rest Timer" row is the rest after a set.
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
    unit: 'kg' | 'lbs';
    exercises: string[]; // every exercise name met
}

const LB = 0.45359237;
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

export function parseStrongCsv(text: string, unit: 'kg' | 'lbs' = 'kg'): StrongImport {
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
        const rowUnit = c.weightUnit >= 0 ? (r[c.weightUnit] ?? '').trim().toLowerCase() : unit;
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
    return { workouts, rows: rows.length - 1, skipped, unit, exercises: [...names].sort() };
}
