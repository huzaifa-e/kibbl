import express from 'express';
import multer from 'multer';
import {
    isMuscle,
    isWorkoutKind,
    SET_KINDS,
    type Equipment,
    type ExerciseInfo,
    type ExerciseKind,
    type GymExerciseLog,
    type GymSet,
    type SetKind,
    type TemplateExercise,
} from '../../../shared/gym';
import { checkAuthMiddleware } from '../core/auth';
import { logger } from '../core/logger';
import {
    GymError,
    activeWorkout,
    addWorkout,
    getWorkout,
    importStrong,
    exerciseHeartRate,
    workoutHeartRate,
    previewStrong,
    learnTemplates,
    suggestions,
    listTemplates,
    orderTemplates,
    overview,
    removeExercise,
    removeTemplate,
    removeWorkout,
    saveExercise,
    saveTemplate,
    setProfile,
    setFavorite,
    startWorkout,
    updateWorkout,
    type WorkoutFields,
} from '../gym/service';
import { setRest } from '../gym/rest';

const log = logger('gym');
const NAME_MAX = 80;
const NOTES_MAX = 2000;
const MAX_EXERCISES = 60;
const MAX_SETS = 100;
const MAX_CSV_BYTES = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CSV_BYTES, files: 1 } }).single('file');

const EQUIPMENT: Equipment[] = ['barbell', 'dumbbell', 'cable', 'machine', 'smith', 'bodyweight', 'kettlebell', 'band', 'plate', 'mat', 'reformer', 'other'];
const EXERCISE_KINDS: ExerciseKind[] = ['weight', 'bodyweight', 'assisted', 'duration', 'mobility', 'cardio'];

const isName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= NAME_MAX;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 946684800000 && v < Date.now() + 2 * 24 * 3600_000;
const inRange = (v: unknown, max: number) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

class Bad extends Error {}

function cleanSet(s: Record<string, unknown>): GymSet {
    if (!s || typeof s !== 'object') throw new Bad('a set is an object');
    const kind = (s.kind ?? 'normal') as SetKind;
    if (!SET_KINDS.includes(kind)) throw new Bad(`set kind ${SET_KINDS.join(', ')}`);
    for (const [k, max] of [
        ['weight', 2000],
        ['reps', 10000],
        ['seconds', 86400],
        ['distance', 1000],
        ['rpe', 10],
    ] as const)
        if (!inRange(s[k], max)) throw new Bad(`${k}: a number from 0 to ${max}`);
    const out: GymSet = { kind, done: s.done === true };
    for (const k of ['weight', 'reps', 'seconds', 'distance', 'rpe'] as const) if (typeof s[k] === 'number') out[k] = s[k] as number;
    if (s.at !== undefined && s.at !== null) {
        if (!isTime(s.at)) throw new Bad('at: when the set was ticked, ms');
        out.at = s.at;
    }
    return out;
}

function cleanExercises(v: unknown): GymExerciseLog[] {
    if (!Array.isArray(v) || v.length > MAX_EXERCISES) throw new Bad(`up to ${MAX_EXERCISES} exercises`);
    return v.map((e: Record<string, unknown>) => {
        if (!isName(e?.name)) throw new Bad(`an exercise name of 1 to ${NAME_MAX} characters`);
        if (!Array.isArray(e.sets) || e.sets.length > MAX_SETS) throw new Bad(`up to ${MAX_SETS} sets an exercise`);
        if (e.notes !== undefined && (typeof e.notes !== 'string' || e.notes.length > NOTES_MAX)) throw new Bad('notes up to 2000 characters');
        if (!inRange(e.restSeconds, 3600)) throw new Bad('rest up to an hour');
        return {
            name: (e.name as string).trim(),
            sets: (e.sets as Record<string, unknown>[]).map(cleanSet),
            ...(e.notes ? { notes: e.notes as string } : {}),
            ...(typeof e.restSeconds === 'number' ? { restSeconds: e.restSeconds } : {}),
        };
    });
}

function cleanWorkout(b: Record<string, unknown>): WorkoutFields {
    const f: WorkoutFields = {};
    if (b.name !== undefined) {
        if (!isName(b.name)) throw new Bad(`a name of 1 to ${NAME_MAX} characters`);
        f.name = b.name.trim();
    }
    if (b.kind !== undefined) {
        if (!isWorkoutKind(b.kind)) throw new Bad('an unknown kind of workout');
        f.kind = b.kind;
    }
    if (b.start !== undefined) {
        if (!isTime(b.start)) throw new Bad('start: a time in ms');
        f.start = b.start;
    }
    if (b.end !== undefined) {
        if (b.end !== null && !isTime(b.end)) throw new Bad('end: a time in ms or null');
        f.end = b.end as number | null;
    }
    if (f.start && f.end && f.end < f.start) throw new Bad('the end before the start');
    if (b.notes !== undefined) {
        if (typeof b.notes !== 'string' || b.notes.length > NOTES_MAX) throw new Bad('notes up to 2000 characters');
        f.notes = b.notes;
    }
    if (b.exercises !== undefined) f.exercises = cleanExercises(b.exercises);
    if (b.pausedMs !== undefined) {
        if (!inRange(b.pausedMs, 24 * 3600_000)) throw new Bad('pausedMs: up to a day');
        f.pausedMs = b.pausedMs as number;
    }
    if (b.pausedAt !== undefined) {
        if (b.pausedAt !== null && !isTime(b.pausedAt)) throw new Bad('pausedAt: a time in ms or null');
        f.pausedAt = b.pausedAt as number | null;
    }
    return f;
}

function cleanTemplateExercises(v: unknown): TemplateExercise[] {
    if (!Array.isArray(v) || v.length > MAX_EXERCISES) throw new Bad(`up to ${MAX_EXERCISES} exercises`);
    return v.map((e: Record<string, unknown>) => {
        if (!isName(e?.name)) throw new Bad(`an exercise name of 1 to ${NAME_MAX} characters`);
        const n = (k: string, max: number, def: number) => {
            if (e[k] === undefined || e[k] === null) return def;
            if (!inRange(e[k], max)) throw new Bad(`${k}: 0 to ${max}`);
            return e[k] as number;
        };
        const out: TemplateExercise = {
            name: (e.name as string).trim(),
            sets: Math.max(1, Math.round(n('sets', 50, 3))),
            repsLow: Math.round(n('repsLow', 1000, 8)),
            repsHigh: Math.round(n('repsHigh', 1000, 12)),
            restSeconds: Math.round(n('restSeconds', 3600, 90)),
        };
        if (out.repsHigh < out.repsLow) out.repsHigh = out.repsLow;
        const seconds = n('seconds', 86400, 0);
        const distance = n('distance', 1000, 0);
        if (seconds) out.seconds = seconds;
        if (distance) out.distance = distance;
        return out;
    });
}

function cleanExerciseInfo(b: Record<string, unknown>): ExerciseInfo {
    if (!isName(b?.name)) throw new Bad(`a name of 1 to ${NAME_MAX} characters`);
    const muscles = (v: unknown) => {
        if (!Array.isArray(v) || v.length > 12 || !v.every(isMuscle)) throw new Bad('muscles from the list');
        return v;
    };
    if (!EQUIPMENT.includes(b.equipment as Equipment)) throw new Bad(`equipment ${EQUIPMENT.join(', ')}`);
    if (!EXERCISE_KINDS.includes(b.kind as ExerciseKind)) throw new Bad(`kind ${EXERCISE_KINDS.join(', ')}`);
    if (b.activity !== undefined && b.activity !== null && !isWorkoutKind(b.activity)) throw new Bad('an unknown activity');
    return {
        name: (b.name as string).trim(),
        primary: muscles(b.primary ?? []),
        secondary: muscles(b.secondary ?? []),
        equipment: b.equipment as Equipment,
        kind: b.kind as ExerciseKind,
        ...(isWorkoutKind(b.activity) ? { activity: b.activity } : {}),
        ...(b.unit === 'kg' || b.unit === 'lbs' ? { unit: b.unit } : {}),
    };
}

/* The gym (gym/service.ts): workouts of every kind, templates, the Strong import. */
export default function initGymRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;
    const user = (req: RequestWithSessionInfo) => req.sessionInfo!.userID;
    const handle =
        (fn: (req: RequestWithSessionInfo, res: express.Response) => Promise<unknown>): express.RequestHandler =>
        async (req, res) => {
            try {
                const out = await fn(req as RequestWithSessionInfo, res);
                if (!res.headersSent) res.json(out);
            } catch (e) {
                if (e instanceof Bad || e instanceof GymError) res.status(400).send(e.message);
                else {
                    log.error('request failed', { path: req.path }, e);
                    if (!res.headersSent) res.status(500).send('the request failed');
                }
            }
        };

    // a year of workouts (with the tracker's sessions), templates, own exercises, the profile
    app.get(
        '/api/gym',
        auth,
        handle(async (req) => {
            const days = Number(req.query.days);
            return overview(user(req), Number.isFinite(days) && days >= 7 && days <= 3650 ? days : 365);
        }),
    );

    app.put(
        '/api/gym/profile',
        auth,
        handle(async (req) => {
            const b = (req.body ?? {}) as Record<string, unknown>;
            if (b.sex !== undefined && b.sex !== 'male' && b.sex !== 'female') throw new Bad('sex: male or female');
            if (b.bodyweight !== undefined && b.bodyweight !== null && !(typeof b.bodyweight === 'number' && b.bodyweight >= 20 && b.bodyweight <= 400))
                throw new Bad('bodyweight: 20 to 400 kg');
            return setProfile(user(req), { sex: b.sex as 'male' | 'female' | undefined, bodyweight: b.bodyweight as number | null | undefined });
        }),
    );

    // { name, favorite }: an exercise marked as a favorite, or not any more
    app.put(
        '/api/gym/favorites',
        auth,
        handle(async (req) => {
            const b = (req.body ?? {}) as Record<string, unknown>;
            if (!isName(b.name) || typeof b.favorite !== 'boolean') throw new Bad('a name and favorite true or false');
            return { favorites: await setFavorite(user(req), b.name, b.favorite) };
        }),
    );

    /* -- workouts -- */

    app.get(
        '/api/gym/active',
        auth,
        handle(async (req) => ({ workout: await activeWorkout(user(req)) })),
    );

    // { templateId } or { kind, name, exercises? }: starts a workout (or returns the one that runs)
    app.post(
        '/api/gym/workouts/start',
        auth,
        handle(async (req) => {
            const b = (req.body ?? {}) as Record<string, unknown>;
            if (b.templateId !== undefined && b.templateId !== null && !isId(b.templateId)) throw new Bad('no such template');
            if (b.kind !== undefined && !isWorkoutKind(b.kind)) throw new Bad('an unknown kind of workout');
            if (b.name !== undefined && !isName(b.name)) throw new Bad(`a name of 1 to ${NAME_MAX} characters`);
            const planned = b.exercises !== undefined ? cleanTemplateExercises(b.exercises) : undefined;
            return startWorkout(user(req), (b.templateId as string) ?? null, b.kind as never, b.name as string | undefined, planned);
        }),
    );

    // a whole workout logged afterwards
    app.post(
        '/api/gym/workouts',
        auth,
        handle(async (req) => {
            const f = cleanWorkout(req.body ?? {});
            if (!f.name || !f.kind || !f.start || !f.exercises) throw new Bad('a name, a kind, a start and the exercises');
            return addWorkout(user(req), { ...f, name: f.name, kind: f.kind, start: f.start, exercises: f.exercises });
        }),
    );

    app.get(
        '/api/gym/workouts/:id',
        auth,
        handle(async (req, res) => {
            const w = await getWorkout(user(req), req.params.id);
            if (!w) res.sendStatus(404);
            return w;
        }),
    );

    // the heart rate of a workout (also a tracker's session, tracker-<start>) and of its exercises
    app.get(
        '/api/gym/workouts/:id/heartrate',
        auth,
        handle(async (req, res) => {
            const r = await workoutHeartRate(user(req), req.params.id);
            if (!r) res.sendStatus(404);
            return r;
        }),
    );

    // an exercise's mean and peak heart rate in its latest sessions
    app.get(
        '/api/gym/exercises/:name/heartrate',
        auth,
        handle(async (req) => {
            if (!isName(req.params.name)) throw new Bad('an exercise name');
            return exerciseHeartRate(user(req), req.params.name);
        }),
    );

    // any of name, kind, start, end (null: runs again), notes, exercises (all of them), pausedMs, pausedAt
    app.patch(
        '/api/gym/workouts/:id',
        auth,
        handle(async (req) => updateWorkout(user(req), req.params.id, cleanWorkout(req.body ?? {}))),
    );

    app.delete(
        '/api/gym/workouts/:id',
        auth,
        handle(async (req) => ({ ok: await removeWorkout(user(req), req.params.id) })),
    );

    /* -- templates -- */

    app.get(
        '/api/gym/templates',
        auth,
        handle(async (req) => listTemplates(user(req))),
    );

    const templateBody = (b: Record<string, unknown>) => {
        if (!isName(b?.name)) throw new Bad(`a name of 1 to ${NAME_MAX} characters`);
        if (!isWorkoutKind(b.kind)) throw new Bad('an unknown kind of workout');
        return { name: (b.name as string).trim(), kind: b.kind, exercises: cleanTemplateExercises(b.exercises) };
    };

    app.post(
        '/api/gym/templates',
        auth,
        handle(async (req) => ({ _id: await saveTemplate(user(req), templateBody(req.body)) })),
    );

    app.put(
        '/api/gym/templates/:id',
        auth,
        handle(async (req) => ({ _id: await saveTemplate(user(req), { ...templateBody(req.body), _id: req.params.id }) })),
    );

    app.delete(
        '/api/gym/templates/:id',
        auth,
        handle(async (req) => ({ ok: await removeTemplate(user(req), req.params.id) })),
    );

    // { ids }: the templates in this order
    app.put(
        '/api/gym/templates-order',
        auth,
        handle(async (req) => {
            const ids = (req.body as Record<string, unknown>)?.ids;
            if (!Array.isArray(ids) || ids.length > 200 || !ids.every(isId)) throw new Bad('ids: the templates');
            await orderTemplates(user(req), ids);
            return { ok: true };
        }),
    );

    // templates suggested from the routine, balanced over the week; the page saves the one taken
    app.get(
        '/api/gym/suggestions',
        auth,
        handle(async (req) => suggestions(user(req))),
    );

    // templates from the workouts done twice or more
    app.post(
        '/api/gym/templates/learn',
        auth,
        handle(async (req) => learnTemplates(user(req))),
    );

    /* -- exercises of the user's own -- */

    app.put(
        '/api/gym/exercises',
        auth,
        handle(async (req) => {
            await saveExercise(user(req), cleanExerciseInfo(req.body));
            return { ok: true };
        }),
    );

    app.delete(
        '/api/gym/exercises/:name',
        auth,
        handle(async (req) => ({ ok: await removeExercise(user(req), req.params.name) })),
    );

    /* -- Strong -- */

    const fileOf = (req: RequestWithSessionInfo) => {
        const file = (req as unknown as { file?: Express.Multer.File }).file;
        if (!file) throw new Bad('no file');
        return file.buffer.toString('utf-8');
    };
    const withUpload: express.RequestHandler = (req, res, next) => {
        upload(req, res, (err: unknown) => {
            if (err) {
                res.status(400).send(err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 'the file is larger than 20 MB' : 'the upload failed');
                return;
            }
            next();
        });
    };

    // until: when the running rest ends (ms), null when it is over or skipped
    app.put(
        '/api/gym/rest',
        auth,
        handle(async (req) => {
            const until = (req.body ?? {}).until as unknown;
            if (until !== null && !(typeof until === 'number' && Number.isFinite(until) && until > Date.now() - 60_000 && until < Date.now() + 3600_000))
                throw new Bad('until: a time within the hour, or null');
            setRest(user(req), until);
            return { ok: true };
        }),
    );

    // multipart: file; what it holds, each exercise with its unit where the file proves it
    app.post(
        '/api/gym/import/strong/preview',
        auth,
        withUpload,
        handle(async (req) => previewStrong(user(req), fileOf(req))),
    );

    // multipart: file (the CSV of Strong's export), unit kg or lbs (the default), units: JSON {exercise name: kg or lbs}
    app.post('/api/gym/import/strong', auth, (req, res, next) => {
        upload(req, res, (err: unknown) => {
            if (err) {
                res.status(400).send(err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 'the file is larger than 20 MB' : 'the upload failed');
                return;
            }
            next();
        });
    }, handle(async (req) => {
        const file = (req as unknown as { file?: Express.Multer.File }).file;
        if (!file) throw new Bad('no file');
        const unit = req.body?.unit === 'lbs' ? 'lbs' : 'kg';
        let units: Record<string, 'kg' | 'lbs'> = {};
        if (req.body?.units) {
            try {
                const parsed = JSON.parse(String(req.body.units)) as Record<string, unknown>;
                if (Object.keys(parsed).length > 2000) throw new Bad('too many units');
                units = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => isName(k) && (v === 'kg' || v === 'lbs'))) as Record<string, 'kg' | 'lbs'>;
            } catch (e) {
                if (e instanceof Bad) throw e;
                throw new Bad('units: JSON of exercise names to kg or lbs');
            }
        }
        return importStrong(user(req), file.buffer.toString('utf-8'), unit, units);
    }));
}
