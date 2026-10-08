import { climateHints } from '../../../shared/climate';
import { FEEDER_MAX_MM, FEEDER_MIN_MM, feedLevels, roomClimate, type AirLevel, type DeviceSummary } from '../../../shared/protocol';
import { request } from './socket';
import { escapeHtml } from './utils';

/* The controls of a device, built from the capabilities it reports: the camera's
 * flash led today, the feeder, switches and heating of docs/protocol.md once those
 * devices exist. A device with a new capability needs a block here, nothing else. */
export const levelColors: Record<AirLevel, string> = {
    none: 'var(--tblr-secondary)',
    green: 'var(--tblr-green)',
    yellow: 'var(--tblr-yellow)',
    red: 'var(--tblr-red)',
};

// the lamp looks the home card offers; the device page has all of them and the colours
const quickLamps = [
    { mode: 'traffic', icon: 'traffic-lights', label: 'Air' },
    { mode: 'warm', icon: 'bulb', label: 'Warm' },
    { mode: 'off', icon: 'bulb-off', label: 'Off' },
];

// the air now: CO2 in the colour of the traffic light, temperature, humidity, the window
export function airNowHtml(d: DeviceSummary) {
    const s = d.air?.state;
    if (!d.online || !s) return `<div class="text-secondary">offline${d.lastSeen ? ' since ' + new Date(d.lastSeen).toLocaleString() : ''}</div>`;
    if (d.air?.sensorError) return `<div class="text-danger"><i class="ti ti-alert-triangle"></i> ${escapeHtml(d.air.sensorError)}</div>`;
    const co2 = s.co2 === undefined ? '–' : String(s.co2);
    // the most pressing health hint of the climate, without the weather outside (the device page has it)
    const climate = roomClimate(d.air);
    const worst = climateHints({ ...s, ...climate }).find((h) => h.level === 'alert' || h.level === 'warn');
    return `<div class="d-flex align-items-baseline gap-2 mb-1">
            <i class="ti ti-circle-filled" style="color:${levelColors[s.level]}"></i>
            <span class="stat-value">${co2}</span><span class="text-secondary">ppm CO₂</span>
        </div>
        <div class="text-secondary small">
            ${climate.temperature !== undefined ? `<i class="ti ti-temperature"></i> ${climate.temperature.toFixed(1)} °C · ` : ''}${climate.humidity !== undefined ? `<i class="ti ti-droplet"></i> ${Math.round(climate.humidity)} %` : ''}
            ${s.window === 'open' ? ` · <span class="text-orange"><i class="ti ti-window"></i> window open</span>` : ''}
            ${s.night ? ` · <i class="ti ti-moon"></i> night` : ''}
        </div>
        ${worst ? `<div class="small mt-1 ${worst.level === 'alert' ? 'text-danger' : 'text-orange'}"><i class="ti ti-${worst.icon}"></i> ${escapeHtml(worst.title)}</div>` : ''}`;
}

// a kibbl. feeder: where the iris is, a slider to set it, and the feeding levels
function feederHtml(d: DeviceSummary, disabled: string) {
    const f = d.feeder;
    const opening = f?.opening ?? FEEDER_MIN_MM;
    const busy = f?.busy ? 'disabled' : '';
    const state = !d.online
        ? `<span class="text-secondary">offline: the feeder's controller is not connected</span>`
        : f?.busy
          ? `<span class="text-orange"><span class="spinner-border spinner-border-sm me-1"></span> ${f.job === 'feed' ? 'feeding' : 'moving'}…</span>`
          : `<span class="text-secondary">${opening <= FEEDER_MIN_MM + 0.5 ? 'closed' : `open ${opening.toFixed(0)} mm`}</span>`;
    return `<div class="mb-3">
            <label class="form-label d-flex"><span class="flex-fill"><i class="ti ti-aperture me-1"></i> Opening</span><span data-feeder-value="${d._id}">${state}</span></label>
            <input type="range" class="form-range" min="${FEEDER_MIN_MM}" max="${FEEDER_MAX_MM}" step="1" value="${Math.round(opening)}" data-control="iris" data-device="${d._id}" ${disabled} ${busy} />
            <div class="d-flex justify-content-between small text-secondary"><span>closed</span><span>${FEEDER_MAX_MM} mm</span></div>
            <div class="btn-group w-100 mt-2">
                <button class="btn btn-sm" data-control="iris-set" data-opening="${FEEDER_MIN_MM}" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-circle-dot me-1"></i> Close</button>
                <button class="btn btn-sm" data-control="iris-set" data-opening="${FEEDER_MAX_MM}" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-circle me-1"></i> Open</button>
            </div>
        </div>
        <div class="mb-3">
            <label class="form-label"><i class="ti ti-bowl me-1"></i> Feed</label>
            <div class="row g-2">${feedLevels
                .map(
                    (l) => `<div class="col-6"><button class="btn w-100 flex-column py-2" data-control="feed" data-level="${l.id}" data-device="${d._id}" ${disabled} ${busy}>
                        <span class="fw-bold">${l.label}</span>
                        <span class="small text-secondary">${l.portions} × ${l.opening} mm, ${l.openMs / 1000} s</span>
                    </button></div>`,
                )
                .join('')}</div>
        </div>`;
}

// airNow: the air values on top; the home card of a kibbl. air shows them itself
export function controlsHtml(d: DeviceSummary, airNow = true) {
    const disabled = d.online ? '' : 'disabled';
    const blocks: string[] = [];

    if (d.caps.includes('air') && airNow) {
        blocks.push(`<div class="mb-3" data-air-now="${d._id}">${airNowHtml(d)}</div>`);
    }
    if (d.caps.includes('lamp')) {
        const mode = d.air?.lamp?.mode;
        blocks.push(
            `<div class="mb-3 btn-group w-100">${quickLamps
                .map(
                    (l) =>
                        `<button class="btn btn-sm ${mode === l.mode ? 'active' : ''}" data-control="lamp" data-mode="${l.mode}" data-device="${d._id}" ${disabled}><i class="ti ti-${l.icon} me-1"></i> ${l.label}</button>`,
                )
                .join('')}</div>`,
        );
    }
    if (d.caps.includes('night')) {
        blocks.push(`<div class="mb-3 d-flex align-items-center">
            <label class="form-check form-switch mb-0 flex-fill">
                <input class="form-check-input" type="checkbox" data-control="night" data-device="${d._id}" ${d.air?.state?.night ? 'checked' : ''} ${disabled} />
                <span class="form-check-label"><i class="ti ti-moon me-1"></i> Night mode</span>
            </label>
            <a href="/air/${d._id}" class="btn btn-sm">Details <i class="ti ti-chevron-right ms-1"></i></a>
        </div>`);
    }

    if (d.caps.includes('light')) {
        blocks.push(`<div class="mb-3">
            <label class="form-label d-flex"><span class="flex-fill"><i class="ti ti-bulb me-1"></i> Light</span><span class="text-secondary" data-light-value="${d._id}">${d.light ?? 0} %</span></label>
            <input type="range" class="form-range" min="0" max="100" step="5" value="${d.light ?? 0}" data-control="light" data-device="${d._id}" ${disabled} />
        </div>`);
    }
    if (d.caps.includes('feeder')) {
        blocks.push(feederHtml(d, disabled));
    }
    if (d.caps.includes('switch')) {
        blocks.push(`<div class="mb-3">
            <label class="form-check form-switch">
                <input class="form-check-input" type="checkbox" data-control="switch" data-device="${d._id}" ${disabled} />
                <span class="form-check-label">Power</span>
            </label>
        </div>`);
    }
    if (d.caps.includes('thermostat')) {
        blocks.push(`<div class="mb-3">
            <label class="form-label"><i class="ti ti-temperature me-1"></i> Target temperature</label>
            <div class="input-group">
                <input type="number" class="form-control" min="5" max="30" step="0.5" value="20" data-thermostat-input="${d._id}" ${disabled} />
                <button class="btn" data-control="thermostat" data-device="${d._id}" ${disabled}>Set</button>
            </div>
        </div>`);
    }
    if (!blocks.length) {
        return `<div class="text-secondary">${escapeHtml(d.name)} has no controls.</div>`;
    }
    return blocks.join('') + `<div data-control-result="${d._id}"></div>`;
}

export function bindControls(root: HTMLElement, lookup: (id: string) => DeviceSummary | undefined) {
    const send = async (deviceId: string, command: Record<string, unknown>) => {
        const result = root.querySelector<HTMLElement>(`[data-control-result="${deviceId}"]`);
        const resp = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, command);
        if (result) {
            result.innerHTML = resp.ok ? '' : `<div class="text-danger small mt-1">${escapeHtml(resp.error ?? 'failed')}</div>`;
        }
        return resp;
    };

    root.addEventListener('input', (e) => {
        const el = e.target as HTMLInputElement;
        if (el.dataset.control === 'light') {
            const value = root.querySelector(`[data-light-value="${el.dataset.device}"]`);
            if (value) value.textContent = `${el.value} %`;
        } else if (el.dataset.control === 'iris') {
            const value = root.querySelector(`[data-feeder-value="${el.dataset.device}"]`);
            if (value) value.textContent = Number(el.value) <= FEEDER_MIN_MM ? 'closed' : `open ${el.value} mm`;
        }
    });

    root.addEventListener('change', (e) => {
        const el = e.target as HTMLInputElement;
        const deviceId = el.dataset.device;
        if (!deviceId || !lookup(deviceId)) return;
        if (el.dataset.control === 'light') {
            send(deviceId, { cmd: 'light', level: Number(el.value) });
        } else if (el.dataset.control === 'switch') {
            send(deviceId, { cmd: 'switch', channel: 'main', on: el.checked });
        } else if (el.dataset.control === 'night') {
            send(deviceId, { cmd: 'night', on: el.checked });
        } else if (el.dataset.control === 'iris') {
            send(deviceId, { cmd: 'iris', opening: Number(el.value) });
        }
    });

    root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-control]');
        const deviceId = el?.dataset.device;
        if (!el || !deviceId) return;
        e.stopPropagation();
        if (el.dataset.control === 'feed') {
            const level = feedLevels.find((l) => l.id === el.dataset.level) ?? feedLevels[0];
            send(deviceId, { cmd: 'feed', portions: level.portions, opening: level.opening, openMs: level.openMs });
        } else if (el.dataset.control === 'iris-set') {
            send(deviceId, { cmd: 'iris', opening: Number(el.dataset.opening) });
        } else if (el.dataset.control === 'lamp') {
            void send(deviceId, { cmd: 'lamp', mode: el.dataset.mode }).then((resp) => {
                if (resp.ok) el.parentElement?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === el));
            });
        } else if (el.dataset.control === 'thermostat') {
            const input = root.querySelector<HTMLInputElement>(`[data-thermostat-input="${deviceId}"]`);
            send(deviceId, { cmd: 'thermostat', target: Number(input?.value) });
        }
    });
}
