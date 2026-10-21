import './main';
import type ApexCharts from 'apexcharts';
import {
    framesizes,
    isMirrored,
    productName,
    rotationCommand,
    rotationOf,
    viewRect,
    ZOOM_MAX,
    type CameraView,
    type Rotation,
    type ActivityBucket,
    type CameraSettings,
    type DeviceSummary,
    type DeviceTelemetry,
    type MotionEvent,
} from '../../../shared/protocol';
import { heatmapChart } from './activityCharts';
import { bindControls, controlsHtml } from './controls';
import { bindEventViewer, eventCardHtml } from './events';
import { bindPetkit, feederWatchedBy, loadPetkit, petkitFeederHtml } from './petkitCard';
import { request, socket } from './socket';
import { bindUpdateInstall, updateNoticeHtml } from './updateNotice';
import { byId, cameraProblem, emptyState, errorAlert, escapeHtml, formatBytes, formatUptime, signalQuality, successAlert, timeAgo } from './utils';

const deviceId = window.location.pathname.split('/')[2]?.toUpperCase() ?? '';
// the size as it is shown: a camera turned by a quarter streams it the other way round, a zoom shows a part
function sizeLabel(d: DeviceSummary) {
    const label = framesizeLabels[d.camera!.framesize] ?? d.camera!.framesize;
    const [w, h] = label.split('×').map(Number);
    if (!w || !h) return label;
    const [tw, th] = d.turn90 ? [h, w] : [w, h];
    if (!d.view) return `${tw}×${th}`;
    const r = viewRect(tw, th, d.view);
    return `${r.width}×${r.height} · ${d.view.zoom.toFixed(1)}×`;
}

const framesizeLabels: Record<string, string> = {
    QVGA: '320×240',
    CIF: '400×296',
    HVGA: '480×320',
    VGA: '640×480',
    SVGA: '800×600',
    XGA: '1024×768',
    HD: '1280×720',
    SXGA: '1280×1024',
    UXGA: '1600×1200',
};

let device: DeviceSummary | undefined;
let cameras: DeviceSummary[] = []; // the other cameras, whose view this one can take
let events: MotionEvent[] = [];
let heatmap: ApexCharts | undefined;
let rendered = false;
let paused = false;

function layout(d: DeviceSummary) {
    byId('page-title').textContent = d.name;
    byId('page-pretitle').textContent = productName(d.model, d.caps);
    byId('container').innerHTML = `
        <div id="camera-update"></div>
        <div class="row row-cards">
            <div class="col-lg-8">
                <div class="card">
                    <div class="stream-frame" id="stream-frame">
                        <div class="stream-badges" id="stream-badges"></div>
                        <img id="stream" alt="live view of ${escapeHtml(d.name)}" />
                        <div class="stream-placeholder" id="stream-placeholder"></div>
                    </div>
                    <div class="card-body py-2">
                        <div class="btn-list">
                            <button class="btn" id="btn-pause"><i class="ti ti-player-pause me-1"></i> <span>Pause</span></button>
                            <a class="btn" id="btn-snapshot" href="/api/devices/${d._id}/snapshot?fresh=1&download=1"><i class="ti ti-camera me-1"></i> Snapshot</a>
                            <button class="btn" id="btn-fullscreen"><i class="ti ti-maximize me-1"></i> Full screen</button>
                        </div>
                    </div>
                </div>
                <div class="card mt-3">
                    <div class="card-header">
                        <h3 class="card-title">Activity, last 14 days</h3>
                        <div class="card-actions"><a href="/activity?device=${d._id}" class="btn btn-sm">Timeline <i class="ti ti-chevron-right ms-1"></i></a></div>
                    </div>
                    <div class="card-body"><div id="heatmap"></div></div>
                </div>
                <div class="card mt-3">
                    <div class="card-header"><h3 class="card-title">Latest motion</h3></div>
                    <div class="card-body"><div class="row g-2" id="events"></div></div>
                </div>
            </div>
            <div class="col-lg-4">
                <div id="petkit-slot"></div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Status</h3></div>
                    <div class="card-body" id="status"></div>
                </div>
                <div class="card mb-3" id="controls-card">
                    <div class="card-header"><h3 class="card-title">Controls</h3></div>
                    <div class="card-body" id="controls"></div>
                </div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Motion detection</h3></div>
                    <div class="card-body" id="motion"></div>
                </div>
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Picture</h3></div>
                    <div class="card-body" id="picture"></div>
                </div>
            </div>
        </div>`;

    byId('btn-pause').addEventListener('click', () => {
        paused = !paused;
        byId('btn-pause').innerHTML = paused
            ? '<i class="ti ti-player-play me-1"></i> <span>Play</span>'
            : '<i class="ti ti-player-pause me-1"></i> <span>Pause</span>';
        updateStream();
    });
    byId('btn-fullscreen').addEventListener('click', () => {
        const frame = byId('stream-frame');
        if (document.fullscreenElement) document.exitFullscreen();
        else frame.requestFullscreen?.();
    });
    bindEventViewer(byId('events'), (id) => {
        const event = events.find((e) => e._id === id);
        return event ? { event, device } : undefined;
    });
    bindControls(byId('controls'), () => device);
    bindPetkit(byId('petkit-slot'), renderFeeder);
    rendered = true;
}

/* The stream runs only while this page is visible and not paused: a hidden tab
 * would keep the camera sending at the full rate for nobody. */
function updateStream() {
    const img = byId<HTMLImageElement>('stream');
    const placeholder = byId('stream-placeholder');
    const problem = device?.online ? cameraProblem(device.cameraError) : undefined;
    const want = !!device?.online && !problem && !paused && document.visibilityState === 'visible';
    const src = `/api/devices/${deviceId}/stream`;

    if (want && !img.src.endsWith(src)) {
        img.src = src;
    } else if (!want && img.src) {
        img.removeAttribute('src'); // closes the connection, the camera slows down
    }
    img.style.display = want ? '' : 'none';
    placeholder.style.display = want ? 'none' : '';
    placeholder.innerHTML = !device?.online
        ? `<i class="ti ti-wifi-off"></i><span>The camera is offline${device?.lastSeen ? `, last seen ${timeAgo(device.lastSeen)}` : ''}.</span>`
        : problem
          ? `<i class="ti ti-camera-off"></i><span>${escapeHtml(problem)}</span>`
          : '<i class="ti ti-player-pause"></i><span>Paused</span>';
}

function renderBadges() {
    const d = device!;
    const t = d.telemetry;
    byId('stream-badges').innerHTML = !d.online
        ? '<span class="badge badge-overlay">offline</span>'
        : cameraProblem(d.cameraError)
          ? '<span class="badge badge-overlay">no picture</span>'
          : `<span class="badge badge-live">LIVE</span>
           ${d.camera ? `<span class="badge badge-overlay">${sizeLabel(d)}</span>` : ''}
           ${t ? `<span class="badge badge-overlay">${t.fps} fps</span>` : ''}
           ${d.viewers > 1 ? `<span class="badge badge-overlay"><i class="ti ti-eye"></i> ${d.viewers}</span>` : ''}`;
}

function renderStatus() {
    const d = device!;
    const t: DeviceTelemetry | undefined = d.telemetry;
    const signal = signalQuality(t?.rssi);
    const row = (label: string, value: string) =>
        `<div class="datagrid-item"><div class="datagrid-title">${label}</div><div class="datagrid-content">${value}</div></div>`;
    byId('status').innerHTML = `<div class="datagrid">
        ${row('State', d.online ? '<span class="status status-green"><span class="status-dot status-dot-animated"></span> online</span>' : '<span class="status status-secondary">offline</span>')}
        ${row('Wi-Fi', t?.rssi !== undefined ? `<span class="text-${signal.color}"><i class="ti ti-${signal.icon}"></i> ${signal.label}</span> <span class="text-secondary">(${t.rssi} dBm)</span>` : '–')}
        ${row('Network', d.ssid ? `${escapeHtml(d.ssid)}<div class="text-secondary small">${escapeHtml(d.ip ?? '')}</div>` : '–')}
        ${row('Uptime', t ? formatUptime(t.uptime) : '–')}
        ${row('Stream', t ? `${t.fps} fps · ${formatBytes(t.frameBytes)}/frame` : '–')}
        ${row('Memory', t ? `${formatBytes(t.heap)} RAM · ${formatBytes(t.psram)} PSRAM` : '–')}
        ${row('Firmware', `<span class="text-mono small">${escapeHtml(d.fw ?? '–')}</span>`)}
        ${row('Device id', `<span class="text-mono small">${escapeHtml(d._id)}</span>`)}
    </div>
    ${d.online && d.cameraError ? `<div class="mt-3">${errorAlert(cameraProblem(d.cameraError)!)}</div>` : ''}`;
}

function renderControls() {
    const d = device!;
    const hasControls = d.caps.some((c) => c !== 'camera' && c !== 'ota');
    byId('controls-card').style.display = hasControls ? '' : 'none';
    byId('controls').innerHTML = controlsHtml(d);
}

// the PetKit feeder this camera watches (set on the devices page)
function renderFeeder() {
    const f = feederWatchedBy(deviceId);
    byId('petkit-slot').innerHTML = f ? `<div class="mb-3">${petkitFeederHtml(f, { title: false })}</div>` : '';
}

// a kibbl. feeder's own camera, or one that watches a PetKit feeder: the cat comes there to eat
const atFeeder = () => device!.caps.includes('feeder') || !!feederWatchedBy(deviceId);

function renderMotion() {
    const m = device!.motion;
    const hours = (selected: number) =>
        Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === selected ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    byId('motion').innerHTML = `
        <label class="form-check form-switch mb-3">
            <input class="form-check-input" type="checkbox" id="motion-enabled" ${m.enabled ? 'checked' : ''} />
            <span class="form-check-label">Record motion as activity</span>
        </label>
        ${
            device!.caps.includes('blink')
                ? `<label class="form-check form-switch mb-3">
            <input class="form-check-input" type="checkbox" id="motion-blink" ${m.blink !== false ? 'checked' : ''} />
            <span class="form-check-label">Blink the white light when something moves</span>
        </label>`
                : ''
        }
        <label class="form-check form-switch mb-1">
            <input class="form-check-input" type="checkbox" id="motion-pictures" ${m.keepPictures ? 'checked' : ''} />
            <span class="form-check-label">Keep a picture of each movement</span>
        </label>
        <div class="form-hint mb-2">Off: only when and how much something moved is logged, no picture is stored.</div>
        <label class="form-check form-switch mb-1">
            <input class="form-check-input" type="checkbox" id="motion-cat-only" ${m.catOnly ? 'checked' : ''} />
            <span class="form-check-label">${atFeeder() ? 'Only count the cat as activity' : 'Only count a cat as activity'}</span>
        </label>
        <div class="form-hint mb-3">The server looks for a cat in what moves; a hand, a person or the light changing is ignored.</div>
        <label class="form-check form-switch mb-1">
            <input class="form-check-input" type="checkbox" id="motion-notify" ${m.notify ? 'checked' : ''} />
            <span class="form-check-label">${atFeeder() ? 'E-mail me when the cat comes to eat' : 'E-mail me when a cat comes'}</span>
        </label>
        <div class="form-hint mb-3">One e-mail a visit, with the picture. Only a cat counts: the server looks for one in what moves.</div>
        <div class="d-flex align-items-center gap-2 mb-3 small" id="saved-pictures"></div>
        <div class="mb-3">
            <label class="form-label">Sensitivity</label>
            <div class="btn-group w-100" role="group">
                ${(['low', 'medium', 'high'] as const)
                    .map(
                        (
                            s,
                        ) => `<input type="radio" class="btn-check" name="motion-sensitivity" id="sens-${s}" value="${s}" ${m.sensitivity === s ? 'checked' : ''} />
                    <label for="sens-${s}" class="btn">${s}</label>`,
                    )
                    .join('')}
            </div>
            <div class="form-hint">High also sees a cat at the far end of the room, low only people close by.</div>
        </div>
        <div class="mb-3">
            <label class="form-label">Quiet hours (no recording)</label>
            <div class="row g-2">
                <div class="col"><select class="form-select" id="quiet-from">${hours(m.quietFrom)}</select></div>
                <div class="col-auto d-flex align-items-center">to</div>
                <div class="col"><select class="form-select" id="quiet-to">${hours(m.quietTo)}</select></div>
            </div>
            <div class="form-hint">The same hour twice records around the clock.</div>
        </div>
        <button class="btn btn-primary w-100" id="motion-save"><i class="ti ti-device-floppy me-1"></i> Save</button>
        <div id="motion-result" class="mt-2"></div>`;

    byId('motion-save').addEventListener('click', async () => {
        const settings = {
            enabled: byId<HTMLInputElement>('motion-enabled').checked,
            blink: document.querySelector<HTMLInputElement>('#motion-blink')?.checked,
            keepPictures: byId<HTMLInputElement>('motion-pictures').checked,
            catOnly: byId<HTMLInputElement>('motion-cat-only').checked,
            notify: byId<HTMLInputElement>('motion-notify').checked,
            sensitivity: document.querySelector<HTMLInputElement>('input[name="motion-sensitivity"]:checked')?.value,
            quietFrom: Number(byId<HTMLSelectElement>('quiet-from').value),
            quietTo: Number(byId<HTMLSelectElement>('quiet-to').value),
        };
        const res = await request<{ ok: boolean; error?: string }>('setMotionSettings', deviceId, settings);
        byId('motion-result').innerHTML = res.ok ? successAlert('Saved.') : errorAlert(res.error ?? 'Not saved.');
    });
    renderSavedPictures();
}

/* Pictures saved so far stay when keeping them is switched off: deleting them is a
 * decision of its own, and it keeps the activity log. */
async function renderSavedPictures() {
    const el = byId('saved-pictures');
    const res = await request<{ ok: boolean; count?: number }>('countEventPictures', deviceId);
    const count = res.ok ? (res.count ?? 0) : 0;
    if (count === 0) {
        el.innerHTML = '<span class="text-secondary"><i class="ti ti-photo-off me-1"></i>No saved pictures</span>';
        return;
    }
    el.innerHTML = `<span class="text-secondary flex-fill"><i class="ti ti-photo me-1"></i>${count} saved picture${count === 1 ? '' : 's'}</span>
        <button class="btn btn-sm btn-outline-danger" id="delete-pictures"><i class="ti ti-trash me-1"></i>Delete pictures</button>`;
    byId('delete-pictures').addEventListener('click', async () => {
        if (!confirm(`Delete the ${count} saved picture${count === 1 ? '' : 's'} of ${device!.name}? The activity log stays.`)) return;
        const del = await request<{ ok: boolean; deleted?: number; error?: string }>('deleteEventPictures', deviceId);
        if (!del.ok) {
            byId('motion-result').innerHTML = errorAlert(del.error ?? 'Not deleted.');
            return;
        }
        events = await request<MotionEvent[]>('getEvents', { deviceId, limit: 24 });
        renderEvents();
        renderSavedPictures();
    });
}

function renderPicture() {
    const d = device!;
    const c: CameraSettings | undefined = d.camera;
    if (!c) {
        byId('picture').innerHTML = '<div class="text-secondary">The camera reports its settings when it is online.</div>';
        return;
    }
    let rotation = rotationOf(c, d.turn90);
    const view: CameraView = d.view ?? { zoom: 1, x: 0.5, y: 0.5 };
    const level = (id: string, label: string, value: number) => `<div class="col-4">
        <label class="form-label small">${label}</label>
        <select class="form-select form-select-sm" id="${id}">${[-2, -1, 0, 1, 2].map((v) => `<option value="${v}" ${v === value ? 'selected' : ''}>${v > 0 ? '+' : ''}${v}</option>`).join('')}</select>
    </div>`;
    byId('picture').innerHTML = `
        <div class="mb-3">
            <label class="form-label">Resolution</label>
            <select class="form-select" id="cam-framesize">
                ${framesizes.map((f) => `<option value="${f}" ${f === c.framesize ? 'selected' : ''}>${f} · ${framesizeLabels[f]}</option>`).join('')}
            </select>
            <div class="form-hint">VGA streams smoothly; higher sizes lower the frame rate.</div>
        </div>
        <div class="mb-3">
            <label class="form-label d-flex"><span class="flex-fill">Quality</span><span class="text-secondary" id="cam-quality-value">${c.quality}</span></label>
            <input type="range" class="form-range" id="cam-quality" min="4" max="40" value="${c.quality}" />
            <div class="d-flex text-secondary small"><span class="flex-fill">sharper</span><span>smaller</span></div>
        </div>
        <div class="row g-2 mb-3">
            ${level('cam-brightness', 'Brightness', c.brightness)}
            ${level('cam-contrast', 'Contrast', c.contrast)}
            ${level('cam-saturation', 'Saturation', c.saturation)}
        </div>
        <div class="mb-3">
            <label class="form-label">Orientation</label>
            <div class="d-flex align-items-center gap-2">
                <button type="button" class="btn" id="cam-rotate" ${d.online ? '' : 'disabled'}><i class="ti ti-rotate-clockwise-2 me-1"></i> Rotate 90°</button>
                <span class="text-secondary" id="cam-rotation">${rotation}°</span>
                <label class="form-check form-check-inline ms-auto mb-0"><input class="form-check-input" type="checkbox" id="cam-mirror" ${isMirrored(c) ? 'checked' : ''} /><span class="form-check-label">Mirror</span></label>
            </div>
            <div class="form-hint">Each tap turns the picture a quarter clockwise, at once.</div>
        </div>
        <div class="mb-3">
            <label class="form-label d-flex"><span class="flex-fill">Zoom</span><span class="text-secondary" id="cam-zoom-value">${view.zoom.toFixed(1)}×</span></label>
            <input type="range" class="form-range" id="cam-zoom" min="1" max="${ZOOM_MAX}" step="0.1" value="${view.zoom}" ${d.online ? '' : 'disabled'} />
            <div class="row g-2 mt-1" id="cam-pan" ${view.zoom > 1 ? '' : 'hidden'}>
                <div class="col"><label class="form-label small mb-0">Left · right</label><input type="range" class="form-range" id="cam-pan-x" min="0" max="1" step="0.01" value="${view.x}" /></div>
                <div class="col"><label class="form-label small mb-0">Up · down</label><input type="range" class="form-range" id="cam-pan-y" min="0" max="1" step="0.01" value="${view.y}" /></div>
            </div>
            <div class="form-hint">Shows only the middle of the picture, e.g. to hide a housing around the lens. Cut out on the server: the more zoom, the softer.</div>
        </div>
        <button class="btn btn-primary w-100" id="cam-apply" ${d.online ? '' : 'disabled'}><i class="ti ti-check me-1"></i> Apply</button>
        <div id="cam-result" class="mt-2"></div>
        ${
            cameras.length
                ? `<hr class="my-3" />
        <label class="form-label">Same view as</label>
        <div class="d-flex gap-2">
            <select class="form-select" id="cam-copy-from">${cameras.map((o) => `<option value="${o._id}">${escapeHtml(o.name)}</option>`).join('')}</select>
            <button class="btn" id="cam-copy" ${d.online ? '' : 'disabled'}><i class="ti ti-copy me-1"></i> Take</button>
        </div>
        <div class="form-hint">Takes over the other camera's resolution, quality, levels, turn, mirror and zoom, and its motion detection.</div>`
                : ''
        }`;

    document.getElementById('cam-copy')?.addEventListener('click', async () => {
        const from = cameras.find((o) => o._id === byId<HTMLSelectElement>('cam-copy-from').value);
        if (!from || !confirm(`Give ${d.name} the picture and motion detection of ${from.name}?`)) return;
        const button = byId<HTMLButtonElement>('cam-copy');
        button.classList.add('btn-loading');
        const resp = await request<{ ok: boolean; error?: string }>('copyCameraView', deviceId, from._id);
        button.classList.remove('btn-loading');
        byId('cam-result').innerHTML = resp.ok ? successAlert(`Same view as ${escapeHtml(from.name)}.`) : errorAlert(resp.error ?? 'Not taken over.');
    });

    byId('cam-rotate').addEventListener('click', async () => {
        const button = byId<HTMLButtonElement>('cam-rotate');
        const next = ((rotation + 90) % 360) as Rotation;
        button.classList.add('btn-loading');
        const resp = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, {
            cmd: 'camera',
            ...rotationCommand(next, byId<HTMLInputElement>('cam-mirror').checked),
        });
        button.classList.remove('btn-loading');
        if (resp.ok) {
            rotation = next;
            byId('cam-rotation').textContent = `${rotation}°`;
        }
        byId('cam-result').innerHTML = resp.ok ? '' : errorAlert(resp.error ?? 'Not turned.');
    });
    const readView = (): CameraView => ({
        zoom: Number(byId<HTMLInputElement>('cam-zoom').value),
        x: Number(byId<HTMLInputElement>('cam-pan-x').value),
        y: Number(byId<HTMLInputElement>('cam-pan-y').value),
    });
    byId('cam-zoom').addEventListener('input', () => {
        const zoom = Number(byId<HTMLInputElement>('cam-zoom').value);
        byId('cam-zoom-value').textContent = `${zoom.toFixed(1)}×`;
        byId('cam-pan').hidden = zoom <= 1;
    });
    // applied when the slider is let go: the server cuts the frames from the next one on
    for (const id of ['cam-zoom', 'cam-pan-x', 'cam-pan-y']) {
        byId(id).addEventListener('change', async () => {
            const resp = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, { cmd: 'camera', view: readView() });
            byId('cam-result').innerHTML = resp.ok ? '' : errorAlert(resp.error ?? 'Not zoomed.');
        });
    }
    byId('cam-quality').addEventListener('input', () => {
        byId('cam-quality-value').textContent = byId<HTMLInputElement>('cam-quality').value;
    });
    byId('cam-apply').addEventListener('click', async () => {
        const button = byId<HTMLButtonElement>('cam-apply');
        button.classList.add('btn-loading');
        const resp = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, {
            cmd: 'camera',
            framesize: byId<HTMLSelectElement>('cam-framesize').value,
            quality: Number(byId<HTMLInputElement>('cam-quality').value),
            brightness: Number(byId<HTMLSelectElement>('cam-brightness').value),
            contrast: Number(byId<HTMLSelectElement>('cam-contrast').value),
            saturation: Number(byId<HTMLSelectElement>('cam-saturation').value),
            ...rotationCommand(rotation, byId<HTMLInputElement>('cam-mirror').checked),
        });
        button.classList.remove('btn-loading');
        byId('cam-result').innerHTML = resp.ok ? successAlert('Applied.') : errorAlert(resp.error ?? 'Not applied.');
    });
}

function renderEvents() {
    byId('events').innerHTML = events.length
        ? events
              .slice(0, 12)
              .map((e) => eventCardHtml(e, undefined))
              .join('')
        : `<div class="col-12">${emptyState('mood-smile', 'No motion yet', 'When something moves in front of this camera, it shows up here.')}</div>`;
}

async function renderHeatmap() {
    const buckets = await request<ActivityBucket[]>('getActivity', { deviceId, days: 14 });
    heatmap?.destroy();
    heatmap = heatmapChart(byId('heatmap'), buckets, 14, (day) => {
        window.location.href = `/activity?device=${deviceId}&day=${day}`;
    });
}

function renderDevice() {
    const update = document.getElementById('camera-update');
    if (update && device) update.innerHTML = updateNoticeHtml(device);
    renderBadges();
    renderStatus();
    updateStream();
}

async function load() {
    const devices = await request<DeviceSummary[]>('getDevices');
    device = devices.find((d) => d._id === deviceId && d.status === 'approved');
    cameras = devices.filter((d) => d._id !== deviceId && d.status === 'approved' && d.caps.includes('camera') && d.camera);
    await loadPetkit();
    if (!device) {
        byId('container').innerHTML = errorAlert('This camera does not exist or is not approved yet.');
        return;
    }
    events = await request<MotionEvent[]>('getEvents', { deviceId, limit: 24 });
    if (!rendered) layout(device);
    renderDevice();
    renderFeeder();
    renderControls();
    renderMotion();
    renderPicture();
    renderEvents();
    renderHeatmap();
}

document.addEventListener('visibilitychange', () => {
    if (rendered) updateStream();
});
window.addEventListener('themechange', () => {
    if (rendered) renderHeatmap();
});

socket.on('connect', load);
bindUpdateInstall(document.body);

socket.on('deviceUpdate', (d: DeviceSummary) => {
    if (d._id !== deviceId || !rendered) return;
    const wasOnline = device?.online;
    const settingsChanged = JSON.stringify(device?.camera) !== JSON.stringify(d.camera) || device?.light !== d.light;
    const motionChanged = JSON.stringify(device?.motion) !== JSON.stringify(d.motion);
    device = d;
    renderDevice();
    if (wasOnline !== d.online || settingsChanged) {
        renderControls();
        renderPicture();
    }
    if (motionChanged) renderMotion();
});

// the feeder this camera watches was read, fed or given to another camera
socket.on('petkitUpdate', () => {
    if (!rendered) return;
    const before = !!feederWatchedBy(deviceId);
    void loadPetkit().then(() => {
        renderFeeder();
        if (before !== !!feederWatchedBy(deviceId)) renderMotion();
    });
});

socket.on('telemetry', (id: string, t: DeviceTelemetry) => {
    if (id !== deviceId || !device || !rendered) return;
    device.telemetry = t;
    renderBadges();
    renderStatus();
});

socket.on('motionEvent', (event: MotionEvent) => {
    if (event.deviceId !== deviceId || !rendered) return;
    const i = events.findIndex((e) => e._id === event._id);
    if (i >= 0) events[i] = event;
    else events.unshift(event);
    renderEvents();
});

socket.on('deviceRemoved', (id: string) => {
    if (id === deviceId) window.location.href = '/';
});
