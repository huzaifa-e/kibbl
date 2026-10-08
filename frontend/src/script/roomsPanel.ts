import type { HeatingStatus, HomeRoom } from '../../../shared/heating';
import { ROOM_KINDS } from '../../../shared/roomKind';
import { errorAlert, escapeHtml, successAlert, timeAgo } from './utils';

/* The rooms of the home and heating through tado, on the devices page. A device and one of
 * tado's rooms in the same room share its readings: a kibbl. air there shows tado's
 * temperature and humidity and switches the heating off while its window is open. */

export let rooms: HomeRoom[] = [];
export let heating: HeatingStatus | undefined;

async function json<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: T; error?: string }> {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, ...init });
    if (!res.ok) return { ok: false, error: await res.text() };
    return { ok: true, data: (await res.json().catch(() => undefined)) as T };
}

export async function loadRooms() {
    rooms = (await json<HomeRoom[]>('/api/rooms')).data ?? [];
}

export async function loadHeating() {
    heating = (await json<HeatingStatus>('/api/heating')).data;
}

// what a room is used for: the advice on its air follows it
export function roomKindSelectHtml(room: HomeRoom, attrs = '') {
    return `<select class="form-select form-select-sm w-auto" data-room-kind="${room._id}" title="What the room is used for: the advice on its air follows it" ${attrs}>
        ${Object.entries(ROOM_KINDS)
            .map(([k, label]) => `<option value="${k}" ${room.kind === k ? 'selected' : ''}>${label}</option>`)
            .join('')}
    </select>`;
}

// a select of the rooms: "No room" first; attrs carry what it moves
export function roomSelectHtml(selected: string | undefined, attrs: string) {
    return `<select class="form-select form-select-sm" ${attrs}>
        <option value="">No room</option>
        ${rooms.map((r) => `<option value="${r._id}" ${r._id === selected ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
    </select>`;
}

/* ----------------------------------------------------------------------- */

export function roomsCardHtml() {
    const rows = rooms
        .map(
            (r) => `<div class="list-group-item d-flex align-items-center gap-2">
                <i class="ti ti-door"></i><span class="flex-fill">${escapeHtml(r.name)}</span>
                ${roomKindSelectHtml(r)}
                <button class="btn btn-sm btn-ghost-secondary" data-room-rename="${r._id}" data-name="${escapeHtml(r.name)}" title="Rename"><i class="ti ti-pencil"></i></button>
                <button class="btn btn-sm btn-ghost-danger" data-room-delete="${r._id}" data-name="${escapeHtml(r.name)}" title="Remove"><i class="ti ti-trash"></i></button>
            </div>`,
        )
        .join('');
    return `<div class="card mb-4">
        <div class="card-header"><h3 class="card-title">Rooms</h3></div>
        <div class="card-body text-secondary small pb-0">A kibbl. air in the same room as a room of tado shows tado's temperature and humidity and switches the heating off while a window is open; in a room of its own it measures them itself. Move a device by choosing its room in the list above. What a room is used for sets the advice on its air: a bathroom says when to air after a shower, a bedroom when to air before the night and how the last night was.</div>
        <div class="list-group list-group-flush mt-2">${rows || '<div class="list-group-item text-secondary">No rooms yet.</div>'}</div>
        <div class="card-body">
            <form class="d-flex gap-2" id="room-add"><input class="form-control" id="room-name" placeholder="New room, e.g. Bedroom" maxlength="40" required /><button class="btn" type="submit"><i class="ti ti-plus me-1"></i> Add</button></form>
            <div id="room-result" class="mt-2"></div>
        </div>
    </div>`;
}

export function heatingCardHtml() {
    const h = heating;
    let body: string;
    if (h?.pending) {
        body = `<div class="card-body">
            <ol class="mb-3">
                <li>Open <a href="${escapeHtml(h.pending.url)}" target="_blank" rel="noopener"><b>tado's sign-in</b></a> (a new tab) and log in with your tado account.</li>
                <li>Confirm the code <span class="text-mono fw-bold">${escapeHtml(h.pending.userCode)}</span>.</li>
                <li>Come back here: kibbl. connects by itself within a few seconds.</li>
            </ol>
            <div class="text-secondary small">The code is valid until ${new Date(h.pending.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Your tado password stays with tado.</div>
        </div>`;
    } else if (!h?.connected) {
        body = `<div class="card-body">
            <p class="text-secondary">Read the temperature, humidity and heating of your tado rooms, change them from here, and let a kibbl. air in the same room switch the heating off while its window is open.</p>
            ${h?.error ? errorAlert(escapeHtml(h.error)) : ''}
            <button class="btn btn-primary" data-heating-connect><i class="ti ti-link me-1"></i> Connect tado</button>
        </div>`;
    } else {
        const list = h.rooms
            .map(
                (r) => `<tr>
                    <td><div class="fw-bold">${escapeHtml(r.name)}</div><div class="text-secondary small">${r.power === 'ON' ? `heats to ${r.target}°${r.heating ? ` · ${r.heating} %` : ''}` : 'off'}${r.manual ? ' · manual' : ''}${r.openWindow ? ' · window open' : ''}</div></td>
                    <td>${r.temperature !== undefined ? `${r.temperature.toFixed(1)}°` : '–'} <span class="text-secondary">${r.humidity !== undefined ? `${Math.round(r.humidity)} %` : ''}</span></td>
                    <td style="min-width:150px">${roomSelectHtml(r.roomId, `data-tado-place="${r.id}"`)}</td>
                </tr>`,
            )
            .join('');
        const b = h.budget;
        body = `<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>tado room</th><th>Now</th><th>In room</th></tr></thead><tbody>${list}</tbody></table></div>
            <div class="card-body d-flex flex-wrap align-items-center gap-2 text-secondary small">
                <span class="flex-fill">${h.home ? escapeHtml(h.home.name) : ''}${h.lastPoll ? ` · read ${timeAgo(h.lastPoll)}` : ''} · every ${b?.pollMinutes ?? 20} min${b?.remaining !== undefined ? ` · ${b.remaining} of 100 requests left today` : ''}${b?.paused ? ' · paused to keep requests for your commands' : ''}</span>
                <button class="btn btn-sm btn-ghost-danger" data-heating-disconnect>Disconnect</button>
            </div>
            ${h.error ? `<div class="card-body pt-0">${errorAlert(escapeHtml(h.error))}</div>` : ''}`;
    }
    return `<div class="card mb-4">
        <div class="card-header"><h3 class="card-title"><i class="ti ti-flame me-1"></i> Heating · tado</h3></div>
        ${body}
    </div>`;
}

/* ----------------------------------------------------------------------- */

/* The clicks and changes of both cards and of the room selects of the devices; refresh
 * redraws the page after a change. */
export function bindRoomsPanel(root: HTMLElement, refresh: () => Promise<void>) {
    const result = (html: string) => {
        const el = document.getElementById('room-result');
        if (el) el.innerHTML = html;
    };

    root.addEventListener('submit', async (e) => {
        if ((e.target as HTMLElement).id !== 'room-add') return;
        e.preventDefault();
        const input = document.getElementById('room-name') as HTMLInputElement;
        const res = await json('/api/rooms', { method: 'POST', body: JSON.stringify({ name: input.value }) });
        if (!res.ok) return result(errorAlert(escapeHtml(res.error ?? 'Not added.')));
        await refresh();
    });

    root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-room-rename],[data-room-delete],[data-heating-connect],[data-heating-disconnect]');
        if (!el) return;
        e.preventDefault();
        if (el.dataset.roomRename) {
            const name = prompt('New name', el.dataset.name)?.trim();
            if (!name) return;
            await json(`/api/rooms/${el.dataset.roomRename}`, { method: 'PATCH', body: JSON.stringify({ name }) });
        } else if (el.dataset.roomDelete) {
            if (!confirm(`Remove the room ${el.dataset.name}? What stands in it is in no room then.`)) return;
            await json(`/api/rooms/${el.dataset.roomDelete}`, { method: 'DELETE' });
        } else if (el.hasAttribute('data-heating-connect')) {
            const res = await json<{ url: string }>('/api/heating/connect', { method: 'POST' });
            if (!res.ok) {
                result(errorAlert(escapeHtml(res.error ?? 'tado did not answer.')));
                return;
            }
            if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
        } else if (el.hasAttribute('data-heating-disconnect')) {
            if (!confirm('Disconnect tado? Its readings stored here are removed; tado itself keeps running as before.')) return;
            await json('/api/heating', { method: 'DELETE' });
        }
        await refresh();
    });

    root.addEventListener('change', async (e) => {
        const el = e.target as HTMLSelectElement;
        const roomId = el.value || null;
        if (el.dataset.roomKind) {
            await json(`/api/rooms/${el.dataset.roomKind}`, { method: 'PATCH', body: JSON.stringify({ kind: el.value }) });
        } else if (el.dataset.tadoPlace) {
            await json(`/api/heating/rooms/${el.dataset.tadoPlace}/place`, { method: 'PUT', body: JSON.stringify({ roomId }) });
        } else if (el.dataset.deviceRoom) {
            const res = await json(`/api/devices/${el.dataset.deviceRoom}/room`, { method: 'PUT', body: JSON.stringify({ roomId }) });
            if (res.ok) result(successAlert('Moved.'));
        } else {
            return;
        }
        await refresh();
    });
}
