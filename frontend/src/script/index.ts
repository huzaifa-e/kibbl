import './main';
import type ApexCharts from 'apexcharts';
import type { ActivityBucket, DeviceSummary, MotionEvent } from '../../../shared/protocol';
import { hourlyChart } from './activityCharts';
import { controlsHtml, bindControls } from './controls';
import { bindEventViewer, eventCardHtml } from './events';
import { request, socket } from './socket';
import { byId, emptyState, escapeHtml, localDayKey, signalQuality, startOfDay, timeAgo } from './utils';

const TILE_REFRESH_MS = 4000;

let devices: DeviceSummary[] = [];
let events: MotionEvent[] = [];
let activity: ActivityBucket[] = [];
let chart: ApexCharts | undefined;
let rendered = false;

const cameras = () => devices.filter((d) => d.status === 'approved' && d.caps.includes('camera'));
const others = () => devices.filter((d) => d.status === 'approved' && !d.caps.includes('camera'));

function layout() {
    byId('container').innerHTML = `
        <div id="pending-alert"></div>
        <div class="row row-deck row-cards mb-3" id="stats"></div>
        <div class="row row-cards" id="camera-grid"></div>
        <div class="row row-cards mt-1" id="other-devices"></div>
        <div class="row row-cards mt-1">
            <div class="col-lg-5">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Today, by hour</h3></div>
                    <div class="card-body"><div id="hourly-chart"></div></div>
                </div>
            </div>
            <div class="col-lg-7">
                <div class="card">
                    <div class="card-header">
                        <h3 class="card-title">Latest activity</h3>
                        <div class="card-actions"><a href="/activity" class="btn btn-sm">All activity <i class="ti ti-chevron-right ms-1"></i></a></div>
                    </div>
                    <div class="card-body"><div class="row g-2" id="recent-events"></div></div>
                </div>
            </div>
        </div>`;
    bindEventViewer(byId('recent-events'), (id) => {
        const event = events.find((e) => e._id === id);
        return event ? { event, device: devices.find((d) => d._id === event.deviceId) } : undefined;
    });
    rendered = true;
}

function renderStats() {
    const cams = cameras();
    const online = cams.filter((d) => d.online).length;
    const today = events.filter((e) => e.start >= startOfDay());
    const last = events[0];
    const stat = (icon: string, color: string, value: string, label: string) => `<div class="col-6 col-lg-3">
        <div class="card card-sm hud-tile"><div class="card-body"><div class="row align-items-center g-2">
            <div class="col-auto"><span class="hud-icon hud-${color}"><i class="ti ti-${icon}"></i></span></div>
            <div class="col"><div class="stat-value">${value}</div><div class="hud-label text-secondary">${label}</div></div>
        </div></div></div></div>`;
    byId('stats').innerHTML =
        stat('device-cctv', online === cams.length && cams.length ? 'olive' : 'rust', `${online}/${cams.length}`, 'cameras online') +
        stat('paw', 'pumpkin', String(today.length), 'events today') +
        stat('hourglass', 'mustard', last ? timeAgo(last.start) : '–', 'last activity') +
        stat('eye', 'plum', String(cams.reduce((n, d) => n + d.viewers, 0)), 'watching now');

    const pending = devices.filter((d) => d.status === 'pending');
    byId('pending-alert').innerHTML = pending.length
        ? `<div class="alert alert-warning d-flex align-items-center"><i class="ti ti-plug-connected me-2"></i>
            <div class="flex-fill">${pending.length} new device${pending.length > 1 ? 's want' : ' wants'} to join your home.</div>
            <a href="/devices" class="btn btn-warning btn-sm">Review</a></div>`
        : '';
}

function cameraTileHtml(d: DeviceSummary) {
    const signal = signalQuality(d.telemetry?.rssi);
    const todayCount = events.filter((e) => e.deviceId === d._id && e.start >= startOfDay()).length;
    const picture = d.online
        ? `<img data-tile-img="${d._id}" alt="${escapeHtml(d.name)}" style="display:none" />
           <div class="stream-placeholder" data-tile-placeholder="${d._id}"><i class="ti ti-player-play"></i><span>${d.motion.enabled ? 'Waiting for a picture' : 'Open the live view'}</span></div>`
        : `<div class="stream-placeholder"><i class="ti ti-wifi-off"></i><span>Offline${d.lastSeen ? ` since ${timeAgo(d.lastSeen)}` : ''}</span></div>`;
    return `<div class="col-md-6 col-xl-4">
        <div class="card camera-tile" data-camera="${d._id}">
            <div class="stream-frame" style="border-radius: var(--kb-radius) var(--kb-radius) 0 0">
                <div class="stream-badges">
                    ${d.online ? '<span class="badge badge-overlay"><i class="ti ti-point-filled text-green"></i> online</span>' : '<span class="badge badge-overlay">offline</span>'}
                    ${d.viewers > 0 ? `<span class="badge badge-live">LIVE · ${d.viewers}</span>` : ''}
                </div>
                ${picture}
            </div>
            <div class="card-body py-2">
                <div class="d-flex align-items-center">
                    <div class="flex-fill">
                        <div class="fw-bold">${escapeHtml(d.name)}</div>
                        <div class="text-secondary small">${todayCount} event${todayCount === 1 ? '' : 's'} today · motion ${d.motion.enabled ? d.motion.sensitivity : 'off'}</div>
                    </div>
                    <span class="text-${signal.color}" title="Wi-Fi ${signal.label}${d.telemetry?.rssi ? ` (${d.telemetry.rssi} dBm)` : ''}"><i class="ti ti-${signal.icon}"></i></span>
                </div>
            </div>
        </div>
    </div>`;
}

function renderCameras() {
    const cams = cameras();
    const grid = byId('camera-grid');
    if (cams.length === 0) {
        grid.innerHTML = `<div class="col-12"><div class="card"><div class="card-body">${emptyState(
            'device-cctv',
            'No camera yet',
            'Plug your kibbl. cam into this computer and set it up under Devices.',
            '<a href="/devices" class="btn btn-primary">Devices</a>',
        )}</div></div></div>`;
        return;
    }
    grid.innerHTML = cams.map(cameraTileHtml).join('');
    refreshTiles();
}

function renderOthers() {
    const list = others();
    byId('other-devices').innerHTML = list
        .map(
            (d) => `<div class="col-md-6 col-xl-4"><div class="card">
                <div class="card-header"><h3 class="card-title">${escapeHtml(d.name)}</h3>
                    <div class="card-actions"><span class="badge ${d.online ? 'bg-green-lt' : 'bg-secondary-lt'}">${d.online ? 'online' : 'offline'}</span></div></div>
                <div class="card-body">${controlsHtml(d)}</div></div></div>`,
        )
        .join('');
    bindControls(byId('other-devices'), (id) => devices.find((d) => d._id === id));
}

function renderEvents() {
    const recent = events.slice(0, 8);
    byId('recent-events').innerHTML = recent.length
        ? recent.map((e) => eventCardHtml(e, devices.find((d) => d._id === e.deviceId)?.name)).join('')
        : `<div class="col-12">${emptyState('mood-smile', 'All quiet', 'Motion your cameras see shows up here.')}</div>`;
}

function renderChart() {
    chart?.destroy();
    chart = hourlyChart(byId('hourly-chart'), activity, localDayKey(Date.now()));
}

/* A tile shows the camera's latest frame, refreshed every few seconds, without
 * opening a stream: with motion detection on, the camera sends 2 frames a second
 * anyway, otherwise the tile asks the viewer to open the live view. */
async function refreshTiles() {
    for (const d of cameras().filter((c) => c.online)) {
        const img = document.querySelector<HTMLImageElement>(`[data-tile-img="${d._id}"]`);
        if (!img) continue;
        const res = await fetch(`/api/devices/${d._id}/snapshot`).catch(() => undefined);
        if (!res || res.status !== 200) continue;
        const url = URL.createObjectURL(await res.blob());
        const old = img.src;
        img.onload = () => {
            if (old.startsWith('blob:')) URL.revokeObjectURL(old);
        };
        img.src = url;
        img.style.display = '';
        document.querySelector<HTMLElement>(`[data-tile-placeholder="${d._id}"]`)?.remove();
    }
}

function renderAll() {
    if (!rendered) layout();
    renderStats();
    renderCameras();
    renderOthers();
    renderEvents();
}

async function load() {
    [devices, events, activity] = await Promise.all([
        request<DeviceSummary[]>('getDevices'),
        request<MotionEvent[]>('getEvents', { limit: 100, from: startOfDay() - 6 * 86400000 }),
        request<ActivityBucket[]>('getActivity', { days: 1 }),
    ]);
    renderAll();
    renderChart();
}

document.addEventListener('DOMContentLoaded', () => {
    byId('container').addEventListener('click', (e) => {
        const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-camera]');
        if (tile) window.location.href = `/camera/${tile.dataset.camera}`;
    });
    setInterval(refreshTiles, TILE_REFRESH_MS);
    window.addEventListener('themechange', renderChart);
});

socket.on('connect', load);

socket.on('deviceUpdate', (device: DeviceSummary) => {
    const i = devices.findIndex((d) => d._id === device._id);
    if (i >= 0) devices[i] = device;
    else devices.push(device);
    if (rendered) {
        renderStats();
        renderCameras();
        renderOthers();
    }
});

socket.on('deviceRemoved', (deviceId: string) => {
    devices = devices.filter((d) => d._id !== deviceId);
    if (rendered) renderAll();
});

socket.on('motionEvent', (event: MotionEvent) => {
    const i = events.findIndex((e) => e._id === event._id);
    const isNew = i < 0;
    if (isNew) {
        events.unshift(event);
        const bucket = activity.find((b) => b.day === localDayKey(event.start) && b.hour === new Date(event.start).getHours());
        if (bucket) bucket.count++;
        else activity.push({ day: localDayKey(event.start), hour: new Date(event.start).getHours(), count: 1, seconds: 0 });
        renderChart();
    } else {
        events[i] = event;
    }
    if (!rendered) return;
    renderStats();
    renderEvents();
    if (isNew) document.querySelector(`[data-event-id="${event._id}"] .event-thumb`)?.classList.add('event-new');
});
