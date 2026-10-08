import type { Weather } from '../../../shared/climate';
import { roomClimate, type AirEvent, type AirReading, type AirState, type DeviceSummary } from '../../../shared/protocol';
import { escapeHtml, timeAgo } from './utils';

/* The home card of a kibbl. air, in the look of the heating cards: the freshness of the air
 * as a gauge of its CO2, how the room feels in three tiles, the CO2 of the last hours as a
 * line and the windows below it. */

type Freshness = { word: string; color: string };

// by CO2: under 800 ppm fresh, up to 1200 fair, above stale (German Environment Agency: 1000-2000 conspicuous)
function freshness(co2: number | undefined): Freshness {
    if (co2 === undefined) return { word: 'Measuring', color: '#8a8f94' };
    if (co2 < 800) return { word: 'Fresh', color: '#5cb894' };
    if (co2 <= 1200) return { word: 'Fair', color: '#e8c24a' };
    return { word: 'Stale', color: '#ec8a55' };
}

// what a person feels: cold and too warm first, then dry and humid
function comfort(t: number | undefined, rh: number | undefined) {
    if (t === undefined || rh === undefined) return 'Measuring';
    if (t < 18) return 'Cold';
    if (t > 25) return rh > 60 ? 'Muggy' : 'Too warm';
    if (rh < 35) return 'Dry';
    if (rh > 60) return 'Humid';
    if (t < 19) return 'Cool';
    return 'Pleasant';
}

// the last opening of a window and its closing, as the device reported them
export interface WindowEvents {
    open?: AirEvent;
    closed?: AirEvent;
}

const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/* When a window was open, as times: the device needs a little to be sure a window is shut
 * again, the times say when it really was open. */
export function windowText(state: AirState | undefined, w: WindowEvents | undefined) {
    const open = w?.open && Date.now() - w.open.at < 24 * 3600_000 ? w.open : undefined;
    if (state?.window === 'open') return open ? `Window open since ${hhmm(open.at)}.` : 'A window is open now.';
    if (!open) return undefined;
    const closed = w?.closed && w.closed.at > open.at ? w.closed : undefined;
    if (closed) {
        const minutes = Math.max(1, Math.round((closed.at - open.at) / 60_000));
        return `Last open ${hhmm(open.at)}–${hhmm(closed.at)} (${minutes} min).`;
    }
    return `Last open at ${hhmm(open.at)}.`;
}

function windowLine(state: AirState | undefined, w: WindowEvents | undefined) {
    if (state?.window === 'open') return windowText(state, w) as string;
    if (state?.window === 'paused')
        return state.calibrating
            ? 'Calibrating: windows are not watched right now.'
            : `Windows are watched again ${state.settleSeconds ? `in about ${Math.max(1, Math.round(state.settleSeconds / 60))} min` : 'shortly'}.`;
    return windowText(state, w) ?? 'No open window has been detected in the last 24 hours.';
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/* ----------------------------------------------------------------------- */

const HISTORY_HOURS = 6;
const history = new Map<string, AirReading[]>();

// the CO2 of the last hours of a kibbl. air, for the line of its card
export async function loadAirHistory(deviceId: string) {
    const res = await fetch(`/api/air/${deviceId}/readings?hours=${HISTORY_HOURS}`, { headers: { Accept: 'application/json' } }).catch(() => undefined);
    if (res?.ok) history.set(deviceId, (await res.json()) as AirReading[]);
}

// the gauge: an arc of 240 degrees over 400-2000 ppm, green, yellow and orange, the CO2 a dot on it
const GAUGE_MIN = 400;
const GAUGE_MAX = 2000;
function gauge(co2: number | undefined, f: Freshness) {
    const r = 64;
    const point = (ppm: number) => {
        const a = ((-210 + ((clamp(ppm, GAUGE_MIN, GAUGE_MAX) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 240) * Math.PI) / 180;
        return [80 + r * Math.cos(a), 80 + r * Math.sin(a)];
    };
    const arc = (from: number, to: number, colour: string, width: number) => {
        const [x1, y1] = point(from);
        const [x2, y2] = point(to);
        const large = ((to - from) / (GAUGE_MAX - GAUGE_MIN)) * 240 > 180 ? 1 : 0;
        return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${colour}" stroke-width="${width}" fill="none" stroke-linecap="round" />`;
    };
    const [dx, dy] = point(co2 ?? GAUGE_MIN);
    return `<svg viewBox="0 0 160 140" class="room-gauge" role="img" aria-label="Air ${f.word}">
        ${arc(GAUGE_MIN, GAUGE_MAX, 'rgba(255,255,255,0.08)', 12)}
        ${arc(GAUGE_MIN, 790, '#5cb894', 6)}${arc(810, 1190, '#e8c24a', 6)}${arc(1210, GAUGE_MAX, '#ec8a55', 6)}
        ${co2 === undefined ? '' : `<circle cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="8" fill="${f.color}" stroke="#26292d" stroke-width="3" />`}
        <text x="80" y="78" text-anchor="middle" class="room-gauge-word" fill="${f.color}">${f.word}</text>
        <text x="80" y="98" text-anchor="middle" class="room-gauge-ppm">${co2 === undefined ? '' : `${co2} ppm CO₂`}</text>
    </svg>`;
}

// the CO2 of the last hours, the newest reading at the end; the lines of 800 and 1200 ppm behind it
function co2Line(points: { at: number; co2: number }[]) {
    if (points.length < 2) return '';
    const w = 300;
    const h = 56;
    const from = points[0].at;
    const span = Math.max(1, points[points.length - 1].at - from);
    const top = Math.max(1300, ...points.map((p) => p.co2)) + 50;
    const bottom = Math.min(400, ...points.map((p) => p.co2));
    const y = (v: number) => h - ((v - bottom) / (top - bottom)) * h;
    const xy = points.map((p) => `${(((p.at - from) / span) * w).toFixed(1)},${y(p.co2).toFixed(1)}`);
    const last = points[points.length - 1];
    return `<svg viewBox="0 -4 ${w} ${h + 8}" class="room-line" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="room-line-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${freshness(last.co2).color}" stop-opacity="0.35"/><stop offset="1" stop-color="${freshness(last.co2).color}" stop-opacity="0"/></linearGradient></defs>
        <line x1="0" x2="${w}" y1="${y(800).toFixed(1)}" y2="${y(800).toFixed(1)}" class="room-line-mark" />
        <line x1="0" x2="${w}" y1="${y(1200).toFixed(1)}" y2="${y(1200).toFixed(1)}" class="room-line-mark" />
        <polygon points="0,${h} ${xy.join(' ')} ${w},${h}" fill="url(#room-line-fill)" />
        <polyline points="${xy.join(' ')}" fill="none" stroke="${freshness(last.co2).color}" stroke-width="2" vector-effect="non-scaling-stroke" />
    </svg>`;
}

function windowChip(state: AirState | undefined, w: WindowEvents | undefined) {
    const open = state?.window === 'open';
    return `<div class="room-window ${open ? 'room-window-open' : ''}"><i class="ti ti-window"></i><span>${escapeHtml(windowLine(state, w))}</span></div>`;
}

const tile = (icon: string, caption: string, value: string) =>
    `<div class="room-tile"><i class="ti ti-${icon}"></i><div class="room-tile-value">${value}</div><div class="room-tile-caption">${caption}</div></div>`;

// the card: how fresh the air is, how the room feels, the CO2 of the last hours, the windows
export function airCardHtml(d: DeviceSummary, weather: Weather | null, lastOpen: WindowEvents | undefined) {
    const s = d.online ? d.air?.state : undefined;
    // tado's temperature and humidity when it is in the same room
    const climate = d.online ? roomClimate(d.air) : undefined;
    const t = climate?.temperature;
    const rh = climate?.humidity;
    const f = freshness(s?.co2);
    const outside = weather
        ? `<span class="room-outside" title="${escapeHtml(weather.description ?? '')}"><i class="ti ti-${weather.icon ?? 'cloud'}"></i> ${Math.round(weather.temperature)}° outside</span>`
        : '';
    const points = [...(history.get(d._id) ?? [])];
    if (s?.co2 !== undefined) points.push({ at: Date.now(), co2: s.co2, temperature: 0, humidity: 0 });
    // OpenWeather asks to be named where its data is shown
    const notes = [climate?.fromTado ? 'temperature and humidity from tado' : '', weather?.source === 'openweather' ? 'weather © OpenWeather' : '']
        .filter(Boolean)
        .join(' · ');
    return `<a href="/air/${d._id}" class="card room-card text-reset text-decoration-none h-100" data-air-card="${d._id}">
        <div class="room-head"><span class="room-name">${escapeHtml(d.name)}</span>${outside}</div>
        ${d.online ? '' : `<div class="room-offline">offline${d.lastSeen ? ` since ${timeAgo(d.lastSeen)}` : ''}</div>`}
        ${gauge(s?.co2, f)}
        <div class="room-tiles">
            ${tile('temperature', 'Temperature', t === undefined ? '–' : `${t.toFixed(1)}°`)}
            ${tile('droplet', 'Humidity', rh === undefined ? '–' : `${Math.round(rh)}%`)}
            ${tile('mood-smile', 'Feels', comfort(t, rh))}
        </div>
        ${points.length > 1 ? `<div class="room-line-box"><div class="room-line-caption">CO₂, last ${HISTORY_HOURS} h</div>${co2Line(points)}</div>` : ''}
        ${windowChip(s, lastOpen)}
        ${notes ? `<div class="room-note">${notes}</div>` : ''}
    </a>`;
}
