import './main';
import {
    PETKIT_MEALS_MAX,
    PETKIT_PLAN_PORTIONS,
    WEEKDAY_NAMES,
    dayProblem,
    mealTime,
    parseMealTime,
    type PetkitFeeder,
    type PetkitPlan,
    type PetkitPlanMeal,
} from '../../../shared/petkit';
import { bindPetkit, loadPetkit, petkitFeederHtml } from './petkitCard';
import { socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml, successAlert } from './utils';

/* The feeder's own page: the picture of the camera over it, today (the card of the home
 * page) and the weekly plan, edited here and saved to PetKit as a whole. */

const wanted = Number(new URLSearchParams(window.location.search).get('id')) || undefined;
let feeder: PetkitFeeder | undefined;
let plan: PetkitPlan | undefined;
let draft: PetkitPlanMeal[][] = [];
let dirty = false;
let rendered = false;

const today = () => (new Date().getDay() + 6) % 7; // Monday 0

function layout() {
    byId('container').innerHTML = `
        <div class="row row-cards">
            <div class="col-lg-7" id="feeder-picture"></div>
            <div class="col-lg-5" id="feeder-today"></div>
            <div class="col-12">
                <div class="card">
                    <div class="card-header">
                        <h3 class="card-title"><i class="ti ti-calendar-time me-1"></i> Weekly plan</h3>
                        <div class="card-actions btn-list">
                            <button class="btn btn-sm" id="plan-reload"><i class="ti ti-refresh me-1"></i> Undo changes</button>
                            <button class="btn btn-sm btn-primary" id="plan-save"><i class="ti ti-device-floppy me-1"></i> Save</button>
                        </div>
                    </div>
                    <div class="card-body" id="plan"></div>
                </div>
            </div>
        </div>`;
    bindPetkit(byId('feeder-today'), renderToday);
    bindPlan();
    rendered = true;
}

/* ----------------------------------------------------------------------- */

// the camera over the feeder: its stream while the page is visible
function renderPicture() {
    const slot = byId('feeder-picture');
    const cam = feeder?.cameraId;
    if (!cam) {
        slot.innerHTML = `<div class="card"><div class="card-body">${emptyState('device-cctv', 'No camera over the feeder', 'Choose the camera that watches it on the Devices page, under Pet feeder · PetKit.')}</div></div>`;
        return;
    }
    if (!slot.querySelector('img')) {
        slot.innerHTML = `<div class="card">
            <div class="stream-frame"><img id="feeder-stream" alt="the feeder" /></div>
            <div class="card-body py-2"><a class="btn btn-sm" href="/camera/${cam}"><i class="ti ti-device-cctv me-1"></i> Camera <i class="ti ti-chevron-right ms-1"></i></a></div>
        </div>`;
    }
    updateStream();
}

function updateStream() {
    const img = document.querySelector<HTMLImageElement>('#feeder-stream');
    if (!img || !feeder?.cameraId) return;
    const src = `/api/devices/${feeder.cameraId}/stream`;
    if (document.visibilityState === 'visible') {
        if (!img.src.endsWith(src)) img.src = src;
    } else if (img.src) {
        img.removeAttribute('src'); // a hidden tab would keep the camera streaming for nobody
    }
}

function renderToday() {
    byId('feeder-today').innerHTML = feeder ? petkitFeederHtml(feeder, { heading: 'Today', link: false }) : '';
}

/* ----------------------------------------------------------------------- */

function mealRow(day: number, i: number, m: PetkitPlanMeal) {
    const options = Array.from({ length: PETKIT_PLAN_PORTIONS.max - PETKIT_PLAN_PORTIONS.min + 1 }, (_, k) => k + PETKIT_PLAN_PORTIONS.min)
        .map((n) => `<option value="${n}" ${n === m.portions ? 'selected' : ''}>${n}</option>`)
        .join('');
    const at = `data-day="${day}" data-meal="${i}"`;
    return `<div class="d-flex gap-1 align-items-center mb-1">
        <input type="time" class="form-control form-control-sm" style="width:6.5rem" value="${mealTime(m.time)}" data-field="time" ${at} />
        <select class="form-select form-select-sm" style="width:4.2rem" title="portions" data-field="portions" ${at}>${options}</select>
        <input class="form-control form-control-sm" placeholder="name" maxlength="20" value="${escapeHtml(m.name)}" data-field="name" ${at} />
        <button class="btn btn-sm btn-ghost-danger btn-icon" title="remove" data-remove ${at}><i class="ti ti-x"></i></button>
    </div>`;
}

function renderPlan() {
    const slot = byId('plan');
    if (!plan) {
        slot.innerHTML = '<div class="text-secondary">Reading the plan from PetKit…</div>';
        return;
    }
    const days = draft
        .map((meals, d) => {
            const problem = dayProblem(meals);
            const total = meals.reduce((sum, m) => sum + m.portions, 0);
            return `<div class="col-md-6 col-xl-3">
                <div class="border rounded p-2 h-100 ${d === today() ? 'border-primary' : ''}">
                    <div class="d-flex align-items-center mb-2">
                        <span class="fw-bold flex-fill">${WEEKDAY_NAMES[d]}${d === today() ? ' <span class="badge bg-primary-lt ms-1">today</span>' : ''}</span>
                        <span class="text-secondary small">${total} portion${total === 1 ? '' : 's'} · ~${total * 10} g</span>
                    </div>
                    ${meals.map((m, i) => mealRow(d, i, m)).join('') || '<div class="text-secondary small mb-1">No meals.</div>'}
                    ${problem ? `<div class="text-danger small mb-1">${escapeHtml(problem)}</div>` : ''}
                    <div class="d-flex gap-1 mt-2">
                        <button class="btn btn-sm flex-fill" data-add="${d}" ${meals.length >= PETKIT_MEALS_MAX ? 'disabled' : ''}><i class="ti ti-plus me-1"></i> Meal</button>
                        <button class="btn btn-sm" data-copy="${d}" title="the same meals on every day"><i class="ti ti-copy me-1"></i> To all days</button>
                    </div>
                </div>
            </div>`;
        })
        .join('');
    slot.innerHTML = `
        ${plan.paused ? `<div class="alert alert-warning">The plan is paused: no meal is given until it runs again (the switch under Today).</div>` : ''}
        <div class="row g-2">${days}</div>
        <div class="form-hint mt-3">A portion is about 10 g. Meals at least 5 minutes apart, at most ${PETKIT_MEALS_MAX} a day. Saving sends the whole week to the feeder; PetKit's app shows the same plan.</div>
        <div id="plan-result" class="mt-2"></div>`;
    byId<HTMLButtonElement>('plan-save').disabled = !dirty || draft.some((d) => !!dayProblem(d));
    byId<HTMLButtonElement>('plan-reload').disabled = !dirty;
}

function change() {
    dirty = true;
    renderPlan();
}

function bindPlan() {
    const root = byId('plan');
    root.addEventListener('change', (e) => {
        const el = e.target as HTMLInputElement;
        const m = draft[Number(el.dataset.day)]?.[Number(el.dataset.meal)];
        if (!m || !el.dataset.field) return;
        if (el.dataset.field === 'time') m.time = parseMealTime(el.value) ?? m.time;
        else if (el.dataset.field === 'portions') m.portions = Number(el.value);
        else m.name = el.value.trim();
        if (el.dataset.field === 'time') draft[Number(el.dataset.day)].sort((a, b) => a.time - b.time);
        change();
    });
    root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-remove],[data-add],[data-copy]');
        if (!el) return;
        const d = el.dataset;
        if (el.hasAttribute('data-remove')) {
            draft[Number(d.day)].splice(Number(d.meal), 1);
        } else if (d.add !== undefined) {
            const meals = draft[Number(d.add)];
            // an hour after the last meal, or 07:00
            const last = meals[meals.length - 1]?.time;
            meals.push({ time: last === undefined ? 7 * 3600 : Math.min(last + 3600, 23 * 3600 + 55 * 60), portions: 1, name: '' });
        } else if (d.copy !== undefined) {
            if (!confirm(`The meals of ${WEEKDAY_NAMES[Number(d.copy)]} on every day?`)) return;
            const meals = draft[Number(d.copy)];
            draft = draft.map(() => meals.map((m) => ({ ...m })));
        }
        change();
    });
    byId('plan-reload').addEventListener('click', () => {
        if (plan) setDraft(plan);
    });
    byId('plan-save').addEventListener('click', async () => {
        if (!feeder) return;
        const button = byId<HTMLButtonElement>('plan-save');
        button.classList.add('btn-loading');
        const res = await fetch(`/api/petkit/feeders/${feeder.id}/schedule`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: draft }),
        }).catch(() => undefined);
        button.classList.remove('btn-loading');
        if (!res?.ok) {
            byId('plan-result').innerHTML = errorAlert(escapeHtml(res ? await res.text() : 'The server did not answer.'));
            return;
        }
        setDraft((await res.json()) as PetkitPlan);
        byId('plan-result').innerHTML = successAlert('Saved to the feeder.');
    });
}

function setDraft(p: PetkitPlan) {
    plan = p;
    draft = p.days.map((d) => d.map((m) => ({ ...m })));
    dirty = false;
    renderPlan();
}

async function loadPlan(fresh = false) {
    if (!feeder) return;
    const res = await fetch(`/api/petkit/feeders/${feeder.id}/schedule${fresh ? '?fresh=1' : ''}`).catch(() => undefined);
    if (!res?.ok) {
        byId('plan').innerHTML = errorAlert(escapeHtml(res ? await res.text() : 'The server did not answer.'));
        return;
    }
    const p = (await res.json()) as PetkitPlan;
    // changes not saved yet stay; only the pause is taken over
    if (dirty && plan) {
        plan = { ...plan, paused: p.paused };
        renderPlan();
    } else setDraft(p);
}

/* ----------------------------------------------------------------------- */

async function load() {
    const s = await loadPetkit();
    if (!s?.connected || !s.feeders.length) {
        byId('container').innerHTML = `<div class="card"><div class="card-body">${emptyState(
            'bowl',
            s?.connected ? 'No feeder read yet' : 'No feeder connected',
            s?.connected ? 'The PetKit account has no feeder, or it was not read yet.' : 'Connect PetKit on the Devices page, under Pet feeder · PetKit.',
        )}</div></div>`;
        rendered = false;
        return;
    }
    feeder = s.feeders.find((f) => f.id === wanted) ?? s.feeders[0];
    byId('page-title').textContent = feeder.name;
    document.title = `${feeder.name} · kibbl.`;
    if (!rendered) layout();
    renderPicture();
    renderToday();
    if (!plan) renderPlan();
    await loadPlan();
}

socket.on('connect', () => void load());

// read again or changed: today's card follows, the plan when it may have changed (a pause)
socket.on('petkitUpdate', () => {
    if (!rendered) return;
    void loadPetkit().then((s) => {
        feeder = s?.feeders.find((f) => f.id === feeder?.id) ?? feeder;
        renderToday();
        renderPicture();
        if (plan && feeder && plan.paused !== feeder.planPaused) void loadPlan(true);
    });
});

document.addEventListener('visibilitychange', updateStream);

window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
});
