import { allRoomHints } from '../../../shared/climate';
import { productName, roomClimate, airSensorError } from '../../../shared/protocol';
import { LEVEL_ORDER, type AnalysisReport, type AnalysisSection, type Finding, type FindingLevel } from '../../../shared/analysis';
import { lastNight, recentAirOf, smokeDays } from '../core/air';
import { AirReading, Device, HealthLink, Meter, TadoReading } from '../core/db';
import { getSummaries, summarize } from '../core/devices';
import { logger } from '../core/logger';
import { weatherForUser } from '../core/weather';
import { configured } from '../health/google';
import { summary, syncStatus, trackers } from '../health/service';
import { heatInsights } from '../heat/insights';
import { meterPeriods, meterReadings, meterState } from '../meters/service';
import { status as heatingStatus } from '../tado/service';
import { baseLoad, dayVsUsual, recentVsUsual, thermometerGap } from './checks';

/*
 * The analysis page and kibbl_analysis: every part of kibbl. asked what stands out now, in one
 * report. Each part is analysed on its own; one that fails (a source down) shows its error and
 * the rest still come. The parts:
 * - heat: the radiators ranked and the hints of heat/insights.ts;
 * - air: each kibbl. air with the advice for its room (climate and kind), its sensor, the last
 *   night in a bedroom, cigarettes, and its thermometer against tado's in the same room;
 * - heating: tado's connection, its request budget, open windows it sees;
 * - meters: sync, battery, yesterday against the usual day, the base load at night;
 * - devices: offline, camera errors, firmware updates, devices waiting for approval;
 * - health: the tracker's sync and battery, the sign-in, resting heart rate, HRV and sleep
 *   of the last week against the four before.
 */

const log = logger('analysis');
const DAY_MS = 86_400_000;
const CACHE_MS = 2 * 60_000;
const OFFLINE_MS = 15 * 60_000;

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const local = (t: number) => ({ day: dayFmt.format(new Date(t)), hour: Number(hourFmt.format(new Date(t))) });
const today = () => dayFmt.format(new Date());
const n0 = (v: number) => Math.round(v).toLocaleString('en');
const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en');
const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60_000);
    return m < 120 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};

/* ----------------------------------------------------------------------- */

async function heat(userID: string): Promise<Finding[]> {
    const h = await heatInsights(userID);
    const icons: Record<string, string> = {
        top: 'trophy',
        weather: 'temperature-plus',
        warm: 'sun',
        window: 'window',
        cold: 'droplet-half-2',
        loss: 'wind',
        data: 'info-circle',
    };
    return h.insights.map((x) => ({ level: x.level, icon: icons[x.kind], title: x.title, text: x.text, link: '/heat' }));
}

async function air(userID: string): Promise<Finding[]> {
    const docs = await Device.find({ ownerID: userID, status: 'approved', caps: 'air' }).lean();
    const weather = await weatherForUser(userID);
    const out: Finding[] = [];
    for (const doc of docs) {
        const s = summarize(doc);
        const a = s.air;
        const link = `/air/${doc._id}`;
        const base = { link, device: doc.name };
        // offline: the devices part says so
        if (!s.online) continue;
        const sensor = airSensorError(a?.state, a?.sensorError);
        if (sensor) out.push({ ...base, level: 'alert', icon: 'alert-triangle', title: `${doc.name}: the CO2 sensor does not answer`, text: sensor });
        if (a?.state?.fire)
            out.push({
                ...base,
                level: 'alert',
                icon: 'flame',
                title: `${doc.name}: fire alarm`,
                text: 'The device sounds its fire alarm. Check the room now.',
            });

        const state = a?.state;
        if (state) {
            const hints = allRoomHints(a?.roomKind, { ...state, ...roomClimate(a) }, weather, recentAirOf(doc._id), {
                hour: local(Date.now()).hour,
                night: state.night,
            });
            const shown = hints.filter((x) => x.level !== 'good');
            for (const x of shown) out.push({ ...base, level: x.level, icon: x.icon, title: `${doc.name}: ${x.title}`, text: x.text });
            if (!shown.length)
                out.push({
                    ...base,
                    level: 'good',
                    icon: 'mood-smile',
                    title: `${doc.name}: the air is fine`,
                    text: hints.map((x) => x.title).join(' · ') || 'Nothing to change.',
                });
        }

        if (a?.roomKind === 'bedroom' && a.schedule) {
            const night = await lastNight(doc._id, a.schedule);
            if (night && (night.co2Mean > 1000 || night.minutesAbove1000 > 60)) {
                out.push({
                    ...base,
                    level: 'warn',
                    icon: 'moon',
                    title: `${doc.name}: stale air last night`,
                    text: `CO2 ${n0(night.co2Mean)} ppm on average, ${n0(night.minutesAbove1000)} minutes above 1000 ppm. Air before bed, or leave a door or window ajar.`,
                });
            }
        }

        const smoke = (await smokeDays(doc._id, 7)).reduce((s, d) => s + d.count, 0);
        if (smoke)
            out.push({
                ...base,
                level: 'info',
                icon: 'smoking',
                title: `${doc.name}: ${smoke} cigarette${smoke > 1 ? 's' : ''} in 7 days`,
                text: 'Counted from the CO2 of the smoke and the button.',
            });

        // its thermometer against tado's in the same room, over the last 6 hours
        if (a?.room?.source === 'tado') {
            const since = new Date(Date.now() - 6 * 3600_000);
            const [airRows, tadoRows] = await Promise.all([
                AirReading.find({ deviceId: doc._id, at: { $gte: since } }, { _id: 0, at: 1, temperature: 1 }).lean(),
                TadoReading.find({ userID, roomId: a.room.id, at: { $gte: since } }, { _id: 0, at: 1, temperature: 1 }).lean(),
            ]);
            const gap = thermometerGap(
                airRows.map((r) => ({ at: r.at.getTime(), temperature: r.temperature })),
                tadoRows.map((r) => ({ at: r.at.getTime(), temperature: r.temperature })),
            );
            if (gap && Math.abs(gap.gap) >= 2) {
                out.push({
                    ...base,
                    level: Math.abs(gap.gap) >= 4 ? 'warn' : 'info',
                    icon: 'temperature',
                    title: `${doc.name} and tado disagree by ${n1(Math.abs(gap.gap))} °C`,
                    text: `Over the last 6 hours the kibbl. air read ${gap.gap > 0 ? 'warmer' : 'colder'} than tado's thermostat in the same room. Move it away from a lamp, screen, radiator or sunny spot, or set its temperature offset in its settings.`,
                });
            }
        }
    }
    return out;
}

async function heating(userID: string): Promise<Finding[]> {
    const h = await heatingStatus(userID);
    if (!h.connected) return [];
    const out: Finding[] = [];
    const link = '/rooms';
    if (h.error) out.push({ level: 'warn', icon: 'plug-x', title: 'tado: not read', text: h.error, link });
    if (h.budget?.paused)
        out.push({
            level: 'warn',
            icon: 'hourglass',
            title: 'tado: requests used up',
            text: 'Only commands go out until tado refills the daily budget.',
            link,
        });
    if (h.lastPoll && Date.now() - h.lastPoll > 2 * 3600_000)
        out.push({ level: 'warn', icon: 'clock-pause', title: 'tado: no read for a while', text: `Last read ${ago(h.lastPoll)} ago.`, link });
    for (const r of h.rooms) {
        if (r.openWindow)
            out.push({
                level: 'info',
                icon: 'window',
                title: `${r.name}: tado sees an open window`,
                text: 'The heating there is paused while it is open.',
                link,
            });
    }
    if (!out.length) {
        const on = h.rooms.filter((r) => r.power === 'ON');
        out.push({
            level: 'good',
            icon: 'flame',
            title: 'tado: all fine',
            text: `${h.rooms.length} room${h.rooms.length === 1 ? '' : 's'}, ${on.length} heating${on.length ? ` (${on.map((r) => `${r.name} to ${r.target} °C`).join(', ')})` : ''}; read ${h.lastPoll ? ago(h.lastPoll) : '?'} ago.`,
            link,
        });
    }
    return out;
}

async function meters(userID: string): Promise<Finding[]> {
    const docs = await Meter.find({ ownerID: userID }).lean();
    const out: Finding[] = [];
    for (const m of docs) {
        const link = `/meter/${m._id}`;
        const st = await meterState(m);
        if (st.lastSyncError) out.push({ level: 'warn', icon: 'plug-x', title: `${m.name}: the LoRaWAN server does not answer`, text: st.lastSyncError, link });
        if (st.latest && Date.now() - st.latest.at > 6 * 3600_000) {
            out.push({
                level: 'warn',
                icon: 'antenna-bars-off',
                title: `${m.name}: no reading for ${ago(st.latest.at)}`,
                text: 'The meter usually reports every 30 minutes: check its battery and signal.',
                link,
            });
        }
        const b = st.battery;
        if (b?.daysLeft !== null && b?.daysLeft !== undefined && b.daysLeft < 60) {
            out.push({
                level: b.daysLeft < 14 ? 'alert' : 'warn',
                icon: 'battery-1',
                title: `${m.name}: battery for about ${b.daysLeft} days`,
                text: `${b.percent ?? '?'} % left at the current drain.`,
                link,
            });
        }
        const day = dayVsUsual(await meterPeriods(m._id, 'day'), today());
        if (day && (day.ratio >= 1.4 || day.ratio <= 0.6)) {
            out.push({
                level: day.ratio >= 1.4 ? 'warn' : 'info',
                icon: day.ratio >= 1.4 ? 'trending-up' : 'trending-down',
                title: `${m.name}: ${day.day} used ${n1(day.ratio)}× the usual`,
                text: `${n1(day.use)} ${m.unit} against ${n1(day.usual)} ${m.unit} on a usual day of the last 4 weeks.`,
                link,
            });
        }
        if (m.unit === 'kWh' && m.medium === 'electricity') {
            const readings = await meterReadings(m._id, new Date(Date.now() - 8 * DAY_MS), new Date(), 100_000);
            const load = baseLoad(readings, local);
            if (load) {
                out.push({
                    level: load.watts >= 150 ? 'warn' : 'info',
                    icon: 'plug',
                    title: `${m.name}: ${n0(load.watts)} W run all night`,
                    text:
                        `The base load from 01:00 to 05:00 over ${load.nights} nights, about ${n0((load.watts * 8760) / 1000)} kWh a year.` +
                        (load.watts >= 150 ? ' Look for standby devices, an old fridge or freezer, a heater or a pump that runs all the time.' : ''),
                    link,
                });
            }
        }
        if (!out.some((f) => f.link === link)) {
            out.push({
                level: 'good',
                icon: 'gauge',
                title: `${m.name}: as usual`,
                text: st.today ? `${n1(st.today.consumption)} ${m.unit} today so far.` : 'Nothing stands out.',
                link,
            });
        }
    }
    return out;
}

async function devices(userID: string): Promise<Finding[]> {
    const [approved, pending] = await Promise.all([
        getSummaries({ ownerID: userID, status: 'approved' }),
        getSummaries({ ownerID: userID, status: 'pending' }),
    ]);
    const out: Finding[] = [];
    for (const d of approved) {
        const kind = productName(d.model, d.caps);
        const link = d.caps.includes('air') ? `/air/${d._id}` : d.caps.includes('camera') ? `/camera/${d._id}` : '/devices';
        if (!d.online) {
            const long = !d.lastSeen || Date.now() - d.lastSeen > OFFLINE_MS;
            if (long)
                out.push({
                    level: 'warn',
                    icon: 'wifi-off',
                    title: `${d.name} (${kind}) is offline`,
                    text: d.lastSeen ? `Last seen ${ago(d.lastSeen)} ago.` : 'Not seen yet.',
                    link,
                    device: d.name,
                });
            continue;
        }
        if (d.cameraError)
            out.push({
                level: 'warn',
                icon: 'camera-off',
                title: `${d.name}: camera error`,
                text: /init 0x10[56]/.test(d.cameraError)
                    ? 'The camera module does not answer: check its ribbon cable, then power it off and on.'
                    : d.cameraError,
                link,
                device: d.name,
            });
        if (d.update && !d.update.installing)
            out.push({
                level: 'info',
                icon: 'download',
                title: `${d.name}: update ${d.update.version}`,
                text: 'A newer firmware is ready on the Devices page.',
                link: '/devices',
                device: d.name,
            });
        if (d.wifiChangeFailed)
            out.push({
                level: 'info',
                icon: 'wifi',
                title: `${d.name}: Wi-Fi change failed`,
                text: `It could not join ${d.wifiChangeFailed} and went back.`,
                link,
                device: d.name,
            });
    }
    for (const d of pending)
        out.push({
            level: 'info',
            icon: 'user-check',
            title: `${d.name} waits for approval`,
            text: 'Approve it on the Devices page before it is used.',
            link: '/devices',
            device: d.name,
        });
    if (!out.length)
        out.push({
            level: 'good',
            icon: 'circle-check',
            title: 'All devices online',
            text: `${approved.length} device${approved.length === 1 ? '' : 's'}, no errors.`,
            link: '/devices',
        });
    return out;
}

async function health(userID: string): Promise<Finding[]> {
    if (!configured()) return [];
    const link = await HealthLink.findById(userID, { refreshTokenExpiresAt: 1 }).lean();
    if (!link) return [];
    const out: Finding[] = [];
    const page = '/health';
    const sync = await syncStatus(userID);
    if (sync.error) out.push({ level: 'warn', icon: 'refresh-alert', title: 'Health: sync failed', text: String(sync.error), link: page });
    if (link.refreshTokenExpiresAt && link.refreshTokenExpiresAt - Date.now() < 3 * DAY_MS) {
        out.push({
            level: 'warn',
            icon: 'key',
            title: 'Health: sign in again soon',
            text: `The link to the tracker ends in ${ago(2 * Date.now() - link.refreshTokenExpiresAt)}: sign in on the Health page to keep it.`,
            link: page,
        });
    }
    for (const t of trackers(userID)) {
        if (typeof t.battery === 'number' && t.battery <= 20)
            out.push({
                level: 'warn',
                icon: 'battery-1',
                title: `${t.name}: battery ${t.battery} %`,
                text: 'Charge the tracker so the night is recorded.',
                link: page,
            });
    }
    const data = (await summary(userID, '90')) as { series?: Record<string, { date: string | null; value?: unknown }[]> } | undefined;
    const s = data?.series ?? {};
    const now = today();
    const rhr = recentVsUsual(s.resting_hr ?? [], now);
    if (rhr && rhr.recent - rhr.usual >= 4) {
        out.push({
            level: rhr.recent - rhr.usual >= 7 ? 'warn' : 'info',
            icon: 'heart-rate-monitor',
            title: `Resting heart rate up ${n1(rhr.recent - rhr.usual)} bpm`,
            text: `${n1(rhr.recent)} bpm this week against ${n1(rhr.usual)} before: often a coming cold, stress, alcohol or too little sleep.`,
            link: page,
        });
    }
    const hrv = recentVsUsual(s.hrv ?? [], now);
    if (hrv && hrv.recent <= hrv.usual * 0.85) {
        out.push({
            level: 'info',
            icon: 'activity-heartbeat',
            title: `HRV down ${n0((1 - hrv.recent / hrv.usual) * 100)} %`,
            text: `${n0(hrv.recent)} ms this week against ${n0(hrv.usual)} ms before: the body recovers less well.`,
            link: page,
        });
    }
    const sleep = recentVsUsual(s.sleep ?? [], now);
    if (sleep && sleep.recent < 7) {
        out.push({
            level: sleep.recent < 6 ? 'warn' : 'info',
            icon: 'zzz',
            title: `Sleep ${n1(sleep.recent)} h a night this week`,
            text: `Usual before: ${n1(sleep.usual)} h. Most adults need 7 to 9 hours.`,
            link: page,
        });
    }
    if (!out.length && (rhr || sleep))
        out.push({
            level: 'good',
            icon: 'heart',
            title: 'Health: as usual',
            text: 'Resting heart rate, HRV and sleep this week are in your usual range.',
            link: page,
        });
    return out;
}

/* ----------------------------------------------------------------------- */

const PARTS: { source: AnalysisSection['source']; title: string; run: (userID: string) => Promise<Finding[]> }[] = [
    { source: 'heat', title: 'Heat & radiators', run: heat },
    { source: 'air', title: 'Air in the rooms', run: air },
    { source: 'heating', title: 'Heating (tado)', run: heating },
    { source: 'meters', title: 'Meters', run: meters },
    { source: 'devices', title: 'Devices', run: devices },
    { source: 'health', title: 'Health', run: health },
];

const rank = (f: Finding) => LEVEL_ORDER.indexOf(f.level);

const cache = new Map<string, { at: number; value: Promise<AnalysisReport> }>();

// fresh: analysed again now, also within the time a report is kept
export function analysis(userID: string, fresh = false): Promise<AnalysisReport> {
    const hit = cache.get(userID);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = build(userID);
    cache.set(userID, { at: Date.now(), value });
    value.catch(() => cache.delete(userID));
    return value;
}

async function build(userID: string): Promise<AnalysisReport> {
    const sections = await Promise.all(
        PARTS.map(async (p): Promise<AnalysisSection> => {
            try {
                return { source: p.source, title: p.title, findings: (await p.run(userID)).sort((a, b) => rank(a) - rank(b)) };
            } catch (err) {
                log.warn('part not analysed', { part: p.source, user: userID }, err);
                return { source: p.source, title: p.title, findings: [], error: (err as Error).message };
            }
        }),
    );
    const shown = sections.filter((s) => s.findings.length || s.error);
    const counts = Object.fromEntries(LEVEL_ORDER.map((l) => [l, 0])) as Record<FindingLevel, number>;
    for (const s of shown) for (const f of s.findings) counts[f.level]++;
    return { at: Date.now(), counts, sections: shown };
}
