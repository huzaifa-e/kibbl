import './main';
import type ApexCharts from 'apexcharts';
import {
    STAGE_LABELS,
    STAGE_TONES,
    breathingChart,
    dayChart,
    heartRateDayChart,
    sleepFanChart,
    sleepNightsChart,
    sparkline,
    tone,
    type Tone,
} from './healthCharts';
import { SLEEP_BIN, sleepStageQuantiles, trend, type Direction, type SeriesPoint, type SleepNight } from './healthStats';
import { byId, emptyState, errorAlert, escapeHtml, localDayKey, successAlert, timeAgo } from './utils';

/* Health: the data of a fitness tracker through Google Health (ported from whoofit).
 * The server syncs every minute; this page reads its summary and asks for a day at full
 * resolution when a card is opened. */

declare const bootstrap: { Modal: { getOrCreateInstance(el: Element): { show(): void; hide(): void } } };

interface Metric {
    key: string;
    label: string;
    unit: string;
    tone: Tone;
    good: Direction;
    icon: string;
    band?: boolean;
    drill?: string; // the intraday type behind the card
}

const METRICS: Metric[] = [
    { key: 'resting_hr', label: 'Resting heart rate', unit: 'bpm', tone: 'pumpkin', good: 'down', icon: 'heart', drill: 'heart-rate' },
    { key: 'hrv', label: 'Heart rate variability', unit: 'ms', tone: 'pine', good: 'up', icon: 'wave-sine' },
    { key: 'spo2', label: 'Blood oxygen', unit: '%', tone: 'plum', good: 'up', icon: 'droplet', band: true, drill: 'oxygen-saturation' },
    { key: 'respiratory_rate', label: 'Breathing rate', unit: 'br/min', tone: 'olive', good: 'flat', icon: 'lungs' },
    { key: 'skin_temp', label: 'Skin temperature', unit: '°C', tone: 'mustard', good: 'flat', icon: 'temperature' },
    { key: 'active_zone_minutes', label: 'Active zone minutes', unit: 'min', tone: 'rust', good: 'up', icon: 'run', drill: 'active-zone-minutes' },
    { key: 'sedentary', label: 'Sedentary', unit: 'h', tone: 'bark', good: 'down', icon: 'armchair', drill: 'sedentary-granular' },
];

const DRILLS: Record<string, { title: string; tone: Tone }> = {
    'heart-rate': { title: 'Heart rate', tone: 'pumpkin' },
    'oxygen-saturation': { title: 'Blood oxygen', tone: 'plum' },
    'active-zone-minutes': { title: 'Active zone minutes', tone: 'rust' },
    'sedentary-granular': { title: 'Worn, active and sedentary', tone: 'bark' },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Summary = any;

const RANGES: Record<string, string> = { '30': '30 days', '90': '90 days', '365': '1 year', all: 'All' };
let range = new URLSearchParams(window.location.search).get('range') ?? '30';
if (!(range in RANGES)) range = '30';
const summaryUrl = () => `/api/health/summary?range=${range}`;

const LIVE_HR_MS = 10_000;
const SUMMARY_MS = 60_000;

let summary: Summary;
let charts: ApexCharts[] = [];
let fanChart: ApexCharts | undefined;
let fanStage = 'DEEP';
let drillChart: ApexCharts | undefined;
let drill = { type: '', date: '' };

const fmt = (v: number | null | undefined, digits = 1) => (typeof v === 'number' ? (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString() : '–');
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

async function getJson(url: string) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('not logged in');
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* ----------------------------------------------------------------------- */

function connectNotice() {
    const result = new URLSearchParams(window.location.search).get('connect');
    if (!result) return '';
    history.replaceState(null, '', '/health');
    const messages: Record<string, string> = {
        ok: successAlert('Google Health is connected. The first sync takes a few seconds.'),
        denied: errorAlert('Google Health was not connected: the access was not allowed.'),
        expired: errorAlert('The connection took too long or was started elsewhere. Try again.'),
        failed: errorAlert('Google did not accept the connection. Try again in a moment.'),
    };
    return messages[result] ?? '';
}

function connectCard(title: string, text: string, again = false) {
    return `<div class="card"><div class="card-body text-center py-5">
        <span class="hud-icon hud-plum mb-3" style="width:56px;height:56px;font-size:28px"><i class="ti ti-heartbeat"></i></span>
        <h2 class="mb-2">${title}</h2>
        <p class="text-secondary mx-auto" style="max-width:520px">${text}</p>
        <a class="btn btn-primary" href="/api/health/google/connect"><i class="ti ti-brand-google me-1"></i> ${again ? 'Connect again' : 'Connect Google Health'}</a>
        <p class="text-secondary small mt-3 mb-0">Read only: heart rate, sleep, blood oxygen, breathing, temperature and workouts. Disconnect any time below or in your Google account.</p>
    </div></div>`;
}

function statusCard() {
    const device = summary.device;
    const sync = summary.sync ?? {};
    const battery = typeof device?.battery === 'number' ? device.battery : null;
    const batteryIcon =
        battery === null ? 'battery' : battery > 60 ? 'battery-3' : battery > 30 ? 'battery-2' : battery > 10 ? 'battery-1' : 'battery-exclamation';
    const lastSync = device?.last_sync ? timeAgo(Date.parse(device.last_sync)) : 'never';
    return `<div class="card h-100"><div class="card-body d-flex flex-wrap align-items-center gap-3">
        <span class="hud-icon hud-plum"><i class="ti ti-device-watch"></i></span>
        <div class="flex-fill">
            <div class="fw-bold">${escapeHtml(device?.name ?? 'Tracker')}</div>
            <div class="text-secondary small"><i class="ti ti-${batteryIcon} me-1"></i>${battery === null ? '–' : `${battery} %`} · synced ${lastSync}${sync.error ? ` · <span class="text-danger">${escapeHtml(sync.error)}</span>` : ''}</div>
        </div>
        <div class="text-end" id="live-hr">
            <div class="health-live"><i class="ti ti-heart-filled"></i><span id="live-bpm">–</span><small>bpm</small></div>
            <div class="text-secondary small" id="live-age">latest heart rate</div>
        </div>
    </div></div>`;
}

function lastNightCard() {
    const nights = summary.series?.sleep ?? [];
    const n = nights[nights.length - 1];
    if (!n) return `<div class="card h-100"><div class="card-body">${emptyState('moon', 'No sleep yet', 'Wear the tracker at night.')}</div></div>`;
    const stages = ['DEEP', 'LIGHT', 'REM', 'AWAKE'];
    const total = stages.reduce((s, st) => s + (n.stages?.[st] ?? 0), 0) || 1;
    const bar = stages
        .map(
            (st) =>
                `<span title="${STAGE_LABELS[st]}: ${n.stages?.[st] ?? 0} min" style="width:${((n.stages?.[st] ?? 0) / total) * 100}%;background:${tone(STAGE_TONES[st])}"></span>`,
        )
        .join('');
    const legend = stages
        .map(
            (st) =>
                `<span class="me-3"><span class="health-dot" style="background:${tone(STAGE_TONES[st])}"></span>${STAGE_LABELS[st]} ${Math.floor((n.stages?.[st] ?? 0) / 60)}:${String((n.stages?.[st] ?? 0) % 60).padStart(2, '0')}</span>`,
        )
        .join('');
    return `<div class="card h-100"><div class="card-body">
        <div class="d-flex align-items-baseline gap-2 mb-2">
            <span class="hud-icon hud-plum"><i class="ti ti-moon"></i></span>
            <div class="flex-fill"><div class="fw-bold">Last night</div><div class="text-secondary small">${shortDate(n.date)}</div></div>
            <div class="stat-value">${Math.floor(n.value)} h ${Math.round((n.value % 1) * 60)} min</div>
        </div>
        <div class="health-stagebar mb-2">${bar}</div>
        <div class="small text-secondary">${legend}</div>
    </div></div>`;
}

function metricCard(m: Metric) {
    const series: SeriesPoint[] = summary.series?.[m.key] ?? [];
    const t = trend(series, m.good);
    const latest = t?.latest;
    const delta = t?.delta;
    const arrow = delta === null || delta === undefined ? '' : delta > 0 ? 'arrow-up-right' : delta < 0 ? 'arrow-down-right' : 'minus';
    const verdictClass = t?.verdict === 'good' ? 'text-success' : t?.verdict === 'bad' ? 'text-warning' : 'text-secondary';
    const extra = m.key === 'skin_temp' && latest && typeof (latest as any).baseline === 'number' ? ` · baseline ${fmt((latest as any).baseline)}` : '';
    return `<div class="col-sm-6 col-lg-4 col-xxl-3">
        <div class="card h-100 health-metric ${m.drill ? 'health-drillable' : ''}" ${m.drill ? `data-drill="${m.drill}" data-date="${latest?.date ?? ''}" tabindex="0" role="button"` : ''}>
            <div class="card-body pb-1">
                <div class="d-flex align-items-center gap-2 mb-1">
                    <i class="ti ti-${m.icon}" style="color:${tone(m.tone)}"></i>
                    <span class="text-secondary small flex-fill">${m.label}</span>
                    ${m.drill ? '<i class="ti ti-zoom-in text-secondary" title="Open the day"></i>' : ''}
                </div>
                <div class="d-flex align-items-baseline gap-2">
                    <span class="stat-value">${fmt(latest?.value)}</span><span class="text-secondary">${m.unit}</span>
                    ${arrow ? `<span class="ms-auto small ${verdictClass}" title="against the 7 days before"><i class="ti ti-${arrow}"></i>${fmt(Math.abs(delta as number))}</span>` : ''}
                </div>
                <div class="text-secondary small">${latest ? shortDate(latest.date) : 'no data yet'}${extra}</div>
                <div class="health-spark" id="spark-${m.key}"></div>
            </div>
        </div>
    </div>`;
}

function zonesCard() {
    const zones = summary.series?.hr_zones?.[0]?.zones ?? [];
    if (!zones.length) return '';
    const tones: Tone[] = ['olive', 'mustard', 'pumpkin', 'rust'];
    const max = Math.max(...zones.map((z: any) => z.max ?? 0)) || 220;
    return `<div class="card h-100"><div class="card-header"><h3 class="card-title">Heart rate zones</h3></div><div class="card-body">
        ${zones
            .map(
                (z: any, i: number) => `<div class="mb-3">
            <div class="d-flex small mb-1"><span class="flex-fill">${escapeHtml(z.zone)}</span><span class="text-secondary">${fmt(z.min, 0)}–${fmt(z.max, 0)} bpm</span></div>
            <div class="health-zone"><span style="left:${(z.min / max) * 100}%;width:${((z.max - z.min) / max) * 100}%;background:${tone(tones[i] ?? 'rust')}"></span></div>
        </div>`,
            )
            .join('')}
        <div class="text-secondary small">Personal zones, recomputed by Google from your resting heart rate.</div>
    </div></div>`;
}

function workoutsCard() {
    const list = [...(summary.series?.exercise ?? [])].reverse();
    if (!list.length) return '';
    const rows = list
        .slice(0, 12)
        .map(
            (w: any) =>
                `<tr><td>${shortDate(w.date)}</td><td>${escapeHtml(w.type)}</td><td class="text-end">${fmt(w.calories, 0)}</td><td class="text-end">${fmt(w.avg_hr, 0)}</td><td class="text-end d-none d-md-table-cell">${fmt(w.azm, 0)}</td></tr>`,
        )
        .join('');
    return `<div class="card"><div class="card-header"><h3 class="card-title">Workouts</h3><div class="card-actions text-secondary small">${list.length} ${range === 'all' ? 'in total' : `in ${RANGES[range].toLowerCase()}`}</div></div>
        <div class="table-responsive"><table class="table table-vcenter card-table">
            <thead><tr><th>Day</th><th>Type</th><th class="text-end">kcal</th><th class="text-end">Avg HR</th><th class="text-end d-none d-md-table-cell">Zone min</th></tr></thead>
            <tbody>${rows}</tbody></table></div></div>`;
}

const DISCOVERED_LABELS: Record<string, string> = {
    steps: 'Steps',
    distance: 'Distance',
    'active-energy-burned': 'Active energy',
    'heart-rate': 'Heart rate',
    'oxygen-saturation': 'Blood oxygen',
    'heart-rate-variability': 'HRV',
};

// data types that started to return data and have no card of their own yet
function discoveredCard() {
    const found = Object.entries(summary.discovered ?? {}) as [string, { date: string; value: number; label: string }[]][];
    if (!found.length) return '';
    const items = found
        .map(([type, series]) => {
            const last = series[series.length - 1];
            const label = DISCOVERED_LABELS[type] ?? type.replace(/-/g, ' ');
            return `<div class="list-group-item d-flex align-items-center"><span class="flex-fill">${escapeHtml(label)}</span><span class="text-secondary small me-3">${series.length} day${series.length === 1 ? '' : 's'}${last ? ` · ${shortDate(last.date)}` : ''}</span><b>${fmt(last?.value)}</b></div>`;
        })
        .join('');
    return `<div class="card h-100"><div class="card-header"><h3 class="card-title">Also recorded</h3></div><div class="list-group list-group-flush">${items}</div>
        <div class="card-footer text-secondary small">Found by the regular look for data types the tracker started to record.</div></div>`;
}

const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });

// what this server keeps, and how far the one-time fetch of the history has come
function historyLine() {
    const st = summary.storage;
    const h = summary.sync?.history;
    if (!st?.days) return '';
    let fetch = '';
    if (h?.state === 'running' || h?.state === 'failed') {
        const done = h.heartRateDaysTotal ? Math.round(((h.heartRateDays ?? 0) / h.heartRateDaysTotal) * 100) : 0;
        fetch = h.heartRateDaysTotal
            ? ` · fetching heart rate at full resolution: ${h.heartRateDays} of ${h.heartRateDaysTotal} days (${done} %)`
            : ` · fetching the history, back to ${longDate(h.reachedDay ?? st.oldestDay)} so far`;
        if (h.state === 'failed') fetch += ', paused, it goes on by itself';
    }
    return `<div><i class="ti ti-database me-1"></i>Stored on this server: <b>${st.days} days</b> since ${longDate(st.oldestDay)}, heart rate at full resolution for ${st.heartRateDays} days${fetch}.</div>`;
}

function connectionCard() {
    const link = summary.link;
    const expires = link?.refreshTokenExpiresAt;
    const soon = expires && expires - Date.now() < 3 * 24 * 3600_000;
    const connected = link
        ? `<div>Data from <b>Google Health</b>, connected ${link.connectedAt ? timeAgo(link.connectedAt) : ''}${link.scopes && link.scopesAsked && link.scopes < link.scopesAsked ? ` · ${link.scopes} of ${link.scopesAsked} permissions` : ''}; new data is fetched after each sync of the tracker.</div>`
        : `<div class="text-warning">Not connected to Google Health: no new data comes in. The history stored here stays.</div>`;
    const expiry = expires
        ? `<div class="${soon ? 'text-warning' : 'text-secondary'}">The access ends ${new Date(expires).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: the Google app is in testing mode. Publish it to production in the Google Cloud console, or connect again then.</div>`
        : '';
    return `<div class="card"><div class="card-body d-flex flex-wrap align-items-center gap-3">
        <i class="ti ti-brand-google text-secondary" style="font-size:1.4rem"></i>
        <div class="flex-fill small">${connected}${historyLine()}${expiry}</div>
        <div class="d-flex flex-wrap gap-2 ms-auto">
            <a class="btn btn-sm" href="/api/health/google/connect"><i class="ti ti-refresh me-1"></i> ${link ? 'Connect again' : 'Connect'}</a>
            ${link ? '<button class="btn btn-sm" id="health-disconnect"><i class="ti ti-plug-connected-x me-1"></i> Disconnect</button>' : ''}
            <button class="btn btn-sm btn-outline-danger" id="health-delete"><i class="ti ti-trash me-1"></i> Delete stored history</button>
        </div>
    </div></div>`;
}

/* ----------------------------------------------------------------------- */

function destroyCharts() {
    charts.forEach((c) => c.destroy());
    charts = [];
    fanChart?.destroy();
    fanChart = undefined;
}

function renderFan() {
    const el = document.getElementById('sleep-fan');
    if (!el) return;
    fanChart?.destroy();
    fanChart = undefined;
    const stats = sleepStageQuantiles((summary.series?.sleep ?? []) as SleepNight[], fanStage, SLEEP_BIN);
    if (stats.length < 2) {
        el.innerHTML = emptyState('moon', 'Not enough nights yet', 'The bands need at least 3 nights asleep at the same time.');
        return;
    }
    el.innerHTML = '';
    fanChart = sleepFanChart(el, stats, fanStage);
    document.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach((b) => b.classList.toggle('active', b.dataset.stage === fanStage));
}

function render(notice = '') {
    destroyCharts();
    const sleep = summary.series?.sleep ?? [];
    const stageButtons = ['DEEP', 'LIGHT', 'REM', 'AWAKE'].map((st) => `<button class="btn btn-sm" data-stage="${st}">${STAGE_LABELS[st]}</button>`).join('');

    byId('container').innerHTML = `
        ${notice}
        <div class="row row-cards mb-3">
            <div class="col-lg-7">${statusCard()}</div>
            <div class="col-lg-5">${lastNightCard()}</div>
        </div>
        <div class="row row-cards mb-3">${METRICS.map(metricCard).join('')}</div>
        <div class="row row-cards mb-3">
            <div class="col-xl-6">
                <div class="card h-100"><div class="card-header"><h3 class="card-title">Sleep</h3><div class="card-actions text-secondary small">${sleep.length} nights</div></div>
                <div class="card-body"><div id="sleep-nights"></div></div></div>
            </div>
            <div class="col-xl-6">
                <div class="card h-100"><div class="card-header"><h3 class="card-title">Sleep stage through the night</h3>
                    <div class="card-actions"><div class="btn-group">${stageButtons}</div></div></div>
                <div class="card-body"><div id="sleep-fan"></div>
                    <div class="text-secondary small mt-1">Minutes of the stage per half hour of the clock over the last nights: median (line), middle half (darker) and 10–90 % (lighter).</div></div></div>
            </div>
        </div>
        <div class="row row-cards mb-3">
            <div class="col-lg-4">${zonesCard()}</div>
            <div class="col-lg-8">
                <div class="card h-100"><div class="card-header"><h3 class="card-title">Breathing by sleep stage</h3></div>
                <div class="card-body"><div id="breathing"></div></div></div>
            </div>
        </div>
        <div class="row row-cards mb-3">
            <div class="col-lg-8">${workoutsCard()}</div>
            <div class="col-lg-4">${discoveredCard()}</div>
        </div>
        ${connectionCard()}`;

    for (const m of METRICS) {
        const el = document.getElementById(`spark-${m.key}`);
        const series = summary.series?.[m.key] ?? [];
        if (el && series.length > 1) charts.push(sparkline(el, series, m.tone, m.unit, m.band));
    }
    if (sleep.length) charts.push(sleepNightsChart(byId('sleep-nights'), sleep));
    else byId('sleep-nights').innerHTML = emptyState('moon', 'No nights yet', 'Wear the tracker to bed.');
    renderFan();
    const breathing = summary.series?.breathing_stages ?? [];
    if (breathing.length) charts.push(breathingChart(byId('breathing'), breathing));
    else byId('breathing').innerHTML = emptyState('lungs', 'No nights yet', '');

    document.querySelectorAll<HTMLButtonElement>('[data-stage]').forEach((b) =>
        b.addEventListener('click', () => {
            fanStage = b.dataset.stage!;
            renderFan();
        }),
    );
    document.querySelectorAll<HTMLElement>('[data-drill]').forEach((card) => {
        const open = () => openDrill(card.dataset.drill!, card.dataset.date || localDayKey(Date.now()));
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') open();
        });
    });
    document.getElementById('health-disconnect')?.addEventListener('click', disconnect);
    byId('health-delete').addEventListener('click', deleteHistory);
    renderRanges();
    updateLiveHr();
}

// the range of the page: 30 days, 90 days, a year or everything stored
function renderRanges() {
    const slot = document.getElementById('page-actions');
    if (!slot) return;
    slot.innerHTML = `<div class="btn-group">${Object.entries(RANGES)
        .map(([key, label]) => `<button class="btn btn-sm ${key === range ? 'active' : ''}" data-range="${key}">${label}</button>`)
        .join('')}</div>`;
    slot.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
        b.addEventListener('click', async () => {
            if (b.dataset.range === range) return;
            range = b.dataset.range!;
            const url = new URL(window.location.href);
            if (range === '30') url.searchParams.delete('range');
            else url.searchParams.set('range', range);
            history.replaceState(null, '', url);
            slot.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('active', x === b));
            const { status, body } = await getJson(summaryUrl());
            if (status === 200) {
                summary = body;
                render();
            }
        }),
    );
}

/* ----------------------------------------------------------------------- */

async function updateLiveHr() {
    const el = document.getElementById('live-bpm');
    if (!el || document.hidden) return;
    try {
        const { status, body } = await getJson('/api/health/hr-latest');
        if (status !== 200) return;
        el.textContent = typeof body.bpm === 'number' ? String(Math.round(body.bpm)) : '–';
        // the value only moves when the tracker syncs: its age says how fresh it is
        byId('live-age').textContent = typeof body.age_sec === 'number' ? `${timeAgo(Date.now() - body.age_sec * 1000)}` : 'latest heart rate';
    } catch {
        // the next round tries again
    }
}

async function disconnect() {
    if (
        !confirm(
            'Disconnect Google Health? No new data comes in; the history stored on this server stays. To remove the access entirely, also remove kibbl. under Third-party apps in your Google account.',
        )
    )
        return;
    await fetch('/api/health/google/disconnect', { method: 'POST' });
    window.location.reload();
}

async function deleteHistory() {
    const st = summary.storage;
    if (
        !confirm(
            `Delete the health history stored on this server (${st?.days ?? 0} days) and disconnect Google Health? This cannot be undone; Google keeps its own copy.`,
        )
    )
        return;
    await fetch('/api/health/google/disconnect?delete=1', { method: 'POST' });
    window.location.reload();
}

async function load() {
    const notice = connectNotice();
    const { status, body } = await getJson(summaryUrl());
    if (body.configured === false && !body.series) {
        byId('container').innerHTML =
            notice +
            emptyState(
                'heartbeat',
                'Health is not set up on this server',
                'The server needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET of a Google Cloud OAuth client with the Google Health API.',
            );
        return;
    }
    if (!body.linked && body.series) {
        summary = body; // not connected, but the history is stored here
        render(notice);
        return;
    }
    if (!body.linked) {
        byId('container').innerHTML =
            notice +
            connectCard(
                'Your health, next to your home',
                'Connect the Google account of your fitness tracker to see heart rate, sleep, blood oxygen, breathing and workouts here.',
            );
        return;
    }
    if (status === 202 || (status === 503 && !body.series)) {
        const sync = body.sync ?? {};
        byId('container').innerHTML =
            notice +
            (sync.reconnect
                ? connectCard(
                      'Connect Google Health again',
                      'Google no longer accepts the access kibbl. had: it expired (7 days while the Google app is in testing mode) or was removed.',
                      true,
                  )
                : sync.error
                  ? errorAlert(`Google Health does not answer: ${escapeHtml(sync.error)}. Trying again every minute.`)
                  : `<div class="center-loading text-center"><div class="text-secondary h2 mb-3">First sync with Google Health<span class="animated-dots"></span></div><div class="progress progress-sm mx-auto" style="max-width:320px"><div class="progress-bar progress-bar-indeterminate"></div></div></div>`);
        setTimeout(load, 5000);
        return;
    }
    summary = body;
    render(
        notice +
            (summary.sync?.reconnect
                ? errorAlert(
                      'Google no longer accepts the access: <a href="/api/health/google/connect">connect again</a>. The data shown is from the last sync.',
                  )
                : ''),
    );
}

/* ----------------------------------------------------------------------- */

function ensureDrillModal() {
    let modal = document.getElementById('drill-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'drill-modal';
    modal.className = 'modal modal-blur fade';
    modal.tabIndex = -1;
    modal.innerHTML = `<div class="modal-dialog modal-xl modal-dialog-centered"><div class="modal-content">
        <div class="modal-header">
            <h5 class="modal-title flex-fill" id="drill-title"></h5>
            <div class="d-flex align-items-center gap-2 me-3">
                <button class="btn btn-sm btn-icon" id="drill-prev" title="Day before"><i class="ti ti-chevron-left"></i></button>
                <input type="date" class="form-control form-control-sm" id="drill-date" />
                <button class="btn btn-sm btn-icon" id="drill-next" title="Day after"><i class="ti ti-chevron-right"></i></button>
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body"><div id="drill-body"></div><div class="text-secondary small mt-2" id="drill-meta"></div></div>
    </div></div>`;
    document.body.appendChild(modal);
    const shift = (days: number) => {
        const d = new Date(`${drill.date}T12:00:00`);
        d.setDate(d.getDate() + days);
        const next = localDayKey(d.getTime());
        if (next <= localDayKey(Date.now())) loadDrill(drill.type, next);
    };
    byId('drill-prev').addEventListener('click', () => shift(-1));
    byId('drill-next').addEventListener('click', () => shift(1));
    byId<HTMLInputElement>('drill-date').addEventListener('change', (e) => {
        const v = (e.target as HTMLInputElement).value;
        if (v) loadDrill(drill.type, v);
    });
    modal.addEventListener('hidden.bs.modal', () => {
        drillChart?.destroy();
        drillChart = undefined;
    });
    return modal;
}

function openDrill(type: string, date: string) {
    const modal = ensureDrillModal();
    bootstrap.Modal.getOrCreateInstance(modal).show();
    loadDrill(type, date);
}

function timeline(runs: { sm: number; em: number; s: string; e: string; state: string; min: number }[], totals: Record<string, number>) {
    const colors: Record<string, string> = { active: tone('olive'), sedentary: tone('mustard'), off: 'transparent' };
    const labels: Record<string, string> = { active: 'active', sedentary: 'sedentary', off: 'not worn' };
    const segs = runs
        .map(
            (r) =>
                `<span class="health-run health-run-${r.state}" style="left:${(r.sm / 1440) * 100}%;width:${((r.em - r.sm) / 1440) * 100}%;background:${colors[r.state]}" title="${r.s}–${r.e} · ${labels[r.state]} ${r.min} min"></span>`,
        )
        .join('');
    const ticks = Array.from({ length: 9 }, (_, i) => `<span style="left:${(i / 8) * 100}%">${String(i * 3).padStart(2, '0')}:00</span>`).join('');
    const h = (m: number) => `${Math.floor(m / 60)} h ${m % 60} min`;
    return `<div class="health-timeline">${segs}</div><div class="health-ticks">${ticks}</div>
        <div class="d-flex flex-wrap gap-4 mt-4 small">
            <span><span class="health-dot" style="background:${colors.active}"></span>Active ${h(totals.active ?? 0)}</span>
            <span><span class="health-dot" style="background:${colors.sedentary}"></span>Sedentary ${h(totals.sedentary ?? 0)}</span>
            <span><span class="health-dot health-dot-off"></span>Not worn ${h(totals.off ?? 0)}</span>
        </div>
        <div class="text-secondary small mt-2">A minute with a heart rate was worn; worn without steps is sedentary. Without a heart rate it is not counted as sedentary.</div>`;
}

async function loadDrill(type: string, date: string) {
    drill = { type, date };
    const spec = DRILLS[type];
    byId('drill-title').textContent = `${spec.title} · ${shortDate(date)}`;
    const input = byId<HTMLInputElement>('drill-date');
    input.value = date;
    input.max = localDayKey(Date.now());
    byId<HTMLButtonElement>('drill-next').disabled = date >= localDayKey(Date.now());
    drillChart?.destroy();
    drillChart = undefined;
    const body = byId('drill-body');
    body.innerHTML = '<div class="text-center text-secondary py-5">Loading the day<span class="animated-dots"></span></div>';
    byId('drill-meta').textContent = '';

    const { status, body: data } = await getJson(`/api/health/intraday?type=${encodeURIComponent(type)}&date=${date}`);
    if (drill.type !== type || drill.date !== date) return; // another day was asked for meanwhile
    if (status !== 200 || data.error) {
        body.innerHTML = errorAlert(escapeHtml(data.error ?? `The day could not be loaded (${status}).`));
        return;
    }
    if (type === 'sedentary-granular') {
        body.innerHTML = timeline(data.runs ?? [], data.totals ?? {});
        return;
    }
    const points = data.points ?? [];
    if (!points.length) {
        body.innerHTML = emptyState('calendar-off', 'Nothing recorded', 'The tracker has no data for this day (not worn, or not synced yet).');
        return;
    }
    body.innerHTML = '<div id="drill-chart"></div>';
    if (type === 'heart-rate') {
        drillChart = heartRateDayChart(byId('drill-chart'), points, summary?.series?.hr_zones?.[0]?.zones ?? []);
    } else {
        drillChart = dayChart(byId('drill-chart'), points, spec.tone, data.unit ?? '', type !== 'oxygen-saturation');
    }
    const meta = data.meta ?? {};
    byId('drill-meta').textContent = [
        `${(data.raw_count ?? points.length).toLocaleString()} samples`,
        data.bucket_min
            ? `shown as ${data.bucket_min}-minute ${type === 'oxygen-saturation' ? 'means' : 'sums'}`
            : type === 'heart-rate'
              ? 'shown per minute (mean and range)'
              : '',
        meta.device ? `from ${meta.device}` : '',
        meta.utc_offset ? `times in ${meta.utc_offset}` : '',
    ]
        .filter(Boolean)
        .join(' · ');
}

/* ----------------------------------------------------------------------- */

window.addEventListener('themechange', () => {
    if (summary) render();
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateLiveHr();
});

load();
window.setInterval(updateLiveHr, LIVE_HR_MS);
window.setInterval(async () => {
    // a quiet refresh: only when the page is seen and no day is open
    if (document.hidden || !summary || document.querySelector('#drill-modal.show')) return;
    const { status, body } = await getJson(summaryUrl());
    if (
        status === 200 &&
        (body.sync?.last_update !== summary.sync?.last_update || JSON.stringify(body.sync?.history) !== JSON.stringify(summary.sync?.history))
    ) {
        summary = body;
        render();
    }
}, SUMMARY_MS);
