import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { productName, roomClimate } from '../../../shared/protocol';
import { version } from '../../../shared/version';
import { Device, HealthLink, Meter, MotionEventModel } from '../core/db';
import { getLive, summarize } from '../core/devices';
import { freshFrame } from '../core/frames';
import { ownedDeviceIds } from '../core/owners';
import { imageRoot, resolveInside } from '../core/storage';
import { INTRADAY } from '../health/extract';
import { configured } from '../health/google';
import { INTRADAY_TYPES, intraday, summary, syncStatus, trackers } from '../health/service';
import { storageStats } from '../health/store';
import { meterPeriods, meterReadings, meterState } from '../meters/service';
import { meterReadings as heatMeterReadings, overview as heatOverview } from '../heat/service';
import { heatInsights } from '../heat/insights';
import { allRoomHints } from '../../../shared/climate';
import { airEvents, airReadings, lastNight, recentAirOf, smokeDays } from '../core/air';
import { weatherForUser } from '../core/weather';
import { listRooms } from '../core/rooms';
import { readings as heatingReadings, status as heatingStatus } from '../tado/service';
import { registerWriteTools } from './writeTools';

/*
 * What the MCP endpoint offers: every kind of data the app has (cameras, motion,
 * meters, health, the air of a kibbl. air, the heating), read; and the settings a person
 * changes in the app, written through the same checks (writeTools.ts). Times are the server's local time, which is the home's,
 * written as "YYYY-MM-DD HH:MM:SS"; days as YYYY-MM-DD.
 */

const DAY_MS = 24 * 3600_000;
const SNAPSHOT_MAX_AGE_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 6000;

const pad = (n: number) => String(n).padStart(2, '0');

export function localDay(time: number) {
    const d = new Date(time);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function localTime(time: number | null | undefined) {
    if (typeof time !== 'number') return null;
    const d = new Date(time);
    return `${localDay(time)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// the local midnight that starts a day, moved by whole days (a day of a clock change is 23 or 25 h)
function dayStart(day: string, addDays = 0) {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d + addDays).getTime();
}

/* A range of whole local days, both included: missing ends default to the last
 * `defaultDays` days up to today. start and end are times, end excluded. */
export function dayRange(from: string | undefined, to: string | undefined, defaultDays: number) {
    const last = to ?? localDay(Date.now());
    const first = from ?? localDay(dayStart(last, 1 - defaultDays));
    return { from: first, to: last, start: dayStart(first), end: dayStart(last, 1) };
}

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/* Evenly thinned to at most max points: each kept point stands for a run of samples,
 * with its mean, lowest and highest value. */
export function thinSamples(points: { t: string; value: number }[], max: number) {
    if (points.length <= max) return points;
    const size = Math.ceil(points.length / max);
    const out = [];
    for (let i = 0; i < points.length; i += size) {
        const run = points.slice(i, i + size);
        const values = run.map((p) => p.value);
        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        out.push({ t: run[0].t, value: Math.round(mean * 10) / 10, min: Math.min(...values), max: Math.max(...values) });
    }
    return out;
}

const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('a day, YYYY-MM-DD');
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/* ----------------------------------------------------------------------- */

// one of the user's cameras or other devices by its id or its name, any case
async function findDevice(userID: string, ref: string) {
    const docs = await Device.find({ status: 'approved', ownerID: userID }).lean();
    const lower = ref.trim().toLowerCase();
    return docs.find((d) => d._id === ref.trim().toUpperCase()) ?? docs.find((d) => d.name.toLowerCase() === lower);
}

// a kibbl. air of the user, by name or id
async function findAir(userID: string, ref: string) {
    const docs = await Device.find({ ownerID: userID, status: 'approved', caps: 'air' }).lean();
    const lower = ref.trim().toLowerCase();
    return docs.find((d) => d._id.toLowerCase() === lower) ?? docs.find((d) => d.name.toLowerCase() === lower) ?? (ref.trim() ? undefined : docs[0]);
}

async function findMeter(userID: string, ref: string) {
    const meters = await Meter.find({ ownerID: userID }).lean();
    const lower = ref.trim().toLowerCase();
    return meters.find((m) => m._id === lower) ?? meters.find((m) => m.name.toLowerCase() === lower);
}

// what the app shows of a device, without the hardware inside it
function deviceInfo(doc: DeviceDoc) {
    const s = summarize(doc);
    return {
        id: s._id,
        name: s.name,
        product: productName(s.model, s.caps),
        online: s.online,
        last_seen: localTime(s.lastSeen),
        added: localTime(s.createdAt),
        firmware: s.fw ?? null,
        capabilities: s.caps,
        motion: s.motion,
        camera: s.camera ?? null,
        camera_error: s.cameraError ?? null,
        signal_dbm: s.telemetry?.rssi ?? null,
        uptime_s: s.telemetry?.uptime ?? null,
        viewers: s.viewers,
    };
}

function meterInfo(state: Awaited<ReturnType<typeof meterState>>) {
    return {
        id: state._id,
        name: state.name,
        medium: state.medium,
        unit: state.unit,
        latest: state.latest ? { at: localTime(state.latest.at), value: state.latest.value, signal_dbm: state.latest.rssi } : null,
        power_kw: state.powerKw,
        today: state.today,
        battery: state.battery
            ? {
                  mv: state.battery.mv,
                  percent: state.battery.percent,
                  at: localTime(state.battery.at),
                  drain_mv_per_day: state.battery.drainMvPerDay,
                  days_left: state.battery.daysLeft,
              }
            : null,
        readings: state.readings,
        since: localTime(state.since),
        last_sync: localTime(state.lastSyncAt),
        last_sync_error: state.lastSyncError,
    };
}

/* ----------------------------------------------------------------------- */

// the health series of the summary, smallest stored range that holds the window
async function healthSeries(userID: string, from: string) {
    const ageDays = Math.ceil((Date.now() - dayStart(from)) / DAY_MS) + 1;
    const range = ageDays <= 30 ? '30' : ageDays <= 90 ? '90' : ageDays <= 365 ? '365' : 'all';
    const data = (await summary(userID, range)) as { series: Record<string, unknown[]>; discovered: Record<string, unknown[]> } | undefined;
    if (!data) return undefined;
    return { ...data.series, ...data.discovered } as Record<string, { date: string | null; [key: string]: unknown }[]>;
}

const METRIC_NOTES: Record<string, string> = {
    resting_hr: 'resting heart rate, bpm',
    hrv: 'heart rate variability, ms',
    spo2: 'blood oxygen, % (low, high)',
    respiratory_rate: 'breaths per minute',
    skin_temp: 'nightly skin temperature, °C, with baseline',
    sleep: 'per night: hours (value) and minutes per stage; the date is the day the night ended',
    exercise: 'workouts: type, calories, average heart rate, active zone minutes',
    active_zone_minutes: 'minutes a day',
    sedentary: 'sedentary hours a day',
    hr_zones: 'the latest personal heart rate zones',
    breathing_stages: 'breaths per minute per night, by sleep stage',
};

/* ----------------------------------------------------------------------- */

export function createMcpServer(session: SessionInfo) {
    const server = new McpServer(
        { name: 'kibbl', title: 'kibbl.', version },
        {
            instructions:
                "kibbl. is the user's home: cameras with motion detection, the air of rooms (kibbl. air: CO2, temperature, humidity, cigarettes, windows, fire alerts), the heating (tado), " +
                'utility meters, the heat used (radiator readings, Techem) and health data from a fitness tracker. ' +
                "Start with kibbl_overview. All times are the home's local time; ranges of days include both ends. " +
                'The *_set and *_edit tools change settings as the app does; the heating set by kibbl_heating_set lasts 60 minutes unless asked otherwise.',
        },
    );

    server.registerTool(
        'kibbl_overview',
        {
            title: 'Overview',
            description:
                "What the home has: cameras and other devices, meters and their latest values, the health data stored, the server's time and time zone.",
            annotations: readOnly,
        },
        async () => {
            const [devices, meters, link, stats] = await Promise.all([
                Device.find({ status: 'approved', ownerID: session.userID }).sort({ createdAt: 1 }).lean(),
                Meter.find({ ownerID: session.userID }).sort({ addedAt: 1 }).lean(),
                configured() ? HealthLink.findById(session.userID, { connectedAt: 1 }).lean() : null,
                storageStats(session.userID),
            ]);
            const states = await Promise.all(meters.map(meterState));
            return json({
                now: localTime(Date.now()),
                time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                user: session.name,
                devices: devices.map((d) => {
                    const s = summarize(d);
                    const air = s.air?.state;
                    return {
                        id: s._id,
                        name: s.name,
                        product: productName(s.model, s.caps),
                        online: s.online,
                        last_seen: localTime(s.lastSeen),
                        ...(air ? { co2: air.co2, temperature: air.temperature, humidity: air.humidity, window: air.window } : {}),
                    };
                }),
                meters: states.map((m) => ({ id: m._id, name: m.name, medium: m.medium, unit: m.unit, latest: m.latest?.value ?? null, today: m.today })),
                health: {
                    tracker_linked: !!link,
                    stored_days: stats.days,
                    first_day: stats.oldestDay,
                    last_day: stats.newestDay,
                    heart_rate_days: stats.heartRateDays,
                },
            });
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_devices',
        {
            title: 'Devices',
            description: 'The cameras and other kibbl. devices: online state, last seen, firmware, motion and camera settings, signal.',
            annotations: readOnly,
        },
        async () => {
            const docs = await Device.find({ status: 'approved', ownerID: session.userID }).sort({ createdAt: 1 }).lean();
            return json(docs.map(deviceInfo));
        },
    );

    server.registerTool(
        'kibbl_camera_picture',
        {
            title: 'Camera picture',
            description: 'A picture of what a camera sees right now. The camera must be online. Nothing is stored.',
            inputSchema: { camera: z.string().describe('the camera, by name or id') },
            annotations: readOnly,
        },
        async ({ camera }) => {
            const doc = await findDevice(session.userID, camera);
            if (!doc || !doc.caps?.includes('camera')) return fail(`No camera "${camera}". kibbl_devices lists them.`);
            if (!getLive(doc._id)) return fail(`${doc.name} is offline, last seen ${localTime(doc.lastSeen) ?? 'never'}.`);
            const frame = await freshFrame(doc._id, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_TIMEOUT_MS);
            if (!frame) return fail(`${doc.name} sent no picture: its camera is not running.`);
            return {
                content: [
                    { type: 'image', data: frame.jpeg.toString('base64'), mimeType: 'image/jpeg' },
                    { type: 'text', text: `${doc.name}, ${localTime(frame.time)}` },
                ],
            };
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_motion_events',
        {
            title: 'Motion events',
            description:
                'Motion the cameras detected, newest first: start, end, duration, how much of the picture changed (peak_share, 0-1), and whether a picture was kept. ' +
                'Pictures are kept only on cameras where the user switched that on.',
            inputSchema: {
                camera: z.string().optional().describe('only this camera, by name or id; all cameras if left out'),
                from: day.optional().describe('first day, YYYY-MM-DD; default 7 days ago'),
                to: day.optional().describe('last day, YYYY-MM-DD; default today'),
                limit: z.number().int().min(1).max(500).default(100),
            },
            annotations: readOnly,
        },
        async ({ camera, from, to, limit }) => {
            const own = await Device.find({ ownerID: session.userID }, { name: 1 }).lean();
            const names = new Map(own.map((d) => [d._id, d.name]));
            const filter: Record<string, unknown> = { deviceId: { $in: [...names.keys()] } };
            if (camera) {
                const doc = await findDevice(session.userID, camera);
                if (!doc) return fail(`No camera "${camera}". kibbl_devices lists them.`);
                filter.deviceId = doc._id;
            }
            const range = dayRange(from, to, 7);
            filter.start = { $gte: range.start, $lt: range.end };
            const [docs, total] = await Promise.all([
                MotionEventModel.find(filter).sort({ start: -1 }).limit(limit).lean(),
                MotionEventModel.countDocuments(filter),
            ]);
            return json({
                from: range.from,
                to: range.to,
                total,
                shown: docs.length,
                events: docs.map((e) => ({
                    id: e._id,
                    camera: names.get(e.deviceId) ?? e.deviceId,
                    start: localTime(e.start),
                    end: localTime(e.end),
                    duration_s: e.end ? Math.round((e.end - e.start) / 1000) : null,
                    peak_share: Math.round(e.peakScore * 1000) / 1000,
                    has_picture: !!e.snapshot,
                })),
            });
        },
    );

    server.registerTool(
        'kibbl_motion_activity',
        {
            title: 'Motion activity',
            description: 'How much motion there was, counted per hour or per day: number of events and seconds of motion. Good for patterns over weeks.',
            inputSchema: {
                camera: z.string().optional().describe('only this camera, by name or id; all cameras if left out'),
                from: day.optional().describe('first day; default 7 days ago'),
                to: day.optional().describe('last day; default today'),
                per: z.enum(['hour', 'day']).default('hour'),
            },
            annotations: readOnly,
        },
        async ({ camera, from, to, per }) => {
            const filter: Record<string, unknown> = { deviceId: { $in: await ownedDeviceIds(session.userID) } };
            if (camera) {
                const doc = await findDevice(session.userID, camera);
                if (!doc) return fail(`No camera "${camera}". kibbl_devices lists them.`);
                filter.deviceId = doc._id;
            }
            const range = dayRange(from, to, 7);
            filter.start = { $gte: range.start, $lt: range.end };
            const docs = await MotionEventModel.find(filter, { start: 1, end: 1 }).sort({ start: 1 }).lean();
            const buckets = new Map<string, { day: string; hour?: number; events: number; seconds: number }>();
            for (const e of docs) {
                const d = localDay(e.start);
                const hour = per === 'hour' ? new Date(e.start).getHours() : undefined;
                const key = `${d} ${hour ?? ''}`;
                const b = buckets.get(key) ?? { day: d, ...(hour === undefined ? {} : { hour }), events: 0, seconds: 0 };
                b.events++;
                b.seconds += Math.round(((e.end ?? e.start) - e.start) / 1000);
                buckets.set(key, b);
            }
            return json({ from: range.from, to: range.to, per, events: docs.length, buckets: [...buckets.values()] });
        },
    );

    server.registerTool(
        'kibbl_motion_picture',
        {
            title: 'Motion picture',
            description: 'The picture kept for a motion event (has_picture in kibbl_motion_events).',
            inputSchema: { event_id: z.string().uuid() },
            annotations: readOnly,
        },
        async ({ event_id }) => {
            const doc = await MotionEventModel.findOne({ _id: event_id, deviceId: { $in: await ownedDeviceIds(session.userID) } }).lean();
            if (!doc) return fail('No such motion event.');
            if (!doc.snapshot) return fail('No picture was kept for this event.');
            try {
                const jpeg = await readFile(resolveInside(imageRoot(), doc.snapshot));
                return {
                    content: [
                        { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' },
                        { type: 'text', text: `motion at ${localTime(doc.start)}` },
                    ],
                };
            } catch {
                return fail('The picture of this event is gone.');
            }
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_meters',
        {
            title: 'Meters',
            description:
                "The utility meters (electricity, gas, water, heat): latest reading, current power, today's consumption, battery and how long it lasts.",
            annotations: readOnly,
        },
        async () => {
            const meters = await Meter.find({ ownerID: session.userID }).sort({ addedAt: 1 }).lean();
            return json((await Promise.all(meters.map(meterState))).map(meterInfo));
        },
    );

    server.registerTool(
        'kibbl_meter_consumption',
        {
            title: 'Meter consumption',
            description: "A meter's consumption per day, month or year, with the meter value at the start (opening) and end (closing) of each.",
            inputSchema: {
                meter: z.string().describe('the meter, by name or id'),
                per: z.enum(['day', 'month', 'year']).default('day'),
                from: z.string().optional().describe('first day, month or year as YYYY-MM-DD, YYYY-MM or YYYY; all if left out'),
                to: z.string().optional().describe('last one, in the same form'),
            },
            annotations: readOnly,
        },
        async ({ meter, per, from, to }) => {
            const doc = await findMeter(session.userID, meter);
            if (!doc) return fail(`No meter "${meter}". kibbl_meters lists them.`);
            const rows = (await meterPeriods(doc._id, per)).filter((r) => (!from || r.key >= from) && (!to || r.key <= to));
            const total = rows.reduce((s, r) => s + (r.consumption ?? 0), 0);
            return json({ meter: doc.name, unit: doc.unit, per, total: Math.round(total * 1000) / 1000, periods: rows });
        },
    );

    server.registerTool(
        'kibbl_meter_readings',
        {
            title: 'Meter readings',
            description: 'Every reading a meter sent (meter value, battery voltage, signal), thinned evenly to max_points for long windows.',
            inputSchema: {
                meter: z.string().describe('the meter, by name or id'),
                from: day.optional().describe('first day; default 2 days ago'),
                to: day.optional().describe('last day; default today'),
                max_points: z.number().int().min(10).max(3000).default(500),
            },
            annotations: readOnly,
        },
        async ({ meter, from, to, max_points }) => {
            const doc = await findMeter(session.userID, meter);
            if (!doc) return fail(`No meter "${meter}". kibbl_meters lists them.`);
            const range = dayRange(from, to, 2);
            const rows = await meterReadings(doc._id, new Date(range.start), new Date(range.end), max_points);
            return json({
                meter: doc.name,
                unit: doc.unit,
                from: range.from,
                to: range.to,
                readings: rows.map((r) => ({ at: localTime(r.at), value: r.value, battery_mv: r.batteryMv, signal_dbm: r.rssi })),
            });
        },
    );

    server.registerTool(
        'kibbl_heat',
        {
            title: 'Heat used',
            description:
                'The heat used in the home from readings entered by hand or from a Techem report: each heat meter (the heat cost allocator of a radiator, in units ' +
                'times its factor, or a meter of the whole home in kWh or m³) with its latest reading, and the use per day, month or year; kwh_per_unit is a radiator unit in kWh by the latest imported heating cost report. Between two readings the ' +
                "use is spread by tado's heating time in the radiator's room (spread tado), else by the degree days outside (weather), else evenly. " +
                "Also tado's heating hours (heating power × time of all its rooms) and the mean outside temperature. With meter, that meter's readings.",
            inputSchema: {
                per: z.enum(['day', 'month', 'year']).default('month'),
                from: z.string().optional().describe('first day, month or year as YYYY-MM-DD, YYYY-MM or YYYY'),
                to: z.string().optional().describe('last one, in the same form'),
                meter: z.string().optional().describe('a heat meter by name or id: its readings'),
            },
            annotations: readOnly,
        },
        async ({ per, from, to, meter }) => {
            const o = await heatOverview(session.userID);
            if (meter) {
                const m = o.meters.find((x) => x._id === meter.trim() || x.name.toLowerCase() === meter.trim().toLowerCase());
                if (!m) return fail(`No heat meter "${meter}". Heat meters: ${o.meters.map((x) => x.name).join(', ') || 'none'}.`);
                return json({ meter: m.name, unit: m.unit, factor: m.factor, readings: await heatMeterReadings(session.userID, m._id) });
            }
            const len = per === 'day' ? 10 : per === 'month' ? 7 : 4;
            const periods = new Map<string, { use: Record<string, number>; heating_hours: number; outside: number[] }>();
            for (const d of o.days) {
                const key = d.date.slice(0, len);
                if ((from && key < from) || (to && key > to)) continue;
                const p = periods.get(key) ?? { use: {}, heating_hours: 0, outside: [] };
                periods.set(key, p);
                for (const m of o.meters) if (d.use[m._id] !== undefined) p.use[m.name] = (p.use[m.name] ?? 0) + d.use[m._id];
                p.heating_hours += d.heatingHours ?? 0;
                if (d.outside !== undefined) p.outside.push(d.outside);
            }
            const r2 = (v: number) => Math.round(v * 100) / 100;
            return json({
                meters: o.meters.map((m) => ({
                    id: m._id,
                    name: m.name,
                    kind: m.kind,
                    unit: m.unit,
                    factor: m.factor,
                    latest: m.latest ?? null,
                    readings: m.readings,
                })),
                kwh_per_unit: o.energy ? { value: o.energy.kWhPerUnit, from_report: `${o.energy.from ?? '?'} to ${o.energy.to ?? '?'}` } : null,
                per,
                periods: [...periods].map(([key, p]) => ({
                    period: key,
                    use: Object.fromEntries(Object.entries(p.use).map(([k, v]) => [k, r2(v)])),
                    tado_heating_hours: r2(p.heating_hours),
                    outside_mean: p.outside.length ? r2(p.outside.reduce((s, v) => s + v, 0) / p.outside.length) : null,
                })),
            });
        },
    );

    server.registerTool(
        'kibbl_heat_insights',
        {
            title: 'Heat insights',
            description:
                'Which radiator uses the most (its share of all radiators over the last year of readings, in units and kWh) and hints where heat may be wasted: ' +
                'a radiator needing more per degree day than before or counting in warm weather (valve), tado heating with a window open (kibbl. air), ' +
                'tado heating hard while the room stays cold (air in the radiator), a room cooling faster at night than the others (drafts). Hints, not measurements.',
            inputSchema: {},
            annotations: readOnly,
        },
        async () => json(await heatInsights(session.userID)),
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_air',
        {
            title: 'Air now',
            description:
                'A kibbl. air (CO2 traffic light) now: CO2, temperature (corrected for the device warmth), humidity, the traffic light level, ' +
                'window open, night mode, fire alarm, the weather outside, what its room is used for, and the advice for the room: the health hints of its climate (cold, heat, dry, humid, ' +
                'mould on outer walls) and those of its kind (a bathroom after a shower, a bedroom before and during the night, a kitchen while cooking). In a bedroom also the air of the last night.',
            inputSchema: { device: z.string().default('').describe('the kibbl. air, by name or id; the first one if left empty') },
            annotations: readOnly,
        },
        async ({ device }) => {
            const doc = await findAir(session.userID, device);
            if (!doc) return fail(`No kibbl. air "${device}". kibbl_devices lists the devices.`);
            const s = summarize(doc);
            const state = s.air?.state;
            const weather = await weatherForUser(session.userID);
            const kind = s.air?.roomKind;
            const climate = roomClimate(s.air);
            const night = kind === 'bedroom' && s.air ? await lastNight(doc._id, s.air.schedule) : undefined;
            return json({
                device: doc.name,
                online: s.online,
                room_kind: kind ?? null,
                state: state ?? null,
                settings: s.air?.settings ?? null,
                night_schedule: s.air?.schedule,
                outside: weather ? { temperature: weather.temperature, humidity: weather.humidity, at: localTime(weather.at) } : null,
                climate: state
                    ? allRoomHints(kind, { ...state, ...climate }, weather, recentAirOf(doc._id), { hour: new Date().getHours(), night: state.night }).map(
                          (h) => ({
                              level: h.level,
                              title: h.title,
                              text: h.text,
                          }),
                      )
                    : [],
                last_night: night ? { ...night, from: localTime(night.from), to: localTime(night.to) } : null,
            });
        },
    );

    server.registerTool(
        'kibbl_air_readings',
        {
            title: 'Air readings',
            description:
                'CO2 (ppm), temperature (°C) and humidity (%) of a kibbl. air, a mean per minute, as longer means for long windows (at most about 2000 points).',
            inputSchema: {
                device: z.string().default('').describe('the kibbl. air, by name or id; the first one if left empty'),
                from: day.optional().describe('first day; default today'),
                to: day.optional().describe('last day; default today'),
            },
            annotations: readOnly,
        },
        async ({ device, from, to }) => {
            const doc = await findAir(session.userID, device);
            if (!doc) return fail(`No kibbl. air "${device}". kibbl_devices lists the devices.`);
            const range = dayRange(from, to, 1);
            const rows = await airReadings(doc._id, new Date(range.start), new Date(range.end));
            return json({
                device: doc.name,
                from: range.from,
                to: range.to,
                readings: rows.map((r) => ({ at: localTime(r.at), co2: r.co2, temperature: r.temperature, humidity: r.humidity })),
            });
        },
    );

    server.registerTool(
        'kibbl_air_events',
        {
            title: 'Cigarettes, windows, fire',
            description:
                'What a kibbl. air detected: cigarettes (source button = logged by hand, auto = found in the CO2 of exhaled smoke, rough; ' +
                'auto with button true was logged too and counts once), windows opened and closed, fire alerts; and cigarettes per day.',
            inputSchema: {
                device: z.string().default('').describe('the kibbl. air, by name or id; the first one if left empty'),
                days: z.number().int().min(1).max(366).default(7),
            },
            annotations: readOnly,
        },
        async ({ device, days }) => {
            const doc = await findAir(session.userID, device);
            if (!doc) return fail(`No kibbl. air "${device}". kibbl_devices lists the devices.`);
            const [events, perDay] = await Promise.all([airEvents(doc._id, Date.now() - days * DAY_MS, 1000), smokeDays(doc._id, days)]);
            return json({
                device: doc.name,
                cigarettes_per_day: perDay,
                events: events.map((e) => ({
                    at: localTime(e.at),
                    kind: e.kind,
                    ...Object.fromEntries(Object.entries(e).filter(([k]) => !['_id', 'deviceId', 'at', 'kind'].includes(k))),
                })),
            });
        },
    );

    server.registerTool(
        'kibbl_heating',
        {
            title: 'Heating',
            description:
                'The heating through tado: each tado room with its temperature and humidity (measured by tado), what it heats to (null: off), heating power in %, manual or schedule, ' +
                "tado's open window detection, and the room of the home it is in (a kibbl. air in the same room shares its temperature and humidity). With hours, the readings of a room (every 2 to 20 min).",
            inputSchema: {
                room: z.string().optional().describe('a tado room by name, for its readings'),
                hours: z
                    .number()
                    .int()
                    .min(1)
                    .max(24 * 31)
                    .default(24),
            },
            annotations: readOnly,
        },
        async ({ room, hours }) => {
            const [h, homeRooms] = await Promise.all([heatingStatus(session.userID), listRooms(session.userID)]);
            if (!h.connected) return fail('tado is not connected (Devices, Heating · tado).');
            const roomName = (id?: string) => homeRooms.find((r) => r._id === id)?.name ?? null;
            const out: Record<string, unknown> = {
                home: h.home?.name,
                last_read: localTime(h.lastPoll),
                requests_left_today: h.budget?.remaining ?? null,
                rooms: h.rooms.map((r) => ({
                    name: r.name,
                    in_room: roomName(r.roomId),
                    temperature: r.temperature ?? null,
                    humidity: r.humidity ?? null,
                    heats_to: r.target ?? null,
                    heating_percent: r.heating,
                    manual: r.manual,
                    window_open: r.openWindow,
                })),
            };
            if (room) {
                const r = h.rooms.find((x) => x.name.toLowerCase() === room.trim().toLowerCase());
                if (!r) return fail(`No tado room "${room}".`);
                const rows = await heatingReadings(session.userID, r.id, new Date(Date.now() - hours * 3600_000), new Date());
                out.readings = rows.map((x) => ({
                    at: localTime(x.at),
                    temperature: x.temperature ?? null,
                    humidity: x.humidity ?? null,
                    heats_to: x.target,
                    heating_percent: x.heating,
                }));
            }
            return json(out);
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_health_status',
        {
            title: 'Health status',
            description: 'The fitness tracker and the stored health history: which metrics exist, the days covered, the last sync, battery.',
            annotations: readOnly,
        },
        async () => {
            const [stats, sync, link] = await Promise.all([
                storageStats(session.userID),
                syncStatus(session.userID),
                configured() ? HealthLink.findById(session.userID, { connectedAt: 1, refreshTokenExpiresAt: 1, discoveredTypes: 1 }).lean() : null,
            ]);
            return json({
                linked: !!link,
                link_expires: localTime(link?.refreshTokenExpiresAt),
                trackers: trackers(session.userID).map((t) => ({ name: t.name, battery: t.battery, last_sync: t.lastSync })),
                tracker_last_sync: sync.tracker_last_sync,
                sync_error: sync.error,
                stored: stats,
                daily_metrics: { ...METRIC_NOTES, ...Object.fromEntries((link?.discoveredTypes ?? []).map((t) => [t, 'one value a day'])) },
                intraday_types: [...INTRADAY_TYPES],
            });
        },
    );

    server.registerTool(
        'kibbl_health_daily',
        {
            title: 'Health per day',
            description:
                'Health metrics day by day from the stored history: resting_hr, hrv, spo2, respiratory_rate, skin_temp, sleep, exercise, ' +
                'active_zone_minutes, sedentary, hr_zones, breathing_stages, and other recorded types such as steps (kibbl_health_status lists them).',
            inputSchema: {
                metrics: z.array(z.string()).optional().describe('the metrics wanted; all if left out'),
                from: day.optional().describe('first day; default 30 days ago'),
                to: day.optional().describe('last day; default today'),
                sleep_stages: z.boolean().default(false).describe('include the timeline of sleep stages of each night (long)'),
            },
            annotations: readOnly,
        },
        async ({ metrics, from, to, sleep_stages }) => {
            const range = dayRange(from, to, 30);
            const series = await healthSeries(session.userID, range.from);
            if (!series) return fail('No health data is stored yet.');
            const wanted = metrics?.length ? metrics : Object.keys(series);
            const unknown = wanted.filter((m) => !(m in series));
            const out: Record<string, unknown[]> = {};
            for (const m of wanted.filter((m) => m in series)) {
                const rows = m === 'hr_zones' ? series[m] : series[m].filter((r) => r.date && r.date >= range.from && r.date <= range.to);
                out[m] = m === 'sleep' && !sleep_stages ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'seg'))) : rows;
            }
            return json({ from: range.from, to: range.to, metrics: out, ...(unknown.length ? { not_recorded: unknown, recorded: Object.keys(series) } : {}) });
        },
    );

    server.registerTool(
        'kibbl_health_intraday',
        {
            title: 'Health during a day',
            description:
                'One metric through one day: heart-rate (bpm), oxygen-saturation, steps, distance (mm), active-zone-minutes, ' +
                'sedentary-period (blocks of sitting) or sedentary-granular (each minute sedentary, active or not worn). Today comes live from the tracker.',
            inputSchema: {
                type: z.enum([...INTRADAY_TYPES] as [string, ...string[]]),
                date: day,
                max_points: z.number().int().min(24).max(1440).default(288).describe('heart rate is thinned to this many points, each with min and max'),
            },
            annotations: readOnly,
        },
        async ({ type, date, max_points }) => {
            try {
                const data = (await intraday(session.userID, type, date)) as Record<string, unknown>;
                if (Array.isArray(data.points) && INTRADAY[type]?.kind === 'sample') {
                    const points = data.points as { t: string; value: number }[];
                    const thinned = thinSamples(points, max_points);
                    return json({
                        ...data,
                        points: thinned,
                        resolution: thinned.length < points.length ? `${points.length} samples in ${thinned.length}` : 'full',
                    });
                }
                return json(data);
            } catch (err) {
                return fail(`The tracker data of ${date} could not be read: ${(err as Error).message}`);
            }
        },
    );

    registerWriteTools(server, session);
    return server;
}
