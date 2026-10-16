import {
    WORKOUT_KINDS,
    exerciseKey,
    guessExercise,
    isWorkSet,
    setVolume,
    shownWeight,
    storedWeight,
    type ExerciseInfo,
    type GymTemplate,
    type GymWorkout,
    type WorkoutKind,
} from '../../../shared/gym';
import { exerciseFigure, type Sex } from './gymBody';
import { escapeHtml } from './utils';

/* What the parts of the gym page share: the data read from the server, the lookup of an
 * exercise, the calls to the api, the formats, the sheets (modals) and the colours of the kinds. */

declare const bootstrap: { Modal: { getOrCreateInstance(el: Element, o?: Record<string, unknown>): { show(): void; hide(): void } } };

export interface GymData {
    workouts: GymWorkout[];
    templates: GymTemplate[];
    exercises: ExerciseInfo[]; // the user's own
    profile: { sex: Sex; bodyweight: number | null };
    oldest: number | null;
}

export const state: { data: GymData; own: Map<string, ExerciseInfo> } = {
    data: { workouts: [], templates: [], exercises: [], profile: { sex: 'male', bodyweight: null }, oldest: null },
    own: new Map(),
};

export function setData(d: GymData) {
    state.data = d;
    state.own = new Map(d.exercises.map((e) => [exerciseKey(e.name), e]));
}

export const info = (name: string): ExerciseInfo => state.own.get(exerciseKey(name)) ?? guessExercise(name);

/* Weights are kept in kg; each exercise shows and takes them in its unit (lbs on a machine
 * labelled in pounds). */
export const unitLabel = (name: string) => (info(name).unit === 'lbs' ? 'lb' : 'kg');
export const shown = (kgValue: number, name: string) => shownWeight(kgValue, info(name).unit);
export const stored = (value: number, name: string) => storedWeight(value, info(name).unit);
// "55 lb", "25 kg"
export const wText = (kgValue: number | null | undefined, name: string) => (typeof kgValue === 'number' ? `${kg(shown(kgValue, name))} ${unitLabel(name)}` : '–');

// the workouts that hold sets (not the tracker's alone), finished
export const logged = () => state.data.workouts.filter((w) => w.source !== 'tracker' && w.end);

/* ----------------------------------------------------------------------- */

export class ApiError extends Error {}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
        method,
        headers: body instanceof FormData ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    if (res.status === 401) {
        window.location.href = '/login';
        throw new ApiError('not logged in');
    }
    if (!res.ok) throw new ApiError((await res.text()) || `${res.status}`);
    return (await res.json()) as T;
}

/* ----------------------------------------------------------------------- */
/* Formats                                                                  */

export const esc = escapeHtml;
export const r1 = (v: number) => Math.round(v * 10) / 10;
export const kg = (v: number | null | undefined) => (typeof v === 'number' ? `${r1(v).toLocaleString()}` : '–');

export function clock(seconds: number) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// "1:05:00", "5:30", "90" (seconds) or "5m" as seconds
export function parseClock(v: string): number | null {
    const t = v.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const parts = t.split(':').map(Number);
    if (parts.some((p) => !Number.isFinite(p))) return null;
    return parts.reduce((s, p) => s * 60 + p, 0);
}

export function minutesText(min: number) {
    const m = Math.round(min);
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

export function pace(secPerKm: number) {
    return `${clock(secPerKm)} /km`;
}

export const dayText = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
export const timeText = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const shortDay = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });

export function tonnage(v: number) {
    return v >= 1000 ? `${r1(v / 1000).toLocaleString()} t` : `${Math.round(v)} kg`;
}

export function workoutStats(w: GymWorkout) {
    let sets = 0;
    let volume = 0;
    let distance = 0;
    for (const e of w.exercises)
        for (const s of e.sets) {
            if (!isWorkSet(s)) continue;
            sets++;
            volume += setVolume(s);
            distance += s.distance ?? 0;
        }
    return { sets, volume, distance };
}

/* ----------------------------------------------------------------------- */
/* Kinds                                                                    */

export const KIND_COLORS: Record<WorkoutKind, string> = {
    strength: '#d9622b',
    running: '#3d7a73',
    cycling: '#c98d12',
    pilates: '#7b3f61',
    yoga: '#6d8526',
    hiit: '#a63d1f',
    swimming: '#3d6f9a',
    walking: '#8a6f5c',
    cardio: '#b0574a',
    sport: '#5e8c7f',
};

export const kindIcon = (k: WorkoutKind, size = 40) =>
    `<span class="gym-kind" style="--k:${KIND_COLORS[k]};width:${size}px;height:${size}px"><i class="ti ti-${WORKOUT_KINDS[k].icon}"></i></span>`;

/* ----------------------------------------------------------------------- */
/* Drawings                                                                 */

const figureCache = new Map<string, string>();

export function figureOf(name: string) {
    const x = info(name);
    const key = `${state.data.profile.sex}|${x.primary.join()}|${x.secondary.join()}`;
    let svg = figureCache.get(key);
    if (!svg) {
        svg = x.primary.length ? exerciseFigure(x.primary, x.secondary, state.data.profile.sex, name) : '';
        figureCache.set(key, svg);
    }
    return svg || `<div class="gym-noimg"><i class="ti ti-${x.kind === 'cardio' ? WORKOUT_KINDS[x.activity ?? 'cardio'].icon : 'barbell'}"></i></div>`;
}

// tapped, it opens big (gym.ts, onZoomClick)
export const thumb = (name: string, size = 56) =>
    `<div class="gym-plate gym-thumb" style="width:${size}px;height:${size}px"${info(name).primary.length ? ` data-zoom="${escapeHtml(name)}" role="button" aria-label="Zoom"` : ''}>${figureOf(name)}</div>`;

export function clearFigures() {
    figureCache.clear();
}

/* ----------------------------------------------------------------------- */
/* Sheets: a modal, full screen on a phone                                  */

let sheetCount = 0;

export interface Sheet {
    el: HTMLElement;
    body: HTMLElement;
    close(): void;
}

/* Screens over the page (sheets, the workout, the zoomed drawing) are layers. The first one
 * opened puts one entry in the browser's history, so the phone's back button or gesture closes
 * the top layer instead of leaving the gym; when the last one closes by its own button that
 * entry is taken back out. */
const layers: { close: () => void }[] = [];
let marker = false;
let ignorePop = false;

export function openLayer(close: () => void) {
    const layer = { close };
    layers.push(layer);
    if (!marker) {
        history.pushState({ ...(history.state ?? {}), gymLayer: true }, '');
        marker = true;
    }
    // the layer closed itself (its button, the backdrop): when none is left, the entry goes
    return () => {
        const i = layers.indexOf(layer);
        if (i >= 0) layers.splice(i, 1);
        // a layer that opens the next as it closes keeps the entry: decide once it has
        setTimeout(() => {
            if (!layers.length && marker) {
                marker = false;
                ignorePop = true;
                history.back();
            }
        }, 0);
    };
}

// the browser went back: true when that was a layer's (closed now), false for the page's own
export function layerPop() {
    if (ignorePop) {
        ignorePop = false;
        return true;
    }
    if (!marker) return false;
    marker = false;
    const top = layers.pop();
    if (!top) return false;
    top.close();
    if (layers.length) {
        history.pushState({ ...(history.state ?? {}), gymLayer: true }, '');
        marker = true;
    }
    return true;
}

/* A sheet: a modal, full screen on a phone, a back arrow on its left. `back` is the screen it
 * was opened from, shown again when going back (the arrow or the phone's back); the cross
 * closes it to the page. */
export function sheet(title: string, body: string, opts: { footer?: string; size?: 'lg' | 'xl'; onClose?: () => void; back?: () => void } = {}): Sheet {
    const el = document.createElement('div');
    el.className = 'modal modal-blur fade gym-sheet';
    el.id = `gym-sheet-${++sheetCount}`;
    el.tabIndex = -1;
    el.innerHTML = `<div class="modal-dialog modal-dialog-scrollable modal-fullscreen-sm-down ${opts.size ? `modal-${opts.size}` : ''}">
        <div class="modal-content">
            <div class="modal-header gap-2">
                <button type="button" class="btn btn-icon btn-ghost-secondary gym-back" data-sheet-back aria-label="Back"><i class="ti ti-arrow-left"></i></button>
                <h5 class="modal-title text-truncate flex-fill">${title}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">${body}</div>
            ${opts.footer ? `<div class="modal-footer">${opts.footer}</div>` : ''}
        </div></div>`;
    document.body.appendChild(el);
    const modal = bootstrap.Modal.getOrCreateInstance(el);
    let goBack = false;
    const closed = openLayer(() => {
        goBack = true;
        modal.hide();
    });
    el.querySelector('[data-sheet-back]')!.addEventListener('click', () => {
        goBack = true;
        modal.hide();
    });
    el.addEventListener('hide.bs.modal', () => {
        // the screen before opens as this one leaves
        if (goBack) opts.back?.();
    });
    el.addEventListener('hidden.bs.modal', () => {
        closed();
        opts.onClose?.();
        el.remove();
    });
    modal.show();
    return { el, body: el.querySelector('.modal-body') as HTMLElement, close: () => modal.hide() };
}

// a question with two answers, as a sheet (never the browser's confirm, which blocks the page)
export function ask(title: string, text: string, yes: string, danger = false, no = 'Cancel'): Promise<boolean> {
    return new Promise((resolve) => {
        let answered = false;
        const s = sheet(title, `<p class="mb-0">${text}</p>`, {
            footer: `<button class="btn" data-a="no">${no}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${yes}</button>`,
            onClose: () => !answered && resolve(false),
        });
        s.el.querySelector('[data-a="no"]')!.addEventListener('click', () => s.close());
        s.el.querySelector('[data-a="yes"]')!.addEventListener('click', () => {
            answered = true;
            resolve(true);
            s.close();
        });
    });
}

/* A workout kept as a template: its exercises in their order, the sets done, the reps they
 * spanned, their time and distance. */
export async function saveAsTemplate(w: GymWorkout, name = w.name) {
    return api<{ _id: string }>('POST', '/api/gym/templates', {
        name,
        kind: w.kind,
        exercises: w.exercises
            .filter((e) => e.sets.some(isWorkSet))
            .map((e) => {
                const work = e.sets.filter(isWorkSet);
                const reps = work.map((x) => x.reps ?? 0).filter(Boolean);
                return {
                    name: e.name,
                    sets: Math.max(1, work.length),
                    repsLow: reps.length ? Math.min(...reps) : 0,
                    repsHigh: reps.length ? Math.max(...reps) : 0,
                    restSeconds: e.restSeconds ?? 90,
                    seconds: Math.max(0, ...work.map((x) => x.seconds ?? 0)) || undefined,
                    distance: Math.max(0, ...work.map((x) => x.distance ?? 0)) || undefined,
                };
            }),
    });
}

let toastTimer: number | undefined;
export function toast(text: string, tone: 'ok' | 'error' = 'ok') {
    let el = document.getElementById('gym-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'gym-toast';
        document.body.appendChild(el);
    }
    el.className = `gym-toast show ${tone}`;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el!.classList.remove('show'), 3200);
}
