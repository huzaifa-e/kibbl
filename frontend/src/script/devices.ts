import './main';
import { productName, type DeviceSummary } from '../../../shared/protocol';
import { request, socket } from './socket';
import { knownPorts, onUsbPlugged, usbSupported, usbUnsupportedReason } from './usbSerial';
import { byId, emptyState, errorAlert, escapeHtml, successAlert, timeAgo } from './utils';
import { changeWifiRemotely, setupOverUsb } from './wifiSetup';

let devices: DeviceSummary[] = [];

const capabilityLabels: Record<string, string> = {
    camera: 'camera',
    light: 'light',
    ota: 'updates',
    switch: 'switch',
    feeder: 'pet feeder',
    thermostat: 'heating',
    air: 'CO2',
    lamp: 'lamp',
    fan: 'fan',
    night: 'night mode',
    smoke: 'cigarettes',
    window: 'windows',
    fire: 'fire warning',
};
// shown on the device page instead
const hiddenCapabilities = new Set(['blink', 'buzzer', 'calibrate']);

function pendingCard(d: DeviceSummary) {
    return `<div class="col-md-6">
        <div class="card card-sm border-warning">
            <div class="card-body">
                <div class="d-flex align-items-center mb-2">
                    <span class="avatar bg-orange-lt me-3"><i class="ti ti-plug-connected"></i></span>
                    <div class="flex-fill">
                        <div class="fw-bold">${escapeHtml(productName(d.model, d.caps))}</div>
                        <div class="text-secondary small">id <span class="text-mono">${escapeHtml(d._id)}</span> · first seen ${timeAgo(d.createdAt)}</div>
                    </div>
                    <span class="badge ${d.online ? 'bg-green-lt' : 'bg-secondary-lt'}">${d.online ? 'online' : 'offline'}</span>
                </div>
                <div class="text-secondary small mb-3">Approve only a device you set up yourself: its id is on the label and in the setup over USB.</div>
                <div class="btn-list">
                    <button class="btn btn-success" data-action="approve" data-device="${d._id}"><i class="ti ti-check me-1"></i> Approve</button>
                    <button class="btn btn-outline-danger" data-action="remove" data-device="${d._id}"><i class="ti ti-x me-1"></i> Reject</button>
                </div>
            </div>
        </div>
    </div>`;
}

function deviceRow(d: DeviceSummary) {
    const caps = d.caps
        .filter((c) => !hiddenCapabilities.has(c))
        .map((c) => `<span class="badge bg-blue-lt me-1">${escapeHtml(capabilityLabels[c] ?? c)}</span>`)
        .join('');
    return `<tr data-row="${d._id}">
        <td>
            <div class="d-flex align-items-center">
                <span class="avatar me-2 ${d.online ? 'bg-green-lt' : 'bg-secondary-lt'}"><i class="ti ti-${d.caps.includes('camera') ? 'device-cctv' : d.caps.includes('air') ? 'wind' : 'cpu'}"></i></span>
                <div>
                    <div class="fw-bold">${escapeHtml(d.name)}</div>
                    <div class="text-secondary small">${escapeHtml(productName(d.model, d.caps))} · <span class="text-mono">${escapeHtml(d._id)}</span></div>
                </div>
            </div>
        </td>
        <td>${d.online ? `<span class="status status-green"><span class="status-dot status-dot-animated"></span> online</span><div class="text-secondary small"><i class="ti ti-wifi"></i> ${escapeHtml(d.ssid ?? '')}</div>` : `<span class="status status-secondary">offline</span><div class="text-secondary small">${d.lastSeen ? timeAgo(d.lastSeen) : ''}</div>`}
            ${d.wifiChangeFailed ? `<div class="text-orange small"><i class="ti ti-alert-triangle"></i> could not join ${escapeHtml(d.wifiChangeFailed)}, went back</div>` : ''}</td>
        <td class="d-none d-md-table-cell">${caps}</td>
        <td class="d-none d-lg-table-cell text-mono small">${escapeHtml(d.fw ?? '–')}</td>
        <td class="text-end">
            <div class="dropdown">
                <button class="btn btn-sm dropdown-toggle" data-bs-toggle="dropdown" data-bs-popper-config='{"strategy":"fixed"}'>Actions</button>
                <div class="dropdown-menu dropdown-menu-end">
                    ${d.caps.includes('camera') ? `<a class="dropdown-item" href="/camera/${d._id}"><i class="ti ti-video me-2"></i> Live view</a>` : ''}
                    ${d.caps.includes('air') ? `<a class="dropdown-item" href="/air/${d._id}"><i class="ti ti-wind me-2"></i> Open</a>` : ''}
                    <a class="dropdown-item" href="#" data-action="rename" data-device="${d._id}"><i class="ti ti-pencil me-2"></i> Rename</a>
                    <a class="dropdown-item ${d.online ? '' : 'disabled'}" href="#" data-action="wifi" data-device="${d._id}"><i class="ti ti-wifi me-2"></i> Wi-Fi network</a>
                    ${d.caps.includes('blink') ? `<a class="dropdown-item ${d.online ? '' : 'disabled'}" href="#" data-action="blink" data-device="${d._id}"><i class="ti ti-bulb me-2"></i> Blink to find it</a>` : ''}
                    <a class="dropdown-item ${d.online ? '' : 'disabled'}" href="#" data-action="reboot" data-device="${d._id}"><i class="ti ti-refresh me-2"></i> Restart</a>
                    ${d.caps.includes('ota') ? `<a class="dropdown-item ${d.online ? '' : 'disabled'}" href="#" data-action="update" data-device="${d._id}"><i class="ti ti-upload me-2"></i> Update firmware</a>` : ''}
                    <div class="dropdown-divider"></div>
                    <a class="dropdown-item text-danger" href="#" data-action="remove" data-device="${d._id}"><i class="ti ti-trash me-2"></i> Remove</a>
                </div>
            </div>
        </td>
    </tr>`;
}

function render() {
    const pending = devices.filter((d) => d.status === 'pending');
    const approved = devices.filter((d) => d.status === 'approved');

    const usb = usbSupported()
        ? `<button class="btn btn-primary" data-action="usb"><i class="ti ti-usb me-1"></i> Set up over USB</button>`
        : `<div class="text-secondary small">${escapeHtml(usbUnsupportedReason())}</div>`;
    byId('container').innerHTML = `
        <div id="result"></div>
        <div id="usb-plugged"></div>
        <div class="card mb-4">
            <div class="card-body d-flex flex-wrap align-items-center gap-3">
                <span class="hud-icon hud-pine"><i class="ti ti-plug-connected"></i></span>
                <div class="flex-fill">
                    <div class="fw-bold">Add or move a device</div>
                    <div class="text-secondary small">With a phone: the device opens its own Wi-Fi, a page there connects it to yours and gives a code to enter here. Or plug it into this computer.</div>
                </div>
                <div class="btn-list">
                    <button class="btn btn-primary" data-action="claim"><i class="ti ti-qrcode me-1"></i> Add with a code</button>
                    ${usb.replace('btn-primary', 'btn-outline-primary')}
                </div>
            </div>
            <div class="card-body border-top d-none" id="claim-panel">
                <ol class="mb-3">
                    <li>A new device opens the Wi-Fi <b>kibbl-xxxx</b> by itself. To set up one that had a network: hold the button of a kibbl. air for 10 seconds; switch a kibbl. cam off and on three times, each within 10 seconds.</li>
                    <li>Join <b>kibbl-xxxx</b> with your phone. The setup page opens (else go to <span class="text-mono">192.168.4.1</span>).</li>
                    <li>Choose your Wi-Fi and its password. When it says <i>connected</i>, it shows a code.</li>
                    <li>Back on your usual Wi-Fi, enter the code here.</li>
                </ol>
                <form class="row g-2 align-items-end" id="claim-form">
                    <div class="col-sm-4"><label class="form-label">Code</label><input class="form-control text-mono text-uppercase" id="claim-code" placeholder="ABCD-EFGH" maxlength="9" autocomplete="off" required /></div>
                    <div class="col-sm-5"><label class="form-label">Name</label><input class="form-control" id="claim-name" placeholder="Living room" maxlength="40" required /></div>
                    <div class="col-sm-3"><button class="btn btn-primary w-100" type="submit">Add</button></div>
                </form>
            </div>
        </div>
        ${pending.length ? `<h3 class="mb-2">Waiting for approval</h3><div class="row row-cards mb-4">${pending.map(pendingCard).join('')}</div>` : ''}
        <div class="card mb-4">
            <div class="card-header"><h3 class="card-title">Your devices</h3></div>
            ${
                approved.length
                    ? `<div class="table-responsive"><table class="table table-vcenter card-table">
                        <thead><tr><th>Device</th><th>State</th><th class="d-none d-md-table-cell">Can</th><th class="d-none d-lg-table-cell">Firmware</th><th></th></tr></thead>
                        <tbody>${approved.map(deviceRow).join('')}</tbody></table></div>`
                    : `<div class="card-body">${emptyState('cpu', 'No devices yet', 'A new device appears above once it reaches the server.')}</div>`
            }
        </div>
        <div id="meters"></div>
        <div id="trackers"></div>
        <div class="row row-cards">
            <div class="col-lg-7">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Good to know</h3></div>
                    <div class="card-body">
                        <ul class="mb-0">
                            <li class="mb-2">A device that reaches your home on its own appears above under <i>Waiting for approval</i>. Approve only one you set up yourself.</li>
                            <li class="mb-2">Moving to another Wi-Fi: <i>Actions → Wi-Fi network</i> while it is online, or set it up over USB again.</li>
                            <li>Power it off and on three times within ten seconds each to make it forget its Wi-Fi.</li>
                        </ul>
                    </div>
                </div>
            </div>
            <div class="col-lg-5">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Coming to the home network</h3></div>
                    <div class="list-group list-group-flush">
                        <div class="list-group-item"><i class="ti ti-bowl me-2 text-orange"></i> Pet feeder: feed on a schedule or from the app</div>
                        <div class="list-group-item"><i class="ti ti-flame me-2 text-red"></i> Heating: radiator valve or relay with a target temperature</div>
                        <div class="list-group-item"><i class="ti ti-plug me-2 text-blue"></i> Switches: any device behind a relay</div>
                    </div>
                    <div class="card-footer text-secondary small">They speak the same protocol as the camera (docs/protocol.md) and get their controls here automatically.</div>
                </div>
            </div>
        </div>
        <input type="file" id="firmware-file" accept=".bin" class="d-none" />`;
    renderMeters();
    renderTrackers();
}

/* ----------------------------------------------------------------------- */

/* Utility meters (electricity, gas, water) of the EMONI LoRaWAN server: kibbl. keeps a
 * copy of their readings, battery included; added here by the uuid of their dashboard. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let meters: any[] | undefined;

function renderMeters() {
    const slot = document.getElementById('meters');
    if (!slot || !meters) return;
    const rows = meters
        .map((m) => {
            const b = m.battery;
            const battery = b
                ? `<i class="ti ti-${b.percent > 60 ? 'battery-3' : b.percent > 30 ? 'battery-2' : b.percent > 10 ? 'battery-1' : 'battery-exclamation'} me-1 ${b.percent !== null && b.percent <= 15 ? 'text-danger' : ''}"></i>${b.percent ?? '–'} % <span class="text-secondary small">${(b.mv / 1000).toFixed(2)} V</span>`
                : '–';
            const stale = m.latest && Date.now() - m.latest.at > 6 * 3600_000;
            return `<tr>
                <td><div class="d-flex align-items-center gap-3">
                    <span class="avatar bg-orange-lt"><i class="ti ti-${m.medium === 'electricity' ? 'bolt' : m.medium === 'water' ? 'droplet' : 'flame'}"></i></span>
                    <div><div class="fw-bold">${escapeHtml(m.name)}</div><div class="text-secondary small">${escapeHtml(m.deviceType ?? m.medium)} · EMONI LoRaWAN</div></div>
                </div></td>
                <td><b>${m.latest ? Number(m.latest.value).toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–'}</b> <span class="text-secondary small">${escapeHtml(m.unit)}</span></td>
                <td>${battery}</td>
                <td class="${stale || m.lastSyncError ? 'text-warning' : 'text-secondary'}">${m.lastSyncError ? 'source not answering' : m.latest ? `read ${timeAgo(m.latest.at)}` : 'no reading yet'}</td>
                <td class="text-end"><a class="btn btn-sm" href="/meter/${m._id}"><i class="ti ti-chart-bar me-1"></i> Open</a>
                    <button class="btn btn-sm btn-ghost-danger" data-remove-meter="${m._id}" data-name="${escapeHtml(m.name)}" title="Remove from kibbl."><i class="ti ti-trash"></i></button></td>
            </tr>`;
        })
        .join('');
    slot.innerHTML = `<div class="card mb-4">
        <div class="card-header"><h3 class="card-title">Meters</h3></div>
        ${meters.length ? `<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>Meter</th><th>Reading</th><th>Battery</th><th>Last</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
        <div class="card-body">
            <form class="d-flex flex-wrap gap-2" id="add-meter">
                <input class="form-control" style="max-width:420px" id="meter-uuid" placeholder="Device id from the LoRaWAN dashboard (a uuid)" autocomplete="off" />
                <button class="btn" type="submit"><i class="ti ti-plus me-1"></i> Add meter</button>
            </form>
            <div id="meter-result" class="mt-2"></div>
        </div>
    </div>`;
    byId('add-meter').addEventListener('submit', async (e) => {
        e.preventDefault();
        const uuid = byId<HTMLInputElement>('meter-uuid').value.trim();
        const res = await fetch('/api/meters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            byId('meter-result').innerHTML = errorAlert(escapeHtml(body.error ?? 'Not added.'));
            return;
        }
        byId('meter-result').innerHTML = successAlert(`${escapeHtml(body.name)} added: its history is being copied.`);
        setTimeout(loadMeters, 3000);
    });
    slot.querySelectorAll<HTMLButtonElement>('[data-remove-meter]').forEach((b) =>
        b.addEventListener('click', async () => {
            if (!confirm(`Remove ${b.dataset.name} and kibbl.'s copy of its data? The LoRaWAN server keeps its own.`)) return;
            await fetch(`/api/meters/${b.dataset.removeMeter}`, { method: 'DELETE' });
            loadMeters();
        }),
    );
}

async function loadMeters() {
    try {
        const res = await fetch('/api/meters');
        if (!res.ok) return;
        meters = await res.json();
        renderMeters();
    } catch {
        // the devices page works without them
    }
}

/* ----------------------------------------------------------------------- */

interface Tracker {
    name: string;
    type: string;
    battery: number | null;
    batteryStatus: string | null;
    lastSync: string | null;
}

let trackers: { linked: boolean; trackers: Tracker[] } | undefined;

function batteryIcon(level: number | null) {
    if (level === null) return 'battery';
    return level > 60 ? 'battery-3' : level > 30 ? 'battery-2' : level > 10 ? 'battery-1' : 'battery-exclamation';
}

/* Fitness trackers are not kibbl. devices: they reach the server through the Google
 * account they sync to (Health), so they are listed on their own, without actions. */
function renderTrackers() {
    const slot = document.getElementById('trackers');
    if (!slot || !trackers) return;
    if (!trackers.linked) {
        slot.innerHTML = `<div class="card mb-4"><div class="card-body d-flex flex-wrap align-items-center gap-3">
            <span class="hud-icon hud-plum"><i class="ti ti-device-watch"></i></span>
            <div class="flex-fill"><div class="fw-bold">Fitness tracker</div>
                <div class="text-secondary small">Connect the Google account your tracker syncs to, and it appears here with its battery and last sync.</div></div>
            <a class="btn" href="/health"><i class="ti ti-heartbeat me-1"></i> Health</a>
        </div></div>`;
        return;
    }
    const rows = trackers.trackers
        .map((t) => {
            const synced = t.lastSync ? Date.parse(t.lastSync) : null;
            // a tracker syncs several times an hour while it is near the phone
            const stale = synced !== null && Date.now() - synced > 24 * 3600_000;
            return `<tr>
                <td><div class="d-flex align-items-center gap-3">
                    <span class="avatar bg-purple-lt"><i class="ti ti-${t.type === 'TRACKER' ? 'device-watch' : 'device-mobile'}"></i></span>
                    <div><div class="fw-bold">${escapeHtml(t.name)}</div><div class="text-secondary small">${escapeHtml(t.type.toLowerCase())} · through Google Health</div></div>
                </div></td>
                <td><i class="ti ti-${batteryIcon(t.battery)} me-1 ${t.battery !== null && t.battery <= 15 ? 'text-danger' : ''}"></i>${t.battery === null ? '–' : `${t.battery} %`}</td>
                <td class="${stale ? 'text-warning' : 'text-secondary'}">${synced ? `synced ${timeAgo(synced)}` : 'not synced yet'}</td>
                <td class="text-end"><a class="btn btn-sm" href="/health"><i class="ti ti-heartbeat me-1"></i> Health</a></td>
            </tr>`;
        })
        .join('');
    slot.innerHTML = `<div class="card mb-4">
        <div class="card-header"><h3 class="card-title">Trackers</h3></div>
        ${
            trackers.trackers.length
                ? `<div class="table-responsive"><table class="table table-vcenter card-table">
                    <thead><tr><th>Tracker</th><th>Battery</th><th>Sync</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
                : `<div class="card-body text-secondary">Google Health is connected; the trackers show after its first sync.</div>`
        }
    </div>`;
}

async function loadTrackers() {
    try {
        const res = await fetch('/api/health/trackers');
        if (!res.ok) return;
        trackers = await res.json();
        renderTrackers();
    } catch {
        // the devices page works without them
    }
}

function result(html: string) {
    byId('result').innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function onAction(action: string, deviceId: string) {
    if (action === 'usb') {
        setupOverUsb(() => devices);
        return;
    }
    if (action === 'claim') {
        byId('claim-panel').classList.toggle('d-none');
        byId('claim-code').focus();
        return;
    }
    const d = devices.find((x) => x._id === deviceId);
    if (!d) return;

    if (action === 'wifi') {
        changeWifiRemotely(d);
        return;
    }

    if (action === 'approve') {
        const res = await request<{ ok: boolean; error?: string }>('approveDevice', deviceId);
        result(res.ok ? successAlert(`${d.name} is part of your home now.`) : errorAlert(res.error ?? 'Not approved.'));
    } else if (action === 'rename') {
        const name = prompt('New name', d.name)?.trim();
        if (!name) return;
        const res = await request<{ ok: boolean; error?: string }>('renameDevice', deviceId, name);
        if (!res.ok) result(errorAlert(res.error ?? 'Not renamed.'));
    } else if (action === 'blink') {
        const res = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, { cmd: 'blink', count: 5, level: 60 });
        if (!res.ok) result(errorAlert(res.error ?? 'No blink.'));
    } else if (action === 'reboot') {
        const res = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, { cmd: 'reboot' });
        result(res.ok ? successAlert(`${d.name} restarts.`) : errorAlert(res.error ?? 'No restart.'));
    } else if (action === 'remove') {
        const what = d.status === 'pending' ? 'Reject' : 'Remove';
        if (!confirm(`${what} ${d.name}? Its recorded activity and snapshots are deleted. It can pair again and wait for approval.`)) return;
        const res = await request<{ ok: boolean }>('removeDevice', deviceId);
        if (!res.ok) result(errorAlert('Not removed.'));
    } else if (action === 'update') {
        const input = byId<HTMLInputElement>('firmware-file');
        input.value = '';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            result(`<div class="alert alert-info">Uploading ${escapeHtml(file.name)} to ${escapeHtml(d.name)}<span class="animated-dots"></span></div>`);
            const form = new FormData();
            form.append('firmware', file);
            const response = await fetch(`/api/devices/${deviceId}/firmware`, { method: 'POST', body: form });
            if (response.ok) {
                const { version } = await response.json();
                result(successAlert(`${d.name} is installing ${version}. It restarts by itself in about a minute.`));
            } else {
                result(errorAlert(await response.text()));
            }
        };
        input.click();
    }
}

async function load() {
    devices = await request<DeviceSummary[]>('getDevices');
    render();
    if (!trackers) loadTrackers();
    if (!meters) loadMeters();
    if (usbSupported()) offerPluggedDevice();
}

/* A device plugged in on a port this site may already use: offered right away. A new
 * kind of adapter needs the button once (the browser asks which port). */
async function offerPluggedDevice() {
    const ports = await knownPorts();
    const slot = document.getElementById('usb-plugged');
    if (!slot || ports.length === 0) return;
    slot.innerHTML = `<div class="alert alert-info d-flex align-items-center">
        <i class="ti ti-usb me-2"></i><div class="flex-fill">A device is plugged into this computer.</div>
        <button class="btn btn-sm btn-primary" id="usb-plugged-setup">Set it up</button></div>`;
    document.getElementById('usb-plugged-setup')!.addEventListener('click', () => {
        slot.innerHTML = '';
        setupOverUsb(() => devices, ports[ports.length - 1]);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // a device set up over its own Wi-Fi: the code its setup page showed
    byId('container').addEventListener('submit', async (e) => {
        if ((e.target as HTMLElement).id !== 'claim-form') return;
        e.preventDefault();
        const code = byId<HTMLInputElement>('claim-code').value;
        const name = byId<HTMLInputElement>('claim-name').value.trim();
        const res = await request<{ ok: boolean; error?: string; deviceId?: string }>('claimDevice', code, name);
        if (!res.ok) {
            result(errorAlert(res.error ?? 'Not added.'));
            return;
        }
        const added = devices.find((d) => d._id === res.deviceId);
        const link = added?.caps.includes('air')
            ? ` <a href="/air/${res.deviceId}">Open it</a>`
            : added?.caps.includes('camera')
              ? ` <a href="/camera/${res.deviceId}">Live view</a>`
              : '';
        result(successAlert(`${escapeHtml(name)} is part of your home now.${link}`));
    });

    byId('container').addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!el || el.classList.contains('disabled')) return;
        e.preventDefault();
        onAction(el.dataset.action!, el.dataset.device!);
    });
});

/* The table scrolls sideways on a phone (.table-responsive): its overflow would cut
 * off the Actions menu, so the menu is positioned fixed (data-bs-popper-config). A
 * device update re-renders the list; while a menu is open that waits until it closes. */
let renderWhenClosed = false;

function renderUnlessMenuOpen() {
    const kept = byId('result')?.innerHTML ?? '';
    if (document.querySelector('#container .dropdown-menu.show')) {
        renderWhenClosed = true;
        return;
    }
    render();
    byId('result').innerHTML = kept;
}

document.addEventListener('hidden.bs.dropdown', () => {
    if (renderWhenClosed) {
        renderWhenClosed = false;
        renderUnlessMenuOpen();
    }
});

socket.on('connect', load);
if (usbSupported()) {
    onUsbPlugged(() => offerPluggedDevice());
}
socket.on('deviceUpdate', (device: DeviceSummary) => {
    const i = devices.findIndex((d) => d._id === device._id);
    if (i >= 0) devices[i] = device;
    else devices.push(device);
    renderUnlessMenuOpen(); // keeps a message the user is reading
});
socket.on('meterUpdate', () => loadMeters());
socket.on('deviceRemoved', (deviceId: string) => {
    devices = devices.filter((d) => d._id !== deviceId);
    renderUnlessMenuOpen();
});
