import {
    WORKOUT_KINDS,
    WORKOUT_KIND_IDS,
    cardioTotals,
    e1rm,
    exerciseKey,
    exerciseSessions,
    isWorkSet,
    records,
    suggestNext,
    type ExerciseInfo,
    type GymExerciseLog,
    type GymSet,
    type GymWorkout,
    type SetKind,
} from '../../../shared/gym';
import { api, ask, clock, openLayer, saveAsTemplate, esc, info, kg, logged, minutesText, pace, parseClock, r1, sheet, shown, state, stored, thumb, toast, tonnage, workoutStats, wText } from './gymCommon';
import { pickExercise } from './gymPicker';

/* The workout as it is done: full screen over the page. Each exercise with its sets (what was
 * lifted last time beside each, the next step suggested), a tick per set starts the rest
 * timer. Every change is saved a moment later; without a network it is kept in the browser and
 * sent when the network is back, so a basement gym loses nothing. A finished workout opened
 * again is edited the same way. */

const BACKUP = 'kibbl-gym-active';
const SAVE_MS = 1200;
const RETRY_MS = 10_000;

let w: GymWorkout;
let editing = false;
let root: HTMLElement | null = null;
let onDone: () => void = () => {};
let saveTimer: number | undefined;
let clockTimer: number | undefined;
let rest: { until: number; total: number; timer?: number } | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let saving = false;
let pending = false;
let layerClosed: (() => void) | null = null;

/* ----------------------------------------------------------------------- */
/* Saving                                                                   */

function backup() {
    try {
        localStorage.setItem(BACKUP, JSON.stringify({ at: Date.now(), workout: w }));
    } catch {
        /* private mode: the server copy is all */
    }
}

export function readBackup(): { at: number; workout: GymWorkout } | null {
    try {
        const v = JSON.parse(localStorage.getItem(BACKUP) ?? 'null');
        return v?.workout?._id ? v : null;
    } catch {
        return null;
    }
}

function dropBackup() {
    try {
        localStorage.removeItem(BACKUP);
    } catch {
        /* nothing kept */
    }
}

const body = () => ({ name: w.name, kind: w.kind, notes: w.notes ?? '', exercises: w.exercises, start: w.start, ...(editing ? { end: w.end } : {}) });

function changed() {
    if (!editing) backup();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, SAVE_MS);
    status('…');
}

async function save(): Promise<boolean> {
    clearTimeout(saveTimer);
    if (saving) {
        pending = true;
        return false;
    }
    saving = true;
    try {
        await api('PATCH', `/api/gym/workouts/${w._id}`, body());
        status('saved');
        return true;
    } catch {
        status('offline, kept here');
        saveTimer = window.setTimeout(save, RETRY_MS);
        return false;
    } finally {
        saving = false;
        if (pending) {
            pending = false;
            void save();
        }
    }
}

function status(text: string) {
    const el = root?.querySelector('[data-status]');
    if (el) el.textContent = text;
}

/* ----------------------------------------------------------------------- */
/* What was done last time                                                  */

function previous(name: string) {
    const others = logged().filter((x) => x._id !== w._id && x.start < w.start);
    const sessions = exerciseSessions(others, name);
    return sessions[sessions.length - 1];
}

function repRange(name: string) {
    const t = state.data.templates.find((x) => x._id === w.templateId);
    const te = t?.exercises.find((e) => exerciseKey(e.name) === exerciseKey(name));
    return te && te.repsHigh ? [te.repsLow, te.repsHigh] : [8, 12];
}

// "80 × 8", "1:30", "5.2 km · 28:00" for a set
function setText(s: GymSet | undefined, x: ExerciseInfo, name: string) {
    if (!s) return '–';
    if (x.kind === 'cardio') return [s.distance ? `${r1(s.distance)} km` : '', s.seconds ? clock(s.seconds) : ''].filter(Boolean).join(' · ') || '–';
    if (x.kind === 'duration' || x.kind === 'mobility') return s.seconds ? clock(s.seconds) : '–';
    const weight = s.weight ? `${x.kind === 'assisted' ? '−' : x.kind === 'bodyweight' ? '+' : ''}${kg(shown(s.weight, name))}` : x.kind === 'bodyweight' ? 'BW' : '';
    return weight ? `${weight} × ${s.reps ?? '–'}` : `${s.reps ?? '–'}`;
}

/* ----------------------------------------------------------------------- */
/* Drawing                                                                  */

const KIND_LABEL: Record<SetKind, string> = { normal: '', warmup: 'W', drop: 'D', failure: 'F' };
const NEXT_KIND: Record<SetKind, SetKind> = { normal: 'warmup', warmup: 'drop', drop: 'failure', failure: 'normal' };

function columns(x: ExerciseInfo) {
    if (x.kind === 'cardio') return ['km', 'time'];
    if (x.kind === 'duration' || x.kind === 'mobility') return ['time'];
    const u = x.unit === 'lbs' ? 'lb' : 'kg';
    return [x.kind === 'assisted' ? `−${u}` : x.kind === 'bodyweight' ? `+${u}` : u, 'reps'];
}

function setRow(ei: number, s: GymSet, si: number, x: ExerciseInfo, prev: GymSet | undefined, normalIndex: number, name: string) {
    const w = (v: number | null | undefined) => (typeof v === 'number' ? String(shown(v, name)) : '');
    const cols = columns(x);
    const field = (col: string) => {
        if (col === 'reps') return `<input class="form-control" inputmode="numeric" data-f="reps" value="${s.reps ?? ''}" placeholder="${prev?.reps ?? ''}" />`;
        if (col === 'km') return `<input class="form-control" inputmode="decimal" data-f="distance" value="${s.distance ?? ''}" placeholder="${prev?.distance ?? ''}" />`;
        if (col === 'time') return `<input class="form-control" inputmode="numeric" data-f="seconds" value="${s.seconds ? clock(s.seconds) : ''}" placeholder="${prev?.seconds ? clock(prev.seconds) : 'm:ss'}" />`;
        return `<input class="form-control" inputmode="decimal" data-f="weight" value="${w(s.weight)}" placeholder="${w(prev?.weight)}" />`;
    };
    return `<div class="gym-set${s.done ? ' done' : ''} k-${s.kind}" data-e="${ei}" data-s="${si}">
        <button class="gym-setno" data-act="kind" title="Normal, warm-up, drop set, to failure">${KIND_LABEL[s.kind] || normalIndex}</button>
        <div class="gym-prev text-secondary">${esc(setText(prev, x, name))}</div>
        ${cols.map(field).join('')}
        <button class="gym-tick" data-act="tick" aria-label="Done"><i class="ti ti-check"></i></button>
    </div>`;
}

function exerciseCard(e: GymExerciseLog, ei: number) {
    const x = info(e.name);
    const prevSession = previous(e.name);
    const [low, high] = repRange(e.name);
    const next = suggestNext(prevSession, x, low, high);
    let normal = 0;
    const cols = columns(x);
    const cardio = x.kind === 'cardio' ? cardioTotals(e) : null;
    return `<div class="card gym-ex" data-e="${ei}">
        <div class="card-body p-2 p-sm-3">
            <div class="d-flex align-items-center gap-2 mb-2">
                ${thumb(e.name, 52)}
                <div class="flex-fill min-w-0">
                    <div class="fw-bold text-truncate" data-act="info">${esc(e.name)}</div>
                    <div class="text-secondary small text-truncate">${
                        next
                            ? `<i class="ti ti-trending-up"></i> ${wText(next.weight, e.name)} × ${next.reps} · ${esc(next.why)}`
                            : prevSession
                              ? `last ${new Date(prevSession.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`
                              : 'first time'
                    }</div>
                </div>
                <div class="dropdown">
                    <button class="btn btn-icon btn-ghost-secondary" data-bs-toggle="dropdown" aria-label="More"><i class="ti ti-dots-vertical"></i></button>
                    <div class="dropdown-menu dropdown-menu-end">
                        <a class="dropdown-item" href="#" data-act="notes"><i class="ti ti-note me-2"></i>Notes</a>
                        <a class="dropdown-item" href="#" data-act="rest"><i class="ti ti-clock me-2"></i>Rest ${clock(e.restSeconds ?? 90)}</a>
                        <a class="dropdown-item" href="#" data-act="up"><i class="ti ti-arrow-up me-2"></i>Move up</a>
                        <a class="dropdown-item" href="#" data-act="down"><i class="ti ti-arrow-down me-2"></i>Move down</a>
                        <a class="dropdown-item" href="#" data-act="replace"><i class="ti ti-replace me-2"></i>Replace</a>
                        <a class="dropdown-item" href="#" data-act="unset"><i class="ti ti-minus me-2"></i>Remove last set</a>
                        <a class="dropdown-item text-danger" href="#" data-act="remove"><i class="ti ti-trash me-2"></i>Remove exercise</a>
                    </div>
                </div>
            </div>
            ${e.notes ? `<div class="small text-secondary mb-2 gym-note"><i class="ti ti-note"></i> ${esc(e.notes)}</div>` : ''}
            <div class="gym-set gym-set-head text-secondary" style="--cols:${cols.length}"><span>Set</span><span>Last</span>${cols.map((c) => `<span>${c}</span>`).join('')}<span></span></div>
            <div style="--cols:${cols.length}">${e.sets.map((s, si) => setRow(ei, s, si, x, prevSession?.sets[si] ?? prevSession?.sets[prevSession.sets.length - 1], s.kind === 'warmup' ? 0 : ++normal, e.name)).join('')}</div>
            ${cardio && cardio.paceSecPerKm ? `<div class="small text-secondary mt-1">${r1(cardio.distance)} km in ${clock(cardio.seconds)} · ${pace(cardio.paceSecPerKm)} · ${r1(cardio.kmh!)} km/h</div>` : ''}
            <button class="btn btn-sm w-100 mt-2" data-act="addset"><i class="ti ti-plus me-1"></i>Add set</button>
        </div>
    </div>`;
}

function headerHtml() {
    const kinds = WORKOUT_KIND_IDS.map((k) => `<option value="${k}"${k === w.kind ? ' selected' : ''}>${WORKOUT_KINDS[k].label}</option>`).join('');
    const local = (t: number) => {
        const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
        return d.toISOString().slice(0, 16);
    };
    return `<div class="gym-log-head">
        <button class="btn btn-icon btn-ghost-secondary" data-act="minimize" aria-label="Back" title="Back (the workout keeps running)"><i class="ti ti-arrow-left"></i></button>
        ${editing ? '' : '<button class="btn btn-ghost-danger btn-sm" data-act="cancel">Cancel</button>'}
        <div class="flex-fill text-center min-w-0">
            <div class="gym-log-clock" data-clock>${editing ? minutesText(((w.end ?? w.start) - w.start) / 60_000) : clock((Date.now() - w.start) / 1000)}</div>
            <div class="small text-secondary" data-status>${editing ? 'editing' : 'saved'}</div>
        </div>
        <button class="btn btn-primary" data-act="finish">${editing ? 'Save' : 'Finish'}</button>
    </div>
    <div class="gym-log-meta">
        <input class="form-control form-control-lg fw-bold" data-meta="name" value="${esc(w.name)}" maxlength="80" />
        <div class="d-flex gap-2 mt-2">
            <select class="form-select" data-meta="kind">${kinds}</select>
        </div>
        ${
            editing
                ? `<div class="row g-2 mt-1"><div class="col-6"><label class="form-label small mb-0">Start</label><input type="datetime-local" class="form-control" data-meta="start" value="${local(w.start)}" /></div>
                   <div class="col-6"><label class="form-label small mb-0">End</label><input type="datetime-local" class="form-control" data-meta="end" value="${local(w.end ?? w.start)}" /></div></div>`
                : ''
        }
    </div>`;
}

function render() {
    if (!root) return;
    const scroll = root.querySelector('.gym-log-body')?.scrollTop ?? 0;
    root.innerHTML = `${headerHtml()}
        <div class="gym-log-body">
            ${w.exercises.map(exerciseCard).join('')}
            <button class="btn btn-outline-primary w-100 mb-3" data-act="addex"><i class="ti ti-plus me-1"></i>Add exercise</button>
            <textarea class="form-control mb-3" rows="2" placeholder="Notes on this workout" data-meta="notes" maxlength="2000">${esc(w.notes ?? '')}</textarea>
            <button class="btn btn-ghost-danger w-100 mb-5" data-act="discard"><i class="ti ti-trash me-1"></i>${editing ? 'Delete workout' : 'Discard workout'}</button>
        </div>
        <div class="gym-rest" data-rest hidden></div>`;
    root.querySelector('.gym-log-body')!.scrollTop = scroll;
    drawRest();
}

/* ----------------------------------------------------------------------- */
/* Rest timer                                                               */

function beep() {
    try {
        const ctx = new AudioContext();
        for (const [at, f] of [
            [0, 880],
            [0.25, 880],
            [0.5, 1320],
        ]) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            g.gain.setValueAtTime(0.18, ctx.currentTime + at);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.2);
            o.connect(g).connect(ctx.destination);
            o.start(ctx.currentTime + at);
            o.stop(ctx.currentTime + at + 0.22);
        }
    } catch {
        /* no sound */
    }
    navigator.vibrate?.([200, 100, 200]);
}

function startRest(seconds: number) {
    if (!seconds) return;
    stopRest();
    rest = { until: Date.now() + seconds * 1000, total: seconds };
    rest.timer = window.setInterval(() => {
        if (rest && Date.now() >= rest.until) {
            beep();
            stopRest();
        }
        drawRest();
    }, 250);
    drawRest();
}

function stopRest() {
    if (rest?.timer) clearInterval(rest.timer);
    rest = null;
    drawRest();
}

function drawRest() {
    const el = root?.querySelector<HTMLElement>('[data-rest]');
    if (!el) return;
    if (!rest) {
        el.hidden = true;
        return;
    }
    const left = Math.max(0, (rest.until - Date.now()) / 1000);
    el.hidden = false;
    el.innerHTML = `<div class="gym-rest-bar" style="width:${(left / rest.total) * 100}%"></div>
        <button class="btn btn-sm" data-act="rest-minus">−15</button>
        <div class="flex-fill text-center"><div class="small text-secondary">Rest</div><div class="gym-rest-clock">${clock(left)}</div></div>
        <button class="btn btn-sm" data-act="rest-plus">+15</button>
        <button class="btn btn-sm btn-primary" data-act="rest-skip">Skip</button>`;
}

/* ----------------------------------------------------------------------- */
/* Actions                                                                  */

function emptySet(x: ExerciseInfo, like?: GymSet): GymSet {
    const s: GymSet = { kind: 'normal', done: false };
    if (like) {
        for (const k of ['weight', 'reps', 'seconds', 'distance'] as const) if (like[k]) s[k] = like[k];
        s.kind = like.kind === 'warmup' ? 'normal' : like.kind;
    } else if (x.kind === 'duration' || x.kind === 'mobility') s.seconds = 45;
    return s;
}

function readField(input: HTMLInputElement, s: GymSet, name: string) {
    const f = input.dataset.f as 'weight' | 'reps' | 'seconds' | 'distance';
    const raw = input.value.trim();
    if (!raw) {
        delete s[f];
        return;
    }
    const v = f === 'seconds' ? parseClock(raw) : Number(raw.replace(',', '.'));
    if (v === null || !Number.isFinite(v) || v < 0) return;
    s[f] = f === 'reps' ? Math.round(v) : f === 'weight' ? stored(v, name) : v;
}

async function finish() {
    // unticked sets with nothing in them go; ticked or filled ones stay
    if (!editing) {
        const open = w.exercises.reduce((n, e) => n + e.sets.filter((s) => !s.done).length, 0);
        if (open && !(await ask('Finish the workout?', `${open} set${open === 1 ? ' is' : 's are'} not ticked. They are left out.`, 'Finish'))) return;
        for (const e of w.exercises) e.sets = e.sets.filter((s) => s.done);
        w.exercises = w.exercises.filter((e) => e.sets.length);
        w.end = Date.now();
    }
    try {
        await api('PATCH', `/api/gym/workouts/${w._id}`, { ...body(), end: w.end });
    } catch (err) {
        toast(`Not saved: ${(err as Error).message}. Try again when online.`, 'error');
        return;
    }
    dropBackup();
    const done = { ...w };
    const wasEditing = editing;
    close();
    if (!wasEditing) summary(done);
    onDone();
}

// what the workout brought: time, sets, weight moved, the records it set
function summary(done: GymWorkout) {
    const st = workoutStats(done);
    const before = logged().filter((x) => x._id !== done._id && x.start < done.start);
    const prs: string[] = [];
    for (const e of done.exercises) {
        const r = records(exerciseSessions(before, e.name));
        const best = Math.max(0, ...e.sets.filter(isWorkSet).map((s) => e1rm(s.weight, s.reps)));
        const heaviest = Math.max(0, ...e.sets.filter(isWorkSet).map((s) => s.weight ?? 0));
        if (r.e1rm && best > r.e1rm.value) prs.push(`${esc(e.name)}: estimated 1RM ${wText(best, e.name)} (was ${wText(r.e1rm.value, e.name)})`);
        else if (r.weight && heaviest > r.weight.value) prs.push(`${esc(e.name)}: heaviest ${wText(heaviest, e.name)}`);
    }
    const s = sheet(
        'Workout done',
        `<div class="text-center mb-3"><div class="display-6 fw-bold">${esc(done.name)}</div>
            <div class="text-secondary">${minutesText(((done.end ?? done.start) - done.start) / 60_000)} · ${st.sets} sets${st.volume ? ` · ${tonnage(st.volume)}` : ''}${st.distance ? ` · ${r1(st.distance)} km` : ''}</div></div>
        ${prs.length ? `<h4><i class="ti ti-trophy text-warning me-1"></i>New records</h4><ul>${prs.map((p) => `<li>${p}</li>`).join('')}</ul>` : '<p class="text-secondary text-center mb-0">Logged. Keep it going.</p>'}
        ${
            done.templateId || !done.exercises.length
                ? ''
                : `<div class="card mt-3"><div class="card-body p-3"><div class="fw-bold mb-1">Keep this workout?</div>
                    <div class="small text-secondary mb-2">Save it as a template to start it again with one tap.</div>
                    <div class="d-flex gap-2"><input class="form-control" data-tname value="${esc(done.name)}" maxlength="80" /><button class="btn btn-primary text-nowrap" data-save-tpl>Save as template</button></div></div></div>`
        }`,
    );
    s.el.querySelector('[data-save-tpl]')?.addEventListener('click', async (ev) => {
        const b = ev.currentTarget as HTMLButtonElement;
        const name = s.el.querySelector<HTMLInputElement>('[data-tname]')!.value.trim() || done.name;
        b.disabled = true;
        try {
            await saveAsTemplate(done, name);
            b.closest('.card')!.innerHTML = `<div class="card-body p-3 text-success"><i class="ti ti-check me-1"></i>Saved as “${esc(name)}”: it is in your templates.</div>`;
            onDone();
        } catch (err) {
            b.disabled = false;
            toast((err as Error).message, 'error');
        }
    });
}

async function onClick(ev: Event) {
    const target = ev.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act!;
    if (btn.tagName === 'A') ev.preventDefault();
    const card = btn.closest<HTMLElement>('[data-e]');
    const ei = card ? Number(card.dataset.e) : -1;
    const e = w.exercises[ei];
    const row = btn.closest<HTMLElement>('[data-s]');
    const si = row ? Number(row.dataset.s) : -1;

    switch (act) {
        case 'minimize':
            close(false);
            onDone();
            return;
        case 'finish':
            await finish();
            return;
        case 'cancel':
            await cancelWorkout(w, () => {
                clearTimeout(saveTimer);
                close();
                onDone();
            });
            return;
        case 'discard':
            if (await ask(editing ? 'Delete this workout?' : 'Discard this workout?', 'Its sets are gone for good.', editing ? 'Delete' : 'Discard', true)) {
                clearTimeout(saveTimer);
                await api('DELETE', `/api/gym/workouts/${w._id}`).catch(() => {});
                dropBackup();
                close();
                onDone();
            }
            return;
        case 'addex':
            pickExercise((name) => {
                const x = info(name);
                const prev = previous(name);
                const n = prev?.sets.length ?? (x.kind === 'cardio' ? 1 : 3);
                w.exercises.push({ name, restSeconds: x.kind === 'cardio' ? 0 : 90, sets: Array.from({ length: n }, () => emptySet(x)) });
                changed();
                render();
                root?.querySelector('.gym-log-body')?.scrollTo({ top: 1e6, behavior: 'smooth' });
            });
            return;
        case 'tick': {
            const s = e.sets[si];
            if (!s.done) {
                // empty fields take last time's values, as they stand in the placeholders
                row!.querySelectorAll<HTMLInputElement>('input[data-f]').forEach((input) => {
                    if (!input.value && input.placeholder && input.placeholder !== 'm:ss') input.value = input.placeholder;
                    readField(input, s, e.name);
                });
                const x = info(e.name);
                if (!s.reps && !s.seconds && !s.distance && x.kind !== 'cardio') {
                    toast('Enter the reps first', 'error');
                    return;
                }
                s.done = true;
                startRest(e.restSeconds ?? 90);
            } else s.done = false;
            changed();
            render();
            return;
        }
        case 'kind':
            e.sets[si].kind = NEXT_KIND[e.sets[si].kind];
            changed();
            render();
            return;
        case 'addset': {
            const last = e.sets[e.sets.length - 1];
            e.sets.push({ ...emptySet(info(e.name), last), done: false });
            changed();
            render();
            return;
        }
        case 'unset':
            e.sets.pop();
            changed();
            render();
            return;
        case 'remove':
            w.exercises.splice(ei, 1);
            changed();
            render();
            return;
        case 'up':
        case 'down': {
            const to = act === 'up' ? ei - 1 : ei + 1;
            if (to < 0 || to >= w.exercises.length) return;
            [w.exercises[ei], w.exercises[to]] = [w.exercises[to], w.exercises[ei]];
            changed();
            render();
            return;
        }
        case 'replace':
            pickExercise((name) => {
                e.name = name;
                changed();
                render();
            }, 'Replace with');
            return;
        case 'notes': {
            const s = sheet(`Notes: ${esc(e.name)}`, `<textarea class="form-control" rows="4" maxlength="2000">${esc(e.notes ?? '')}</textarea>`, {
                footer: '<button class="btn btn-primary" data-ok>Done</button>',
            });
            s.el.querySelector('[data-ok]')!.addEventListener('click', () => {
                e.notes = s.el.querySelector('textarea')!.value.trim() || undefined;
                changed();
                render();
                s.close();
            });
            return;
        }
        case 'rest': {
            const opts = [0, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300];
            const s = sheet(`Rest after each set`, `<div class="gym-chips">${opts.map((o) => `<button class="gym-chip${o === (e.restSeconds ?? 90) ? ' on' : ''}" data-r="${o}">${o ? clock(o) : 'off'}</button>`).join('')}</div>`);
            s.el.querySelector('.gym-chips')!.addEventListener('click', (x) => {
                const b = (x.target as HTMLElement).closest<HTMLElement>('[data-r]');
                if (!b) return;
                e.restSeconds = Number(b.dataset.r);
                changed();
                render();
                s.close();
            });
            return;
        }
        case 'info':
            document.dispatchEvent(new CustomEvent('gym:exercise', { detail: e.name }));
            return;
        case 'rest-minus':
            if (rest) rest.until -= 15_000;
            drawRest();
            return;
        case 'rest-plus':
            if (rest) {
                rest.until += 15_000;
                rest.total += 15;
            }
            drawRest();
            return;
        case 'rest-skip':
            stopRest();
            return;
    }
}

function onInput(ev: Event) {
    const input = ev.target as HTMLInputElement;
    if (input.dataset.meta) {
        const k = input.dataset.meta;
        if (k === 'name') w.name = input.value.trim() || 'Workout';
        else if (k === 'notes') w.notes = input.value;
        else if (k === 'kind') w.kind = input.value as GymWorkout['kind'];
        else if (k === 'start' || k === 'end') {
            const t = new Date(input.value).getTime();
            if (Number.isFinite(t)) w[k] = t;
        }
        changed();
        return;
    }
    const row = input.closest<HTMLElement>('[data-s]');
    if (!row || !input.dataset.f) return;
    const ex = w.exercises[Number(row.dataset.e)];
    readField(input, ex.sets[Number(row.dataset.s)], ex.name);
    changed();
}

/* ----------------------------------------------------------------------- */

function close(final = true) {
    layerClosed?.();
    layerClosed = null;
    clearInterval(clockTimer);
    stopRest();
    if (!final) void save();
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    root?.remove();
    root = null;
    document.body.classList.remove('gym-logging');
}

/* Cancelling always asks first; with ticked sets it says they go too. */
export async function cancelWorkout(workout: GymWorkout, done: () => void) {
    const ticked = workout.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);
    const text = ticked
        ? `${ticked} set${ticked === 1 ? ' is' : 's are'} ticked. Cancelling deletes the workout with them.`
        : 'The workout is deleted and nothing of it is kept.';
    if (!(await ask('Are you sure you want to cancel this workout?', text, 'Yes, cancel it', true, 'No, keep it'))) return;
    try {
        await api('DELETE', `/api/gym/workouts/${workout._id}`);
    } catch (err) {
        toast(`Not cancelled: ${(err as Error).message}`, 'error');
        return;
    }
    dropBackup();
    toast('Workout cancelled');
    done();
}

export function isOpen() {
    return !!root;
}

export async function openLogger(workout: GymWorkout, opts: { editing?: boolean; onDone?: () => void } = {}) {
    if (root) close(false);
    w = structuredClone(workout);
    editing = !!opts.editing;
    onDone = opts.onDone ?? (() => {});
    root = document.createElement('div');
    root.className = 'gym-logger';
    document.body.appendChild(root);
    document.body.classList.add('gym-logging');
    // the phone's back: the page again, the workout keeps running
    layerClosed = openLayer(() => {
        layerClosed = null;
        close(false);
        onDone();
    });
    root.addEventListener('click', (e) => void onClick(e));
    root.addEventListener('change', onInput);
    root.addEventListener('input', (e) => {
        if ((e.target as HTMLElement).matches('input[data-f], [data-meta="notes"], [data-meta="name"]')) onInput(e);
    });
    render();
    if (!editing) {
        clockTimer = window.setInterval(() => {
            const el = root?.querySelector('[data-clock]');
            if (el) el.textContent = clock((Date.now() - w.start) / 1000);
        }, 1000);
        try {
            wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
        } catch {
            /* the screen may sleep */
        }
    }
}

/* The workout that runs: the server's, or the copy in this browser when it is newer (it was
 * changed without a network), which is then sent. */
export async function resumeActive(server: GymWorkout | null) {
    const local = readBackup();
    if (local && server && local.workout._id === server._id && local.at > (server.updatedAt ?? 0)) {
        try {
            await api('PATCH', `/api/gym/workouts/${server._id}`, { name: local.workout.name, kind: local.workout.kind, notes: local.workout.notes ?? '', exercises: local.workout.exercises });
            return local.workout;
        } catch {
            return local.workout;
        }
    }
    if (local && !server) {
        // finished elsewhere, or never reached the server: the copy here is the only one left
        dropBackup();
        return null;
    }
    return server;
}
