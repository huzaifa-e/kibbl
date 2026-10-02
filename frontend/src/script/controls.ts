import type { DeviceSummary } from '../../../shared/protocol';
import { request } from './socket';
import { escapeHtml } from './utils';

/* The controls of a device, built from the capabilities it reports: the camera's
 * flash led today, the feeder, switches and heating of docs/protocol.md once those
 * devices exist. A device with a new capability needs a block here, nothing else. */
export function controlsHtml(d: DeviceSummary) {
    const disabled = d.online ? '' : 'disabled';
    const blocks: string[] = [];

    if (d.caps.includes('light')) {
        blocks.push(`<div class="mb-3">
            <label class="form-label d-flex"><span class="flex-fill"><i class="ti ti-bulb me-1"></i> Light</span><span class="text-secondary" data-light-value="${d._id}">${d.light ?? 0} %</span></label>
            <input type="range" class="form-range" min="0" max="100" step="5" value="${d.light ?? 0}" data-control="light" data-device="${d._id}" ${disabled} />
        </div>`);
    }
    if (d.caps.includes('feeder')) {
        blocks.push(`<div class="mb-3">
            <button class="btn btn-primary w-100" data-control="feed" data-device="${d._id}" ${disabled}><i class="ti ti-bowl me-1"></i> Feed one portion</button>
        </div>`);
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
        }
    });

    root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-control]');
        const deviceId = el?.dataset.device;
        if (!el || !deviceId) return;
        e.stopPropagation();
        if (el.dataset.control === 'feed') {
            send(deviceId, { cmd: 'feed', portions: 1 });
        } else if (el.dataset.control === 'thermostat') {
            const input = root.querySelector<HTMLInputElement>(`[data-thermostat-input="${deviceId}"]`);
            send(deviceId, { cmd: 'thermostat', target: Number(input?.value) });
        }
    });
}
