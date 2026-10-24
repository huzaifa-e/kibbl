import './main';
import {
    ALERT_INFO,
    EFFECT_INFO,
    LIGHT_ALERT_KINDS,
    LIGHT_EFFECTS,
    LIGHT_MOODS,
    LIGHT_SPEEDS,
    LIGHT_TIMERS_MAX,
    RAMP_MINUTES,
    WEEKDAYS,
    actionText,
    hexOf,
    type LightAction,
    type LightAlertKind,
    type LightAlerts,
    type LightEffect,
    type LightPlan,
    type LightShowState,
    type LightTimer,
} from '../../../shared/light';
import type { DeviceSummary } from '../../../shared/protocol';
import { bindControls, controlsHtml } from './controls';
import { request, socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml, successAlert } from './utils';

/* A kibbl. light's own page: the light now, moods, effects the server plays on it, the
 * weekly timers (edited here, saved as a whole) and the alerts that flash it. */

type Result = { ok: boolean; error?: string };

const wanted = window.location.pathname.split('/')[2];
let light: DeviceSummary | undefined;
let plan: LightPlan | undefined;
let next: Record<string, number | null> = {};
let draft: LightTimer[] = [];
let dirty = false;
let rendered = false;

const ramp = (e: LightEffect) => e === 'sunrise' || e === 'sunset';
const swatch = (c: [number, number, number]) => `<span class="avatar avatar-xs rounded" style="background:${hexOf(c)}"></span>`;

function layout() {
    byId('container').innerHTML = `
        <div class="row row-cards">
            <div class="col-lg-4">
                <div class="card">
                    <div class="card-header"><h3 class="card-title"><i class="ti ti-bulb me-1"></i> Now</h3></div>
                    <div class="card-body">
                        <div id="light-playing" class="mb-3"></div>
                        <div id="light-now"></div>
                    </div>
                </div>
            </div>
            <div class="col-lg-8">
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title"><i class="ti ti-palette me-1"></i> Moods</h3></div>
                    <div class="card-body"><div class="row g-2" id="light-moods"></div></div>
                </div>
                <div class="card">
                    <div class="card-header"><h3 class="card-title"><i class="ti ti-sparkles me-1"></i> Effects</h3></div>
                    <div class="card-body">
                        <div class="row g-2 mb-3" id="light-effects"></div>
                        <div class="row g-2 align-items-end">
                            <div class="col-sm-4">
                                <label class="form-label">Speed</label>
                                <select class="form-select" id="effect-speed">${LIGHT_SPEEDS.map((s) => `<option value="${s}" ${s === 'normal' ? 'selected' : ''}>${s}</option>`).join('')}</select>
                            </div>
                            <div class="col-sm-4">
                                <label class="form-label">Minutes</label>
                                <input type="number" class="form-control" id="effect-minutes" min="${RAMP_MINUTES.min}" max="${RAMP_MINUTES.max}" placeholder="${RAMP_MINUTES.default} for sunrise, sunset" />
                            </div>
                            <div class="col-sm-4 form-hint">A sunrise or sunset takes the minutes; any other effect ends after them and the light comes back as it was. A change of the light ends an effect.</div>
                        </div>
                        <div id="effect-result" class="mt-2"></div>
                    </div>
                </div>
            </div>
            <div class="col-12">
                <div class="card">
                    <div class="card-header">
                        <h3 class="card-title"><i class="ti ti-alarm me-1"></i> Timers</h3>
                        <div class="card-actions btn-list">
                            <button class="btn btn-sm" id="timers-undo"><i class="ti ti-refresh me-1"></i> Undo changes</button>
                            <button class="btn btn-sm btn-primary" id="timers-save"><i class="ti ti-device-floppy me-1"></i> Save</button>
                        </div>
                    </div>
                    <div class="card-body" id="timers"></div>
                </div>
            </div>
            <div class="col-12">
                <div class="card">
                    <div class="card-header"><h3 class="card-title"><i class="ti ti-bell-ringing me-1"></i> Alerts</h3></div>
                    <div class="card-body" id="alerts"></div>
                </div>
            </div>
        </div>`;
    bindControls(byId('light-now'), (id) => (light?._id === id ? light : undefined));
    bindMoods();
    bindTimers();
    bindAlerts();
    rendered = true;
}

/* ----------------------------------------------------------------------- */

function renderNow() {
    if (!light) return;
    const active = document.activeElement as HTMLElement | null;
    // the colour picker or slider being moved stays as it is
    if (!active?.dataset.control?.startsWith('rgb-')) byId('light-now').innerHTML = controlsHtml(light) + `<div data-control-result="${light._id}"></div>`;
    renderPlaying(light.lightShow);
}

function renderPlaying(show: LightShowState | undefined) {
    const slot = byId('light-playing');
    if (!show) {
        slot.innerHTML = '';
        return;
    }
    const ends = show.endsAt ? ` · until ${new Date(show.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    slot.innerHTML = `<div class="d-flex align-items-center gap-2">
        <span class="status-dot status-dot-animated status-green"></span>
        <span class="flex-fill">Playing <b>${escapeHtml(show.name)}</b>${ends}</span>
        <button class="btn btn-sm" data-effect-stop><i class="ti ti-player-stop me-1"></i> Stop</button>
    </div>`;
}

function renderMoods() {
    const disabled = light?.online ? '' : 'disabled';
    const playing = light?.lightShow?.name;
    byId('light-moods').innerHTML = Object.entries(LIGHT_MOODS)
        .map(
            ([
                id,
                m,
            ]) => `<div class="col-6 col-md-4 col-xl-3"><button class="btn w-100 justify-content-start ${playing === m.label ? 'active' : ''}" data-mood="${id}" ${disabled}>
                ${swatch(m.color)}<i class="ti ti-${m.icon} ms-2 me-1"></i> ${m.label}</button></div>`,
        )
        .join('');
    byId('light-effects').innerHTML = LIGHT_EFFECTS.map(
        (
            e,
        ) => `<div class="col-6 col-md-3"><button class="btn w-100 flex-column py-2 ${playing === EFFECT_INFO[e].label ? 'active' : ''}" data-effect="${e}" ${disabled}>
            <span><i class="ti ti-${EFFECT_INFO[e].icon} me-1"></i> ${EFFECT_INFO[e].label}</span>
            <span class="small text-secondary text-wrap">${EFFECT_INFO[e].text}</span></button></div>`,
    ).join('');
}

function bindMoods() {
    const result = (r: Result) => (byId('effect-result').innerHTML = r.ok ? '' : errorAlert(escapeHtml(r.error ?? 'failed')));
    document.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-mood],[data-effect],[data-effect-stop]');
        if (!el || !light) return;
        if (el.dataset.mood) {
            result(await request<Result>('lightMood', light._id, el.dataset.mood));
        } else if (el.hasAttribute('data-effect-stop')) {
            result(await request<Result>('lightEffect', light._id, { stop: true }));
        } else if (el.dataset.effect) {
            const minutes = Number(byId<HTMLInputElement>('effect-minutes').value) || undefined;
            const speed = byId<HTMLSelectElement>('effect-speed').value;
            result(await request<Result>('lightEffect', light._id, { effect: el.dataset.effect, speed, minutes }));
        }
    });
}

/* ----------------------------------------------------------------------- */

// what a timer does, as one value of its select
const actionValue = (a: LightAction) => (a.kind === 'mood' ? `mood:${a.mood}` : a.kind === 'effect' ? `effect:${a.effect}` : a.kind);

function actionOptions(t: LightTimer) {
    const now = actionValue(t.action);
    const opt = (value: string, label: string) => `<option value="${value}" ${value === now ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    return [
        opt('off', 'Off'),
        t.action.kind === 'color' ? opt('color', actionText(t.action)) : '',
        `<optgroup label="Mood">${Object.entries(LIGHT_MOODS)
            .map(([id, m]) => opt(`mood:${id}`, m.label))
            .join('')}</optgroup>`,
        `<optgroup label="Effect">${LIGHT_EFFECTS.map((e) => opt(`effect:${e}`, EFFECT_INFO[e].label)).join('')}</optgroup>`,
    ].join('');
}

function timerRow(t: LightTimer, i: number) {
    const at = `data-timer="${i}"`;
    const effect = t.action.kind === 'effect' ? t.action : undefined;
    const minutes = effect && ramp(effect.effect) ? (effect.minutes ?? RAMP_MINUTES.default) : undefined;
    const when = next[t.id] && !dirty ? `next ${new Date(next[t.id]!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
    return `<div class="border rounded p-2 mb-2 ${t.enabled ? '' : 'opacity-50'}">
        <div class="d-flex flex-wrap gap-2 align-items-center">
            <label class="form-check form-switch mb-0" title="on"><input class="form-check-input" type="checkbox" data-field="enabled" ${at} ${t.enabled ? 'checked' : ''} /></label>
            <input type="time" class="form-control form-control-sm" style="width:6.5rem" value="${t.at}" data-field="at" ${at} />
            <div class="btn-group btn-group-sm">${WEEKDAYS.map(
                (d, k) => `<button type="button" class="btn ${t.days.includes(k) ? 'btn-primary' : ''}" data-day="${k}" ${at}>${d}</button>`,
            ).join('')}</div>
            <select class="form-select form-select-sm" style="width:11rem" data-field="action" ${at}>${actionOptions(t)}</select>
            ${
                minutes !== undefined
                    ? `<div class="input-group input-group-sm" style="width:8rem"><input type="number" class="form-control" min="${RAMP_MINUTES.min}" max="${RAMP_MINUTES.max}" value="${minutes}" data-field="minutes" ${at} /><span class="input-group-text">min</span></div>`
                    : ''
            }
            <input class="form-control form-control-sm" style="max-width:12rem" placeholder="name" maxlength="40" value="${escapeHtml(t.name ?? '')}" data-field="name" ${at} />
            <span class="text-secondary small flex-fill">${when}</span>
            <button class="btn btn-sm btn-ghost-danger btn-icon" title="remove" data-remove ${at}><i class="ti ti-x"></i></button>
        </div>
    </div>`;
}

function renderTimers() {
    const slot = byId('timers');
    if (!plan) {
        slot.innerHTML = '<div class="text-secondary">Loading…</div>';
        return;
    }
    slot.innerHTML = `
        ${draft.map(timerRow).join('') || '<div class="text-secondary mb-2">No timers yet.</div>'}
        <div class="btn-list mt-2">
            <button class="btn btn-sm" data-add="sunrise" ${draft.length >= LIGHT_TIMERS_MAX ? 'disabled' : ''}><i class="ti ti-sunrise me-1"></i> Wake-up sunrise</button>
            <button class="btn btn-sm" data-add="sunset" ${draft.length >= LIGHT_TIMERS_MAX ? 'disabled' : ''}><i class="ti ti-sunset me-1"></i> Bedtime sunset</button>
            <button class="btn btn-sm" data-add="mood" ${draft.length >= LIGHT_TIMERS_MAX ? 'disabled' : ''}><i class="ti ti-plus me-1"></i> Timer</button>
        </div>
        <div class="form-hint mt-3">Home time. A sunrise is bright at its time and starts its minutes before; a sunset starts at its time and ends with the light off. A timer that sets the light ends an effect.</div>
        <div id="timers-result" class="mt-2"></div>`;
    byId<HTMLButtonElement>('timers-save').disabled = !dirty || draft.some((t) => !t.days.length);
    byId<HTMLButtonElement>('timers-undo').disabled = !dirty;
}

function change() {
    dirty = true;
    renderTimers();
}

function bindTimers() {
    const root = byId('timers');
    root.addEventListener('change', (e) => {
        const el = e.target as HTMLInputElement;
        const t = draft[Number(el.dataset.timer)];
        if (!t || !el.dataset.field) return;
        const field = el.dataset.field;
        if (field === 'enabled') t.enabled = el.checked;
        else if (field === 'at' && el.value) t.at = el.value;
        else if (field === 'name') t.name = el.value.trim() || undefined;
        else if (field === 'minutes' && t.action.kind === 'effect')
            t.action.minutes = Math.min(Math.max(Number(el.value) || RAMP_MINUTES.default, RAMP_MINUTES.min), RAMP_MINUTES.max);
        else if (field === 'action') {
            const [kind, name] = el.value.split(':');
            if (kind === 'mood') t.action = { kind: 'mood', mood: name };
            else if (kind === 'effect') t.action = { kind: 'effect', effect: name as LightEffect };
            else if (kind === 'off') t.action = { kind: 'off' };
        }
        change();
    });
    root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-remove],[data-add],[data-day]');
        if (!el) return;
        const t = draft[Number(el.dataset.timer)];
        if (el.hasAttribute('data-remove') && t) {
            draft.splice(Number(el.dataset.timer), 1);
        } else if (el.dataset.day !== undefined && t) {
            const d = Number(el.dataset.day);
            t.days = t.days.includes(d) ? t.days.filter((x) => x !== d) : [...t.days, d].sort();
        } else if (el.dataset.add) {
            const id = '';
            const add = el.dataset.add;
            draft.push(
                add === 'sunrise'
                    ? {
                          id,
                          enabled: true,
                          days: [0, 1, 2, 3, 4],
                          at: '07:00',
                          action: { kind: 'effect', effect: 'sunrise', minutes: RAMP_MINUTES.default },
                          name: 'Wake up',
                      }
                    : add === 'sunset'
                      ? {
                            id,
                            enabled: true,
                            days: [0, 1, 2, 3, 4, 5, 6],
                            at: '23:00',
                            action: { kind: 'effect', effect: 'sunset', minutes: 30 },
                            name: 'Bedtime',
                        }
                      : { id, enabled: true, days: [0, 1, 2, 3, 4, 5, 6], at: '19:00', action: { kind: 'mood', mood: 'relax' } },
            );
        } else return;
        change();
    });
    byId('timers-undo').addEventListener('click', () => {
        if (plan) setDraft(plan.timers);
    });
    byId('timers-save').addEventListener('click', async () => {
        if (!light) return;
        const button = byId<HTMLButtonElement>('timers-save');
        button.classList.add('btn-loading');
        const r = await request<Result & { timers?: LightTimer[] }>('setLightTimers', light._id, draft);
        button.classList.remove('btn-loading');
        if (!r.ok || !r.timers) {
            byId('timers-result').innerHTML = errorAlert(escapeHtml(r.error ?? 'not saved'));
            return;
        }
        await loadPlan();
        byId('timers-result').innerHTML = successAlert('Saved.');
    });
}

function setDraft(timers: LightTimer[]) {
    draft = timers.map((t) => ({ ...t, days: [...t.days], action: { ...t.action } as LightAction }));
    dirty = false;
    renderTimers();
}

/* ----------------------------------------------------------------------- */

function renderAlerts() {
    if (!plan) return;
    const a = plan.alerts;
    const hours = (value: number) =>
        Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === value ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    byId('alerts').innerHTML = `
        <label class="form-check form-switch mb-3">
            <input class="form-check-input" type="checkbox" data-alert="enabled" ${a.enabled ? 'checked' : ''} />
            <span class="form-check-label">Flash the light when kibbl. sends an alert</span>
        </label>
        <div class="row g-2 mb-3 ${a.enabled ? '' : 'opacity-50'}">${LIGHT_ALERT_KINDS.map(
            (k) => `<div class="col-md-6 col-xl-4"><div class="d-flex align-items-center gap-2 border rounded p-2">
                ${swatch(ALERT_INFO[k].color)}
                <label class="form-check mb-0 flex-fill"><input class="form-check-input" type="checkbox" data-kind="${k}" ${a.kinds.includes(k) ? 'checked' : ''} />
                    <span class="form-check-label">${ALERT_INFO[k].label}</span></label>
                <button class="btn btn-sm btn-ghost-secondary" data-test="${k}" ${light?.online ? '' : 'disabled'}>Test</button>
            </div></div>`,
        ).join('')}</div>
        <div class="row g-2 align-items-end">
            <div class="col-auto"><label class="form-label">Quiet from</label><select class="form-select form-select-sm" data-alert="quietFrom">${hours(a.quietFrom)}</select></div>
            <div class="col-auto"><label class="form-label">to</label><select class="form-select form-select-sm" data-alert="quietTo">${hours(a.quietTo)}</select></div>
            <div class="col-auto">
                <label class="form-check form-switch mb-1">
                    <input class="form-check-input" type="checkbox" data-alert="onlyWhenOn" ${a.onlyWhenOn ? 'checked' : ''} />
                    <span class="form-check-label">Only while the light is on</span>
                </label>
            </div>
        </div>
        <div class="form-hint mt-2">A possible fire flashes always, also in quiet hours and with the light off. "From the assistant" is an assistant flashing the light to tell you something.</div>
        <div id="alerts-result" class="mt-2"></div>`;
}

function bindAlerts() {
    const root = byId('alerts');
    root.addEventListener('change', async (e) => {
        const el = e.target as HTMLInputElement;
        if (!light || !plan) return;
        const change: Partial<LightAlerts> = {};
        if (el.dataset.kind) {
            const k = el.dataset.kind as LightAlertKind;
            change.kinds = el.checked ? [...plan.alerts.kinds, k] : plan.alerts.kinds.filter((x) => x !== k);
        } else if (el.dataset.alert === 'enabled' || el.dataset.alert === 'onlyWhenOn') {
            change[el.dataset.alert] = el.checked;
        } else if (el.dataset.alert === 'quietFrom' || el.dataset.alert === 'quietTo') {
            change[el.dataset.alert] = Number(el.value);
        } else return;
        const r = await request<Result & { alerts?: LightAlerts }>('setLightAlerts', light._id, change);
        if (r.ok && r.alerts) plan.alerts = r.alerts;
        renderAlerts();
        if (!r.ok) byId('alerts-result').innerHTML = errorAlert(escapeHtml(r.error ?? 'not saved'));
    });
    root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-test]');
        if (!el || !light) return;
        el.classList.add('btn-loading');
        await request<Result>('lightFlash', light._id, el.dataset.test);
        el.classList.remove('btn-loading');
    });
}

/* ----------------------------------------------------------------------- */

async function loadPlan() {
    if (!light) return;
    const r = await request<Result & { plan?: LightPlan; show?: LightShowState | null; next?: Record<string, number | null> }>('getLightPlan', light._id);
    if (!r.ok || !r.plan) {
        byId('timers').innerHTML = errorAlert(escapeHtml(r.error ?? 'not read'));
        return;
    }
    plan = r.plan;
    next = r.next ?? {};
    // changes not saved yet stay
    if (!dirty) setDraft(plan.timers);
    renderAlerts();
}

async function load() {
    const lights = (await request<DeviceSummary[]>('getDevices')).filter((d) => d.status === 'approved' && d.caps.includes('rgb'));
    light = lights.find((d) => d._id === wanted) ?? lights[0];
    if (!light) {
        byId('container').innerHTML =
            `<div class="card"><div class="card-body">${emptyState('bulb', 'No kibbl. light', 'Add one on the Devices page.')}</div></div>`;
        rendered = false;
        return;
    }
    byId('page-title').textContent = light.name;
    document.title = `${light.name} · kibbl.`;
    if (!rendered) layout();
    renderNow();
    renderMoods();
    if (!plan) renderTimers();
    await loadPlan();
}

socket.on('connect', () => void load());

socket.on('deviceUpdate', (d: DeviceSummary) => {
    if (!rendered || d._id !== light?._id) return;
    const wasOnline = light.online;
    const playing = light.lightShow?.name;
    light = d;
    renderNow();
    if (wasOnline !== d.online || playing !== d.lightShow?.name) {
        renderMoods();
        renderAlerts();
    }
});

window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
});
