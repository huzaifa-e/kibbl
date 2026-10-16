import './main';
import '../gym.css';
import type ApexCharts from 'apexcharts';
import {
    GROUPS,
    GROUP_IDS,
    MUSCLES,
    MUSCLE_IDS,
    WORKOUT_KINDS,
    WORKOUT_KIND_IDS,
    cardioTotals,
    exerciseKey,
    exerciseSessions,
    groupOf,
    groupStrengthChange,
    groupStrengthIndex,
    gymInsights,
    isWorkSet,
    records,
    setsPerGroup,
    setsPerMuscle,
    weekStart,
    weeklyActivity,
    weeklyGroups,
    workoutMinutes,
    type Equipment,
    type ExerciseInfo,
    type ExerciseKind,
    type GymTemplate,
    type GymWorkout,
    type Muscle,
    type MuscleGroup,
    type TemplateExercise,
    type WorkoutKind,
} from '../../../shared/gym';
import { BODY_CSS, bodyMap } from './gymBody';
import { activityChart, exerciseChart, groupSetsChart, strengthChart } from './gymCharts';
import {
    ApiError,
    KIND_COLORS,
    api,
    ask,
    clearFigures,
    clock,
    dayText,
    esc,
    figureOf,
    info,
    kg,
    kindIcon,
    logged,
    minutesText,
    pace,
    parseClock,
    r1,
    setData,
    sheet,
    shortDay,
    state,
    thumb,
    timeText,
    toast,
    tonnage,
    workoutStats,
    type GymData,
} from './gymCommon';
import { openLogger, isOpen, readBackup, resumeActive } from './gymLogger';
import { FILTERS, allExercises, matchesFilter, muscleText, pickExercise, useCounts } from './gymPicker';
import { emptyState, errorAlert } from './utils';

/* The gym: every kind of training in one place. Train starts a workout from a template (lifting,
 * running, riding, Pilates, mobility, HIIT); History is everything done, with the fitness
 * tracker's sessions; Progress the muscles by the sets they got and how strength goes; Exercises
 * the library with the drawings of the muscles and each one's records. Made for the phone, and
 * to be kept on its home screen. */

type Tab = 'train' | 'history' | 'progress' | 'exercises';
const TABS: [Tab, string, string][] = [
    ['train', 'Train', 'barbell'],
    ['history', 'History', 'calendar-event'],
    ['progress', 'Progress', 'chart-arrows-vertical'],
    ['exercises', 'Exercises', 'list-search'],
];

const DAY_MS = 24 * 3600_000;
let tab: Tab = ((): Tab => {
    const p = window.location.pathname.split('/')[2] as Tab;
    return TABS.some(([t]) => t === p) ? p : 'train';
})();
let active: GymWorkout | null = null;
let charts: ApexCharts[] = [];
let kindFilter: WorkoutKind | 'all' = 'all';
let progressWeeks = 12;
let exerciseFilter: (typeof FILTERS)[number][0] = 'all';
let exerciseQuery = '';

const container = () => document.getElementById('container')!;

function dropCharts() {
    for (const c of charts) c.destroy();
    charts = [];
}

/* ----------------------------------------------------------------------- */
/* Loading                                                                  */

const DATA_COPY = 'kibbl-gym-data';
let offline = false;

/* The data from the server; without a network the copy of the last visit, and the workout that
 * runs as this browser kept it (it is sent once the network is back). */
async function load() {
    try {
        const [data, act] = await Promise.all([api<GymData>('GET', '/api/gym'), api<{ workout: GymWorkout | null }>('GET', '/api/gym/active')]);
        setData(data);
        active = await resumeActive(act.workout);
        offline = false;
        try {
            localStorage.setItem(DATA_COPY, JSON.stringify(data));
        } catch {
            /* too large or private mode: no copy */
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        let copy: GymData | null = null;
        try {
            copy = JSON.parse(localStorage.getItem(DATA_COPY) ?? 'null');
        } catch {
            copy = null;
        }
        if (!copy) throw err;
        setData(copy);
        active = readBackup()?.workout ?? null;
        offline = true;
    }
}

async function reload() {
    await load();
    render();
}

/* ----------------------------------------------------------------------- */
/* Train                                                                    */

function weekStrip() {
    const now = Date.now();
    const monday = weekStart(now);
    const days = Array.from({ length: 7 }, (_, i) => new Date(monday + i * DAY_MS + 12 * 3600_000));
    const week = weeklyActivity(state.data.workouts, 1, now)[0];
    const lastWeek = weeklyActivity(state.data.workouts, 2, now)[0];
    const cells = days
        .map((d) => {
            const key = d.toDateString();
            const ws = state.data.workouts.filter((w) => new Date(w.start).toDateString() === key && w.end);
            const today = key === new Date().toDateString();
            return `<div class="gym-day${today ? ' today' : ''}">
                <div class="small text-secondary">${d.toLocaleDateString([], { weekday: 'narrow' })}</div>
                <div class="gym-day-dots">${ws.length ? ws.slice(0, 4).map((w) => `<span style="background:${KIND_COLORS[w.kind]}" title="${esc(w.name)}"></span>`).join('') : '<span class="none"></span>'}</div>
            </div>`;
        })
        .join('');
    const kinds = WORKOUT_KIND_IDS.filter((k) => week.byKind[k])
        .map((k) => `<span class="gym-kpill" style="--k:${KIND_COLORS[k]}"><i class="ti ti-${WORKOUT_KINDS[k].icon}"></i> ${week.byKind[k]!.sessions} · ${minutesText(week.byKind[k]!.minutes)}</span>`)
        .join('');
    return `<div class="card mb-3"><div class="card-body">
        <div class="d-flex align-items-baseline justify-content-between mb-2">
            <div><div class="hud-label">This week</div><div class="h2 mb-0">${week.sessions} workout${week.sessions === 1 ? '' : 's'} · ${minutesText(week.minutes)}</div></div>
            <div class="text-secondary small text-end">last week<br>${lastWeek.sessions} · ${minutesText(lastWeek.minutes)}</div>
        </div>
        <div class="gym-week">${cells}</div>
        ${kinds ? `<div class="d-flex flex-wrap gap-1 mt-2">${kinds}</div>` : ''}
    </div></div>`;
}

function templateMuscles(t: GymTemplate) {
    const set = new Map<Muscle, number>();
    for (const e of t.exercises) {
        const x = info(e.name);
        for (const m of x.primary) set.set(m, 1);
        for (const m of x.secondary) if (!set.has(m)) set.set(m, 0.35);
    }
    return set;
}

function templateCard(t: GymTemplate) {
    const muscles = templateMuscles(t);
    const groups = [...new Set([...muscles.entries()].filter(([, v]) => v === 1).map(([m]) => GROUPS[groupOf(m)].label))];
    const last = logged()
        .filter((w) => w.name === t.name)
        .sort((a, b) => b.start - a.start)[0];
    const map = muscles.size ? bodyMap((m) => muscles.get(m) ?? null, state.data.profile.sex) : null;
    return `<div class="card gym-tpl" data-tpl="${t._id}">
        <div class="card-body p-3 d-flex gap-3">
            ${map ? `<div class="gym-plate gym-tpl-map">${map.front}${map.back}</div>` : `<div class="gym-tpl-map d-flex align-items-center justify-content-center">${kindIcon(t.kind, 56)}</div>`}
            <div class="flex-fill min-w-0">
                <div class="d-flex align-items-start gap-2">
                    <div class="flex-fill min-w-0">
                        <div class="fw-bold text-truncate">${esc(t.name)}</div>
                        <div class="small text-secondary"><i class="ti ti-${WORKOUT_KINDS[t.kind].icon}" style="color:${KIND_COLORS[t.kind]}"></i> ${WORKOUT_KINDS[t.kind].label}${last ? ` · last ${shortDay(last.start)}` : ''}</div>
                    </div>
                    <div class="dropdown">
                        <button class="btn btn-icon btn-ghost-secondary btn-sm" data-bs-toggle="dropdown" aria-label="More"><i class="ti ti-dots-vertical"></i></button>
                        <div class="dropdown-menu dropdown-menu-end">
                            <a class="dropdown-item" href="#" data-act="tpl-edit"><i class="ti ti-pencil me-2"></i>Edit</a>
                            <a class="dropdown-item" href="#" data-act="tpl-copy"><i class="ti ti-copy me-2"></i>Duplicate</a>
                            <a class="dropdown-item text-danger" href="#" data-act="tpl-delete"><i class="ti ti-trash me-2"></i>Delete</a>
                        </div>
                    </div>
                </div>
                ${groups.length ? `<div class="small mt-1">${groups.map(esc).join(' · ')}</div>` : ''}
                <div class="small text-secondary mt-1 gym-tpl-list">${t.exercises
                    .slice(0, 5)
                    .map((e) => `${esc(e.name)}${e.distance ? ` · ${e.distance} km` : e.seconds && !e.repsHigh ? ` · ${clock(e.seconds)}` : ''}${e.sets > 1 ? ` <span class="text-nowrap">× ${e.sets}</span>` : ''}`)
                    .join('<br>')}${t.exercises.length > 5 ? `<br>+ ${t.exercises.length - 5} more` : ''}</div>
                <button class="btn btn-primary btn-sm mt-2" data-act="tpl-start"><i class="ti ti-player-play me-1"></i>Start</button>
            </div>
        </div>
    </div>`;
}

function trainTab() {
    const kinds = WORKOUT_KIND_IDS.filter((k) => state.data.templates.some((t) => t.kind === k));
    const templates = state.data.templates.filter((t) => kindFilter === 'all' || t.kind === kindFilter);
    const noHistory = !logged().some((w) => w.source === 'strong');
    return `${
        active
            ? `<div class="card gym-active mb-3" data-act="resume"><div class="card-body d-flex align-items-center gap-3">
                ${kindIcon(active.kind)}<div class="flex-fill min-w-0"><div class="fw-bold text-truncate">${esc(active.name)}</div>
                <div class="small">running since ${timeText(active.start)} · ${active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0)} sets done</div></div>
                <button class="btn btn-light">Resume</button></div></div>`
            : ''
    }
    ${weekStrip()}
    <div class="d-flex gap-2 mb-3">
        <button class="btn flex-fill" data-act="empty"><i class="ti ti-plus me-1"></i>Empty workout</button>
        <button class="btn flex-fill" data-act="past"><i class="ti ti-history me-1"></i>Log a past one</button>
    </div>
    ${
        noHistory
            ? `<div class="card mb-3 gym-import-cta"><div class="card-body">
                <div class="d-flex gap-3 align-items-center"><span class="hud-icon hud-pumpkin"><i class="ti ti-file-import"></i></span>
                <div class="flex-fill"><div class="fw-bold">Bring your Strong history</div><div class="small text-secondary">Your sets, weights and workouts, and templates made from your real routine.</div></div></div>
                <button class="btn btn-primary w-100 mt-3" data-act="import">Import from Strong</button></div></div>`
            : ''
    }
    <div class="d-flex align-items-center justify-content-between mb-2">
        <h3 class="mb-0">Templates</h3>
        <button class="btn btn-sm" data-act="tpl-new"><i class="ti ti-plus me-1"></i>New</button>
    </div>
    <div class="gym-chips mb-3">
        <button class="gym-chip${kindFilter === 'all' ? ' on' : ''}" data-kind="all">All</button>
        ${kinds.map((k) => `<button class="gym-chip${kindFilter === k ? ' on' : ''}" data-kind="${k}"><i class="ti ti-${WORKOUT_KINDS[k].icon}"></i> ${WORKOUT_KINDS[k].label}</button>`).join('')}
    </div>
    <div class="gym-tpls">${templates.map(templateCard).join('') || emptyState('template', 'No templates', 'Make one with New.')}</div>`;
}

/* ----------------------------------------------------------------------- */
/* History                                                                  */

function workoutLine(w: GymWorkout) {
    const st = workoutStats(w);
    const bits: string[] = [timeText(w.start), minutesText(workoutMinutes(w))];
    if (st.sets && w.kind === 'strength') bits.push(`${st.sets} sets`, ...(st.volume ? [tonnage(st.volume)] : []));
    const cardio = w.exercises.map((e) => cardioTotals(e)).find((c) => c.distance);
    if (cardio) bits.push(`${r1(cardio.distance)} km`, ...(cardio.paceSecPerKm ? [pace(cardio.paceSecPerKm)] : []));
    else if (st.distance) bits.push(`${r1(st.distance)} km`);
    if (w.tracker?.avgHr) bits.push(`<i class="ti ti-heart text-danger"></i> ${w.tracker.avgHr}`);
    if (w.tracker?.calories) bits.push(`${w.tracker.calories} kcal`);
    return `<button class="list-group-item list-group-item-action d-flex align-items-center gap-3" data-workout="${esc(w._id)}">
        ${kindIcon(w.kind)}
        <div class="flex-fill min-w-0">
            <div class="fw-bold text-truncate">${esc(w.name)}${w.source === 'tracker' ? ' <span class="badge bg-secondary-lt">tracker</span>' : w.source === 'strong' ? ' <span class="badge bg-secondary-lt">Strong</span>' : ''}</div>
            <div class="small text-secondary text-truncate">${dayText(w.start)} · ${bits.join(' · ')}</div>
        </div><i class="ti ti-chevron-right text-secondary"></i></button>`;
}

function historyTab() {
    const done = state.data.workouts.filter((w) => w.end);
    if (!done.length) return emptyState('calendar-event', 'Nothing yet', 'Start a workout, or import your Strong history from the menu above.');
    const byWeek = new Map<number, GymWorkout[]>();
    for (const w of done) byWeek.set(weekStart(w.start), [...(byWeek.get(weekStart(w.start)) ?? []), w]);
    return [...byWeek.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([week, ws]) => {
            const minutes = ws.reduce((s, w) => s + workoutMinutes(w), 0);
            const kinds = WORKOUT_KIND_IDS.filter((k) => ws.some((w) => w.kind === k));
            return `<div class="d-flex align-items-baseline justify-content-between mt-3 mb-1 px-1">
                    <div class="fw-bold">Week of ${shortDay(week)}</div>
                    <div class="small text-secondary">${kinds.map((k) => `<i class="ti ti-${WORKOUT_KINDS[k].icon}" style="color:${KIND_COLORS[k]}"></i>`).join(' ')} ${ws.length} · ${minutesText(minutes)}</div>
                </div>
                <div class="card"><div class="list-group list-group-flush">${ws.sort((a, b) => b.start - a.start).map(workoutLine).join('')}</div></div>`;
        })
        .join('');
}

function workoutSheet(w: GymWorkout) {
    const st = workoutStats(w);
    const exercises = w.exercises
        .map((e) => {
            const x = info(e.name);
            const sets = e.sets
                .filter((s) => s.done)
                .map((s, i) => {
                    const label = s.kind === 'warmup' ? 'W' : s.kind === 'drop' ? 'D' : s.kind === 'failure' ? 'F' : String(i + 1);
                    const value =
                        x.kind === 'cardio'
                            ? [s.distance ? `${r1(s.distance)} km` : '', s.seconds ? clock(s.seconds) : ''].filter(Boolean).join(' · ')
                            : x.kind === 'duration' || x.kind === 'mobility'
                              ? clock(s.seconds ?? 0)
                              : `${s.weight ? `${kg(s.weight)} kg × ` : ''}${s.reps ?? ''}${s.rpe ? ` @${s.rpe}` : ''}`;
                    return `<div class="d-flex gap-2"><span class="gym-setno small">${label}</span><span>${value}</span></div>`;
                })
                .join('');
            return `<div class="d-flex gap-3 py-2 border-bottom">${thumb(e.name, 56)}<div class="flex-fill min-w-0">
                <div class="fw-bold" data-ex="${esc(e.name)}" role="button">${esc(e.name)}</div>${sets}${e.notes ? `<div class="small text-secondary">${esc(e.notes)}</div>` : ''}</div></div>`;
        })
        .join('');
    const tracker = w.tracker
        ? `<div class="d-flex flex-wrap gap-3 small mb-3 p-2 rounded gym-tracker"><span><i class="ti ti-device-watch"></i> ${esc(w.tracker.type)}</span>
            ${w.tracker.avgHr ? `<span><i class="ti ti-heart text-danger"></i> ${w.tracker.avgHr} bpm</span>` : ''}
            ${w.tracker.calories ? `<span><i class="ti ti-flame"></i> ${w.tracker.calories} kcal</span>` : ''}
            ${w.tracker.azm ? `<span><i class="ti ti-bolt"></i> ${w.tracker.azm} zone min</span>` : ''}</div>`
        : '';
    const s = sheet(
        esc(w.name),
        `<div class="text-secondary mb-2">${dayText(w.start)}, ${timeText(w.start)} · ${minutesText(workoutMinutes(w))}${st.sets ? ` · ${st.sets} sets` : ''}${st.volume ? ` · ${tonnage(st.volume)}` : ''}</div>
        ${tracker}
        ${w.notes ? `<p>${esc(w.notes)}</p>` : ''}
        ${exercises || (w.source === 'tracker' ? '<p class="text-secondary">Only the tracker saw this one. Add what you did to count its sets.</p>' : '')}`,
        {
            footer:
                w.source === 'tracker'
                    ? '<button class="btn btn-primary" data-a="details"><i class="ti ti-plus me-1"></i>Add details</button>'
                    : `<button class="btn" data-a="template"><i class="ti ti-template me-1"></i>Save as template</button><button class="btn btn-primary" data-a="edit"><i class="ti ti-pencil me-1"></i>Edit</button>`,
        },
    );
    s.el.addEventListener('click', async (ev) => {
        const t = ev.target as HTMLElement;
        const ex = t.closest<HTMLElement>('[data-ex]');
        if (ex) {
            s.close();
            exerciseSheet(ex.dataset.ex!);
            return;
        }
        const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
        if (a === 'edit') {
            s.close();
            void openLogger(w, { editing: true, onDone: () => void reload() });
        } else if (a === 'details') {
            const made = await api<GymWorkout>('POST', '/api/gym/workouts', { name: w.kind === 'strength' ? 'Workout' : w.name, kind: w.kind, start: w.start, end: w.end, exercises: [] });
            s.close();
            void openLogger(made, { editing: true, onDone: () => void reload() });
        } else if (a === 'template') {
            await api('POST', '/api/gym/templates', {
                name: w.name,
                kind: w.kind,
                exercises: w.exercises.map((e) => {
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
            toast('Saved as a template');
            s.close();
            void reload();
        }
    });
}

/* ----------------------------------------------------------------------- */
/* Progress                                                                 */

function progressTab() {
    const lifts = logged();
    const recent = lifts.filter((w) => w.start >= Date.now() - 28 * DAY_MS);
    const weeksCovered = Math.max(1, Math.min(4, recent.length ? (Date.now() - Math.min(...recent.map((w) => w.start))) / (7 * DAY_MS) : 1));
    const perGroup = setsPerGroup(recent, info);
    const perMuscle = setsPerMuscle(recent, info);
    const insights = gymInsights(lifts, info);
    const map = bodyMap((m) => {
        // full red at the top of the group's range: the map tells a little from a lot
        const high = GROUPS[groupOf(m)].sets[1];
        const v = perMuscle[m] / weeksCovered / high;
        return v > 0 ? v : null;
    }, state.data.profile.sex);

    const bars = GROUP_IDS.map((g) => {
        const [low, high] = GROUPS[g].sets;
        const v = perGroup[g] / weeksCovered;
        const max = Math.max(24, high + 4);
        const change = groupStrengthChange(lifts, info, g);
        const tone = low && v < low * 0.6 ? 'low' : low && v < low ? 'near' : v > high * 1.25 ? 'high' : 'ok';
        return `<button class="gym-gbar" data-group="${g}">
            <span class="gym-gbar-name">${GROUPS[g].label}</span>
            <span class="gym-gbar-track"><span class="gym-gbar-band" style="left:${(low / max) * 100}%;width:${((high - low) / max) * 100}%"></span>
                <span class="gym-gbar-fill ${tone}" style="width:${Math.min(100, (v / max) * 100)}%"></span></span>
            <span class="gym-gbar-val">${r1(v)}</span>
            <span class="gym-gbar-chg ${change ? (change.change >= 1 ? 'up' : change.change <= -1 ? 'down' : '') : ''}">${change ? `${change.change > 0 ? '+' : ''}${r1(change.change)}%` : ''}</span>
        </button>`;
    }).join('');

    const tone = { warn: 'danger', info: 'warning', good: 'success' } as const;
    const icon = { warn: 'alert-triangle', info: 'bulb', good: 'trending-up' } as const;
    return `
    <div class="gym-chips mb-3">${[4, 12, 26, 52].map((n) => `<button class="gym-chip${progressWeeks === n ? ' on' : ''}" data-weeks="${n}">${n} weeks</button>`).join('')}</div>
    <div class="card mb-3"><div class="card-body">
        <div class="hud-label mb-1">Everything you did</div>
        <div class="text-secondary small mb-2">Minutes a week by kind: the gym, your runs and rides, Pilates, all of it, the tracker's sessions included.</div>
        <div id="chart-activity"></div>
    </div></div>
    <div class="card mb-3"><div class="card-body">
        <div class="hud-label mb-1">Muscles, last 4 weeks</div>
        <div class="text-secondary small mb-2">Hard sets a week against the range that grows each group (green). The deeper the red, the more it got. Tap a group for its trend.</div>
        <div class="row g-3 align-items-center">
            <div class="col-md-5"><div class="gym-plate gym-bodymap">${map.front}${map.back}</div></div>
            <div class="col-md-7"><div class="gym-gbars">
                <div class="gym-gbar gym-gbar-head small text-secondary"><span>Group</span><span>hard sets a week</span><span></span><span title="estimated 1RM, last 4 weeks against the 4 before">1RM 4 wk</span></div>
                ${bars}</div></div>
        </div>
    </div></div>
    <div class="card mb-3"><div class="card-body">
        <div class="hud-label mb-2">What to change</div>
        ${
            insights.length
                ? insights
                      .map(
                          (i) => `<div class="d-flex gap-2 py-2 border-bottom"${i.exercise ? ` data-ex="${esc(i.exercise)}" role="button"` : i.group ? ` data-group="${i.group}" role="button"` : ''}>
                    <i class="ti ti-${icon[i.level]} text-${tone[i.level]} mt-1"></i><div><div class="fw-bold">${esc(i.title)}</div><div class="small text-secondary">${esc(i.text)}</div></div></div>`,
                      )
                      .join('')
                : '<p class="text-secondary mb-0">Log three or more workouts in four weeks, or import your Strong history, and the advice starts here.</p>'
        }
    </div></div>`;
}

function drawProgressCharts() {
    const el = document.getElementById('chart-activity');
    if (el) charts.push(activityChart(el, weeklyActivity(state.data.workouts, progressWeeks)));
}

function groupSheet(g: MuscleGroup) {
    const lifts = logged();
    const weeks = weeklyGroups(lifts, info, progressWeeks);
    const index = groupStrengthIndex(lifts.filter((w) => w.start >= Date.now() - progressWeeks * 7 * DAY_MS), info, g);
    const muscles = MUSCLE_IDS.filter((m) => groupOf(m) === g);
    const map = bodyMap((m) => (muscles.includes(m) ? 1 : null), state.data.profile.sex);
    const names = [...new Set(lifts.flatMap((w) => w.exercises.map((e) => e.name)))].filter((n) => info(n).primary.some((m) => groupOf(m) === g));
    const rows = names
        .map((n) => {
            const sessions = exerciseSessions(lifts, n);
            const r = records(sessions);
            return { n, sessions, r, last: sessions[sessions.length - 1]?.at ?? 0 };
        })
        .sort((a, b) => b.last - a.last)
        .map(
            ({ n, sessions, r, last }) => `<button class="list-group-item list-group-item-action d-flex gap-3 align-items-center" data-ex="${esc(n)}">${thumb(n, 44)}
            <div class="flex-fill min-w-0"><div class="fw-bold text-truncate">${esc(n)}</div>
            <div class="small text-secondary">${sessions.length}× · last ${shortDay(last)}${r.e1rm ? ` · 1RM ≈ ${kg(r.e1rm.value)} kg` : ''}</div></div></button>`,
        )
        .join('');
    const s = sheet(
        GROUPS[g].label,
        `<div class="row g-3">
            <div class="col-4"><div class="gym-plate gym-bodymap">${map.front}${map.back}</div></div>
            <div class="col-8"><div class="hud-label">Hard sets a week</div><div data-c="sets"></div></div>
        </div>
        <div class="hud-label mt-3">Strength (100 = where each exercise started)</div>
        ${index.length >= 2 ? '<div data-c="strength"></div>' : '<p class="text-secondary small">Needs two or more sessions of an exercise.</p>'}
        <div class="hud-label mt-3 mb-1">Its exercises</div>
        <div class="list-group list-group-flush">${rows || '<p class="text-secondary small">None logged yet.</p>'}</div>`,
        { size: 'lg', onClose: () => local.forEach((c) => c.destroy()) },
    );
    const local: ApexCharts[] = [];
    // after the sheet has its size
    s.el.addEventListener(
        'shown.bs.modal',
        () => {
            local.push(groupSetsChart(s.el.querySelector<HTMLElement>('[data-c="sets"]')!, weeks, g));
            const st = s.el.querySelector<HTMLElement>('[data-c="strength"]');
            if (st) local.push(strengthChart(st, index));
        },
        { once: true },
    );
    s.el.addEventListener('click', (ev) => {
        const ex = (ev.target as HTMLElement).closest<HTMLElement>('[data-ex]');
        if (ex) {
            s.close();
            exerciseSheet(ex.dataset.ex!);
        }
    });
}

/* ----------------------------------------------------------------------- */
/* Exercises                                                                */

function exercisesTab() {
    const counts = useCounts();
    const q = exerciseQuery.trim().toLowerCase();
    const rows = allExercises()
        .filter((e) => matchesFilter(e, exerciseFilter))
        .filter((e) => !q || e.name.toLowerCase().includes(q) || muscleText(e).toLowerCase().includes(q))
        .sort((a, b) => (counts.get(exerciseKey(b.name)) ?? 0) - (counts.get(exerciseKey(a.name)) ?? 0) || a.name.localeCompare(b.name));
    return `<div class="d-flex gap-2 mb-2">
            <input type="search" class="form-control" placeholder="Search ${rows.length} exercises" value="${esc(exerciseQuery)}" data-exq autocomplete="off" />
            <button class="btn" data-act="ex-new" title="New exercise"><i class="ti ti-plus"></i></button>
        </div>
        <div class="gym-chips mb-3">${FILTERS.map(([f, l]) => `<button class="gym-chip${f === exerciseFilter ? ' on' : ''}" data-exf="${f}">${l}</button>`).join('')}</div>
        <div class="card"><div class="list-group list-group-flush" data-exlist>${rows
            .slice(0, 200)
            .map(
                (e) => `<button class="list-group-item list-group-item-action d-flex align-items-center gap-3" data-ex="${esc(e.name)}">
                ${thumb(e.name, 56)}
                <div class="flex-fill min-w-0"><div class="fw-bold text-truncate">${esc(e.name)}${e.custom ? ' <span class="badge bg-secondary-lt">own</span>' : ''}</div>
                <div class="small text-secondary text-truncate">${esc(muscleText(e))}${counts.get(exerciseKey(e.name)) ? ` · ${counts.get(exerciseKey(e.name))}×` : ''}</div></div></button>`,
            )
            .join('')}</div></div>`;
}

function exerciseSheet(name: string) {
    const x = info(name);
    const sessions = exerciseSessions(logged(), name);
    const r = records(sessions);
    const chip = (m: Muscle, primary: boolean) => `<span class="badge ${primary ? 'gym-badge-red' : 'gym-badge-pink'} me-1 mb-1">${MUSCLES[m].label}</span>`;
    const recordTile = (label: string, value: string, sub: string) => `<div class="col-6 col-sm-3"><div class="gym-record"><div class="small text-secondary">${label}</div><div class="fw-bold">${value}</div><div class="small text-secondary">${sub}</div></div></div>`;
    const recent = sessions
        .slice(-8)
        .reverse()
        .map(
            (s) => `<div class="d-flex justify-content-between py-1 border-bottom small"><span>${dayText(s.at)}</span>
            <span>${s.sets.map((set) => (x.kind === 'cardio' ? `${r1(set.distance ?? 0)} km ${clock(set.seconds ?? 0)}` : x.kind === 'duration' || x.kind === 'mobility' ? clock(set.seconds ?? 0) : `${set.weight ? kg(set.weight) + '×' : ''}${set.reps ?? ''}`)).join(', ')}</span></div>`,
        )
        .join('');
    const s = sheet(
        esc(name),
        `<div class="gym-plate gym-hero mb-3">${figureOf(name)}</div>
        <div class="mb-2">${x.primary.map((m) => chip(m, true)).join('')}${x.secondary.map((m) => chip(m, false)).join('')}${!x.primary.length ? '<span class="text-secondary small">No muscles set.</span>' : ''}</div>
        ${
            r.e1rm || r.weight
                ? `<div class="row g-2 mb-3">
                ${r.e1rm ? recordTile('Estimated 1RM', `${kg(r.e1rm.value)} kg`, `${kg(r.e1rm.weight)} × ${r.e1rm.reps}`) : ''}
                ${r.weight ? recordTile('Heaviest', `${kg(r.weight.value)} kg`, `× ${r.weight.reps}, ${shortDay(r.weight.at)}`) : ''}
                ${r.reps ? recordTile('Most reps', `${r.reps.value}`, r.reps.weight ? `at ${kg(r.reps.weight)} kg` : '') : ''}
                ${r.volume ? recordTile('Best session', tonnage(r.volume.value), shortDay(r.volume.at)) : ''}
            </div>`
                : ''
        }
        ${sessions.length >= 2 ? '<div data-c="ex" class="mb-3"></div>' : sessions.length ? '' : '<p class="text-secondary">Not done yet.</p>'}
        ${recent ? `<div class="hud-label mb-1">Recent</div>${recent}` : ''}`,
        {
            size: 'lg',
            footer: `<button class="btn" data-a="muscles"><i class="ti ti-adjustments me-1"></i>Muscles</button>`,
            onClose: () => local.forEach((c) => c.destroy()),
        },
    );
    const local: ApexCharts[] = [];
    s.el.addEventListener(
        'shown.bs.modal',
        () => {
            const el = s.el.querySelector<HTMLElement>('[data-c="ex"]');
            if (el) local.push(exerciseChart(el, sessions));
        },
        { once: true },
    );
    s.el.querySelector('[data-a="muscles"]')!.addEventListener('click', () => {
        s.close();
        exerciseEditor(x);
    });
}

const EQUIPMENT: Equipment[] = ['barbell', 'dumbbell', 'cable', 'machine', 'smith', 'bodyweight', 'kettlebell', 'band', 'plate', 'mat', 'reformer', 'other'];
const EXERCISE_KINDS: [ExerciseKind, string][] = [
    ['weight', 'Weight × reps'],
    ['bodyweight', 'Bodyweight (+ kg)'],
    ['assisted', 'Assisted (− kg)'],
    ['duration', 'Held for time'],
    ['mobility', 'Stretch / mobility'],
    ['cardio', 'Cardio: time and distance'],
];

function exerciseEditor(x: ExerciseInfo | null) {
    const e: ExerciseInfo = x ? structuredClone(x) : { name: '', primary: [], secondary: [], equipment: 'other', kind: 'weight', custom: true };
    const muscleGrid = () =>
        GROUP_IDS.map(
            (g) => `<div class="mb-2"><div class="small text-secondary">${GROUPS[g].label}</div>${MUSCLE_IDS.filter((m) => groupOf(m) === g)
                .map((m) => {
                    const st = e.primary.includes(m) ? 'p' : e.secondary.includes(m) ? 's' : '';
                    return `<button class="gym-chip ${st === 'p' ? 'red' : st === 's' ? 'pink' : ''}" data-m="${m}">${MUSCLES[m].label}</button>`;
                })
                .join('')}</div>`,
        ).join('');
    const s = sheet(
        x ? `Muscles: ${esc(x.name)}` : 'New exercise',
        `${x ? '' : '<input class="form-control mb-2" data-name placeholder="Name, e.g. Incline Press (Machine)" maxlength="80" />'}
        <div class="row g-2 mb-3">
            <div class="col-6"><select class="form-select" data-kind>${EXERCISE_KINDS.map(([k, l]) => `<option value="${k}"${k === e.kind ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
            <div class="col-6"><select class="form-select" data-equip>${EQUIPMENT.map((q) => `<option value="${q}"${q === e.equipment ? ' selected' : ''}>${q}</option>`).join('')}</select></div>
        </div>
        <div class="d-flex gap-3 align-items-start">
            <div class="gym-plate gym-thumb flex-shrink-0" style="width:110px;height:110px" data-fig></div>
            <div class="small text-secondary">Tap a muscle once for <b class="text-danger">trained</b>, again for <b style="color:#c9675e">helps</b>, a third time to clear.</div>
        </div>
        <div class="mt-2" data-grid>${muscleGrid()}</div>`,
        { size: 'lg', footer: `${x?.custom && sessionsOf(x.name) === 0 ? '<button class="btn btn-ghost-danger me-auto" data-del>Delete</button>' : ''}<button class="btn btn-primary" data-save>Save</button>` },
    );
    const fig = () => {
        const el = s.el.querySelector<HTMLElement>('[data-fig]')!;
        el.innerHTML = e.primary.length ? figureFor(e) : '';
    };
    fig();
    s.el.querySelector('[data-grid]')!.addEventListener('click', (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-m]');
        if (!b) return;
        const m = b.dataset.m as Muscle;
        if (e.primary.includes(m)) {
            e.primary = e.primary.filter((v) => v !== m);
            e.secondary.push(m);
        } else if (e.secondary.includes(m)) e.secondary = e.secondary.filter((v) => v !== m);
        else e.primary.push(m);
        s.el.querySelector('[data-grid]')!.innerHTML = muscleGrid();
        fig();
    });
    s.el.querySelector('[data-save]')!.addEventListener('click', async () => {
        const nameEl = s.el.querySelector<HTMLInputElement>('[data-name]');
        if (nameEl) e.name = nameEl.value.trim();
        e.kind = s.el.querySelector<HTMLSelectElement>('[data-kind]')!.value as ExerciseKind;
        e.equipment = s.el.querySelector<HTMLSelectElement>('[data-equip]')!.value as Equipment;
        if (!e.name) {
            toast('Give it a name', 'error');
            return;
        }
        try {
            await api('PUT', '/api/gym/exercises', { name: e.name, primary: e.primary, secondary: e.secondary, equipment: e.equipment, kind: e.kind, ...(e.kind === 'cardio' ? { activity: e.activity ?? 'cardio' } : {}) });
            s.close();
            clearFigures();
            await reload();
            toast('Saved');
        } catch (err) {
            toast((err as Error).message, 'error');
        }
    });
    s.el.querySelector('[data-del]')?.addEventListener('click', async () => {
        await api('DELETE', `/api/gym/exercises/${encodeURIComponent(e.name)}`);
        s.close();
        await reload();
    });
}

const sessionsOf = (name: string) => exerciseSessions(logged(), name).length;
// the drawing of an exercise being edited (not yet what info() knows)
function figureFor(e: ExerciseInfo) {
    const key = exerciseKey(e.name || '__new');
    const before = state.own.get(key);
    state.own.set(key, e);
    clearFigures();
    const svg = figureOf(e.name || '__new');
    if (before) state.own.set(key, before);
    else state.own.delete(key);
    clearFigures();
    return svg;
}

/* ----------------------------------------------------------------------- */
/* Templates                                                                */

function templateEditor(t: GymTemplate | null) {
    const tpl: Omit<GymTemplate, '_id' | 'order'> & { _id?: string } = t ? structuredClone(t) : { name: '', kind: 'strength', exercises: [] };
    const row = (e: TemplateExercise, i: number) => {
        const x = info(e.name);
        const timed = x.kind === 'cardio' || x.kind === 'duration' || x.kind === 'mobility';
        return `<div class="card mb-2" data-i="${i}"><div class="card-body p-2">
            <div class="d-flex align-items-center gap-2 mb-2">${thumb(e.name, 40)}<div class="fw-bold flex-fill text-truncate">${esc(e.name)}</div>
                <button class="btn btn-icon btn-sm btn-ghost-secondary" data-t="up" aria-label="Up"><i class="ti ti-arrow-up"></i></button>
                <button class="btn btn-icon btn-sm btn-ghost-secondary" data-t="down" aria-label="Down"><i class="ti ti-arrow-down"></i></button>
                <button class="btn btn-icon btn-sm btn-ghost-danger" data-t="del" aria-label="Remove"><i class="ti ti-x"></i></button></div>
            <div class="row g-2 small">
                <div class="col-3"><label class="text-secondary">Sets</label><input class="form-control form-control-sm" inputmode="numeric" data-k="sets" value="${e.sets}" /></div>
                ${
                    timed
                        ? `<div class="col-3"><label class="text-secondary">Time</label><input class="form-control form-control-sm" data-k="seconds" value="${e.seconds ? clock(e.seconds) : ''}" placeholder="m:ss" /></div>
                           ${x.kind === 'cardio' ? `<div class="col-3"><label class="text-secondary">km</label><input class="form-control form-control-sm" inputmode="decimal" data-k="distance" value="${e.distance ?? ''}" /></div>` : '<div class="col-3"></div>'}`
                        : `<div class="col-3"><label class="text-secondary">Reps from</label><input class="form-control form-control-sm" inputmode="numeric" data-k="repsLow" value="${e.repsLow}" /></div>
                           <div class="col-3"><label class="text-secondary">to</label><input class="form-control form-control-sm" inputmode="numeric" data-k="repsHigh" value="${e.repsHigh}" /></div>`
                }
                <div class="col-3"><label class="text-secondary">Rest</label><input class="form-control form-control-sm" data-k="restSeconds" value="${clock(e.restSeconds)}" /></div>
            </div></div></div>`;
    };
    const s = sheet(
        t ? 'Edit template' : 'New template',
        `<input class="form-control form-control-lg fw-bold mb-2" data-tname placeholder="Name, e.g. Push day" maxlength="80" value="${esc(tpl.name)}" />
        <select class="form-select mb-3" data-tkind>${WORKOUT_KIND_IDS.map((k) => `<option value="${k}"${k === tpl.kind ? ' selected' : ''}>${WORKOUT_KINDS[k].label}</option>`).join('')}</select>
        <div data-rows></div>
        <button class="btn btn-outline-primary w-100" data-t="add"><i class="ti ti-plus me-1"></i>Add exercise</button>`,
        { size: 'lg', footer: `<button class="btn btn-primary" data-t="save">Save</button>` },
    );
    const rows = s.el.querySelector<HTMLElement>('[data-rows]')!;
    const draw = () => (rows.innerHTML = tpl.exercises.map(row).join('') || '<p class="text-secondary">No exercises yet.</p>');
    draw();
    s.el.addEventListener('input', (ev) => {
        const input = ev.target as HTMLInputElement;
        const card = input.closest<HTMLElement>('[data-i]');
        if (!card || !input.dataset.k) return;
        const e = tpl.exercises[Number(card.dataset.i)];
        const k = input.dataset.k as keyof TemplateExercise;
        const v = k === 'seconds' || k === 'restSeconds' ? parseClock(input.value) : Number(input.value.replace(',', '.'));
        if (v !== null && Number.isFinite(v) && v >= 0) (e[k] as number) = v;
    });
    s.el.addEventListener('click', async (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-t]');
        if (!b) return;
        const i = Number(b.closest<HTMLElement>('[data-i]')?.dataset.i);
        switch (b.dataset.t) {
            case 'add':
                pickExercise((name) => {
                    const x = info(name);
                    const timed = x.kind === 'cardio' || x.kind === 'duration' || x.kind === 'mobility';
                    tpl.exercises.push({ name, sets: x.kind === 'cardio' ? 1 : 3, repsLow: timed ? 0 : 8, repsHigh: timed ? 0 : 12, restSeconds: x.kind === 'cardio' ? 0 : 90, ...(timed ? { seconds: x.kind === 'cardio' ? 1800 : 45 } : {}) });
                    draw();
                });
                return;
            case 'up':
            case 'down': {
                const to = b.dataset.t === 'up' ? i - 1 : i + 1;
                if (to < 0 || to >= tpl.exercises.length) return;
                [tpl.exercises[i], tpl.exercises[to]] = [tpl.exercises[to], tpl.exercises[i]];
                draw();
                return;
            }
            case 'del':
                tpl.exercises.splice(i, 1);
                draw();
                return;
            case 'save': {
                tpl.name = s.el.querySelector<HTMLInputElement>('[data-tname]')!.value.trim();
                tpl.kind = s.el.querySelector<HTMLSelectElement>('[data-tkind]')!.value as WorkoutKind;
                if (!tpl.name) {
                    toast('Give it a name', 'error');
                    return;
                }
                try {
                    const payload = { name: tpl.name, kind: tpl.kind, exercises: tpl.exercises };
                    if (tpl._id) await api('PUT', `/api/gym/templates/${tpl._id}`, payload);
                    else await api('POST', '/api/gym/templates', payload);
                    s.close();
                    await reload();
                    toast('Template saved');
                } catch (err) {
                    toast((err as Error).message, 'error');
                }
            }
        }
    });
}

/* ----------------------------------------------------------------------- */
/* Settings and the Strong import                                           */

function importSheet() {
    const s = sheet(
        'Import from Strong',
        `<ol class="mb-3">
            <li>In Strong: <b>Profile</b> → <b>Settings</b> (the gear) → <b>Export Strong Data</b>.</li>
            <li>Save the CSV file to your phone (Files, or mail it to yourself).</li>
            <li>Pick it here.</li>
        </ol>
        <input type="file" class="form-control mb-2" accept=".csv,text/csv,text/plain" data-file />
        <div class="d-flex align-items-center gap-2 mb-2"><span class="small text-secondary">Weights in the file are in</span>
            <select class="form-select form-select-sm w-auto" data-unit><option value="kg">kg</option><option value="lbs">lbs</option></select></div>
        <div class="form-check mb-0"><input class="form-check-input" type="checkbox" id="gym-learn" checked data-learn />
            <label class="form-check-label" for="gym-learn">Make my templates from the workouts I repeat (they replace the starter weights split)</label></div>
        <div class="small text-secondary mt-2">Importing again replaces the earlier import of the same workouts, never doubles them. Workouts logged here stay.</div>
        <div data-result class="mt-3"></div>`,
        { footer: '<button class="btn btn-primary" data-go>Import</button>' },
    );
    s.el.querySelector('[data-go]')!.addEventListener('click', async (ev) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        const file = s.el.querySelector<HTMLInputElement>('[data-file]')!.files?.[0];
        if (!file) {
            toast('Pick the CSV file first', 'error');
            return;
        }
        const form = new FormData();
        form.append('unit', s.el.querySelector<HTMLSelectElement>('[data-unit]')!.value);
        form.append('file', file);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Importing';
        try {
            const r = await api<{ workouts: number; replaced: number; from: number; to: number; exercises: number; guessed: { name: string; primary: string[] }[] }>('POST', '/api/gym/import/strong', form);
            let learned = 0;
            if (s.el.querySelector<HTMLInputElement>('[data-learn]')!.checked) learned = (await api<{ added: number }>('POST', '/api/gym/templates/learn')).added;
            await reload();
            const unknown = r.guessed.filter((g) => !g.primary.length);
            s.el.querySelector('[data-result]')!.innerHTML = `<div class="alert alert-success mb-0">
                <b>${r.workouts} workouts</b> from ${shortDay(r.from)} ${new Date(r.from).getFullYear()} to ${shortDay(r.to)} ${new Date(r.to).getFullYear()}, ${r.exercises} exercises${r.replaced ? ` (${r.replaced} replaced)` : ''}.
                ${learned ? `<br>${learned} templates made from your routine.` : ''}
                ${r.guessed.length ? `<br>${r.guessed.length} exercises were new to kibbl.: their muscles were guessed from the name${unknown.length ? `, ${unknown.length} need you to set them (Exercises → the exercise → Muscles): ${unknown.map((u) => esc(u.name)).join(', ')}` : ''}.` : ''}
            </div>`;
            btn.remove();
        } catch (err) {
            s.el.querySelector('[data-result]')!.innerHTML = errorAlert(esc((err as Error).message));
            btn.disabled = false;
            btn.textContent = 'Import';
        }
    });
}

function settingsSheet() {
    const p = state.data.profile;
    const s = sheet(
        'Gym settings',
        `<div class="mb-3"><label class="form-label">Figure</label>
            <div class="btn-group w-100" role="group">
                <input type="radio" class="btn-check" name="gym-sex" id="gym-sex-m" value="male"${p.sex === 'male' ? ' checked' : ''}><label class="btn" for="gym-sex-m">Male</label>
                <input type="radio" class="btn-check" name="gym-sex" id="gym-sex-f" value="female"${p.sex === 'female' ? ' checked' : ''}><label class="btn" for="gym-sex-f">Female</label>
            </div></div>
        <div class="mb-3"><label class="form-label">Bodyweight (kg)</label><input class="form-control" inputmode="decimal" data-bw value="${p.bodyweight ?? ''}" placeholder="for bodyweight exercises" /></div>
        <hr>
        <button class="btn w-100 mb-2" data-a="import"><i class="ti ti-file-import me-1"></i>Import from Strong</button>
        <button class="btn w-100 mb-2" data-a="learn"><i class="ti ti-wand me-1"></i>Make templates from my history</button>
        <div class="small text-secondary mt-2">Runs, rides and other sessions of your fitness tracker come in through Health (Google Health) and show here by themselves.</div>`,
        { footer: '<button class="btn btn-primary" data-a="save">Save</button>' },
    );
    s.el.addEventListener('click', async (ev) => {
        const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
        if (a === 'import') {
            s.close();
            importSheet();
        } else if (a === 'learn') {
            const r = await api<{ added: number }>('POST', '/api/gym/templates/learn');
            toast(r.added ? `${r.added} templates made` : 'No workout was repeated yet');
            s.close();
            await reload();
        } else if (a === 'save') {
            const sex = s.el.querySelector<HTMLInputElement>('input[name="gym-sex"]:checked')!.value;
            const bwRaw = s.el.querySelector<HTMLInputElement>('[data-bw]')!.value.trim().replace(',', '.');
            try {
                await api('PUT', '/api/gym/profile', { sex, bodyweight: bwRaw ? Number(bwRaw) : null });
                clearFigures();
                s.close();
                await reload();
            } catch (err) {
                toast((err as Error).message, 'error');
            }
        }
    });
}

/* ----------------------------------------------------------------------- */
/* The page                                                                 */

function render() {
    if (isOpen()) return;
    dropCharts();
    const body = tab === 'train' ? trainTab() : tab === 'history' ? historyTab() : tab === 'progress' ? progressTab() : exercisesTab();
    container().innerHTML = `<div class="gym-page">${offline ? '<div class="alert alert-warning py-2 small"><i class="ti ti-wifi-off me-1"></i>Offline: the data of your last visit. A workout you log is kept here and sent when you are back online.</div>' : ''}${body}</div>`;
    for (const b of document.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
    if (tab === 'progress') drawProgressCharts();
}

function setTab(t: Tab, push = true) {
    tab = t;
    if (push) history.pushState({ tab: t }, '', t === 'train' ? '/gym' : `/gym/${t}`);
    render();
    window.scrollTo({ top: 0 });
}

async function start(templateId: string | null, kind?: WorkoutKind) {
    try {
        const w = await api<GymWorkout>('POST', '/api/gym/workouts/start', templateId ? { templateId } : { kind: kind ?? 'strength', name: 'Workout' });
        active = w;
        void openLogger(w, { onDone: () => void reload() });
    } catch (err) {
        toast((err as Error).message, 'error');
    }
}

function pastWorkout() {
    const s = sheet(
        'Log a past workout',
        `<label class="form-label">What</label>
        <select class="form-select mb-2" data-from>
            <option value="">An empty workout</option>
            ${state.data.templates.map((t) => `<option value="${t._id}">${esc(t.name)}</option>`).join('')}
        </select>
        <label class="form-label">When</label>
        <input type="datetime-local" class="form-control" data-when value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60_000 - 2 * 3600_000).toISOString().slice(0, 16)}" />`,
        { footer: '<button class="btn btn-primary" data-go>Continue</button>' },
    );
    s.el.querySelector('[data-go]')!.addEventListener('click', async () => {
        const tid = s.el.querySelector<HTMLSelectElement>('[data-from]')!.value;
        const at = new Date(s.el.querySelector<HTMLInputElement>('[data-when]')!.value).getTime();
        const t = state.data.templates.find((x) => x._id === tid);
        const exercises = (t?.exercises ?? []).map((e) => ({
            name: e.name,
            restSeconds: e.restSeconds,
            sets: Array.from({ length: e.sets }, () => ({ kind: 'normal', done: true, ...(e.seconds ? { seconds: e.seconds } : {}), ...(e.distance ? { distance: e.distance } : {}) })),
        }));
        try {
            const w = await api<GymWorkout>('POST', '/api/gym/workouts', { name: t?.name ?? 'Workout', kind: t?.kind ?? 'strength', start: at, end: at + 60 * 60_000, exercises });
            s.close();
            void openLogger(w, { editing: true, onDone: () => void reload() });
        } catch (err) {
            toast((err as Error).message, 'error');
        }
    });
}

function onClick(ev: Event) {
    const t = ev.target as HTMLElement;
    const tabBtn = t.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
        ev.preventDefault();
        setTab(tabBtn.dataset.tab as Tab);
        return;
    }
    const act = t.closest<HTMLElement>('[data-act]');
    if (act && act.closest('.gym-logger')) return;
    const tplEl = t.closest<HTMLElement>('[data-tpl]');
    const tpl = tplEl ? state.data.templates.find((x) => x._id === tplEl.dataset.tpl) ?? null : null;
    if (act) {
        if (act.tagName === 'A') ev.preventDefault();
        switch (act.dataset.act) {
            case 'resume':
                if (active) void openLogger(active, { onDone: () => void reload() });
                return;
            case 'empty':
                if (active) void openLogger(active, { onDone: () => void reload() });
                else void start(null);
                return;
            case 'past':
                pastWorkout();
                return;
            case 'import':
                importSheet();
                return;
            case 'settings':
                settingsSheet();
                return;
            case 'tpl-new':
                templateEditor(null);
                return;
            case 'tpl-start':
                if (active) {
                    toast('A workout runs already: finish it first', 'error');
                    void openLogger(active, { onDone: () => void reload() });
                } else if (tpl) void start(tpl._id);
                return;
            case 'tpl-edit':
                templateEditor(tpl);
                return;
            case 'tpl-copy':
                if (tpl) templateEditor({ ...structuredClone(tpl), _id: '', name: `${tpl.name} (copy)` } as GymTemplate);
                return;
            case 'tpl-delete':
                if (tpl)
                    void ask('Delete this template?', `“${esc(tpl.name)}” goes; the workouts done with it stay.`, 'Delete', true).then(async (yes) => {
                        if (!yes) return;
                        await api('DELETE', `/api/gym/templates/${tpl._id}`);
                        await reload();
                    });
                return;
            case 'ex-new':
                exerciseEditor(null);
                return;
        }
    }
    const kind = t.closest<HTMLElement>('[data-kind]');
    if (kind) {
        kindFilter = kind.dataset.kind as WorkoutKind | 'all';
        render();
        return;
    }
    const weeks = t.closest<HTMLElement>('[data-weeks]');
    if (weeks) {
        progressWeeks = Number(weeks.dataset.weeks);
        render();
        return;
    }
    const group = t.closest<HTMLElement>('[data-group]');
    if (group) {
        groupSheet(group.dataset.group as MuscleGroup);
        return;
    }
    const workout = t.closest<HTMLElement>('[data-workout]');
    if (workout) {
        const w = state.data.workouts.find((x) => x._id === workout.dataset.workout);
        if (w) workoutSheet(w);
        return;
    }
    const ex = t.closest<HTMLElement>('[data-ex]');
    if (ex && !ex.closest('.modal')) {
        exerciseSheet(ex.dataset.ex!);
        return;
    }
    const exf = t.closest<HTMLElement>('[data-exf]');
    if (exf) {
        exerciseFilter = exf.dataset.exf as typeof exerciseFilter;
        render();
    }
}

function bottomNav() {
    const nav = document.createElement('nav');
    nav.className = 'gym-tabs';
    nav.innerHTML = TABS.map(([t, label, icon]) => `<a href="${t === 'train' ? '/gym' : `/gym/${t}`}" data-tab="${t}"><i class="ti ti-${icon}"></i><span>${label}</span></a>`).join('');
    document.body.appendChild(nav);
}

function injectStyle() {
    const style = document.createElement('style');
    style.textContent = BODY_CSS;
    document.head.appendChild(style);
}

async function main() {
    injectStyle();
    bottomNav();
    document.getElementById('page-actions')!.innerHTML = `<button class="btn btn-icon" data-act="settings" aria-label="Gym settings"><i class="ti ti-settings"></i></button>`;
    document.addEventListener('click', onClick);
    document.addEventListener('input', (ev) => {
        const el = ev.target as HTMLInputElement;
        if (el.matches('[data-exq]')) {
            exerciseQuery = el.value;
            const pos = el.selectionStart;
            render();
            const again = document.querySelector<HTMLInputElement>('[data-exq]');
            again?.focus();
            again?.setSelectionRange(pos, pos);
        }
    });
    // an exercise's sheet asked for from inside the logger
    document.addEventListener('gym:exercise', (ev) => exerciseSheet((ev as CustomEvent<string>).detail));
    window.addEventListener('popstate', () => {
        const p = (window.location.pathname.split('/')[2] as Tab) || 'train';
        setTab(TABS.some(([t]) => t === p) ? p : 'train', false);
    });
    try {
        await load();
    } catch (err) {
        container().innerHTML = errorAlert(`The gym could not be loaded: ${esc((err as Error).message)}`);
        return;
    }
    render();
    if (active && new URLSearchParams(window.location.search).has('resume')) void openLogger(active, { onDone: () => void reload() });
    // the page kept on the home screen: refresh when it comes back
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !isOpen() && !document.querySelector('.modal.show')) void reload().catch(() => {});
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

void main();
