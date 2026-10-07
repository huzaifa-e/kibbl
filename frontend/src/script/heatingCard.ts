import type { HeatingRoom, HeatingStatus } from '../../../shared/heating';
import { errorAlert, escapeHtml, timeAgo } from './utils';

/* The heating card of the home page: every room of tado with what it measures and heats to,
 * and the quick controls. + and - only change the number here; Set sends it: each change is
 * one of tado's 100 requests a day. */

let status: HeatingStatus | undefined;
const chosen = new Map<number, number>(); // the temperature chosen with + and -, not sent yet

export async function loadHeatingCard() {
    const res = await fetch('/api/heating', { headers: { Accept: 'application/json' } }).catch(() => undefined);
    status = res?.ok ? ((await res.json()) as HeatingStatus) : undefined;
}

function roomHtml(r: HeatingRoom) {
    const value = chosen.get(r.id) ?? r.target ?? 20;
    const state = r.power === 'ON' ? `heats to ${r.target}°${r.heating ? ` · ${r.heating} %` : ''}` : 'off';
    return `<div class="heat-room" data-heat-room="${r.id}">
        <div class="d-flex align-items-baseline gap-2">
            <div class="fw-bold flex-fill text-truncate">${escapeHtml(r.name)}</div>
            <span class="stat-value" style="font-size:1.3rem">${r.temperature !== undefined ? `${r.temperature.toFixed(1)}°` : '–'}</span>
            <span class="text-secondary small">${r.humidity !== undefined ? `${Math.round(r.humidity)} %` : ''}</span>
        </div>
        <div class="text-secondary small mb-2">${state}${r.manual ? ' · set by hand' : ''}${r.openWindow ? ' · window open' : ''}</div>
        <div class="d-flex align-items-center gap-1 flex-wrap">
            <div class="btn-group">
                <button class="btn btn-sm" data-heat-step="-0.5" title="Cooler"><i class="ti ti-minus"></i></button>
                <span class="btn btn-sm disabled heat-value">${value.toFixed(1)}°</span>
                <button class="btn btn-sm" data-heat-step="0.5" title="Warmer"><i class="ti ti-plus"></i></button>
            </div>
            <button class="btn btn-sm btn-primary" data-heat-set>Set</button>
            <button class="btn btn-sm" data-heat-off ${r.power === 'OFF' && r.manual ? 'disabled' : ''}>Off</button>
            ${r.manual ? '<button class="btn btn-sm" data-heat-schedule>Schedule</button>' : ''}
        </div>
    </div>`;
}

// the card, or nothing while tado is not connected
export function heatingCardHtml() {
    if (!status?.connected) return '';
    const b = status.budget;
    return `<div class="col-md-6 col-xl-4" data-heating-card>
        <div class="card h-100">
            <div class="card-header">
                <h3 class="card-title"><i class="ti ti-flame me-1" style="color:var(--tblr-orange)"></i> Heating</h3>
                <div class="card-actions text-secondary small">${escapeHtml(status.home?.name ?? 'tado')}</div>
            </div>
            <div class="card-body heat-rooms">
                ${status.rooms.length ? status.rooms.map(roomHtml).join('') : '<div class="text-secondary">No rooms read yet.</div>'}
                <div id="heat-result"></div>
            </div>
            <div class="card-footer text-secondary small">${status.lastPoll ? `read ${timeAgo(status.lastPoll)} · ` : ''}every ${b?.pollMinutes ?? 20} min${b?.remaining !== undefined ? ` · ${b.remaining} requests left today` : ''}</div>
        </div>
    </div>`;
}

/* The clicks of the card; redraw puts it in again after a change. Bound once on the grid. */
export function bindHeatingCard(root: HTMLElement, redraw: () => void) {
    root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-heat-step],[data-heat-set],[data-heat-off],[data-heat-schedule]');
        const roomEl = el?.closest<HTMLElement>('[data-heat-room]');
        if (!el || !roomEl || !status) return;
        const id = Number(roomEl.dataset.heatRoom);
        const room = status.rooms.find((r) => r.id === id);
        if (!room) return;

        if (el.dataset.heatStep) {
            const next = Math.min(25, Math.max(5, (chosen.get(id) ?? room.target ?? 20) + Number(el.dataset.heatStep)));
            chosen.set(id, next);
            const value = roomEl.querySelector('.heat-value');
            if (value) value.textContent = `${next.toFixed(1)}°`;
            return;
        }
        const body = el.hasAttribute('data-heat-set')
            ? { mode: 'temperature', celsius: chosen.get(id) ?? room.target ?? 20, until: 'next' }
            : el.hasAttribute('data-heat-off')
              ? { mode: 'off', until: 'next' }
              : { mode: 'schedule' };
        el.disabled = true;
        const res = await fetch(`/api/heating/rooms/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) {
            el.disabled = false;
            const out = document.getElementById('heat-result');
            if (out) out.innerHTML = errorAlert(escapeHtml(await res.text()));
            return;
        }
        chosen.delete(id);
        await loadHeatingCard();
        redraw();
    });
}
