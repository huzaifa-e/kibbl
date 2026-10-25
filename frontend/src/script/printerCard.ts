import { printActive, printSpeeds, printStateLabels, type DeviceSummary, type PrinterState } from '../../../shared/protocol';
import { escapeHtml, formatTime } from './utils';

/* A Bambu Lab printer that a kibbl. cam on its network logs into (docs/printer.md): the print
 * now, its temperatures and spools, pause, resume, stop, the light and the speed; on a camera
 * without one the form to add it. The live part is redrawn with every telemetry, the buttons
 * and the form only when the device changes. */

const stateColors: Record<string, string> = {
    running: 'bg-blue-lt',
    prepare: 'bg-blue-lt',
    slicing: 'bg-blue-lt',
    pause: 'bg-yellow-lt',
    finish: 'bg-green-lt',
    failed: 'bg-red-lt',
};

function minutes(m: number) {
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

const temp = (now: number | undefined, target?: number) => (now === undefined ? '–' : `${Math.round(now)}${target ? ` / ${Math.round(target)}` : ''} °C`);

export function printerStateBadge(p: PrinterState | undefined) {
    if (!p?.configured) return '';
    if (!p.connected) return `<span class="badge bg-secondary-lt">not connected</span>`;
    const state = p.state ?? 'unknown';
    return `<span class="badge ${stateColors[state] ?? 'bg-secondary-lt'}">${printStateLabels[state]}</span>`;
}

// the print, the temperatures, the spools: what each telemetry changes
export function printerLiveHtml(p: PrinterState | undefined, online: boolean) {
    if (!online) return `<div class="text-secondary small">offline: the camera that reaches the printer is not connected</div>`;
    if (!p?.configured) return '';
    if (!p.connected) {
        return `<div class="text-danger small"><i class="ti ti-plug-connected-x me-1"></i> ${escapeHtml(p.error ?? 'not connected')} (${escapeHtml(p.host ?? '')})</div>`;
    }
    if (!p.state) return `<div class="text-secondary small">waiting for the printer's report…</div>`;

    const active = printActive(p.state);
    const parts: string[] = [];
    if (p.job && (active || p.state === 'finish' || p.state === 'failed')) {
        parts.push(`<div class="text-truncate fw-bold mb-1" title="${escapeHtml(p.job)}">${escapeHtml(p.job)}</div>`);
    }
    if (active) {
        const percent = p.percent ?? 0;
        const left = p.remainingMin ?? 0;
        parts.push(`<div class="progress progress-sm mb-1"><div class="progress-bar ${p.state === 'pause' ? 'bg-yellow' : ''}" style="width:${percent}%"></div></div>
            <div class="d-flex small text-secondary mb-2">
                <span class="flex-fill">${percent} %${p.layers ? ` · layer ${p.layer ?? 0} of ${p.layers}` : ''}</span>
                ${left > 0 ? `<span>${minutes(left)} left · ${formatTime(Date.now() + left * 60_000)}</span>` : ''}
            </div>`);
    }
    parts.push(`<div class="small text-secondary mb-2">
        <i class="ti ti-flame"></i> nozzle ${temp(p.nozzle, p.nozzleTarget)} · bed ${temp(p.bed, p.bedTarget)}${p.chamber !== undefined ? ` · chamber ${temp(p.chamber)}` : ''}
    </div>`);

    const spools = (p.ams ?? []).filter((t) => t.type);
    if (spools.length) {
        parts.push(
            `<div class="d-flex flex-wrap gap-2 mb-2">${spools
                .map((t) => {
                    const now = t.slot === p.trayNow;
                    return `<span class="d-inline-flex align-items-center gap-1 small ${now ? 'fw-bold' : 'text-secondary'}" title="Slot ${t.slot + 1}${now ? ', printing' : ''}">
                    <span class="avatar avatar-xs rounded-circle" style="background:#${t.color ?? '888888'};${now ? 'outline:2px solid var(--tblr-primary);outline-offset:1px' : ''}"></span>
                    ${escapeHtml(t.type)}${t.remain !== undefined ? ` ${t.remain} %` : ''}
                </span>`;
                })
                .join('')}</div>`,
        );
    }
    if (p.hms?.length) {
        parts.push(`<div class="small text-orange mb-2"><i class="ti ti-alert-triangle me-1"></i> The printer reports ${p.hms.join(', ')}</div>`);
    }
    return parts.join('');
}

// the address, serial and access code; the code is never shown again, left empty it stays
function printerFormHtml(d: DeviceSummary, disabled: string) {
    const p = d.printer;
    const field = (key: string, label: string, value: string, extra = '') =>
        `<div class="mb-2"><label class="form-label small mb-1">${label}</label>
            <input class="form-control form-control-sm" data-printer-field="${key}" data-device="${d._id}" value="${escapeHtml(value)}" ${extra} ${disabled} /></div>`;
    return `<div class="text-secondary small mb-2">On the printer's screen: the IP address and the access code under Settings → Network (LAN), the serial number under Settings → Device. The printer must be on the network of this camera.</div>
        ${field('host', 'IP address', p?.host ?? '', 'placeholder="192.168.0.40" autocomplete="off"')}
        ${field('serial', 'Serial number', p?.serial ?? '', 'placeholder="01P00A..." autocomplete="off"')}
        ${field('code', 'Access code', '', `type="password" autocomplete="new-password" placeholder="${p?.configured ? 'unchanged' : '8 characters'}"`)}
        <div class="d-flex gap-2">
            <button class="btn btn-sm btn-primary flex-fill" data-control="printer-save" data-device="${d._id}" ${disabled}><i class="ti ti-plug-connected me-1"></i> ${p?.configured ? 'Save' : 'Connect'}</button>
            ${p?.configured ? `<button class="btn btn-sm" data-control="printer-remove" data-device="${d._id}" ${disabled}>Remove printer</button>` : ''}
        </div>`;
}

// the stop asks once more: a second tap within a few seconds
const stopArmed = new Map<string, number>();

export function printerStopArmed(deviceId: string) {
    return (stopArmed.get(deviceId) ?? 0) > Date.now();
}

export function armPrinterStop(deviceId: string) {
    stopArmed.set(deviceId, Date.now() + 4000);
}

export function disarmPrinterStop(deviceId: string) {
    stopArmed.delete(deviceId);
}

// the block in a camera's controls: the printer, or the form to add one
export function printerHtml(d: DeviceSummary, disabled: string) {
    const p = d.printer;
    if (!p?.configured) {
        return `<details class="mb-3">
            <summary class="text-secondary small"><i class="ti ti-printer me-1"></i> Add a 3D printer (Bambu Lab, on this network)</summary>
            <div class="mt-2">${printerFormHtml(d, disabled)}</div>
        </details>`;
    }
    const ready = d.online && p.connected ? '' : 'disabled';
    const active = printActive(p.state);
    const buttons = active
        ? `<div class="btn-group w-100 mb-2">
            ${
                p.state === 'pause'
                    ? `<button class="btn btn-sm" data-control="printer-action" data-action="resume" data-device="${d._id}" ${ready}><i class="ti ti-player-play me-1"></i> Resume</button>`
                    : `<button class="btn btn-sm" data-control="printer-action" data-action="pause" data-device="${d._id}" ${ready}><i class="ti ti-player-pause me-1"></i> Pause</button>`
            }
            <button class="btn btn-sm ${printerStopArmed(d._id) ? 'btn-danger' : ''}" data-control="printer-stop" data-device="${d._id}" ${ready}><i class="ti ti-player-stop me-1"></i> ${printerStopArmed(d._id) ? 'Tap again to stop' : 'Stop'}</button>
        </div>`
        : '';
    const speed = active
        ? `<select class="form-select form-select-sm w-auto" data-control="printer-speed" data-device="${d._id}" ${ready} title="Speed">${printSpeeds
              .map((s) => `<option value="${s.level}" ${p.speed === s.level ? 'selected' : ''}>${s.label}</option>`)
              .join('')}</select>`
        : '';
    return `<div class="mb-3">
        <div class="d-flex align-items-center mb-2">
            <span class="flex-fill"><i class="ti ti-printer me-1"></i> 3D printer</span>
            <span data-printer-badge="${d._id}">${printerStateBadge(p)}</span>
        </div>
        <div data-printer-live="${d._id}">${printerLiveHtml(p, d.online)}</div>
        ${buttons}
        <div class="d-flex align-items-center gap-2">
            <label class="form-check form-switch mb-0 flex-fill">
                <input class="form-check-input" type="checkbox" data-control="printer-light" data-device="${d._id}" ${p.light ? 'checked' : ''} ${ready} />
                <span class="form-check-label"><i class="ti ti-bulb me-1"></i> Printer light</span>
            </label>
            ${speed}
        </div>
        <details class="mt-2">
            <summary class="text-secondary small">Printer connection · ${escapeHtml(p.host ?? '')}</summary>
            <div class="mt-2">${printerFormHtml(d, d.online ? '' : 'disabled')}</div>
        </details>
    </div>`;
}

// the card of the home page: the printer with the camera it is reached through
export function printerCardHtml(d: DeviceSummary) {
    return `<div class="card" data-printer-card="${d._id}">
        <div class="card-header"><h3 class="card-title">3D printer <span class="text-secondary small fw-normal">· via ${escapeHtml(d.name)}</span></h3></div>
        <div class="card-body">${printerHtml(d, d.online ? '' : 'disabled')}<div data-control-result="${d._id}"></div></div>
    </div>`;
}

// a telemetry of a camera with a printer: the live part and the badge, nothing the person may be typing in
export function updatePrinterLive(root: ParentNode, d: DeviceSummary) {
    root.querySelectorAll<HTMLElement>(`[data-printer-live="${d._id}"]`).forEach((el) => (el.innerHTML = printerLiveHtml(d.printer, d.online)));
    root.querySelectorAll<HTMLElement>(`[data-printer-badge="${d._id}"]`).forEach((el) => (el.innerHTML = printerStateBadge(d.printer)));
}

// the person is typing in the printer's form: a redraw would empty it
export function editingPrinter(deviceId: string) {
    const active = document.activeElement as HTMLElement | null;
    return !!active?.dataset.printerField && active.dataset.device === deviceId;
}

// what the buttons and the form depend on: these change, the block is drawn again
export function printerControlsKey(p: PrinterState | undefined) {
    return p ? JSON.stringify([p.configured, p.connected, p.host, p.serial, p.state, p.light, p.speed]) : '';
}
