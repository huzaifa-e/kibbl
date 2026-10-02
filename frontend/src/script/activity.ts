import './main';
import type ApexCharts from 'apexcharts';
import type { ActivityBucket, DeviceSummary, MotionEvent } from '../../../shared/protocol';
import { heatmapChart, hourlyChart } from './activityCharts';
import { bindEventViewer, eventCardHtml, eventDuration } from './events';
import { request, socket } from './socket';
import { byId, emptyState, escapeHtml, formatDuration, localDayKey } from './utils';

const DAYS = 14;
const params = new URLSearchParams(window.location.search);

let devices: DeviceSummary[] = [];
let events: MotionEvent[] = [];
let buckets: ActivityBucket[] = [];
let selectedDevice = params.get('device') ?? '';
let selectedDay = params.get('day') ?? localDayKey(Date.now());
let heatmap: ApexCharts | undefined;
let hourly: ApexCharts | undefined;
let rendered = false;

function dayRange(day: string) {
    const from = new Date(`${day}T00:00:00`).getTime();
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to: to.getTime() };
}

function layout() {
    const cams = devices.filter((d) => d.status === 'approved' && d.caps.includes('camera'));
    byId('page-actions').innerHTML = `
        <div class="d-flex flex-wrap gap-2">
        <select class="form-select w-auto" id="device-select">
            <option value="">All cameras</option>
            ${cams.map((d) => `<option value="${d._id}" ${d._id === selectedDevice ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
        </select>
        <input type="date" class="form-control w-auto" id="day-select" value="${selectedDay}" max="${localDayKey(Date.now())}" />
        </div>`;

    byId('container').innerHTML = `
        <div class="row row-cards">
            <div class="col-12">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">When something moved, last ${DAYS} days</h3>
                        <div class="card-actions text-secondary small">click a row to see that day</div></div>
                    <div class="card-body"><div id="heatmap"></div></div>
                </div>
            </div>
            <div class="col-lg-4">
                <div class="card">
                    <div class="card-header"><h3 class="card-title" id="day-title"></h3></div>
                    <div class="card-body">
                        <div class="row mb-3" id="day-stats"></div>
                        <div id="hourly"></div>
                    </div>
                </div>
            </div>
            <div class="col-lg-8">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Timeline</h3></div>
                    <div class="card-body"><div class="row g-2" id="timeline"></div></div>
                </div>
            </div>
        </div>`;

    byId('device-select').addEventListener('change', (e) => {
        selectedDevice = (e.target as HTMLSelectElement).value;
        updateUrl();
        loadData();
    });
    byId('day-select').addEventListener('change', (e) => {
        const value = (e.target as HTMLInputElement).value;
        if (value) selectDay(value);
    });
    bindEventViewer(byId('timeline'), (id) => {
        const event = events.find((e) => e._id === id);
        return event ? { event, device: devices.find((d) => d._id === event.deviceId) } : undefined;
    });
    rendered = true;
}

function updateUrl() {
    const p = new URLSearchParams();
    if (selectedDevice) p.set('device', selectedDevice);
    if (selectedDay !== localDayKey(Date.now())) p.set('day', selectedDay);
    history.replaceState(null, '', `/activity${p.toString() ? `?${p}` : ''}`);
}

async function selectDay(day: string) {
    selectedDay = day;
    byId<HTMLInputElement>('day-select').value = day;
    updateUrl();
    await loadEvents();
    renderDay();
}

function renderDay() {
    const label = new Date(`${selectedDay}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    byId('day-title').textContent = label;
    const total = events.reduce((s, e) => s + eventDuration(e), 0);
    const busiest = (() => {
        const counts = new Array(24).fill(0);
        for (const e of events) counts[new Date(e.start).getHours()]++;
        const max = Math.max(...counts);
        return max > 0 ? `${String(counts.indexOf(max)).padStart(2, '0')}:00` : '–';
    })();
    byId('day-stats').innerHTML = `
        <div class="col-4"><div class="stat-value">${events.length}</div><div class="text-secondary small">events</div></div>
        <div class="col-4"><div class="stat-value">${events.length ? formatDuration(total) : '–'}</div><div class="text-secondary small">in motion</div></div>
        <div class="col-4"><div class="stat-value">${busiest}</div><div class="text-secondary small">busiest hour</div></div>`;

    hourly?.destroy();
    hourly = hourlyChart(byId('hourly'), buckets, selectedDay);

    const name = (id: string) => (selectedDevice ? undefined : devices.find((d) => d._id === id)?.name);
    byId('timeline').innerHTML = events.length
        ? events.map((e) => eventCardHtml(e, name(e.deviceId))).join('')
        : `<div class="col-12">${emptyState('moon', 'Nothing moved', 'No motion was recorded on this day.')}</div>`;
}

function renderHeatmap() {
    heatmap?.destroy();
    heatmap = heatmapChart(byId('heatmap'), buckets, DAYS, (day) => selectDay(day));
}

async function loadEvents() {
    const { from, to } = dayRange(selectedDay);
    events = await request<MotionEvent[]>('getEvents', { deviceId: selectedDevice || undefined, from, to, limit: 500 });
}

async function loadData() {
    [buckets] = await Promise.all([request<ActivityBucket[]>('getActivity', { deviceId: selectedDevice || undefined, days: DAYS }), loadEvents()]);
    renderHeatmap();
    renderDay();
}

async function load() {
    devices = await request<DeviceSummary[]>('getDevices');
    if (!rendered) layout();
    await loadData();
}

window.addEventListener('themechange', () => {
    if (!rendered) return;
    renderHeatmap();
    renderDay();
});

socket.on('connect', load);

socket.on('motionEvent', (event: MotionEvent) => {
    if (!rendered || (selectedDevice && event.deviceId !== selectedDevice) || localDayKey(event.start) !== selectedDay) return;
    const i = events.findIndex((e) => e._id === event._id);
    if (i >= 0) {
        events[i] = event;
    } else {
        events.unshift(event);
        const hour = new Date(event.start).getHours();
        const bucket = buckets.find((b) => b.day === selectedDay && b.hour === hour);
        if (bucket) bucket.count++;
        else buckets.push({ day: selectedDay, hour, count: 1, seconds: 0 });
        renderHeatmap();
    }
    renderDay();
    if (i < 0) document.querySelector(`[data-event-id="${event._id}"] .event-thumb`)?.classList.add('event-new');
});
