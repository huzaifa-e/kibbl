import { randomUUID } from 'node:crypto';
import {
    DEFAULT_TEMPLATES,
    exerciseKey,
    guessExercise,
    gymInsights,
    templatesFromHistory,
    trackerKind,
    type ExerciseInfo,
    type GymExerciseLog,
    type GymTemplate,
    type GymWorkout,
    type WorkoutKind,
} from '../../../shared/gym';
import { GymExerciseModel, GymTemplateModel, GymWorkoutModel, User } from '../core/db';
import { logger } from '../core/logger';
import { parseExercise } from '../health/extract';
import { loadPoints } from '../health/store';
import { parseStrongCsv } from './strong';

/*
 * The gym: workouts as they are logged in the app or imported from Strong, the templates they
 * start from, exercises of the user's own, and the sessions the fitness tracker recorded
 * (Google Health), so every kind of training shows in one place. A tracker session at the time
 * of a logged workout adds its heart rate and calories to it; one without becomes a workout of
 * its own (source 'tracker', made when read, never stored).
 */

const log = logger('gym');
const DAY_MS = 24 * 3600_000;
const MIN_TRACKER_MS = 5 * 60_000; // shorter sessions are the tracker's noise

export class GymError extends Error {}

const civilDay = (t: number) => new Intl.DateTimeFormat('en-CA').format(new Date(t));

/* ----------------------------------------------------------------------- */
/* Exercises                                                                */

export async function customExercises(userID: string): Promise<ExerciseInfo[]> {
    const rows = await GymExerciseModel.find({ ownerID: userID }).lean();
    return rows.map((r) => ({ name: r.name, primary: r.primary, secondary: r.secondary, equipment: r.equipment, kind: r.kind, custom: true, ...(r.activity ? { activity: r.activity } : {}) }));
}

// how an exercise is looked up for this user: their own first, then the catalog, then a guess
export async function lookupFor(userID: string) {
    const own = new Map((await customExercises(userID)).map((e) => [exerciseKey(e.name), e]));
    return (name: string) => own.get(exerciseKey(name)) ?? guessExercise(name);
}

export async function saveExercise(userID: string, e: ExerciseInfo) {
    const key = exerciseKey(e.name);
    await GymExerciseModel.updateOne(
        { ownerID: userID, key },
        {
            $set: { name: e.name.trim(), primary: e.primary, secondary: e.secondary, equipment: e.equipment, kind: e.kind, activity: e.activity },
            $setOnInsert: { _id: randomUUID() },
        },
        { upsert: true },
    );
}

export async function removeExercise(userID: string, name: string) {
    return (await GymExerciseModel.deleteOne({ ownerID: userID, key: exerciseKey(name) })).deletedCount > 0;
}

/* ----------------------------------------------------------------------- */
/* Templates                                                                */

const toTemplate = (t: GymTemplateDoc): GymTemplate => ({ _id: t._id, name: t.name, kind: t.kind ?? 'strength', exercises: t.exercises, order: t.order, source: t.source });

// a new account gets the default templates once
export async function listTemplates(userID: string): Promise<GymTemplate[]> {
    let rows = await GymTemplateModel.find({ ownerID: userID }).sort({ order: 1 }).lean();
    if (!rows.length) {
        await GymTemplateModel.insertMany(DEFAULT_TEMPLATES.map((t) => ({ ...t, _id: randomUUID(), ownerID: userID })));
        rows = await GymTemplateModel.find({ ownerID: userID }).sort({ order: 1 }).lean();
    }
    return rows.map(toTemplate);
}

export async function saveTemplate(userID: string, t: Omit<GymTemplate, '_id' | 'order'> & { _id?: string; order?: number }) {
    if (t._id) {
        const r = await GymTemplateModel.updateOne({ _id: t._id, ownerID: userID }, { $set: { name: t.name, kind: t.kind, exercises: t.exercises, source: t.source === 'default' ? 'app' : t.source } });
        if (!r.matchedCount) throw new GymError('no such template');
        return t._id;
    }
    const last = await GymTemplateModel.findOne({ ownerID: userID }).sort({ order: -1 }).lean();
    const _id = randomUUID();
    await GymTemplateModel.create({ _id, ownerID: userID, name: t.name, kind: t.kind, exercises: t.exercises, order: (last?.order ?? -1) + 1, source: 'app' });
    return _id;
}

export async function removeTemplate(userID: string, id: string) {
    return (await GymTemplateModel.deleteOne({ _id: id, ownerID: userID })).deletedCount > 0;
}

export async function orderTemplates(userID: string, ids: string[]) {
    await GymTemplateModel.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id, ownerID: userID }, update: { $set: { order } } } })));
}

/* The templates the history shows: each workout name of the imported or logged workouts done
 * twice or more. Replaces templates of the same name and the starter weights split (never
 * changed); the starters of running, Pilates... and the user's own stay. */
export async function learnTemplates(userID: string) {
    const workouts = (await GymWorkoutModel.find({ ownerID: userID, end: { $ne: null } }).lean()).map(toWorkout);
    const learned = templatesFromHistory(workouts);
    if (!learned.length) return { added: 0, templates: await listTemplates(userID) };
    const existing = await GymTemplateModel.find({ ownerID: userID }).lean();
    const names = new Set(learned.map((t) => t.name.toLowerCase()));
    // the starter split of the weights makes way for the real one; the starters of the other kinds stay
    const drop = existing.filter((t) => (t.source === 'default' && t.kind === 'strength') || names.has(t.name.toLowerCase())).map((t) => t._id);
    await GymTemplateModel.deleteMany({ ownerID: userID, _id: { $in: drop } });
    const kept = existing.filter((t) => !drop.includes(t._id)).sort((a, b) => a.order - b.order);
    await GymTemplateModel.insertMany(learned.map((t, i) => ({ ...t, _id: randomUUID(), ownerID: userID, order: i })));
    // the user's own after the learned ones
    if (kept.length) await GymTemplateModel.bulkWrite(kept.map((t, i) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { order: learned.length + i } } } })));
    return { added: learned.length, templates: await listTemplates(userID) };
}

/* ----------------------------------------------------------------------- */
/* Workouts                                                                 */

const toWorkout = (w: GymWorkoutDoc): GymWorkout => ({
    _id: w._id,
    name: w.name,
    kind: w.kind ?? 'strength',
    templateId: w.templateId ?? null,
    start: w.start,
    end: w.end ?? null,
    notes: w.notes,
    source: w.source,
    exercises: w.exercises,
    updatedAt: w.updatedAt,
});

interface TrackerSession {
    type: string;
    start: number;
    end: number;
    calories: number | null;
    avgHr: number | null;
    azm: number | null;
}

/* The tracker's sessions from a day on; two records of one session (the tracker's own and an
 * app's, e.g. Strong through Health Connect) are one: the longer is kept. */
async function trackerSessions(userID: string, from: number): Promise<TrackerSession[]> {
    let parsed: ReturnType<typeof parseExercise>;
    try {
        parsed = parseExercise(await loadPoints(userID, 'exercise', civilDay(from - DAY_MS)));
    } catch (e) {
        log.warn('tracker sessions not read', { error: String(e) });
        return [];
    }
    const sessions = parsed
        .filter((s) => s.start && s.end && s.end - s.start >= MIN_TRACKER_MS && s.start >= from)
        .map((s) => ({ type: s.type, start: s.start!, end: s.end!, calories: s.calories ?? null, avgHr: s.avg_hr ?? null, azm: s.azm ?? null }))
        .sort((a, b) => b.end - b.start - (a.end - a.start));
    const kept: TrackerSession[] = [];
    for (const s of sessions) if (!kept.some((k) => overlap(k, s) > 0.5)) kept.push(s);
    return kept.sort((a, b) => a.start - b.start);
}

// how much of the shorter of two times the other covers, 0 to 1
function overlap(a: { start: number; end: number }, b: { start: number; end: number }) {
    const shared = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    const shorter = Math.min(a.end - a.start, b.end - b.start);
    return shared > 0 && shorter > 0 ? shared / shorter : 0;
}

/* The workouts from a time on, newest first, with the tracker's sessions: on a logged workout
 * when they ran with it, else as workouts of their own. */
export async function listWorkouts(userID: string, from: number, withTracker = true): Promise<GymWorkout[]> {
    const rows = (await GymWorkoutModel.find({ ownerID: userID, start: { $gte: from } }).sort({ start: -1 }).lean()).map(toWorkout);
    if (!withTracker) return rows;
    const sessions = await trackerSessions(userID, from);
    const used = new Set<TrackerSession>();
    for (const w of rows) {
        const end = w.end ?? Date.now();
        const match = sessions.find((s) => !used.has(s) && overlap(s, { start: w.start, end }) > 0.4);
        if (match) {
            used.add(match);
            w.tracker = match;
        }
    }
    for (const s of sessions) {
        if (used.has(s)) continue;
        const kind = trackerKind(s.type);
        if (!kind) continue;
        rows.push({ _id: `tracker-${s.start}`, name: s.type, kind, start: s.start, end: s.end, source: 'tracker', exercises: [], tracker: s });
    }
    return rows.sort((a, b) => b.start - a.start);
}

export async function getWorkout(userID: string, id: string) {
    const w = await GymWorkoutModel.findOne({ _id: id, ownerID: userID }).lean();
    return w ? toWorkout(w) : null;
}

// the workout that runs (started, not finished), if any
export async function activeWorkout(userID: string) {
    const w = await GymWorkoutModel.findOne({ ownerID: userID, end: null, source: 'app' }).sort({ start: -1 }).lean();
    return w ? toWorkout(w) : null;
}

/* A new workout, from a template (its exercises with empty sets, last time's numbers filled in
 * by the page) or empty; one that still runs is returned instead of a second. */
export async function startWorkout(userID: string, templateId: string | null, kind?: WorkoutKind, name?: string) {
    const running = await activeWorkout(userID);
    if (running) return running;
    let exercises: GymExerciseLog[] = [];
    let title = name?.trim() || 'Workout';
    let k: WorkoutKind = kind ?? 'strength';
    if (templateId) {
        const t = await GymTemplateModel.findOne({ _id: templateId, ownerID: userID }).lean();
        if (!t) throw new GymError('no such template');
        title = t.name;
        k = t.kind ?? 'strength';
        exercises = t.exercises.map((e) => ({
            name: e.name,
            restSeconds: e.restSeconds,
            sets: Array.from({ length: Math.max(1, e.sets) }, () => ({
                kind: 'normal' as const,
                done: false,
                ...(e.repsHigh ? { reps: null } : {}),
                ...(e.seconds ? { seconds: e.seconds } : {}),
                ...(e.distance ? { distance: e.distance } : {}),
            })),
        }));
    }
    const doc: GymWorkoutDoc = { _id: randomUUID(), ownerID: userID, name: title, kind: k, templateId, start: Date.now(), end: null, source: 'app', exercises, updatedAt: Date.now() };
    await GymWorkoutModel.create(doc);
    return toWorkout(doc);
}

export interface WorkoutFields {
    name?: string;
    kind?: WorkoutKind;
    start?: number;
    end?: number | null;
    notes?: string;
    exercises?: GymExerciseLog[];
}

export async function updateWorkout(userID: string, id: string, f: WorkoutFields) {
    const r = await GymWorkoutModel.updateOne({ _id: id, ownerID: userID }, { $set: { ...f, updatedAt: Date.now() } });
    if (!r.matchedCount) throw new GymError('no such workout');
    return getWorkout(userID, id);
}

// a workout logged afterwards: a whole one at once
export async function addWorkout(userID: string, f: Required<Pick<WorkoutFields, 'name' | 'kind' | 'start' | 'exercises'>> & WorkoutFields) {
    const doc: GymWorkoutDoc = {
        _id: randomUUID(),
        ownerID: userID,
        name: f.name,
        kind: f.kind,
        start: f.start,
        end: f.end ?? f.start + 60 * 60_000,
        notes: f.notes,
        source: 'app',
        exercises: f.exercises,
        updatedAt: Date.now(),
    };
    await GymWorkoutModel.create(doc);
    return toWorkout(doc);
}

export async function removeWorkout(userID: string, id: string) {
    return (await GymWorkoutModel.deleteOne({ _id: id, ownerID: userID })).deletedCount > 0;
}

/* ----------------------------------------------------------------------- */
/* Strong                                                                   */

/* An export of the Strong app: its workouts replace those of an earlier import at the same
 * start (an import twice is never doubled), the ones logged in the app stay. Exercises the
 * catalog does not know are kept as the user's own, their muscles guessed from the name. */
export async function importStrong(userID: string, csv: string, unit: 'kg' | 'lbs') {
    let parsed;
    try {
        parsed = parseStrongCsv(csv, unit);
    } catch (e) {
        throw new GymError((e as Error).message);
    }
    if (!parsed.workouts.length) throw new GymError('no workouts in the file');
    const starts = parsed.workouts.map((w) => w.start);
    const replaced = (await GymWorkoutModel.deleteMany({ ownerID: userID, source: 'strong', start: { $in: starts } })).deletedCount;
    const now = Date.now();
    await GymWorkoutModel.insertMany(
        parsed.workouts.map((w) => ({ _id: randomUUID(), ownerID: userID, source: 'strong', updatedAt: now, templateId: null, ...w, end: w.end ?? w.start + 60 * 60_000 })),
    );
    const own = new Set((await customExercises(userID)).map((e) => exerciseKey(e.name)));
    const unknown = parsed.exercises.map((n) => guessExercise(n)).filter((e) => e.custom && !own.has(exerciseKey(e.name)));
    for (const e of unknown) await saveExercise(userID, e);
    log.info('strong import', { userID, workouts: parsed.workouts.length, replaced, unknown: unknown.length });
    return {
        workouts: parsed.workouts.length,
        replaced,
        rows: parsed.rows,
        skipped: parsed.skipped,
        from: starts[0],
        to: starts[starts.length - 1],
        exercises: parsed.exercises.length,
        guessed: unknown.map((e) => ({ name: e.name, primary: e.primary })),
    };
}

/* ----------------------------------------------------------------------- */

export interface GymProfile {
    sex: 'male' | 'female';
    bodyweight: number | null;
}

export async function profile(userID: string): Promise<GymProfile> {
    const u = await User.findById(userID, { gym: 1 }).lean();
    return { sex: u?.gym?.sex ?? 'male', bodyweight: u?.gym?.bodyweight ?? null };
}

export async function setProfile(userID: string, p: Partial<GymProfile>) {
    const set: Record<string, unknown> = {};
    if (p.sex) set['gym.sex'] = p.sex;
    if (p.bodyweight !== undefined) set['gym.bodyweight'] = p.bodyweight;
    if (Object.keys(set).length) await User.updateOne({ _id: userID }, { $set: set });
    return profile(userID);
}

/* What the page needs at once: a year of workouts with the tracker's, the templates, the
 * user's own exercises, the profile. */
export async function overview(userID: string, days = 365) {
    const from = Date.now() - days * DAY_MS;
    const [workouts, templates, exercises, me] = await Promise.all([listWorkouts(userID, from), listTemplates(userID), customExercises(userID), profile(userID)]);
    return { workouts, templates, exercises, profile: me, oldest: (await GymWorkoutModel.findOne({ ownerID: userID }).sort({ start: 1 }).lean())?.start ?? null };
}

// for the assistant: the advice of the last weeks
export async function insights(userID: string) {
    const [workouts, info] = await Promise.all([listWorkouts(userID, Date.now() - 90 * DAY_MS), lookupFor(userID)]);
    return gymInsights(workouts.filter((w) => w.source !== 'tracker'), info);
}
