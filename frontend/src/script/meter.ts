import './main';
import ApexCharts from 'apexcharts';
import { baseOptions } from './activityCharts';
import { tone } from './healthCharts';
import { socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml, timeAgo } from './utils';

/* A utility meter copied from the EMONI LoRaWAN server: the latest reading, consumption
 * per day, month and year, and the readings of the last days. The server pushes each new
 * reading as the meter sends it. */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Meter = any;

interface PeriodRow {
    key: string;
    consumption: number | null;
    opening: number | null;
    closing: number | null;
}

type Period = 'day' | 'month' | 'year';
const PERIOD_LABELS: Record<Period, string> = { day: 'Days', month: 'Months', year: 'Years' };
const LIVE_RANGES: Record<string, string> = { '2': '2 days', '7': '7 days', '30': '30 days' };

const meterId = window.location.pathname.split('/')[2] ?? '';
let meter: Meter;
let period: Period = 'day';
let liveDays = '2';
let rows: PeriodRow[] = [];
const charts: Record<string, ApexCharts | undefined> = {};

const fmt = (v: number | null | undefined, digits = 1) =>
    typeof v === 'number' ? v.toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';

async function getJson(url: string) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('not logged in');
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

function keyLabel(key: string, p: Period) {
    if (p === 'year') return key;
    if (p === 'month') return new Date(`${key}-15T12:00:00`).toLocaleDateString([], { month: 'short', year: '2-digit' });
    return new Date(`${key}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function draw(name: string, el: HTMLElement, options: Record<string, unknown>) {
    charts[name]?.destroy();
    const chart = new ApexCharts(el, options);
    chart.render();
    charts[name] = chart;
}

/* ----------------------------------------------------------------------- */

function tile(icon: string, color: string, label: string, value: string, unit: string, sub: string) {
    return `<div class="col-sm-6 col-xl-3"><div class="card h-100"><div class="card-body">
        <div class="d-flex align-items-center gap-2 mb-1"><i class="ti ti-${icon}" style="color:${color}"></i><span class="text-secondary small">${label}</span></div>
        <div class="d-flex align-items-baseline gap-2"><span class="stat-value">${value}</span><span class="text-secondary">${unit}</span></div>
        <div class="text-secondary small">${sub}</div>
    </div></div></div>`;
}

function batteryTile() {
    const b = meter.battery;
    if (!b) return tile('battery', tone('olive'), 'Battery', '–', '', 'no voltage reported');
    const icon =
        b.percent === null ? 'battery' : b.percent > 60 ? 'battery-3' : b.percent > 30 ? 'battery-2' : b.percent > 10 ? 'battery-1' : 'battery-exclamation';
    const color = b.percent !== null && b.percent <= 15 ? 'var(--tblr-danger)' : tone('olive');
    return tile(
        icon,
        color,
        'Battery',
        b.percent === null ? '–' : String(b.percent),
        b.percent === null ? '' : '%',
        `${(b.mv / 1000).toFixed(2)} V${b.daysLeft !== null ? ` · about ${b.daysLeft} days left` : ''}`,
    );
}

function layout() {
    byId('page-pretitle').textContent = `${meter.medium === 'electricity' ? 'Electricity' : meter.medium} meter · EMONI LoRaWAN`;
    byId('page-title').textContent = meter.name;

    const periodButtons = (Object.keys(PERIOD_LABELS) as Period[])
        .map((p) => `<button class="btn btn-sm" data-period="${p}">${PERIOD_LABELS[p]}</button>`)
        .join('');
    const liveButtons = Object.entries(LIVE_RANGES)
        .map(([k, v]) => `<button class="btn btn-sm" data-live="${k}">${v}</button>`)
        .join('');

    byId('container').innerHTML = `
        <div id="meter-error"></div>
        <div class="row row-cards mb-3" id="tiles"></div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">Consumption</h3><div class="card-actions"><div class="btn-group">${periodButtons}</div></div></div>
            <div class="card-body">
                <div class="row g-3 mb-3" id="period-kpis"></div>
                <div id="period-chart"></div>
            </div>
        </div>
        <div class="card mb-3"><div class="card-header"><h3 class="card-title">Meter reading</h3><div class="card-actions"><div class="btn-group">${liveButtons}</div></div></div>
            <div class="card-body"><div id="live-chart"></div><div class="text-secondary small mt-1" id="live-note"></div></div></div>`;

    document.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) => b.addEventListener('click', () => loadPeriod(b.dataset.period as Period)));
    document.querySelectorAll<HTMLButtonElement>('[data-live]').forEach((b) => b.addEventListener('click', () => loadLive(b.dataset.live!)));
}

function renderTop() {
    const latest = meter.latest;
    byId('tiles').innerHTML =
        tile('gauge', tone('pumpkin'), 'Meter reading', fmt(latest?.value), meter.unit, latest ? `read ${timeAgo(latest.at)}` : 'no reading yet') +
        tile('bolt', tone('mustard'), 'Power', meter.powerKw === null ? '–' : fmt(meter.powerKw * 1000, 0), 'W', 'mean of the last 2 hours') +
        tile('calendar', tone('pine'), 'Today', fmt(meter.today?.consumption, 2), meter.unit, 'since midnight') +
        batteryTile();

    byId('meter-error').innerHTML = meter.lastSyncError
        ? errorAlert(`The LoRaWAN server does not answer: ${escapeHtml(meter.lastSyncError)}. The data shown is the copy stored here.`)
        : '';
}

/* ----------------------------------------------------------------------- */

async function loadPeriod(p: Period) {
    period = p;
    document.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.period === p));
    rows = (await getJson(`/api/meters/${meterId}/periods?period=${p}`)) as PeriodRow[];
    const values = rows.map((r) => r.consumption ?? 0);
    const sum = values.reduce((s, v) => s + v, 0);
    const kpi = (label: string, value: string, unit: string) =>
        `<div class="col-6 col-lg-3"><div class="text-secondary small text-uppercase" style="letter-spacing:.05em;font-size:10px">${label}</div><div class="h3 mb-0">${value} <span class="text-secondary small">${unit}</span></div></div>`;
    byId('period-kpis').innerHTML =
        kpi(`Sum (${PERIOD_LABELS[p].toLowerCase()})`, fmt(sum, 1), meter.unit) +
        kpi(`Mean per ${p}`, fmt(values.length ? sum / values.length : null, 2), meter.unit) +
        kpi('Peak', fmt(values.length ? Math.max(...values) : null, 2), meter.unit) +
        kpi('Data points', String(rows.length), '');

    const el = byId('period-chart');
    if (!rows.length) {
        el.innerHTML = emptyState('chart-bar-off', 'No values yet', 'They appear after the first sync.');
        return;
    }
    el.innerHTML = '';
    draw('period', el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: 300, zoom: { enabled: false } },
        series: [
            {
                name: 'Consumption',
                data: rows.map((r) => ({ x: keyLabel(r.key, p), y: r.consumption === null ? null : Math.round(r.consumption * 100) / 100 })),
            },
        ],
        colors: [tone('pumpkin')],
        plotOptions: { bar: { columnWidth: rows.length > 60 ? '90%' : '65%', borderRadius: 2 } },
        stroke: { show: rows.length <= 60, width: 1, colors: [document.documentElement.getAttribute('data-bs-theme') === 'dark' ? '#0b0604' : '#2a1a12'] },
        xaxis: {
            type: 'category',
            labels: { rotate: 0, hideOverlappingLabels: true },
            tickAmount: Math.min(rows.length, 12),
            axisBorder: { show: false },
            axisTicks: { show: false },
        },
        yaxis: { labels: { formatter: (v: number) => fmt(v, 0) }, min: 0, tickAmount: 4 },
        tooltip: { ...baseOptions().tooltip, y: { formatter: (v: number) => `${fmt(v, 2)} ${meter.unit}` } },
    });
}

async function loadLive(days: string) {
    liveDays = days;
    document.querySelectorAll('[data-live]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.live === days));
    const readings = ((await getJson(`/api/meters/${meterId}/readings?days=${days}`)) as { at: number; value: number | null }[]).filter(
        (r) => r.value !== null,
    );
    const el = byId('live-chart');
    if (!readings.length) {
        el.innerHTML = emptyState('gauge-off', 'No readings in this window', '');
        return;
    }
    el.innerHTML = '';
    draw('live', el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'area', height: 260 },
        series: [{ name: 'Meter', data: readings.map((r) => [r.at, r.value]) }],
        colors: [tone('pumpkin')],
        fill: { type: 'solid', opacity: 0.12 },
        stroke: { curve: 'stepline', width: 2 },
        xaxis: { type: 'datetime', labels: { datetimeUTC: false }, tooltip: { enabled: false } },
        yaxis: { labels: { formatter: (v: number) => fmt(v, 1) }, tickAmount: 4 },
        tooltip: { ...baseOptions().tooltip, x: { format: 'dd MMM HH:mm' }, y: { formatter: (v: number) => `${fmt(v, 1)} ${meter.unit}` } },
    });
    const first = readings[0];
    const last = readings[readings.length - 1];
    byId('live-note').textContent = `${readings.length} readings · ${fmt((last.value as number) - (first.value as number), 1)} ${meter.unit} in this window`;
}

/* ----------------------------------------------------------------------- */

async function load(first = false) {
    try {
        meter = await getJson(`/api/meters/${meterId}`);
    } catch {
        byId('container').innerHTML = errorAlert('This meter does not exist (any more).');
        return;
    }
    if (first) layout();
    renderTop();
    await Promise.all([loadPeriod(period), loadLive(liveDays)]);
}

window.addEventListener('themechange', () => {
    if (meter) load();
});

// on (re)connect, and each time the server stored a new reading of this meter
socket.on('connect', () => load(!meter));
socket.on('meterUpdate', (id: string) => {
    if (id === meterId && meter) load();
});
// "read … ago" keeps counting between readings
window.setInterval(() => {
    if (!document.hidden && meter) renderTop();
}, 60_000);
