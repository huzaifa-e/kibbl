import './main';
import type { DeviceSummary } from '../../../shared/protocol';
import { request, socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml, successAlert, timeAgo } from './utils';

let devices: DeviceSummary[] = [];

const capabilityLabels: Record<string, string> = {
    camera: 'camera',
    light: 'light',
    ota: 'updates',
    switch: 'switch',
    feeder: 'pet feeder',
    thermostat: 'heating',
};

function pendingCard(d: DeviceSummary) {
    return `<div class="col-md-6">
        <div class="card card-sm border-warning">
            <div class="card-body">
                <div class="d-flex align-items-center mb-2">
                    <span class="avatar bg-orange-lt me-3"><i class="ti ti-plug-connected"></i></span>
                    <div class="flex-fill">
                        <div class="fw-bold">${escapeHtml(d.model ?? 'New device')} ${d.sensor ? `· ${escapeHtml(d.sensor)}` : ''}</div>
                        <div class="text-secondary small">id <span class="text-mono">${escapeHtml(d._id)}</span> · first seen ${timeAgo(d.createdAt)}</div>
                    </div>
                    <span class="badge ${d.online ? 'bg-green-lt' : 'bg-secondary-lt'}">${d.online ? 'online' : 'offline'}</span>
                </div>
                <div class="text-secondary small mb-3">Approve only a device you set up yourself: compare the id with the one the device prints on its serial port.</div>
                <div class="btn-list">
                    <button class="btn btn-success" data-action="approve" data-device="${d._id}"><i class="ti ti-check me-1"></i> Approve</button>
                    <button class="btn btn-outline-danger" data-action="remove" data-device="${d._id}"><i class="ti ti-x me-1"></i> Reject</button>
                </div>
            </div>
        </div>
    </div>`;
}

function deviceRow(d: DeviceSummary) {
    const caps = d.caps.map((c) => `<span class="badge bg-blue-lt me-1">${escapeHtml(capabilityLabels[c] ?? c)}</span>`).join('');
    return `<tr data-row="${d._id}">
        <td>
            <div class="d-flex align-items-center">
                <span class="avatar me-2 ${d.online ? 'bg-green-lt' : 'bg-secondary-lt'}"><i class="ti ti-${d.caps.includes('camera') ? 'device-cctv' : 'cpu'}"></i></span>
                <div>
                    <div class="fw-bold">${escapeHtml(d.name)}</div>
                    <div class="text-secondary small text-mono">${escapeHtml(d._id)}</div>
                </div>
            </div>
        </td>
        <td>${d.online ? '<span class="status status-green"><span class="status-dot status-dot-animated"></span> online</span>' : `<span class="status status-secondary">offline</span><div class="text-secondary small">${d.lastSeen ? timeAgo(d.lastSeen) : ''}</div>`}</td>
        <td class="d-none d-md-table-cell">${caps}</td>
        <td class="d-none d-lg-table-cell text-mono small">${escapeHtml(d.fw ?? '–')}</td>
        <td class="text-end">
            <div class="dropdown">
                <button class="btn btn-sm dropdown-toggle" data-bs-toggle="dropdown">Actions</button>
                <div class="dropdown-menu dropdown-menu-end">
                    ${d.caps.includes('camera') ? `<a class="dropdown-item" href="/camera/${d._id}"><i class="ti ti-video me-2"></i> Live view</a>` : ''}
                    <a class="dropdown-item" href="#" data-action="rename" data-device="${d._id}"><i class="ti ti-pencil me-2"></i> Rename</a>
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

    byId('container').innerHTML = `
        <div id="result"></div>
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
        <div class="row row-cards">
            <div class="col-lg-7">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Add a camera</h3></div>
                    <div class="card-body">
                        <ol class="mb-0">
                            <li class="mb-2">Flash the firmware (<span class="text-mono">firmware/</span> in the repository) and power the ESP32-CAM.</li>
                            <li class="mb-2">It opens the Wi-Fi <b>HM-xxxxxx</b>. Connect it to your home Wi-Fi with the <b>ESP SoftAP Prov</b> app (proof of possession <span class="text-mono">hm-setup</span>), or over USB with <span class="text-mono">{"cmd":"wifi","ssid":"…","password":"…"}</span>.</li>
                            <li class="mb-2">The camera connects to this server and appears here under <i>Waiting for approval</i>.</li>
                            <li>Approve it. Power it off and on three times within ten seconds each to connect it to another Wi-Fi.</li>
                        </ol>
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
}

function result(html: string) {
    byId('result').innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function onAction(action: string, deviceId: string) {
    const d = devices.find((x) => x._id === deviceId);
    if (!d) return;

    if (action === 'approve') {
        const res = await request<{ ok: boolean; error?: string }>('approveDevice', deviceId);
        result(res.ok ? successAlert(`${d.name} is part of your home now.`) : errorAlert(res.error ?? 'Not approved.'));
    } else if (action === 'rename') {
        const name = prompt('New name', d.name)?.trim();
        if (!name) return;
        const res = await request<{ ok: boolean; error?: string }>('renameDevice', deviceId, name);
        if (!res.ok) result(errorAlert(res.error ?? 'Not renamed.'));
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
}

document.addEventListener('DOMContentLoaded', () => {
    byId('container').addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!el || el.classList.contains('disabled')) return;
        e.preventDefault();
        onAction(el.dataset.action!, el.dataset.device!);
    });
});

socket.on('connect', load);
socket.on('deviceUpdate', (device: DeviceSummary) => {
    const i = devices.findIndex((d) => d._id === device._id);
    if (i >= 0) devices[i] = device;
    else devices.push(device);
    // keep a message the user is reading
    const kept = byId('result')?.innerHTML ?? '';
    render();
    byId('result').innerHTML = kept;
});
socket.on('deviceRemoved', (deviceId: string) => {
    devices = devices.filter((d) => d._id !== deviceId);
    const kept = byId('result')?.innerHTML ?? '';
    render();
    byId('result').innerHTML = kept;
});
