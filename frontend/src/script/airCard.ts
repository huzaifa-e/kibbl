import type { Weather } from '../../../shared/climate';
import { roomClimate, type AirEvent, type AirState, type DeviceSummary } from '../../../shared/protocol';
import { escapeHtml, timeAgo } from './utils';

/* The home card of a kibbl. air: the freshness of the indoor air as a house in its colour,
 * with the weather outside and when a window was last open, and below it the comfort of the
 * room, a small dial of temperature and humidity with their values. */

type Freshness = { word: string; color: string; ink: string };

// by CO2: under 800 ppm fresh, up to 1200 fair, above stale (German Environment Agency: 1000-2000 conspicuous)
function freshness(co2: number | undefined): Freshness {
    if (co2 === undefined) return { word: '…', color: '#8a7d70', ink: '#fff' };
    if (co2 < 800) return { word: 'Fresh', color: '#4d9a83', ink: '#fff' };
    if (co2 <= 1200) return { word: 'Fair', color: '#e8c24a', ink: '#3a2a0a' };
    return { word: 'Stale', color: '#d9622b', ink: '#fff' };
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

function scene(f: Freshness, state: AirState | undefined, lastOpen: WindowEvents | undefined) {
    return `<svg viewBox="0 0 320 200" class="air-scene" role="img" aria-label="Indoor air ${f.word}">
        <path d="M0 150 Q60 110 120 145 T240 140 T320 135 V200 H0 Z" class="air-hill" />
        <g class="air-tree">
            <circle cx="38" cy="132" r="22" /><circle cx="56" cy="148" r="17" /><rect x="35" y="148" width="6" height="52" class="air-trunk" />
            <polygon points="70,92 52,170 88,170" /><rect x="67" y="168" width="6" height="32" class="air-trunk" />
            <polygon points="276,108 256,176 296,176" /><rect x="273" y="174" width="6" height="26" class="air-trunk" />
        </g>
        <polygon points="160,38 236,92 236,200 84,200 84,92" fill="${f.color}" />
        <polygon points="160,30 246,92 238,98 160,42 82,98 74,92" fill="${f.color}" style="filter:brightness(.85)" />
        <rect x="108" y="54" width="12" height="24" fill="${f.color}" style="filter:brightness(.85)" />
        <foreignObject x="88" y="96" width="144" height="104">
            <div class="air-house-text" style="color:${f.ink}">
                <i class="ti ti-leaf"></i>
                <div class="air-house-label">Indoor air</div>
                <div class="air-house-word">${f.word}</div>
                <div class="air-house-note">${escapeHtml(windowLine(state, lastOpen))}</div>
            </div>
        </foreignObject>
    </svg>`;
}

function dial(t: number | undefined, rh: number | undefined) {
    // humidity 20-80 % left to right, temperature 16-28 °C bottom to top; the comfort zone 40-60 %, 19-24 °C
    const x = rh === undefined ? 100 : 100 + clamp((rh - 50) / 30, -1, 1) * 62;
    const y = t === undefined ? 100 : 100 - clamp((t - 21.5) / 6, -1, 1) * 62;
    return `<svg viewBox="-34 0 268 200" class="air-dial" role="img" aria-label="Room comfort">
        <circle cx="100" cy="100" r="74" class="air-dial-ring" />
        <circle cx="100" cy="100" r="24" class="air-dial-zone" />
        ${t === undefined || rh === undefined ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" class="air-dial-dot" />`}
        <text x="100" y="16" class="air-dial-label" text-anchor="middle">TOO WARM</text>
        <text x="100" y="194" class="air-dial-label" text-anchor="middle">COLD</text>
        <text x="20" y="104" class="air-dial-label" text-anchor="end">DRY</text>
        <text x="180" y="104" class="air-dial-label" text-anchor="start">HUMID</text>
    </svg>`;
}

// the card: how fresh the indoor air is, the weather outside, the last airing, how the room feels
export function airCardHtml(d: DeviceSummary, weather: Weather | null, lastOpen: WindowEvents | undefined) {
    const s = d.online ? d.air?.state : undefined;
    // tado's temperature and humidity when it is in the same room
    const climate = d.online ? roomClimate(d.air) : undefined;
    const t = climate?.temperature;
    const rh = climate?.humidity;
    const outside = weather
        ? `<span class="air-outside" title="${escapeHtml(weather.description ?? '')}"><i class="ti ti-${weather.icon ?? 'cloud'}"></i> ${Math.round(weather.temperature)}° outside</span>`
        : '';
    const offline = d.online ? '' : `<div class="air-offline">offline${d.lastSeen ? ` since ${timeAgo(d.lastSeen)}` : ''}</div>`;
    // OpenWeather asks to be named where its data is shown
    const notes = [climate?.fromTado ? 'temperature and humidity from tado' : '', weather?.source === 'openweather' ? 'weather © OpenWeather' : '']
        .filter(Boolean)
        .join(' · ');
    return `<a href="/air/${d._id}" class="card air-card air-freshness text-reset text-decoration-none" data-air-card="${d._id}" title="${s?.co2 !== undefined ? `${s.co2} ppm CO₂` : ''}">
        <div class="air-freshness-head"><span class="air-comfort-name">${escapeHtml(d.name)}</span>${outside}</div>
        ${offline}
        ${scene(freshness(s?.co2), s, lastOpen)}
        <div class="air-comfort">
            ${dial(t, rh)}
            <div class="air-comfort-values">
                <div><div class="air-comfort-caption">Temperature</div><div class="air-comfort-value">${t === undefined ? '–' : `${t.toFixed(1)}°`}</div></div>
                <div><div class="air-comfort-caption">Humidity</div><div class="air-comfort-value">${rh === undefined ? '–' : `${Math.round(rh)}%`}</div></div>
                <div><div class="air-comfort-caption">Feels</div><div class="air-comfort-value">${comfort(t, rh)}</div></div>
            </div>
        </div>
        ${notes ? `<div class="air-source">${notes}</div>` : ''}
    </a>`;
}
