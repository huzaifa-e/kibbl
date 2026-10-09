import './main';
import ApexCharts from 'apexcharts';
import type { HeatMeter, HeatOverview, HeatReading, HeatUnit } from '../../../shared/heat';
import type { HomeRoom } from '../../../shared/heating';
import { baseOptions } from './activityCharts';
import { tone, type Tone } from './healthCharts';
import { insightsCard, loadInsights } from './heatInsights';
import { initReports, loadReports, reportsCard } from './heatReports';
import { socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml, localDayKey } from './utils';

/* The heat used in the home: the readings of the heat cost allocators on the radiators and
 * of meters of the whole home, entered here or from a Techem report, and the use per day,
 * month and year, spread between readings by tado's heating time and the weather
 * (backend/src/heat). tado's heating hours are drawn with it; reports are uploaded and
 * imported in heatReports.ts. */

type Period = 'day' | 'month' | 'year';
const PERIOD_LABELS: Record<Period, string> = { day: 'Days', month: 'Months', year: 'Years' };
const SHOWN_DAYS = 90;
const TONES: Tone[] = ['pumpkin', 'pine', 'mustard', 'plum', 'olive', 'rust', 'bark'];

let data: HeatOverview | undefined;
let rooms: HomeRoom[] = [];
let period: Period = 'month';
let hadEnergy = false;
let unit: HeatUnit | 'energy' | undefined; // energy: the radiators' units in kWh, by the latest report
let editing: string | undefined; // the meter whose form is open, 'new' for a new one
let opened: string | undefined; // the meter whose readings are shown
let chart: ApexCharts | undefined;

const fmt = (v: number | null | undefined, digits = 1) =>
    typeof v === 'number' ? v.toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';
const ago = (days: number) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);
const roomName = (id?: string) => rooms.find((r) => r._id === id)?.name;
const meterTone = (m: HeatMeter) => tone(TONES[(data?.meters.indexOf(m) ?? 0) % TONES.length]);

async function api<T>(url: string, init?: RequestInit & { body?: string }): Promise<T> {
    const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('not logged in');
    }
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res.json() as Promise<T>;
}

function dayLabel(key: string) {
    if (key.length === 4) return key;
    if (key.length === 7) return new Date(`${key}-15T12:00:00`).toLocaleDateString([], { month: 'short', year: '2-digit' });
    return new Date(`${key}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/* ----------------------------------------------------------------------- */

function layout() {
    const buttons = (Object.keys(PERIOD_LABELS) as Period[]).map((p) => `<button class="btn btn-sm" data-period="${p}">${PERIOD_LABELS[p]}</button>`).join('');
    byId('container').innerHTML = `
        <div id="heat-error"></div>
        <div class="row row-cards mb-3" id="tiles"></div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">Heat used</h3>
                <div class="card-actions d-flex gap-2"><div class="btn-group" id="unit-buttons"></div><div class="btn-group">${buttons}</div></div></div>
            <div class="card-body"><div id="use-chart"></div><div class="text-secondary small mt-2" id="use-note"></div></div>
        </div>
        ${insightsCard()}
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">Enter readings</h3></div>
            <div class="card-body" id="entry"></div>
        </div>
        <div class="card mb-3">
            <div class="card-header"><h3 class="card-title">Heat meters</h3>
                <div class="card-actions"><button class="btn btn-sm btn-primary" id="add-meter"><i class="ti ti-plus me-1"></i>Add</button></div></div>
            <div id="meters"></div>
        </div>
        ${reportsCard()}`;
    document.querySelectorAll<HTMLButtonElement>('[data-period]').forEach((b) =>
        b.addEventListener('click', () => {
            period = b.dataset.period as Period;
            renderChart();
        }),
    );
    initReports({ rooms: () => rooms, meters: () => data?.meters ?? [] });
    byId('add-meter').addEventListener('click', () => {
        editing = 'new';
        renderMeters();
    });
}

// the meters counted in this unit, the ones the chart and the tiles add up
const shownMeters = () => (data?.meters ?? []).filter((m) => m.unit === (unit === 'energy' ? 'units' : unit));
const scale = () => (unit === 'energy' ? (data?.energy?.kWhPerUnit ?? 1) : 1);
const unitLabel = () => (unit === 'energy' ? 'kWh' : (unit ?? ''));

function sumUse(from: string, to = '9999') {
    const ids = shownMeters().map((m) => m._id);
    let sum = 0;
    let any = false;
    for (const d of data!.days) {
        if (d.date < from || d.date > to) continue;
        for (const id of ids)
            if (d.use[id] !== undefined) {
                sum += d.use[id] * scale();
                any = true;
            }
    }
    return any ? sum : null;
}

function renderTiles() {
    const today = localDayKey(Date.now());
    const month = today.slice(0, 7);
    // the heating season: from the 1st of September
    const season = `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 9 ? 1 : 0)}-09-01`;
    const hours = data!.days.filter((d) => d.date >= `${month}-01`).reduce((s, d) => s + (d.heatingHours ?? 0), 0);
    const last = data!.meters
        .map((m) => m.latest?.date)
        .filter(Boolean)
        .sort()
        .pop();
    const tile = (icon: string, color: string, label: string, value: string, u: string, sub: string) =>
        `<div class="col-sm-6 col-xl-3"><div class="card h-100"><div class="card-body">
            <div class="d-flex align-items-center gap-2 mb-1"><i class="ti ti-${icon}" style="color:${color}"></i><span class="text-secondary small">${label}</span></div>
            <div class="d-flex align-items-baseline gap-2"><span class="stat-value">${value}</span><span class="text-secondary">${u}</span></div>
            <div class="text-secondary small">${sub}</div></div></div></div>`;
    const u = unitLabel();
    const e = data!.energy;
    const energyNote = unit === 'energy' && e ? ` · ${fmt(e.kWhPerUnit, 2)} kWh per unit (report ${e.to?.slice(0, 4) ?? ''})` : '';
    byId('tiles').innerHTML =
        tile('flame', tone('pumpkin'), 'This heating season', fmt(sumUse(season), 0), u, `since ${dayLabel(season)}, up to the last reading${energyNote}`) +
        tile('calendar', tone('mustard'), 'This month', fmt(sumUse(`${month}-01`), 1), u, 'up to the last reading') +
        tile('temperature', tone('pine'), 'tado heating', fmt(hours, 1), 'h', 'this month, at full power') +
        tile(
            'clipboard-list',
            tone('plum'),
            'Last reading',
            last ? dayLabel(last) : '–',
            '',
            last ? ago(Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000)) : 'none yet',
        );
}

function renderUnits() {
    const units: (HeatUnit | 'energy')[] = [...new Set(data!.meters.map((m) => m.unit))];
    if (data!.energy && units.includes('units')) units.unshift('energy');
    // kWh as soon as a report tells what a unit is worth
    if (!unit || !units.includes(unit) || (units[0] === 'energy' && !hadEnergy)) unit = units[0];
    hadEnergy = units[0] === 'energy';
    byId('unit-buttons').innerHTML =
        units.length > 1
            ? units
                  .map(
                      (u) =>
                          `<button class="btn btn-sm${u === unit ? ' active' : ''}" data-unit="${escapeHtml(u)}"${u === 'energy' ? ' title="The radiators\' units in kWh, by the latest report"' : ''}>${u === 'energy' ? 'kWh ≈' : escapeHtml(u)}</button>`,
                  )
                  .join('')
            : '';
    document.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) =>
        b.addEventListener('click', () => {
            unit = b.dataset.unit as HeatUnit | 'energy';
            render();
        }),
    );
}

function renderChart() {
    document.querySelectorAll('[data-period]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.period === period));
    const el = byId('use-chart');
    const meters = shownMeters();
    const len = period === 'day' ? 10 : period === 'month' ? 7 : 4;
    const days = period === 'day' ? data!.days.slice(-SHOWN_DAYS) : data!.days;
    const keys: string[] = [];
    const use = new Map<string, Map<string, number>>(); // meter -> period -> use
    const hours = new Map<string, number>();
    for (const d of days) {
        const key = d.date.slice(0, len);
        if (keys[keys.length - 1] !== key) keys.push(key);
        for (const m of meters) {
            if (d.use[m._id] === undefined) continue;
            if (!use.has(m._id)) use.set(m._id, new Map());
            use.get(m._id)!.set(key, (use.get(m._id)!.get(key) ?? 0) + d.use[m._id] * scale());
        }
        if (d.heatingHours !== undefined) hours.set(key, (hours.get(key) ?? 0) + d.heatingHours);
    }

    chart?.destroy();
    chart = undefined;
    if (!use.size && !hours.size) {
        el.innerHTML = emptyState(
            'flame-off',
            'Nothing to show yet',
            data!.meters.length
                ? 'Enter a second reading: the use is what a meter counted between two.'
                : 'Add the heat meters of your radiators, then enter their readings.',
        );
        byId('use-note').textContent = '';
        return;
    }
    el.innerHTML = '';
    const round = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100) / 100);
    const series = [
        ...meters.filter((m) => use.has(m._id)).map((m) => ({ name: m.name, type: 'bar', data: keys.map((k) => round(use.get(m._id)!.get(k))) })),
        ...(hours.size ? [{ name: 'tado heating', type: 'line', data: keys.map((k) => round(hours.get(k))) }] : []),
    ];
    const bars = series.filter((s) => s.type === 'bar').length;
    chart = new ApexCharts(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'line', stacked: true, height: 320, zoom: { enabled: false } },
        series,
        colors: [...meters.filter((m) => use.has(m._id)).map(meterTone), tone('bark')],
        labels: keys.map(dayLabel),
        plotOptions: { bar: { columnWidth: keys.length > 60 ? '90%' : '60%', borderRadius: 2 } },
        stroke: { width: series.map((s) => (s.type === 'line' ? 2 : 0)), curve: 'smooth' },
        markers: { size: 0 },
        legend: { show: series.length > 1, position: 'top', horizontalAlign: 'left' },
        xaxis: {
            type: 'category',
            labels: { rotate: 0, hideOverlappingLabels: true },
            tickAmount: Math.min(keys.length, el.clientWidth < 600 ? 4 : 12),
            axisTicks: { show: false },
        },
        yaxis: [
            ...series
                .filter((s) => s.type === 'bar')
                .map((_, i) => ({ show: i === 0, seriesName: series[0].name, min: 0, tickAmount: 4, labels: { formatter: (v: number) => fmt(v, 0) } })),
            ...(hours.size
                ? [{ opposite: true, seriesName: 'tado heating', min: 0, tickAmount: 4, labels: { formatter: (v: number) => `${fmt(v, 0)} h` } }]
                : []),
        ],
        tooltip: {
            ...baseOptions().tooltip,
            shared: true,
            intersect: false,
            y: {
                formatter: (v: number | null, o: { seriesIndex: number }) =>
                    v === null ? '–' : o.seriesIndex < bars ? `${fmt(v, 1)} ${unitLabel()}` : `${fmt(v, 1)} h`,
            },
        },
    });
    chart.render();

    const how = new Set(days.flatMap((d) => meters.map((m) => d.spread[m._id]).filter(Boolean)));
    const parts = [
        how.has('tado') ? "by tado's heating time in the radiator's room" : '',
        how.has('weather') ? 'by how cold it was outside' : '',
        how.has('even') ? `evenly${data!.location ? '' : ' (set the home location in Settings to spread by the weather)'}` : '',
    ].filter(Boolean);
    byId('use-note').textContent =
        (parts.length ? `Between two readings the use is spread ${parts.join(', else ')}. ` : '') +
        (hours.size ? 'tado heating: the hours its rooms heated, at full power (heating power × time).' : '');
}

/* ----------------------------------------------------------------------- */

function renderEntry() {
    const el = byId('entry');
    if (!data!.meters.length) {
        el.innerHTML = '<div class="text-secondary">Add a heat meter first.</div>';
        return;
    }
    el.innerHTML = `<form id="entry-form">
        <div class="row g-2 align-items-end mb-3"><div class="col-auto"><label class="form-label" for="entry-date">Read on</label>
            <input type="date" class="form-control" id="entry-date" value="${localDayKey(Date.now())}" max="${localDayKey(Date.now())}" required /></div>
            <div class="col text-secondary small">A heat cost allocator shows its count since the last reset date; enter it as shown. A lower value than before counts as a new start.</div></div>
        <div class="row g-2">${data!.meters
            .map(
                (m) => `<div class="col-sm-6 col-lg-4"><label class="form-label mb-1" for="entry-${m._id}">${escapeHtml(m.name)}
                    <span class="text-secondary small">${escapeHtml(roomName(m.roomId) ?? '')}</span></label>
                <div class="input-group"><input type="number" step="any" min="0" inputmode="decimal" class="form-control" id="entry-${m._id}" data-meter="${m._id}"
                    placeholder="${m.latest ? `${escapeHtml(m.latest.value)} on ${escapeHtml(dayLabel(m.latest.date))}` : 'no reading yet'}" />
                <span class="input-group-text">${escapeHtml(m.unit)}</span></div></div>`,
            )
            .join('')}</div>
        <div class="mt-3 d-flex align-items-center gap-3"><button class="btn btn-primary" type="submit">Save readings</button><span id="entry-status" class="small"></span></div>
    </form>`;
    byId('entry-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const values = [...document.querySelectorAll<HTMLInputElement>('[data-meter]')]
            .filter((i) => i.value.trim() !== '')
            .map((i) => ({ meterId: i.dataset.meter!, value: Number(i.value) }));
        const status = byId('entry-status');
        if (!values.length) {
            status.className = 'small text-warning';
            status.textContent = 'Enter at least one value.';
            return;
        }
        try {
            await api('/api/heat/readings', { method: 'POST', body: JSON.stringify({ date: byId<HTMLInputElement>('entry-date').value, values }) });
            status.className = 'small text-success';
            status.textContent = `${values.length} reading${values.length > 1 ? 's' : ''} saved.`;
        } catch (err) {
            status.className = 'small text-danger';
            status.textContent = (err as Error).message;
        }
    });
}

/* ----------------------------------------------------------------------- */

function meterForm(m?: HeatMeter) {
    const kind = m?.kind ?? 'radiator';
    const roomOptions = [
        '<option value="">No room</option>',
        ...rooms.map((r) => `<option value="${r._id}"${r._id === m?.roomId ? ' selected' : ''}>${escapeHtml(r.name)}</option>`),
    ].join('');
    return `<form class="card-body border-bottom" id="meter-form"><div class="row g-2 align-items-end">
        <div class="col-sm-6 col-lg-3"><label class="form-label">Name</label><input class="form-control" name="name" maxlength="60" required value="${escapeHtml(m?.name ?? '')}" placeholder="Living room, window" /></div>
        <div class="col-sm-6 col-lg-2"><label class="form-label">Kind</label><select class="form-select" name="kind"${m ? ' disabled' : ''}>
            <option value="radiator"${kind === 'radiator' ? ' selected' : ''}>Radiator (units)</option>
            <option value="meter"${kind === 'meter' ? ' selected' : ''}>Meter of the home</option></select></div>
        <div class="col-sm-4 col-lg-1" data-for="meter"><label class="form-label">Unit</label><select class="form-select" name="unit">
            ${(['kWh', 'MWh', 'm³'] as const).map((u) => `<option${m?.unit === u ? ' selected' : ''}>${u}</option>`).join('')}</select></div>
        <div class="col-sm-4 col-lg-1" data-for="radiator"><label class="form-label" title="What one unit counts for, from the Techem report">Factor</label>
            <input class="form-control" name="factor" type="number" step="any" min="0.01" max="100" value="${m?.factor ?? 1}" /></div>
        <div class="col-sm-4 col-lg-2"><label class="form-label">Room</label><select class="form-select" name="roomId">${roomOptions}</select></div>
        <div class="col-sm-6 col-lg-2"><label class="form-label">Device number</label><input class="form-control" name="serial" maxlength="40" value="${escapeHtml(m?.serial ?? '')}" /></div>
        <div class="col-auto"><button class="btn btn-primary" type="submit">${m ? 'Save' : 'Add'}</button> <button class="btn" type="button" id="meter-cancel">Cancel</button></div>
    </div><div id="meter-form-error" class="mt-2"></div></form>`;
}

function renderMeters() {
    const el = byId('meters');
    const list = data!.meters;
    const row = (m: HeatMeter) => `<tr>
        <td><span class="d-inline-block rounded-circle me-2" style="width:8px;height:8px;background:${meterTone(m)}"></span>${escapeHtml(m.name)}
            ${m.serial ? `<div class="text-secondary small">${escapeHtml(m.serial)}</div>` : ''}</td>
        <td class="text-secondary d-none d-md-table-cell">${m.kind === 'radiator' ? `Radiator${m.factor !== 1 ? ` × ${fmt(m.factor, 2)}` : ''}` : 'Meter of the home'}</td>
        <td class="text-secondary d-none d-md-table-cell">${escapeHtml(roomName(m.roomId) ?? '–')}</td>
        <td>${m.latest ? `${fmt(m.latest.value, 1)} ${escapeHtml(m.unit)} <span class="text-secondary small">${escapeHtml(dayLabel(m.latest.date))}</span>` : '<span class="text-secondary">–</span>'}</td>
        <td class="text-end text-nowrap">
            <button class="btn btn-sm btn-ghost-secondary" data-open="${m._id}">${m.readings} reading${m.readings === 1 ? '' : 's'}</button>
            <button class="btn btn-sm btn-ghost-secondary" data-edit="${m._id}" title="Edit"><i class="ti ti-pencil"></i></button>
            <button class="btn btn-sm btn-ghost-danger" data-remove="${m._id}" title="Remove"><i class="ti ti-trash"></i></button></td></tr>
        ${opened === m._id ? `<tr><td colspan="5" class="bg-body-tertiary" id="readings-${m._id}">Loading…</td></tr>` : ''}`;

    el.innerHTML =
        (editing === 'new' ? meterForm() : editing ? meterForm(list.find((m) => m._id === editing)) : '') +
        (list.length
            ? `<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>Name</th><th class="d-none d-md-table-cell">Kind</th><th class="d-none d-md-table-cell">Room</th><th>Last reading</th><th></th></tr></thead>
                <tbody>${list.map(row).join('')}</tbody></table></div>`
            : editing
              ? ''
              : `<div class="card-body">${emptyState('flame', 'No heat meters yet', 'Add the heat cost allocator of each radiator, or a meter of the whole home.')}</div>`);

    const form = document.getElementById('meter-form') as HTMLFormElement | null;
    if (form) {
        const kindSel = form.elements.namedItem('kind') as HTMLSelectElement;
        const showFor = () =>
            form.querySelectorAll<HTMLElement>('[data-for]').forEach((d) => (d.style.display = d.dataset.for === kindSel.value ? '' : 'none'));
        kindSel.addEventListener('change', showFor);
        showFor();
        byId('meter-cancel').addEventListener('click', () => {
            editing = undefined;
            renderMeters();
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const f = new FormData(form);
            const body: Record<string, unknown> = {
                name: f.get('name'),
                roomId: f.get('roomId') || null,
                serial: String(f.get('serial') ?? '').trim() || null,
            };
            const kind = editing === 'new' ? kindSel.value : list.find((m) => m._id === editing)?.kind;
            if (kind === 'radiator') body.factor = Number(f.get('factor')) || 1;
            else body.unit = f.get('unit');
            try {
                if (editing === 'new') await api('/api/heat/meters', { method: 'POST', body: JSON.stringify({ ...body, kind }) });
                else await api(`/api/heat/meters/${editing}`, { method: 'PATCH', body: JSON.stringify(body) });
                editing = undefined;
            } catch (err) {
                byId('meter-form-error').innerHTML = errorAlert((err as Error).message);
            }
        });
    }
    el.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) =>
        b.addEventListener('click', () => {
            editing = b.dataset.edit;
            renderMeters();
        }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
        b.addEventListener('click', async () => {
            const m = list.find((x) => x._id === b.dataset.remove);
            if (m && confirm(`Remove ${m.name} with its ${m.readings} readings?`)) await api(`/api/heat/meters/${m._id}`, { method: 'DELETE' });
        }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) =>
        b.addEventListener('click', () => {
            opened = opened === b.dataset.open ? undefined : b.dataset.open;
            renderMeters();
        }),
    );
    if (opened && list.some((m) => m._id === opened)) void renderReadings(list.find((m) => m._id === opened)!);
}

async function renderReadings(m: HeatMeter) {
    const rows = await api<HeatReading[]>(`/api/heat/meters/${m._id}/readings`);
    const el = document.getElementById(`readings-${m._id}`);
    if (!el) return;
    const source = { manual: 'entered', report: 'from a report', assistant: 'by the assistant' };
    el.innerHTML = rows.length
        ? `<div class="d-flex flex-wrap gap-2">${[...rows]
              .reverse()
              .map(
                  (
                      r,
                  ) => `<span class="badge bg-body text-body border py-2 px-2" title="${source[r.source]}">${escapeHtml(dayLabel(r.date))} ${r.date.slice(0, 4)} · ${fmt(r.value, 1)}
                    <button class="btn btn-sm btn-ghost-danger p-0 ms-1" data-drop="${r.date}" title="Remove"><i class="ti ti-x"></i></button></span>`,
              )
              .join('')}</div>`
        : '<span class="text-secondary">No readings yet.</span>';
    el.querySelectorAll<HTMLButtonElement>('[data-drop]').forEach((b) =>
        b.addEventListener('click', async () => {
            if (confirm(`Remove the reading of ${b.dataset.drop}?`)) await api(`/api/heat/meters/${m._id}/readings/${b.dataset.drop}`, { method: 'DELETE' });
        }),
    );
}

/* ----------------------------------------------------------------------- */

function render() {
    renderUnits();
    renderTiles();
    renderChart();
    renderMeters();
}

async function load(first = false) {
    try {
        [data, rooms] = await Promise.all([api<HeatOverview>('/api/heat'), api<HomeRoom[]>('/api/rooms')]);
    } catch (err) {
        byId('container').innerHTML = errorAlert(`The heat could not be loaded: ${(err as Error).message}`);
        return;
    }
    if (first) layout();
    else void loadReports();
    render();
    // the entry form keeps what is typed while the rest updates
    if (first || !document.getElementById('entry-form')?.contains(document.activeElement)) renderEntry();
}

// the findings: on opening and when the heat data changed, not with every tado read
function insights() {
    if (data) void loadInsights(rooms, (id) => meterTone(data!.meters.find((m) => m._id === id)!));
}

window.addEventListener('themechange', () => {
    if (data) render();
});
socket.on('connect', () => load(!data).then(insights));
// a reading or meter changed, here or through the assistant; tado read its rooms
socket.on('heatUpdate', () => data && load().then(insights));
socket.on('heatingUpdate', () => data && load());
