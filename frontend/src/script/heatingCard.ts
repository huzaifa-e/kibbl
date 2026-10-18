import type { HeatingRoom, HeatingStatus, HeatingUntil } from '../../../shared/heating';
import { errorAlert, escapeHtml } from './utils';

/* A card per room of tado on the home page, as tado's own app shows a room: what it measures,
 * the temperature it heats to in large, a bar to slide it (at the bottom: off) and how long a
 * change lasts. A change is sent a moment after the bar is let go, not while it moves: each
 * one is one of tado's requests of the day. Adaptive control: the server holds the room at
 * the temperature on the bar (it sets tado above or below it until the room measures it,
 * off while a window is open); the bar then changes what it holds. */

let status: HeatingStatus | undefined;
const MIN = 5;
const MAX = 25;
const OFF_ZONE = 0.07; // the lowest part of the bar is off
const SEND_AFTER_MS = 1500;

type Choice = number | 'off'; // the temperature chosen on the bar, not sent yet, or off
const chosen = new Map<number, Choice>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const sending = new Set<number>();

// how long a change lasts, per room, remembered in this browser
interface Duration {
    until: HeatingUntil;
    minutes?: number;
}
const DURATIONS: (Duration & { label: string })[] = [
    { until: 'next', label: 'Until the next change of the schedule' },
    { until: 'manual', label: 'Until you resume the schedule' },
    { until: 'timer', minutes: 30, label: 'For 30 minutes' },
    { until: 'timer', minutes: 60, label: 'For 1 hour' },
    { until: 'timer', minutes: 180, label: 'For 3 hours' },
];

function duration(id: number): Duration {
    try {
        const saved = JSON.parse(localStorage.getItem(`kibbl.heatDuration.${id}`) ?? 'null') as Duration | null;
        if (saved && DURATIONS.some((d) => d.until === saved.until && d.minutes === saved.minutes)) return saved;
    } catch {
        /* no storage: the default */
    }
    return { until: 'next' };
}

function saveDuration(id: number, d: Duration) {
    try {
        localStorage.setItem(`kibbl.heatDuration.${id}`, JSON.stringify(d));
    } catch {
        /* only for this visit then */
    }
}

export async function loadHeatingCard() {
    const res = await fetch('/api/heating', { headers: { Accept: 'application/json' } }).catch(() => undefined);
    status = res?.ok ? ((await res.json()) as HeatingStatus) : undefined;
}

/* ----------------------------------------------------------------------- */

const DEFAULT_AUTO = 20; // what the adaptive control starts at from a room that is off
const shown = (r: HeatingRoom): Choice => (r.auto ? r.auto.celsius : r.power === 'ON' && r.target ? r.target : 'off');
const current = (r: HeatingRoom): Choice => chosen.get(r.id) ?? shown(r);

// how full the bar is, 0 to 1
function level(c: Choice) {
    return c === 'off' ? 0 : OFF_ZONE + ((c - MIN) / (MAX - MIN)) * (1 - OFF_ZONE);
}

function choiceAt(fraction: number): Choice {
    if (fraction < OFF_ZONE) return 'off';
    const t = MIN + ((fraction - OFF_ZONE) / (1 - OFF_ZONE)) * (MAX - MIN);
    return Math.min(MAX, Math.max(MIN, Math.round(t * 2) / 2));
}

// yellow when mild, orange to red when warm, as tado colours it
function colour(c: Choice) {
    if (c === 'off') return '#ececec';
    const hue = 48 - ((c - MIN) / (MAX - MIN)) * 40;
    return `hsl(${hue.toFixed(0)} 92% 58%)`;
}

const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function stateLine(r: HeatingRoom, c: Choice) {
    if (sending.has(r.id)) return 'Sending to tado…';
    if (chosen.has(r.id)) return c === 'off' ? 'Frost protection' : 'Let go to set';
    if (r.auto?.window) return 'Off · window open';
    if (r.auto) return `Adaptive · tado at ${r.auto.setTo !== undefined ? `${r.auto.setTo.toFixed(1)}°` : '–'}${r.heating ? ` · ${r.heating} %` : ''}`;
    if (r.openWindow) return 'Window open';
    if (c === 'off') return 'Frost protection';
    return r.heating ? `Heating · ${r.heating} %` : 'Warm enough';
}

function untilLine(r: HeatingRoom) {
    if (r.auto) return `<i class="ti ti-adjustments-bolt"></i> Adaptive control since ${hhmm(r.auto.since)}`;
    if (!r.manual) return '<i class="ti ti-calendar-event"></i> Following the schedule';
    if (r.manualUntil) return `<i class="ti ti-hand-click"></i> Until ${hhmm(r.manualUntil)}`;
    return '<i class="ti ti-hand-click"></i> Until you resume the schedule';
}

function roomHtml(r: HeatingRoom) {
    const c = current(r);
    const d = duration(r.id);
    const menu = DURATIONS.map(
        (o, i) =>
            `<button class="dropdown-item ${o.until === d.until && o.minutes === d.minutes ? 'active' : ''}" data-heat-duration="${i}">${o.label}</button>`,
    ).join('');
    return `<div class="col-md-6 col-xl-4">
        <div class="card heat-card h-100" data-heat-room="${r.id}">
            <div class="heat-name">${escapeHtml(r.name)}</div>
            <div class="heat-now">
                <span>Inside now <b>${r.temperature !== undefined ? `${r.temperature.toFixed(1)}°` : '–'}</b></span>
                <span>Humidity <b>${r.humidity !== undefined ? `${Math.round(r.humidity)}%` : '–'}</b></span>
            </div>
            <div class="heat-target">${c === 'off' ? 'OFF' : `${c.toFixed(1)}°`}${r.heating && !chosen.has(r.id) ? '<i class="ti ti-flame heat-flame"></i>' : ''}</div>
            <div class="heat-state">${stateLine(r, c)}</div>
            <div class="heat-pill" role="slider" tabindex="0" aria-label="Temperature of ${escapeHtml(r.name)}" aria-valuemin="${MIN}" aria-valuemax="${MAX}"
                aria-valuetext="${c === 'off' ? 'off' : `${c} degrees`}" data-heat-pill>
                <div class="heat-fill" style="height:calc(${(level(c) * 100).toFixed(1)}% + 2.6rem);background:${colour(c)}"><span></span></div>
            </div>
            <div class="heat-actions">
                ${r.auto ? '' : '<button class="btn heat-resume" data-heat-auto title="The server holds the room at this temperature, off while a window is open"><i class="ti ti-adjustments-bolt me-2"></i> Adaptive</button>'}
                ${r.manual || r.auto ? '<button class="btn heat-resume" data-heat-schedule><i class="ti ti-calendar-repeat me-2"></i> Resume schedule</button>' : ''}
            </div>
            <div class="heat-until">
                <span>${untilLine(r)}</span>
                <div class="dropdown">
                    <button class="btn btn-icon heat-edit" data-bs-toggle="dropdown" title="How long a change lasts"><i class="ti ti-pencil"></i></button>
                    <div class="dropdown-menu dropdown-menu-end"><h6 class="dropdown-header">A change lasts</h6>${menu}</div>
                </div>
            </div>
            <div class="heat-result"></div>
        </div>
    </div>`;
}

/* the cards, or nothing while tado is not connected; only: the rooms of tado to show (a room
 * page shows those in its room), all when left out */
export function heatingCardHtml(only?: number[]) {
    if (!status?.connected) return '';
    const rooms = only ? status.rooms.filter((r) => only.includes(r.id)) : status.rooms;
    return rooms.map(roomHtml).join('');
}

/* ----------------------------------------------------------------------- */

async function send(id: number, body: object, card: HTMLElement | null, redraw: () => void) {
    sending.add(id);
    redraw();
    const res = await fetch(`/api/heating/rooms/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(
        () => undefined,
    );
    sending.delete(id);
    chosen.delete(id);
    if (!res?.ok) {
        const text = res ? await res.text() : 'tado did not answer.';
        redraw();
        const out = document.querySelector(`[data-heat-room="${id}"] .heat-result`) ?? card?.querySelector('.heat-result');
        if (out) out.innerHTML = errorAlert(escapeHtml(text));
        return;
    }
    await loadHeatingCard();
    redraw();
}

// off ends the adaptive control, a temperature changes what it holds
function command(r: HeatingRoom, c: Choice, d: Duration) {
    if (c !== 'off' && r.auto) return { mode: 'auto', celsius: c };
    return c === 'off' ? { mode: 'off', ...d } : { mode: 'temperature', celsius: c, ...d };
}

/* The bar, the buttons and the menu of the cards; redraw puts them in again after a change.
 * Bound once on the grid. */
export function bindHeatingCard(root: HTMLElement, redraw: () => void) {
    const roomOf = (el: Element | null) => {
        const card = el?.closest<HTMLElement>('[data-heat-room]');
        const id = Number(card?.dataset.heatRoom);
        const room = status?.rooms.find((r) => r.id === id);
        return card && room ? { card, room } : undefined;
    };

    // while the bar moves only this card changes; the send waits until it is let go
    const show = (card: HTMLElement, r: HeatingRoom, c: Choice) => {
        chosen.set(r.id, c);
        const fill = card.querySelector<HTMLElement>('.heat-fill');
        if (fill) {
            fill.style.height = `calc(${(level(c) * 100).toFixed(1)}% + 2.6rem)`;
            fill.style.background = colour(c);
        }
        card.querySelector('.heat-target')!.textContent = c === 'off' ? 'OFF' : `${c.toFixed(1)}°`;
        card.querySelector('.heat-state')!.textContent = stateLine(r, c);
        card.querySelector('[data-heat-pill]')?.setAttribute('aria-valuetext', c === 'off' ? 'off' : `${c} degrees`);
    };
    const later = (card: HTMLElement, r: HeatingRoom) => {
        clearTimeout(timers.get(r.id));
        timers.set(
            r.id,
            setTimeout(() => {
                timers.delete(r.id);
                const c = chosen.get(r.id);
                if (c === undefined || c === shown(r)) {
                    chosen.delete(r.id);
                    redraw();
                    return;
                }
                void send(r.id, command(r, c, duration(r.id)), card, redraw);
            }, SEND_AFTER_MS),
        );
    };

    let drag: { card: HTMLElement; room: HeatingRoom; pill: HTMLElement } | undefined;
    const fractionAt = (pill: HTMLElement, y: number) => {
        const box = pill.getBoundingClientRect();
        return Math.min(1, Math.max(0, (box.bottom - y) / box.height));
    };
    root.addEventListener('pointerdown', (e) => {
        const pill = (e.target as HTMLElement).closest<HTMLElement>('[data-heat-pill]');
        const at = roomOf(pill);
        if (!pill || !at || sending.has(at.room.id)) return;
        e.preventDefault();
        pill.setPointerCapture(e.pointerId);
        clearTimeout(timers.get(at.room.id));
        drag = { ...at, pill };
        show(at.card, at.room, choiceAt(fractionAt(pill, e.clientY)));
    });
    root.addEventListener('pointermove', (e) => {
        if (drag) show(drag.card, drag.room, choiceAt(fractionAt(drag.pill, e.clientY)));
    });
    const end = () => {
        if (!drag) return;
        later(drag.card, drag.room);
        drag = undefined;
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    root.addEventListener('keydown', (e) => {
        const pill = (e.target as HTMLElement).closest<HTMLElement>('[data-heat-pill]');
        const at = roomOf(pill);
        if (!at || sending.has(at.room.id) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const c = current(at.room);
        const next: Choice = e.key === 'ArrowUp' ? (c === 'off' ? MIN : Math.min(MAX, c + 0.5)) : c === 'off' || c <= MIN ? 'off' : Math.max(MIN, c - 0.5);
        show(at.card, at.room, next);
        later(at.card, at.room);
    });

    root.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-heat-schedule],[data-heat-auto],[data-heat-duration]');
        const at = roomOf(el);
        if (!el || !at || sending.has(at.room.id)) return;
        e.preventDefault();
        if (el.hasAttribute('data-heat-schedule')) {
            void send(at.room.id, { mode: 'schedule' }, at.card, redraw);
            return;
        }
        if (el.hasAttribute('data-heat-auto')) {
            const c = current(at.room);
            void send(at.room.id, { mode: 'auto', celsius: c === 'off' ? DEFAULT_AUTO : c }, at.card, redraw);
            return;
        }
        const { until, minutes } = DURATIONS[Number(el.dataset.heatDuration)];
        saveDuration(at.room.id, { until, minutes });
        // a change already made by hand lasts as now chosen: sent again, otherwise only for the next one
        if (at.room.manual && !at.room.auto) void send(at.room.id, command(at.room, current(at.room), { until, minutes }), at.card, redraw);
        else redraw();
    });
}
