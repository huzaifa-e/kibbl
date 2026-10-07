import './main';
import ApexCharts from 'apexcharts';
import {
    fanModes,
    lampColors,
    type AirEvent,
    type AirReading,
    type DeviceSummary,
    type DeviceTelemetry,
    type LampColor,
    type SmokeDay,
} from '../../../shared/protocol';
import { climateHints, type HintLevel, type Weather } from '../../../shared/climate';
import { baseOptions } from './activityCharts';
import { levelColors } from './controls';
import { tone } from './healthCharts';
import { request, socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml, formatDuration, successAlert, timeAgo } from './utils';

/* A kibbl. air (the Conny CO2 traffic light): the air now and over time, the cigarettes
 * and windows it detected, and everything it can be set to. The live state comes with
 * the telemetry every 10 s, the history from /api/air. */

type Range = '24' | '168' | '720';
const RANGES: Record<Range, string> = { '24': '24 hours', '168': '7 days', '720': '30 days' };

const LAMP_PRESETS = [
    { mode: 'traffic', icon: 'traffic-lights', label: 'Air light', colors: ['green'] },
    { mode: 'white', icon: 'sun', label: 'White', colors: ['white'] },
    { mode: 'warm', icon: 'bulb', label: 'Warm', colors: ['white', 'yellow'] },
    { mode: 'candle', icon: 'flame', label: 'Candle', colors: ['yellow', 'red'] },
    { mode: 'off', icon: 'bulb-off', label: 'Off', colors: [] },
];
const COLOR_CSS: Record<LampColor, string> = { red: '#e03131', green: '#2f9e44', yellow: '#f59f00', white: '#f1ece2' };
const COLOR_LABELS: Record<LampColor, string> = { red: 'Red', green: 'Green', yellow: 'Amber', white: 'White' };
// how big a puff has to be: a lower rise finds more cigarettes and more false ones
const SENSITIVITY = [
    { label: 'High', rise: 100 },
    { label: 'Medium', rise: 150 },
    { label: 'Low', rise: 250 },
];
const FAN_LABELS: Record<string, string> = { off: 'Off', on: 'Always on', pulse: 'On and off in turn', auto: 'From yellow on' };

let devices: DeviceSummary[] = [];
let device: DeviceSummary | undefined;
let range: Range = '24';
let events: AirEvent[] = [];
let weather: Weather | null = null;
const charts: Record<string, ApexCharts | undefined> = {};

const pathId = window.location.pathname.split('/')[2] ?? '';

async function getJson(url: string) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('not logged in');
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

function draw(name: string, el: HTMLElement, options: Record<string, unknown>) {
    charts[name]?.destroy();
    const chart = new ApexCharts(el, options);
    chart.render();
    charts[name] = chart;
}

async function command(cmd: Record<string, unknown>) {
    const resp = await request<{ ok: boolean; error?: string }>('deviceCommand', device!._id, cmd);
    byId('air-result').innerHTML = resp.ok ? '' : errorAlert(resp.error ?? 'The device did not take it.');
    return resp;
}

/* ----------------------------------------------------------------------- */

function layout() {
    const d = device!;
    byId('page-pretitle').textContent = 'kibbl. air';
    byId('page-title').textContent = d.name;
    const switcher =
        devices.length > 1
            ? `<select class="form-select form-select-sm w-auto" id="air-switch">${devices
                  .map((x) => `<option value="${x._id}" ${x._id === d._id ? 'selected' : ''}>${escapeHtml(x.name)}</option>`)
                  .join('')}</select>`
            : '';
    byId('page-actions').innerHTML = `${switcher}<button class="btn btn-sm" id="air-blink"><i class="ti ti-bulb me-1"></i> Find it</button>`;

    const rangeButtons = (Object.keys(RANGES) as Range[]).map((r) => `<button class="btn btn-sm" data-range="${r}">${RANGES[r]}</button>`).join('');
    byId('container').innerHTML = `
        <div id="air-alerts"></div>
        <div id="air-result"></div>
        <div class="row row-cards mb-3" id="air-tiles"></div>
        <div class="row row-cards">
            <div class="col-lg-8">
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Room climate and health</h3><div class="card-actions text-secondary small" id="climate-outdoor"></div></div>
                    <div class="list-group list-group-flush" id="climate-hints"></div>
                </div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">CO₂</h3><div class="card-actions"><div class="btn-group">${rangeButtons}</div></div></div>
                    <div class="card-body"><div id="co2-chart"></div></div>
                </div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Temperature and humidity</h3></div>
                    <div class="card-body"><div id="climate-chart"></div></div>
                </div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Cigarettes</h3><div class="card-actions text-secondary small">last 30 days</div></div>
                    <div class="card-body">
                        <div id="smoke-chart"></div>
                        <div class="text-secondary small mt-2">Logged: a press of the button on the device. Detected: found in the CO₂ of exhaled smoke, only within 1–2 m of the device and rough; one that was also logged counts once.</div>
                    </div>
                </div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">What it noticed</h3><div class="card-actions text-secondary small">last 7 days</div></div>
                    <div class="list-group list-group-flush" id="air-events"></div>
                </div>
            </div>
            <div class="col-lg-4" id="air-settings"></div>
        </div>`;

    byId('page-actions')
        .querySelector('#air-switch')
        ?.addEventListener('change', (e) => {
            window.location.href = `/air/${(e.target as HTMLSelectElement).value}`;
        });
    byId('air-blink').addEventListener('click', () => void command({ cmd: 'blink', count: 5 }));
    document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) => b.addEventListener('click', () => loadReadings(b.dataset.range as Range)));
    bindSettings();
}

/* ----------------------------------------------------------------------- */

function tile(icon: string, color: string, label: string, value: string, unit: string, sub: string) {
    return `<div class="col-6 col-xl"><div class="card h-100"><div class="card-body">
        <div class="d-flex align-items-center gap-2 mb-1"><i class="ti ti-${icon}" style="color:${color}"></i><span class="text-secondary small">${label}</span></div>
        <div class="d-flex align-items-baseline gap-2"><span class="stat-value">${value}</span><span class="text-secondary">${unit}</span></div>
        <div class="text-secondary small">${sub}</div>
    </div></div></div>`;
}

let smokeToday: SmokeDay | undefined;

function renderTiles() {
    const d = device!;
    const s = d.online ? d.air?.state : undefined;
    const settings = d.air?.settings;
    // while a calibration runs the device does not watch the window, whatever an older firmware reports
    const windowState = s ? (s.calibrating ? 'paused' : s.window) : undefined;
    const levelText: Record<string, string> = { green: 'fresh', yellow: 'time to air', red: 'air now', none: 'measuring' };
    byId('air-tiles').innerHTML =
        tile(
            'wind',
            s ? levelColors[s.level] : 'var(--tblr-secondary)',
            'CO₂',
            s?.co2 !== undefined ? String(s.co2) : '–',
            'ppm',
            s ? `${levelText[s.level]}${settings ? ` · yellow ${settings.yellow}, red ${settings.red}` : ''}` : d.online ? 'no reading yet' : 'offline',
        ) +
        tile(
            'temperature',
            tone('pumpkin'),
            'Temperature',
            s?.temperature !== undefined ? s.temperature.toFixed(1) : '–',
            '°C',
            weather ? `outside ${weather.temperature.toFixed(1)} °C` : 'inside',
        ) +
        tile(
            'droplet',
            tone('pine'),
            'Humidity',
            s?.humidity !== undefined ? String(Math.round(s.humidity)) : '–',
            '%',
            weather ? `outside ${Math.round(weather.humidity)} %` : 'relative',
        ) +
        tile(
            'smoking',
            tone('bark'),
            'Cigarettes today',
            smokeToday ? String(smokeToday.count) : '–',
            '',
            smokeToday ? `${smokeToday.button} logged · ${smokeToday.auto} detected${s?.puffs ? ` · ${s.puffs} puffs now` : ''}` : '',
        ) +
        tile(
            'window',
            windowState === 'open' ? 'var(--tblr-orange)' : windowState === 'paused' ? 'var(--tblr-secondary)' : tone('olive'),
            'Window',
            windowState ?? '–',
            '',
            s?.calibrating
                ? 'detection paused while calibrating'
                : windowState === 'paused'
                  ? 'detection paused while it settles'
                  : s?.night
                    ? '<i class="ti ti-moon"></i> night mode'
                    : '',
        );

    const alerts: string[] = [];
    const fire = events.find((e) => e.kind === 'fire' && Date.now() - e.at < 24 * 3600_000);
    if (s?.fire) {
        alerts.push(`<div class="alert alert-danger"><div class="d-flex gap-2"><i class="ti ti-flame fs-2"></i><div>
            <h4 class="alert-title">Fire alarm sounding now</h4>
            <div>${escapeHtml(d.name)} sees the air change as in a fire. Check the room; a press of its button silences it.</div>
        </div></div></div>`);
    } else if (fire) {
        alerts.push(`<div class="alert alert-danger"><div class="d-flex gap-2"><i class="ti ti-flame fs-2"></i><div>
            <h4 class="alert-title">Possible fire, ${timeAgo(fire.at)}</h4>
            <div>The air changed as in a fire${fire.co2Rise ? `: CO₂ up ${fire.co2Rise} ppm` : ''}${fire.temperatureRise ? `, temperature up ${fire.temperatureRise} °C` : ''}. This is a warning in addition to a smoke alarm, not one.</div>
        </div></div></div>`);
    }
    if (d.air?.sensorError) alerts.push(errorAlert(`The CO₂ sensor does not answer: ${escapeHtml(d.air.sensorError)}`));
    if (!d.online)
        alerts.push(
            `<div class="alert alert-secondary">${escapeHtml(d.name)} is offline${d.lastSeen ? ` since ${timeAgo(d.lastSeen)}` : ''}. It keeps measuring and showing the air by itself; what it detects in the meantime arrives when it is back.</div>`,
        );
    byId('air-alerts').innerHTML = alerts.join('');
    renderClimate();
}

const HINT_COLORS: Record<HintLevel, string> = { alert: 'var(--tblr-red)', warn: 'var(--tblr-orange)', info: 'var(--tblr-azure)', good: 'var(--tblr-green)' };

function renderClimate() {
    const s = device!.online ? device!.air?.state : undefined;
    byId('climate-outdoor').innerHTML = weather
        ? `<i class="ti ti-cloud"></i> outside ${weather.temperature.toFixed(1)} °C · ${Math.round(weather.humidity)} %`
        : '<a href="/settings">set the home location</a> for the weather outside';
    const hints = s ? climateHints(s, weather) : [];
    byId('climate-hints').innerHTML = hints.length
        ? hints
              .map(
                  (h) => `<div class="list-group-item"><div class="d-flex gap-3 align-items-start">
                    <i class="ti ti-${h.icon} fs-2" style="color:${HINT_COLORS[h.level]}"></i>
                    <div><div class="fw-bold">${escapeHtml(h.title)}</div><div class="text-secondary small">${escapeHtml(h.text)}</div></div></div></div>`,
              )
              .join('') +
          `<div class="list-group-item text-secondary small">General guidance after the WHO, the German Environment Agency and DIN 4108-2, no medical advice.</div>`
        : `<div class="card-body text-secondary">Shown once the device measures.</div>`;
}

async function loadWeather() {
    weather = (await getJson('/api/weather').catch(() => null)) as Weather | null;
}

/* ----------------------------------------------------------------------- */

async function loadReadings(r: Range) {
    range = r;
    document.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.range === r));
    const readings = (await getJson(`/api/air/${device!._id}/readings?hours=${r}`)) as AirReading[];
    const co2El = byId('co2-chart');
    const climateEl = byId('climate-chart');
    if (!readings.length) {
        charts.co2?.destroy();
        charts.climate?.destroy();
        co2El.innerHTML = emptyState('chart-line', 'No readings yet', 'A minute is stored for every minute the device is online.');
        climateEl.innerHTML = '';
        return;
    }
    co2El.innerHTML = '';
    climateEl.innerHTML = '';
    const settings = device!.air?.settings;
    const line = (y: number, color: string, text: string) => ({
        y,
        borderColor: color,
        strokeDashArray: 4,
        label: { text, borderColor: 'transparent', style: { background: 'transparent', color } },
    });
    draw('co2', co2El, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'area', height: 280 },
        series: [{ name: 'CO₂', data: readings.map((x) => [x.at, x.co2]) }],
        colors: [tone('pumpkin')],
        fill: { type: 'solid', opacity: 0.12 },
        stroke: { curve: 'smooth', width: 2 },
        annotations: settings ? { yaxis: [line(settings.yellow, '#f59f00', 'yellow'), line(settings.red, '#e03131', 'red')] } : undefined,
        xaxis: { type: 'datetime', labels: { datetimeUTC: false }, tooltip: { enabled: false } },
        yaxis: { min: 400, labels: { formatter: (v: number) => String(Math.round(v)) }, tickAmount: 4 },
        tooltip: { ...baseOptions().tooltip, x: { format: 'dd MMM HH:mm' }, y: { formatter: (v: number) => `${v} ppm` } },
    });
    draw('climate', climateEl, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'line', height: 220 },
        series: [
            { name: 'Temperature', data: readings.map((x) => [x.at, x.temperature]) },
            { name: 'Humidity', data: readings.map((x) => [x.at, x.humidity]) },
        ],
        colors: [tone('rust'), tone('pine')],
        stroke: { curve: 'smooth', width: 2 },
        xaxis: { type: 'datetime', labels: { datetimeUTC: false }, tooltip: { enabled: false } },
        yaxis: [
            { seriesName: 'Temperature', labels: { formatter: (v: number) => `${v.toFixed(1)} °C` }, tickAmount: 4 },
            { seriesName: 'Humidity', opposite: true, labels: { formatter: (v: number) => `${Math.round(v)} %` }, tickAmount: 4 },
        ],
        legend: { position: 'top', horizontalAlign: 'left' },
        tooltip: { ...baseOptions().tooltip, x: { format: 'dd MMM HH:mm' } },
    });
}

async function loadSmoke() {
    const days = (await getJson(`/api/air/${device!._id}/smoke?days=30`)) as SmokeDay[];
    smokeToday = days[days.length - 1];
    const el = byId('smoke-chart');
    el.innerHTML = '';
    const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
    draw('smoke', el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: 220, stacked: true },
        series: [
            { name: 'Logged', data: days.map((x) => ({ x: label(x.day), y: x.button })) },
            { name: 'Detected', data: days.map((x) => ({ x: label(x.day), y: x.auto })) },
        ],
        colors: [tone('bark'), tone('mustard')],
        plotOptions: { bar: { columnWidth: '70%', borderRadius: 2 } },
        xaxis: {
            type: 'category',
            labels: { rotate: 0, hideOverlappingLabels: true },
            tickAmount: 10,
            axisBorder: { show: false },
            axisTicks: { show: false },
        },
        yaxis: { min: 0, forceNiceScale: true, labels: { formatter: (v: number) => String(Math.round(v)) } },
        legend: { position: 'top', horizontalAlign: 'left' },
    });
}

function eventHtml(e: AirEvent) {
    const when = `<div class="text-secondary small">${new Date(e.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${timeAgo(e.at)}</div>`;
    let icon = 'smoking';
    let color: string = tone('bark');
    let text = '';
    if (e.kind === 'fire') {
        icon = 'flame';
        color = 'var(--tblr-red)';
        text = `<b>Possible fire</b>${e.co2Rise ? ` · CO₂ +${e.co2Rise} ppm` : ''}${e.temperatureRise ? ` · +${e.temperatureRise} °C` : ''}`;
    } else if (e.kind === 'window') {
        icon = 'window';
        color = e.state === 'open' ? 'var(--tblr-orange)' : tone('olive');
        text =
            e.state === 'open'
                ? `<b>Window opened</b> · CO₂ ${e.co2Before} → ${e.co2} ppm${e.temperatureChange ? ` · ${e.temperatureChange > 0 ? '+' : ''}${e.temperatureChange} °C` : ''}`
                : `<b>Window closed</b>${e.openSeconds ? ` after ${formatDuration(e.openSeconds)}` : ''}`;
    } else if (e.source === 'button') {
        text = '<b>Cigarette logged</b> with the button';
    } else {
        text = `<b>Cigarette detected</b> · ${e.puffs} puffs${e.durationSeconds ? ` in ${formatDuration(e.durationSeconds)}` : ''}${e.button ? ' · also logged' : ''}`;
    }
    return `<div class="list-group-item"><div class="d-flex gap-3 align-items-center">
        <i class="ti ti-${icon} fs-2" style="color:${color}"></i><div>${text}${when}</div></div></div>`;
}

async function loadEvents() {
    events = (await getJson(`/api/air/${device!._id}/events?days=7`)) as AirEvent[];
    byId('air-events').innerHTML = events.length
        ? events.slice(0, 50).map(eventHtml).join('')
        : `<div class="card-body">${emptyState('mood-smile', 'Nothing yet', 'Cigarettes, open windows and fire alerts show up here.')}</div>`;
}

/* ----------------------------------------------------------------------- */

const hourOptions = (selected: number) =>
    Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === selected ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

function renderSettings() {
    const d = device!;
    const off = d.online ? '' : 'disabled';
    const lamp = d.air?.lamp;
    const s = d.air?.settings;
    const fan = d.air?.fan;
    const schedule = d.air?.schedule ?? { enabled: false, from: 22, to: 7 };
    const night = d.air?.state?.night ?? false;
    const sensitivity = SENSITIVITY.reduce((best, x) => (Math.abs(x.rise - (s?.puffRise ?? 150)) < Math.abs(best.rise - (s?.puffRise ?? 150)) ? x : best));

    const presets = LAMP_PRESETS.map(
        (p) => `<button class="btn lamp-preset ${lamp?.mode === p.mode ? 'active' : ''}" data-lamp="${p.mode}" ${off} title="${p.label}">
            <span class="lamp-swatch" style="background:${p.colors.length ? `linear-gradient(135deg, ${p.colors.map((c) => COLOR_CSS[c as LampColor]).join(', ')})` : 'transparent'}"></span>
            <span class="small">${p.label}</span></button>`,
    ).join('');
    const colorChips = lampColors
        .map(
            (c) => `<label class="form-selectgroup-item flex-fill">
                <input type="checkbox" class="form-selectgroup-input" data-lamp-color="${c}" ${lamp?.mode === 'custom' && lamp.colors.includes(c) ? 'checked' : ''} ${off} />
                <span class="form-selectgroup-label d-flex align-items-center gap-2"><span class="lamp-dot" style="background:${COLOR_CSS[c]}"></span>${COLOR_LABELS[c]}</span>
            </label>`,
        )
        .join('');

    byId('air-settings').innerHTML = `
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-bulb me-1"></i> Light</h3></div>
            <div class="card-body">
                <div class="lamp-presets mb-3">${presets}</div>
                <div class="form-label">Own colours</div>
                <div class="form-selectgroup form-selectgroup-boxes d-flex flex-wrap mb-2">${colorChips}</div>
                <div class="text-secondary small mb-3">Four fixed colours, each on or off: they mix, they do not dim.</div>
                <label class="form-check form-switch mb-0">
                    <input class="form-check-input" type="checkbox" id="lamp-fade" ${lamp?.fade !== false ? 'checked' : ''} ${off} />
                    <span class="form-check-label">Fade between looks</span>
                </label>
            </div>
        </div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-moon me-1"></i> Night</h3></div>
            <div class="card-body">
                <label class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" id="night-now" ${night ? 'checked' : ''} ${off} />
                    <span class="form-check-label">Night mode now: light off, no sound</span>
                </label>
                <label class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" id="night-enabled" ${schedule.enabled ? 'checked' : ''} />
                    <span class="form-check-label">Every night</span>
                </label>
                <div class="d-flex gap-2 align-items-center mb-3">
                    <select class="form-select" id="night-from">${hourOptions(schedule.from)}</select>
                    <span class="text-secondary">to</span>
                    <select class="form-select" id="night-to">${hourOptions(schedule.to)}</select>
                </div>
                <label class="form-label d-flex"><span class="flex-fill">Fan at night, at most</span><span class="text-secondary" id="night-fan-value">${s?.nightFan ?? 100} %</span></label>
                <input type="range" class="form-range" min="0" max="100" step="10" id="night-fan" value="${s?.nightFan ?? 100}" ${off} />
                <div class="text-secondary small">A fire alert sounds also at night.</div>
            </div>
        </div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-adjustments me-1"></i> Air light and sound</h3></div>
            <div class="card-body">
                <div class="row g-2 mb-2">
                    <div class="col-6"><label class="form-label">Yellow from</label><div class="input-group input-group-flat"><input type="number" class="form-control" id="th-yellow" min="400" max="5000" step="50" value="${s?.yellow ?? 1000}" ${off} /><span class="input-group-text">ppm</span></div></div>
                    <div class="col-6"><label class="form-label">Red from</label><div class="input-group input-group-flat"><input type="number" class="form-control" id="th-red" min="400" max="10000" step="50" value="${s?.red ?? 2000}" ${off} /><span class="input-group-text">ppm</span></div></div>
                </div>
                <button class="btn btn-sm mb-3" id="th-save" ${off}>Save thresholds</button>
                <label class="form-check form-switch mb-0">
                    <input class="form-check-input" type="checkbox" id="buzzer" ${s?.buzzer ? 'checked' : ''} ${off} />
                    <span class="form-check-label">Beep when it turns yellow or red</span>
                </label>
            </div>
        </div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-propeller me-1"></i> Fan</h3></div>
            <div class="card-body">
                <select class="form-select mb-3" id="fan-mode" ${off}>${fanModes.map((m) => `<option value="${m}" ${fan?.mode === m ? 'selected' : ''}>${FAN_LABELS[m]}</option>`).join('')}</select>
                <label class="form-label d-flex"><span class="flex-fill">Speed</span><span class="text-secondary" id="fan-level-value">${fan?.level ?? 100} %</span></label>
                <input type="range" class="form-range mb-2" min="10" max="100" step="10" id="fan-level" value="${fan?.level ?? 100}" ${off} />
                <div class="row g-2 ${fan?.mode === 'pulse' ? '' : 'd-none'}" id="fan-pulse">
                    <div class="col-6"><label class="form-label">On</label><div class="input-group input-group-flat"><input type="number" class="form-control" id="fan-on" min="1" max="3600" value="${fan?.onSeconds ?? 60}" ${off} /><span class="input-group-text">s</span></div></div>
                    <div class="col-6"><label class="form-label">Off</label><div class="input-group input-group-flat"><input type="number" class="form-control" id="fan-off" min="1" max="3600" value="${fan?.offSeconds ?? 240}" ${off} /><span class="input-group-text">s</span></div></div>
                </div>
                <div class="text-secondary small mt-2">The fan draws room air past the sensor and keeps the device cool, the measurement is best with it on.</div>
            </div>
        </div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-radar me-1"></i> Detection</h3></div>
            <div class="card-body">
                <label class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" id="smoke" ${s?.smoke !== false ? 'checked' : ''} ${off} />
                    <span class="form-check-label">Find cigarettes in the CO₂</span>
                </label>
                <label class="form-label">Sensitivity</label>
                <div class="btn-group w-100 mb-3">${SENSITIVITY.map((x) => `<button class="btn btn-sm ${x === sensitivity ? 'active' : ''}" data-rise="${x.rise}" ${off}>${x.label}</button>`).join('')}</div>
                <div class="text-secondary small">Open windows are always detected; you get an alert as soon as one opens. A fire alert comes when CO₂ and temperature rise as in a fire: in addition to a smoke alarm, never instead of one.</div>
            </div>
        </div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title"><i class="ti ti-target me-1"></i> Calibration</h3></div>
            <div class="card-body">
                <div class="text-secondary small mb-2">Put the device outside or at a wide open window, start, and leave it there for 6 minutes while the light blinks white: it then takes the fresh air as 420 ppm. Cigarette, window and fire-rise detection pause meanwhile and for 15 minutes after, while it is carried back.</div>
                <button class="btn w-100" id="calibrate" ${off || (d.air?.state?.calibrating ? 'disabled' : '')}>${d.air?.state?.calibrating ? 'Calibrating…' : 'Calibrate in fresh air'}</button>
                <label class="form-check form-switch mt-3 mb-0">
                    <input class="form-check-input" type="checkbox" id="asc" ${s?.asc ? 'checked' : ''} ${off} />
                    <span class="form-check-label">Calibrate itself (needs fresh air every day)</span>
                </label>
            </div>
        </div>`;
}

function bindSettings() {
    const root = byId('air-settings');
    const airConfig = (fields: Record<string, unknown>) => command({ cmd: 'air_config', ...fields });

    root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
        if (!el || el.disabled) return;
        if (el.dataset.lamp) {
            await command({ cmd: 'lamp', mode: el.dataset.lamp });
        } else if (el.dataset.rise) {
            await airConfig({ puffRise: Number(el.dataset.rise) });
        } else if (el.id === 'th-save') {
            const yellow = Number((byId('th-yellow') as HTMLInputElement).value);
            const red = Number((byId('th-red') as HTMLInputElement).value);
            if (!(red > yellow)) {
                byId('air-result').innerHTML = errorAlert('Red has to be above yellow.');
                return;
            }
            if ((await airConfig({ yellow, red })).ok) byId('air-result').innerHTML = successAlert('Thresholds saved on the device.');
        } else if (el.id === 'calibrate') {
            if (!confirm('Is the device outside or at a wide open window now? It takes the air of the next 6 minutes as 420 ppm.')) return;
            const resp = await command({ cmd: 'calibrate', ppm: 420 });
            if (resp.ok) byId('air-result').innerHTML = successAlert('Calibration started: leave it in the fresh air until the white blinking stops.');
        }
    });

    root.addEventListener('input', (e) => {
        const el = e.target as HTMLInputElement;
        if (el.id === 'night-fan') byId('night-fan-value').textContent = `${el.value} %`;
        if (el.id === 'fan-level') byId('fan-level-value').textContent = `${el.value} %`;
    });

    root.addEventListener('change', async (e) => {
        const el = e.target as HTMLInputElement;
        if (el.dataset.lampColor) {
            const colors = [...root.querySelectorAll<HTMLInputElement>('[data-lamp-color]:checked')].map((x) => x.dataset.lampColor);
            await command({ cmd: 'lamp', mode: 'custom', colors });
        } else if (el.id === 'lamp-fade') {
            await command({ cmd: 'lamp', fade: el.checked });
        } else if (el.id === 'night-now') {
            await command({ cmd: 'night', on: el.checked });
        } else if (['night-enabled', 'night-from', 'night-to'].includes(el.id)) {
            const resp = await request<{ ok: boolean; error?: string }>('setNightSchedule', device!._id, {
                enabled: (byId('night-enabled') as HTMLInputElement).checked,
                from: Number((byId('night-from') as HTMLSelectElement).value),
                to: Number((byId('night-to') as HTMLSelectElement).value),
            });
            byId('air-result').innerHTML = resp.ok ? '' : errorAlert(resp.error ?? 'Not saved.');
        } else if (el.id === 'night-fan') {
            await airConfig({ nightFan: Number(el.value) });
        } else if (el.id === 'buzzer' || el.id === 'smoke' || el.id === 'asc') {
            await airConfig({ [el.id]: el.checked });
        } else if (el.id === 'fan-mode') {
            byId('fan-pulse').classList.toggle('d-none', el.value !== 'pulse');
            await command({ cmd: 'fan', mode: el.value });
        } else if (el.id === 'fan-level') {
            await command({ cmd: 'fan', level: Number(el.value) });
        } else if (el.id === 'fan-on' || el.id === 'fan-off') {
            await command({
                cmd: 'fan',
                onSeconds: Number((byId('fan-on') as HTMLInputElement).value),
                offSeconds: Number((byId('fan-off') as HTMLInputElement).value),
            });
        }
    });
}

/* ----------------------------------------------------------------------- */

async function load() {
    devices = (await request<DeviceSummary[]>('getDevices')).filter((d) => d.status === 'approved' && d.caps.includes('air'));
    device = devices.find((d) => d._id === pathId) ?? (pathId ? undefined : devices[0]);
    if (!device) {
        byId('page-title').textContent = 'Air';
        byId('container').innerHTML = pathId
            ? errorAlert('This device does not exist (any more).')
            : `<div class="card"><div class="card-body">${emptyState(
                  'wind',
                  'No kibbl. air yet',
                  'A kibbl. air shows the CO₂ of a room on its traffic light, counts cigarettes and notices open windows. Set one up under Devices.',
                  '<a href="/devices" class="btn btn-primary">Devices</a>',
              )}</div></div>`;
        return;
    }
    if (!pathId) window.history.replaceState(null, '', `/air/${device._id}`);
    layout();
    renderSettings();
    await Promise.all([loadReadings(range), loadSmoke(), loadEvents(), loadWeather()]);
    renderTiles();
}

window.addEventListener('themechange', () => {
    if (device) void Promise.all([loadReadings(range), loadSmoke()]);
});

socket.on('connect', () => void load());

socket.on('deviceUpdate', (d: DeviceSummary) => {
    if (d._id !== device?._id) return;
    const wasOnline = device.online;
    device = d;
    renderTiles();
    // the settings are redrawn only when they can have changed elsewhere, not under the cursor
    if (!root().contains(document.activeElement) || wasOnline !== d.online) renderSettings();
});

const root = () => byId('air-settings');

socket.on('telemetry', (deviceId: string, telemetry: DeviceTelemetry) => {
    if (deviceId !== device?._id || !device.air || !telemetry.air) return;
    device.air.state = telemetry.air;
    renderTiles();
});

socket.on('airEvent', (event: AirEvent) => {
    if (event.deviceId !== device?._id) return;
    events.unshift(event);
    void loadEvents();
    if (event.kind === 'smoke') void loadSmoke().then(renderTiles);
    else renderTiles();
});

// the weather outside every 15 minutes
window.setInterval(() => {
    if (device) void loadWeather().then(renderTiles);
}, 15 * 60_000);

// "… ago" keeps counting
window.setInterval(() => {
    if (!document.hidden && device) renderTiles();
}, 60_000);
