import { allRoomHints, type ClimateHint, type RecentAir, type Weather } from '../../../shared/climate';
import { roomClimate, type AirEvent, type AirNight, type AirReading, type AirState, type DeviceSummary } from '../../../shared/protocol';
import { escapeHtml, timeAgo } from './utils';

/* The home card of a kibbl. air, in the look of the heating cards and in the colour of its
 * air: how the room feels as a dial of temperature and humidity, the values in three tiles,
 * the CO2 of the last hours as a line and the windows below it. */

type Freshness = { word: string; tone: string };

// by CO2: under 800 ppm fresh, up to 1200 fair, above stale (German Environment Agency: 1000-2000 conspicuous)
function freshness(co2: number | undefined): Freshness {
    if (co2 === undefined) return { word: 'Measuring', tone: 'none' };
    if (co2 < 800) return { word: 'Fresh', tone: 'fresh' };
    if (co2 <= 1200) return { word: 'Fair', tone: 'fair' };
    return { word: 'Stale', tone: 'stale' };
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

const nights = new Map<string, AirNight | null>();

/* The CO2 of the last hours of a kibbl. air, for the line of its card (and the humidity of
 * the last minutes, for a shower); in a bedroom also the air of its last night. */
export async function loadAirHistory(deviceId: string, bedroom = false) {
    const get = (url: string) => fetch(url, { headers: { Accept: 'application/json' } }).catch(() => undefined);
    const [res, night] = await Promise.all([
        get(`/api/air/${deviceId}/readings?hours=${HISTORY_HOURS}`),
        bedroom ? get(`/api/air/${deviceId}/night`) : undefined,
    ]);
    if (res?.ok) history.set(deviceId, (await res.json()) as AirReading[]);
    if (night?.ok) nights.set(deviceId, (await night.json()) as AirNight | null);
}

// the most pressing advice for the room: one chip, none while all is well
function adviceChip(hint: ClimateHint | undefined) {
    if (!hint || hint.level === 'good') return '';
    return `<div class="room-advice room-advice-${hint.level}" title="${escapeHtml(hint.text)}"><i class="ti ti-${hint.icon}"></i><span>${escapeHtml(hint.title)}</span></div>`;
}

const duration = (minutes: number) => (minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim() : `${minutes} min`);

// a bedroom: how its air was over the last night
function nightLine(n: AirNight | null | undefined) {
    if (!n) return '';
    const above = n.minutesAbove1000 ? `${duration(n.minutesAbove1000)} above 1000 ppm` : 'never above 1000 ppm';
    return `<div class="room-night"><i class="ti ti-moon"></i><span><b>Last night</b> · CO₂ ${n.co2Mean} ppm on average, ${above} · ${n.temperatureMin.toFixed(1)}–${n.temperatureMax.toFixed(1)} °C</span></div>`;
}

// how the room feels: humidity 20-80 % left to right, temperature 16-28 °C bottom to top; the comfort zone in the middle
function dial(t: number | undefined, rh: number | undefined, word: string) {
    const x = rh === undefined ? 100 : 100 + clamp((rh - 50) / 30, -1, 1) * 62;
    const y = t === undefined ? 100 : 100 - clamp((t - 21.5) / 6, -1, 1) * 62;
    return `<svg viewBox="-34 0 268 200" class="room-dial" role="img" aria-label="Room comfort: ${word}">
        <circle cx="100" cy="100" r="74" class="room-dial-ring" />
        <circle cx="100" cy="100" r="24" class="room-dial-zone" />
        ${t === undefined || rh === undefined ? '' : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" class="room-dial-dot" />`}
        <text x="100" y="16" class="room-dial-label" text-anchor="middle">TOO WARM</text>
        <text x="100" y="194" class="room-dial-label" text-anchor="middle">COLD</text>
        <text x="20" y="104" class="room-dial-label" text-anchor="end">DRY</text>
        <text x="180" y="104" class="room-dial-label" text-anchor="start">HUMID</text>
    </svg>
    <div class="room-dial-word">${word}</div>`;
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
    return `<svg viewBox="0 -4 ${w} ${h + 8}" class="room-line" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="room-line-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
        <line x1="0" x2="${w}" y1="${y(800).toFixed(1)}" y2="${y(800).toFixed(1)}" class="room-line-mark" />
        <line x1="0" x2="${w}" y1="${y(1200).toFixed(1)}" y2="${y(1200).toFixed(1)}" class="room-line-mark" />
        <polygon points="0,${h} ${xy.join(' ')} ${w},${h}" fill="url(#room-line-fill)" />
        <polyline points="${xy.join(' ')}" fill="none" stroke="#f2f2f2" stroke-width="2" vector-effect="non-scaling-stroke" />
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
    const kind = d.air?.roomKind;
    const recent: RecentAir[] = (history.get(d._id) ?? [])
        .filter((r) => Date.now() - r.at <= 25 * 60_000)
        .map((r) => ({ at: r.at, humidity: r.humidity, co2: r.co2 }));
    if (s) recent.push({ at: Date.now(), humidity: s.humidity, co2: s.co2 });
    const advice = s
        ? allRoomHints(kind, { temperature: t, humidity: rh, co2: s.co2 }, weather, recent, { hour: new Date().getHours(), night: s.night })[0]
        : undefined;
    const points = [...(history.get(d._id) ?? [])];
    if (s?.co2 !== undefined) points.push({ at: Date.now(), co2: s.co2, temperature: 0, humidity: 0 });
    // OpenWeather asks to be named where its data is shown
    const notes = [climate?.fromTado ? 'temperature and humidity from tado' : '', weather?.source === 'openweather' ? 'weather © OpenWeather' : '']
        .filter(Boolean)
        .join(' · ');
    return `<a href="/air/${d._id}" class="card room-card room-${f.tone} text-reset text-decoration-none h-100" data-air-card="${d._id}">
        <div class="room-head"><span class="room-name">${escapeHtml(d.name)}</span>${outside}</div>
        ${d.online ? '' : `<div class="room-offline">offline${d.lastSeen ? ` since ${timeAgo(d.lastSeen)}` : ''}</div>`}
        ${dial(t, rh, comfort(t, rh))}
        <div class="room-tiles">
            ${tile('temperature', 'Temperature', t === undefined ? '–' : `${t.toFixed(1)}°`)}
            ${tile('droplet', 'Humidity', rh === undefined ? '–' : `${Math.round(rh)}%`)}
            ${tile('leaf', s?.co2 !== undefined ? `Air · ${s.co2} ppm` : 'Air', f.word)}
        </div>
        ${points.length > 1 ? `<div class="room-line-box"><div class="room-line-caption">CO₂, last ${HISTORY_HOURS} h</div>${co2Line(points)}</div>` : ''}
        ${adviceChip(advice)}
        ${kind === 'bedroom' ? nightLine(nights.get(d._id)) : ''}
        ${windowChip(s, lastOpen)}
        ${notes ? `<div class="room-note">${notes}</div>` : ''}
    </a>`;
}
