import './main';
import type { Weather } from '../../../shared/climate';
import type { HeatingRoom, RoomOverview } from '../../../shared/heating';
import { productName, roomClimate, type AirEvent, type DeviceSummary, type DeviceTelemetry } from '../../../shared/protocol';
import { airCardHtml, windowText, type WindowEvents } from './airCard';
import { bindHeatingCard, heatingCardHtml, loadHeatingCard } from './heatingCard';
import { socket } from './socket';
import { byId, emptyState, errorAlert, escapeHtml } from './utils';

/* The rooms of the home: what stands in each, together. /rooms shows every room as a card with
 * its climate (tado's when tado is in it), its air, window, heating and camera; /rooms/:id one
 * room with the cards of its devices, its heating and moving devices in and out. */

type Room = RoomOverview<DeviceSummary>;

const roomId = window.location.pathname.split('/')[2] ?? '';
let rooms: Room[] = [];
let weather: Weather | null = null;
const windows = new Map<string, WindowEvents>();
let heatingBound = false;

async function getJson<T>(url: string): Promise<T | undefined> {
    const res = await fetch(url, { headers: { Accept: 'application/json' } }).catch(() => undefined);
    if (res?.status === 401) window.location.href = '/login';
    return res?.ok ? ((await res.json()) as T) : undefined;
}

async function send(url: string, method: string, body?: unknown) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) byId('rooms-result').innerHTML = errorAlert(escapeHtml(await res.text()));
    return res.ok;
}

const airOf = (r: Room) => r.devices.find((d) => d.caps.includes('air'));
const camerasOf = (r: Room) => r.devices.filter((d) => d.caps.includes('camera'));
const deviceIcon = (d: DeviceSummary) => (d.caps.includes('camera') ? 'device-cctv' : d.caps.includes('air') ? 'wind' : 'cpu');
const deviceLink = (d: DeviceSummary) => (d.caps.includes('camera') ? `/camera/${d._id}` : d.caps.includes('air') ? `/air/${d._id}` : '/devices');

/* ----------------------------------------------------------------------- */

// the climate of a room: tado's when tado is in it, else the kibbl. air's
function climateOf(r: Room) {
    const air = airOf(r);
    const tado = r.heating[0];
    const c = air?.online ? roomClimate(air.air) : undefined;
    return {
        temperature: tado?.temperature ?? c?.temperature,
        humidity: tado?.humidity ?? c?.humidity,
        co2: air?.online ? air.air?.state?.co2 : undefined,
    };
}

function airWord(co2: number | undefined) {
    if (co2 === undefined) return undefined;
    if (co2 < 800) return { word: 'Fresh air', color: '#4d9a83' };
    if (co2 <= 1200) return { word: 'Air is fair', color: '#e8c24a' };
    return { word: 'Stale air', color: '#d9622b' };
}

function heatingLine(h: HeatingRoom) {
    return h.power === 'ON' ? `Heats to ${h.target}°${h.heating ? ` · ${h.heating} %` : ''}` : 'Heating off';
}

function roomCardHtml(r: Room) {
    const c = climateOf(r);
    const air = airOf(r);
    const word = airWord(c.co2);
    const win = air?.online ? windowText(air.air?.state, windows.get(air._id)) : undefined;
    const cam = camerasOf(r).find((d) => d.online);
    const href = r.room ? `/rooms/${r.room._id}` : '/devices';
    const lines = [
        word ? `<div><i class="ti ti-circle-filled" style="color:${word.color}"></i> ${word.word}</div>` : '',
        win ? `<div><i class="ti ti-window"></i> ${escapeHtml(win)}</div>` : '',
        ...r.heating.map((h) => `<div><i class="ti ti-flame"></i> ${escapeHtml(heatingLine(h))}</div>`),
    ].join('');
    return `<div class="col-md-6 col-xl-4">
        <a class="card h-100 text-reset text-decoration-none room-card" href="${href}">
            ${cam ? `<img class="card-img-top room-cam" data-room-cam="${cam._id}" alt="${escapeHtml(cam.name)}" style="display:none" />` : ''}
            <div class="card-body">
                <div class="d-flex align-items-baseline gap-2 mb-2">
                    <h3 class="card-title mb-0 flex-fill text-truncate">${escapeHtml(r.room?.name ?? 'Not in a room')}</h3>
                    ${r.devices.map((d) => `<i class="ti ti-${deviceIcon(d)} ${d.online ? '' : 'text-secondary'}" title="${escapeHtml(d.name)}"></i>`).join(' ')}
                    ${r.heating.length ? '<i class="ti ti-flame" title="tado"></i>' : ''}
                </div>
                ${
                    c.temperature !== undefined || c.humidity !== undefined
                        ? `<div class="d-flex align-items-baseline gap-3 mb-2">
                            <span class="stat-value">${c.temperature !== undefined ? `${c.temperature.toFixed(1)}°` : '–'}</span>
                            <span class="text-secondary">${c.humidity !== undefined ? `${Math.round(c.humidity)} %` : ''}</span>
                        </div>`
                        : ''
                }
                <div class="text-secondary small d-grid gap-1">${lines || (r.devices.length || r.heating.length ? '' : 'Nothing in this room yet.')}</div>
            </div>
        </a>
    </div>`;
}

/* ----------------------------------------------------------------------- */

function renderOverview() {
    byId('page-pretitle').textContent = 'Home';
    byId('page-title').textContent = 'Rooms';
    byId('page-actions').innerHTML = `<button class="btn btn-sm btn-primary" id="room-new"><i class="ti ti-plus me-1"></i> New room</button>`;
    byId('room-new').addEventListener('click', async () => {
        const name = prompt('Name of the room')?.trim();
        if (name && (await send('/api/rooms', 'POST', { name }))) await load();
    });
    byId('container').innerHTML = `<div id="rooms-result"></div>${
        rooms.length
            ? `<div class="row row-cards">${rooms.map(roomCardHtml).join('')}</div>`
            : `<div class="card"><div class="card-body">${emptyState('door', 'No rooms yet', 'Make a room and put your devices in it: those in the same room share their readings.', '<a href="/devices" class="btn btn-primary">Devices</a>')}</div></div>`
    }`;
    void loadCameraPictures();
}

// a select of the rooms for moving something; value "" is no room
function moveSelect(current: string | null, attrs: string) {
    const options = rooms
        .filter((r) => r.room)
        .map((r) => `<option value="${r.room!._id}" ${r.room!._id === current ? 'selected' : ''}>${escapeHtml(r.room!.name)}</option>`);
    return `<select class="form-select form-select-sm" ${attrs}><option value="">No room</option>${options.join('')}</select>`;
}

function renderRoom(r: Room) {
    byId('page-pretitle').textContent = 'Room';
    byId('page-title').textContent = r.room!.name;
    byId('page-actions').innerHTML = `<a href="/rooms" class="btn btn-sm"><i class="ti ti-arrow-left me-1"></i> All rooms</a>
        <button class="btn btn-sm" id="room-rename"><i class="ti ti-pencil me-1"></i> Rename</button>`;
    byId('room-rename').addEventListener('click', async () => {
        const name = prompt('New name', r.room!.name)?.trim();
        if (name && (await send(`/api/rooms/${r.room!._id}`, 'PATCH', { name }))) await load();
    });

    const cards: string[] = [];
    for (const d of r.devices.filter((x) => x.caps.includes('air'))) {
        cards.push(`<div class="col-md-6 col-xl-4">${airCardHtml(d, weather, windows.get(d._id))}</div>`);
    }
    const heating = heatingCardHtml(r.heating.map((h) => h.id));
    if (heating) cards.push(heating);
    for (const cam of camerasOf(r)) {
        cards.push(`<div class="col-md-6 col-xl-4"><a class="card h-100 text-reset text-decoration-none" href="/camera/${cam._id}">
            <img class="card-img-top room-cam" data-room-cam="${cam._id}" alt="${escapeHtml(cam.name)}" style="display:none" />
            <div class="card-body"><i class="ti ti-device-cctv me-1"></i> ${escapeHtml(cam.name)} <span class="text-secondary small">${cam.online ? 'live view' : 'offline'}</span></div>
        </a></div>`);
    }

    const elsewhere = rooms.flatMap((x) => (x.room?._id === r.room!._id ? [] : x.devices));
    const inRoom = [
        ...r.devices.map(
            (d) => `<div class="list-group-item d-flex align-items-center gap-2">
                <i class="ti ti-${deviceIcon(d)}"></i>
                <a href="${deviceLink(d)}" class="flex-fill text-reset">${escapeHtml(d.name)} <span class="text-secondary small">${escapeHtml(productName(d.model, d.caps))}</span></a>
                <div style="min-width:140px">${moveSelect(r.room!._id, `data-move-device="${d._id}" aria-label="Room of ${escapeHtml(d.name)}"`)}</div>
            </div>`,
        ),
        ...r.heating.map(
            (h) => `<div class="list-group-item d-flex align-items-center gap-2">
                <i class="ti ti-flame"></i><span class="flex-fill">${escapeHtml(h.name)} <span class="text-secondary small">tado</span></span>
                <div style="min-width:140px">${moveSelect(r.room!._id, `data-move-tado="${h.id}" aria-label="Room of ${escapeHtml(h.name)}"`)}</div>
            </div>`,
        ),
    ].join('');

    byId('container').innerHTML = `<div id="rooms-result"></div>
        <div class="row row-cards mb-3" id="room-cards">${cards.join('') || `<div class="col-12"><div class="card"><div class="card-body">${emptyState('door', 'Nothing here yet', 'Put a kibbl. air, a camera or a room of tado in this room below.')}</div></div></div>`}</div>
        <div class="card">
            <div class="card-header"><h3 class="card-title">In this room</h3></div>
            <div class="list-group list-group-flush">${inRoom || '<div class="list-group-item text-secondary">Nothing yet.</div>'}</div>
            ${
                elsewhere.length
                    ? `<div class="card-body d-flex gap-2 align-items-center"><span class="text-secondary small">Move here:</span>
                        <select class="form-select form-select-sm w-auto" id="room-add"><option value="">a device…</option>${elsewhere.map((d) => `<option value="${d._id}">${escapeHtml(d.name)}</option>`).join('')}</select></div>`
                    : ''
            }
        </div>`;

    if (!heatingBound) {
        bindHeatingCard(byId('container'), () => void load());
        heatingBound = true;
    }
    void loadCameraPictures();
}

/* ----------------------------------------------------------------------- */

// the latest frame of each camera shown, as the home page does
async function loadCameraPictures() {
    for (const img of document.querySelectorAll<HTMLImageElement>('[data-room-cam]')) {
        const res = await fetch(`/api/devices/${img.dataset.roomCam}/snapshot`).catch(() => undefined);
        if (!res || res.status !== 200) continue;
        img.src = URL.createObjectURL(await res.blob());
        img.style.display = '';
    }
}

function render() {
    if (!roomId) return renderOverview();
    const r = rooms.find((x) => x.room?._id === roomId);
    if (!r) {
        byId('container').innerHTML = errorAlert('This room does not exist (any more). <a href="/rooms">All rooms</a>');
        return;
    }
    renderRoom(r);
}

async function load() {
    const [overview, w] = await Promise.all([getJson<Room[]>('/api/rooms/overview'), getJson<Weather | null>('/api/weather'), loadHeatingCard()]);
    rooms = overview ?? [];
    weather = w ?? null;
    // the last opening and closing of a window of each kibbl. air, for the cards
    await Promise.all(
        rooms
            .flatMap((r) => r.devices)
            .filter((d) => d.caps.includes('air'))
            .map(async (d) => {
                const events = (await getJson<AirEvent[]>(`/api/air/${d._id}/events?days=1`)) ?? [];
                windows.set(d._id, {
                    open: events.find((e) => e.kind === 'window' && e.state === 'open'),
                    closed: events.find((e) => e.kind === 'window' && e.state === 'closed'),
                });
            }),
    );
    render();
}

document.addEventListener('DOMContentLoaded', () => {
    // moving a device or a room of tado: in another room, the page is read again
    byId('container').addEventListener('change', async (e) => {
        const el = e.target as HTMLSelectElement;
        const target = el.value || null;
        if (el.dataset.moveDevice) {
            if (await send(`/api/devices/${el.dataset.moveDevice}/room`, 'PUT', { roomId: target })) await load();
        } else if (el.dataset.moveTado) {
            if (await send(`/api/heating/rooms/${el.dataset.moveTado}/place`, 'PUT', { roomId: target })) await load();
        } else if (el.id === 'room-add' && el.value) {
            if (await send(`/api/devices/${el.value}/room`, 'PUT', { roomId })) await load();
        }
    });
});

let reloadTimer: number | undefined;
const reloadSoon = () => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => void load(), 800);
};

socket.on('connect', () => void load());
socket.on('deviceUpdate', reloadSoon);
socket.on('heatingUpdate', reloadSoon);
socket.on('airEvent', reloadSoon);
// the readings of a kibbl. air every 10 s: its cards and the room card without reading everything
socket.on('telemetry', (deviceId: string, telemetry: DeviceTelemetry) => {
    const d = rooms.flatMap((r) => r.devices).find((x) => x._id === deviceId);
    if (!d?.air || !telemetry.air) return;
    d.air.state = telemetry.air;
    const card = document.querySelector<HTMLElement>(`[data-air-card="${deviceId}"]`);
    if (card) card.outerHTML = airCardHtml(d, weather, windows.get(deviceId));
});
