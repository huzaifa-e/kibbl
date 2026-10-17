import { climateHints } from '../../../shared/climate';
import {
    FEEDER_ACCEL,
    FEEDER_MAX_MM,
    FEEDER_MIN_MM,
    FEEDER_SPEED,
    feedLevels,
    rgbPresets,
    roomClimate,
    type AirLevel,
    type DeviceSummary,
} from '../../../shared/protocol';
import { feedLevelAnimHtml, followFeeder, irisSvg, previewIris } from './iris';
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

// the feeders whose tuning is unfolded: the card is redrawn with every update
const tuningOpen = new Set<string>();

// tuning a feeder: speed and acceleration of its motor, steps by hand, the zero
function feederTuningHtml(d: DeviceSummary, disabled: string, busy: string) {
    const f = d.feeder;
    const speed = f?.speed ?? 2400;
    const accel = f?.accel ?? 8000;
    const rpm = (speed / 4096) * 60;
    const jog = (steps: number) =>
        `<button class="btn btn-sm" data-control="feeder-move" data-steps="${steps}" data-device="${d._id}" ${disabled} ${busy}>${steps > 0 ? '+' : ''}${steps}</button>`;
    return `<details class="mb-3" data-feeder-tuning="${d._id}" ${tuningOpen.has(d._id) ? 'open' : ''}>
        <summary class="text-secondary small"><i class="ti ti-adjustments me-1"></i> Tuning · ${f?.position ?? '–'} steps, ${speed} steps/s</summary>
        <div class="mt-2">
            <label class="form-label d-flex small"><span class="flex-fill">Speed</span><span data-feeder-speed="${d._id}">${speed} steps/s · ${rpm.toFixed(0)} rpm</span></label>
            <input type="range" class="form-range" min="${FEEDER_SPEED.min}" max="${FEEDER_SPEED.max}" step="100" value="${speed}" data-control="feeder-speed" data-device="${d._id}" ${disabled} ${busy} />
            <label class="form-label d-flex small mt-2"><span class="flex-fill">Acceleration</span><span data-feeder-accel="${d._id}">${accel} steps/s²</span></label>
            <input type="range" class="form-range" min="${FEEDER_ACCEL.min}" max="${FEEDER_ACCEL.max}" step="200" value="${accel}" data-control="feeder-accel" data-device="${d._id}" ${disabled} ${busy} />
            <div class="small text-secondary mt-2 mb-1">Steps by hand (+ closes; the stroke is 1792)</div>
            <div class="btn-group w-100">${[-200, -50, 50, 200].map(jog).join('')}</div>
            <button class="btn btn-sm w-100 mt-2" data-control="feeder-home" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-target me-1"></i> Find the zero (fully open, into the stop)</button>
            <div class="small text-secondary mt-3 mb-1">Limits in steps: open is 0, the iris stands at ${f?.position ?? '–'}</div>
            <div class="input-group input-group-sm">
                <span class="input-group-text">Closed at</span>
                <input type="number" class="form-control" step="1" value="${f?.closedPos ?? ''}" data-feeder-closed="${d._id}" ${disabled} ${busy} />
                <span class="input-group-text">steps</span>
                <button class="btn" data-control="feeder-closed" data-device="${d._id}" ${disabled} ${busy}>Save</button>
            </div>
            <button class="btn btn-sm w-100 mt-2" data-control="feeder-zero" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-map-pin me-1"></i> Set zero here (this is fully open)</button>
            <div class="small text-secondary mt-3 mb-1">Or teach them under load: run, then stop where it should end</div>
            <div class="btn-group w-100">
                <button class="btn btn-sm" data-control="feeder-run" data-direction="close" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-player-play me-1"></i> Run closing</button>
                <button class="btn btn-sm" data-control="feeder-run" data-direction="open" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-player-play me-1"></i> Run opening</button>
            </div>
            <button class="btn btn-sm btn-danger w-100 mt-2" data-control="feeder-stop" data-device="${d._id}" ${disabled}><i class="ti ti-player-stop me-1"></i> Stop${f?.job === 'run' ? ' and keep as the limit' : ''}</button>
            <button class="btn btn-sm w-100 mt-2" data-control="feeder-release" data-device="${d._id}" ${disabled} ${busy}><i class="ti ti-hand-stop me-1"></i> Motor off for 10 s (turns by hand)</button>
        </div>
    </details>`;
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
    const tuning = { speed: f?.speed, accel: f?.accel, closedPos: f?.closedPos };
    followFeeder(d._id, f);
    return `<div class="mb-3">
            <label class="form-label d-flex align-items-center gap-2">${irisSvg(opening, 36, `data-feeder-iris="${d._id}"`)}<span class="flex-fill">Opening</span><span data-feeder-value="${d._id}">${state}</span></label>
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
                        <span class="small text-secondary">${l.portions} × ${l.opening} mm, held ${l.openMs / 1000} s</span>
                        ${feedLevelAnimHtml(d._id, l, tuning)}
                    </button></div>`,
                )
                .join('')}</div>
        </div>
        ${feederTuningHtml(d, disabled, busy)}`;
}

const hex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const rgbOf = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));

// the swatches of a kibbl. light, besides the picker
const quickColors = ['warm', 'white', 'orange', 'red', 'purple', 'blue', 'cyan', 'green'];

// a kibbl. light: on or off, its colour and its brightness
function rgbHtml(d: DeviceSummary, disabled: string) {
    const s = d.rgb;
    const color = s ? hex(s.color) : '#ffffff';
    const brightness = s?.brightness ?? 60;
    return `<div class="mb-3">
        <div class="d-flex align-items-center mb-2">
            <label class="form-check form-switch mb-0 flex-fill">
                <input class="form-check-input" type="checkbox" data-control="rgb-on" data-device="${d._id}" ${s?.on ? 'checked' : ''} ${disabled} />
                <span class="form-check-label"><i class="ti ti-bulb me-1"></i> Light</span>
            </label>
            <input type="color" class="form-control form-control-color" value="${color}" data-control="rgb-color" data-device="${d._id}" title="Colour" ${disabled} />
        </div>
        <div class="d-flex flex-wrap gap-1 mb-2">${quickColors
            .map(
                (name) =>
                    `<button class="btn btn-icon btn-sm" style="background:${hex(rgbPresets[name])}" title="${name}" aria-label="${name}" data-control="rgb-preset" data-color="${name}" data-device="${d._id}" ${disabled}></button>`,
            )
            .join('')}</div>
        <label class="form-label d-flex"><span class="flex-fill">Brightness</span><span class="text-secondary" data-rgb-value="${d._id}">${brightness} %</span></label>
        <input type="range" class="form-range" min="1" max="100" value="${brightness}" data-control="rgb-brightness" data-device="${d._id}" ${disabled} />
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
    if (d.caps.includes('rgb')) {
        blocks.push(rgbHtml(d, disabled));
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
    // the tuning of a feeder stays unfolded through the redraws
    root.addEventListener(
        'toggle',
        (e) => {
            const el = e.target as HTMLDetailsElement;
            const id = el.dataset?.feederTuning;
            if (!id) return;
            if (el.open) tuningOpen.add(id);
            else tuningOpen.delete(id);
        },
        true,
    );
    const send = async (deviceId: string, command: Record<string, unknown>) => {
        const result = root.querySelector<HTMLElement>(`[data-control-result="${deviceId}"]`);
        const resp = await request<{ ok: boolean; error?: string }>('deviceCommand', deviceId, command);
        if (result) {
            result.innerHTML = resp.ok ? '' : `<div class="text-danger small mt-1">${escapeHtml(resp.error ?? 'failed')}</div>`;
        }
        return resp;
    };

    // the colour while the picker is dragged: at most a few changes a second, the last one always
    const colorTimers = new Map<string, number>();
    const sendColor = (deviceId: string, value: string, fadeMs: number) => {
        window.clearTimeout(colorTimers.get(deviceId));
        colorTimers.set(
            deviceId,
            window.setTimeout(() => send(deviceId, { cmd: 'rgb', on: true, color: rgbOf(value), fadeMs }), 150),
        );
    };

    root.addEventListener('input', (e) => {
        const el = e.target as HTMLInputElement;
        if (el.dataset.control === 'rgb-color' && el.dataset.device) {
            sendColor(el.dataset.device, el.value, 150);
        } else if (el.dataset.control === 'rgb-brightness') {
            const value = root.querySelector(`[data-rgb-value="${el.dataset.device}"]`);
            if (value) value.textContent = `${el.value} %`;
        } else if (el.dataset.control === 'light') {
            const value = root.querySelector(`[data-light-value="${el.dataset.device}"]`);
            if (value) value.textContent = `${el.value} %`;
        } else if (el.dataset.control === 'iris') {
            const value = root.querySelector(`[data-feeder-value="${el.dataset.device}"]`);
            if (value) value.textContent = Number(el.value) <= FEEDER_MIN_MM ? 'closed' : `open ${el.value} mm`;
            previewIris(el.dataset.device ?? '', Number(el.value));
        } else if (el.dataset.control === 'feeder-speed') {
            const value = root.querySelector(`[data-feeder-speed="${el.dataset.device}"]`);
            if (value) value.textContent = `${el.value} steps/s · ${((Number(el.value) / 4096) * 60).toFixed(0)} rpm`;
        } else if (el.dataset.control === 'feeder-accel') {
            const value = root.querySelector(`[data-feeder-accel="${el.dataset.device}"]`);
            if (value) value.textContent = `${el.value} steps/s²`;
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
        } else if (el.dataset.control === 'rgb-on') {
            send(deviceId, { cmd: 'rgb', on: el.checked });
        } else if (el.dataset.control === 'rgb-color') {
            sendColor(deviceId, el.value, 400);
        } else if (el.dataset.control === 'rgb-brightness') {
            send(deviceId, { cmd: 'rgb', on: true, brightness: Number(el.value) });
        } else if (el.dataset.control === 'night') {
            send(deviceId, { cmd: 'night', on: el.checked });
        } else if (el.dataset.control === 'iris') {
            send(deviceId, { cmd: 'iris', opening: Number(el.value) });
        } else if (el.dataset.control === 'feeder-speed') {
            send(deviceId, { cmd: 'feeder_config', speed: Number(el.value) });
        } else if (el.dataset.control === 'feeder-accel') {
            send(deviceId, { cmd: 'feeder_config', accel: Number(el.value) });
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
        } else if (el.dataset.control === 'feeder-move') {
            send(deviceId, { cmd: 'feeder_move', steps: Number(el.dataset.steps) });
        } else if (el.dataset.control === 'feeder-home') {
            send(deviceId, { cmd: 'feeder_home' });
        } else if (el.dataset.control === 'feeder-run') {
            send(deviceId, { cmd: 'feeder_run', direction: el.dataset.direction });
        } else if (el.dataset.control === 'feeder-closed') {
            const input = root.querySelector<HTMLInputElement>(`[data-feeder-closed="${deviceId}"]`);
            const steps = Math.round(Number(input?.value));
            if (steps) send(deviceId, { cmd: 'feeder_config', closedPos: steps });
        } else if (el.dataset.control === 'feeder-zero') {
            send(deviceId, { cmd: 'feeder_zero' });
        } else if (el.dataset.control === 'feeder-stop') {
            send(deviceId, { cmd: 'feeder_stop' });
        } else if (el.dataset.control === 'feeder-release') {
            send(deviceId, { cmd: 'feeder_release', ms: 10000 });
        } else if (el.dataset.control === 'lamp') {
            void send(deviceId, { cmd: 'lamp', mode: el.dataset.mode }).then((resp) => {
                if (resp.ok) el.parentElement?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === el));
            });
        } else if (el.dataset.control === 'rgb-preset') {
            const color = rgbPresets[el.dataset.color ?? ''];
            if (color) send(deviceId, { cmd: 'rgb', on: true, color });
        } else if (el.dataset.control === 'thermostat') {
            const input = root.querySelector<HTMLInputElement>(`[data-thermostat-input="${deviceId}"]`);
            send(deviceId, { cmd: 'thermostat', target: Number(input?.value) });
        }
    });
}
