import type { HeatInsight, HeatInsights, HeatRank } from '../../../shared/heat';
import { AirEventModel, AirReading, Device, HeatReadingModel, TadoLink, TadoReading } from '../core/db';
import { hub } from '../core/hub';
import { listRooms } from '../core/rooms';
import { heatingButCold, heatingWhileOpen, intervals, nightLoss, openOnColdDays, warmUse, weatherIntensity, type Span } from './analysis';
import { overview } from './service';

/*
 * The findings of the heat page: which radiator uses the most over the last year of readings,
 * and hints where heat may go to waste, each from the data that shows it:
 * - a radiator that needs clearly more per degree day than it used to, or counts in warm
 *   weeks (the radiator readings with the weather; needs readings every week or month);
 * - tado heating while a kibbl. air in the room sees an open window, or windows open for
 *   hours on cold days;
 * - tado heating at full power while the room stays below its target (air in the radiator,
 *   a valve that does not open);
 * - a room that cools clearly faster at night than the others (kibbl. air temperatures):
 *   leaky windows or doors.
 */

const DAY_MS = 24 * 3600_000;
const RANK_DAYS = 365;
const WINDOW_DAYS = 30;
const TADO_DAYS = 14;
const LOSS_DAYS = 21;
const TOP_RATIO = 1.5; // the top radiator against the median of the others
const LOSS_RATIO = 1.5;

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const dayOf = (t: number) => dayFmt.format(new Date(t));
const local = (t: number) => ({ day: dayOf(t), hour: Number(hourFmt.format(new Date(t))) });

const n0 = (v: number) => Math.round(v).toLocaleString('en');
const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString('en');
const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

// windows open from the closing events of a kibbl. air (each says how long it was open)
async function openSpans(deviceId: string, since: number): Promise<Span[]> {
    const events = await AirEventModel.find({ deviceId, kind: 'window', at: { $gte: since } }, { at: 1, data: 1 }).lean();
    return events
        .filter((e) => e.data?.state === 'closed' && typeof e.data.openSeconds === 'number')
        .map((e) => ({ from: e.at - (e.data.openSeconds as number) * 1000, to: e.at }));
}

// kept a while per account: the page reloads with every tado read; a change of the heat data clears it
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Promise<HeatInsights> }>();
hub.on('heatUpdate', (userID) => cache.delete(userID));

export function heatInsights(userID: string): Promise<HeatInsights> {
    const hit = cache.get(userID);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = compute(userID);
    cache.set(userID, { at: Date.now(), value });
    value.catch(() => cache.delete(userID));
    return value;
}

async function compute(userID: string): Promise<HeatInsights> {
    const o = await overview(userID);
    const now = Date.now();
    const insights: HeatInsight[] = [];
    const rooms = await listRooms(userID);
    const roomName = (id?: string) => rooms.find((r) => r._id === id)?.name;
    const outside = new Map(o.days.filter((d) => d.outside !== undefined).map((d) => [d.date, d.outside!]));
    const perUnit = o.energy?.kWhPerUnit;

    // the radiators by their use over the last year that has readings
    const radiators = o.meters.filter((m) => m.kind === 'radiator');
    const withUse = o.days.filter((d) => radiators.some((m) => d.use[m._id] !== undefined));
    let ranking: HeatRank[] = [];
    let period: HeatInsights['period'];
    if (withUse.length) {
        const to = withUse[withUse.length - 1].date;
        const from = dayOf(Date.parse(`${to}T12:00:00Z`) - (RANK_DAYS - 1) * DAY_MS);
        period = { from: [from, withUse[0].date].sort().pop()!, to };
        const sums = radiators.map((m) => ({
            m,
            use: o.days.filter((d) => d.date >= from && d.date <= to).reduce((s, d) => s + (d.use[m._id] ?? 0), 0),
        }));
        const total = sums.reduce((s, x) => s + x.use, 0);
        ranking = (total > 0 ? sums : [])
            .map(({ m, use }) => ({
                meterId: m._id,
                name: m.name,
                roomId: m.roomId,
                use: Math.round(use * 10) / 10,
                share: use / total,
                ...(perUnit ? { kWh: Math.round(use * perUnit) } : {}),
            }))
            .sort((a, b) => b.use - a.use);
        if (ranking.length >= 2) {
            const [top, ...rest] = ranking;
            const ratio = top.use / Math.max(median(rest.map((r) => r.use)), 1e-9);
            insights.push({
                kind: 'top',
                level: ratio >= TOP_RATIO ? 'warn' : 'info',
                title: `${top.name} uses the most`,
                text:
                    `${Math.round(top.share * 100)} % of the radiators' heat (${n0(top.use)} units${top.kWh ? `, about ${n0(top.kWh)} kWh` : ''}), ` +
                    `${n1(ratio)}× a typical radiator of the home.` +
                    (ratio >= TOP_RATIO
                        ? ' A large or much used room explains it; else check its thermostat setting and whether a window there stays tilted.'
                        : ''),
                meterId: top.meterId,
                roomId: top.roomId,
            });
        }
    }

    // each radiator against the weather: needs more per cold day than it used to, or counts while warm
    const readings = await HeatReadingModel.find({ meterId: { $in: radiators.map((m) => m._id) } }, { _id: 0, meterId: 1, date: 1, value: 1 }).lean();
    let fewReadings = 0;
    for (const m of radiators) {
        const list = intervals(
            readings.filter((r) => r.meterId === m._id),
            outside,
        );
        if (list.length < 3) fewReadings++;
        const w = weatherIntensity(list);
        if (w?.unusual) {
            insights.push({
                kind: 'weather',
                level: 'warn',
                title: `${m.name} needs more heat than usual`,
                text: `From ${w.latest.from} to ${w.latest.to} it used ${n1(w.ratio)}× as much per cold day as before. A thermostat turned up, a window left tilted, or a valve that no longer closes.`,
                meterId: m._id,
                roomId: m.roomId,
            });
        }
        const warm = warmUse(list);
        if (warm) {
            insights.push({
                kind: 'warm',
                level: 'warn',
                title: `${m.name} counts in warm weather`,
                text: `${n1(warm.use * m.factor)} units from ${warm.from} to ${warm.to}, when it was warm enough not to heat. Its valve may not close (a stuck valve pin) or its thermostat is open.`,
                meterId: m._id,
                roomId: m.roomId,
            });
        }
    }

    // the rooms: windows (kibbl. air), tado heating, heat loss at night
    const [airs, link] = await Promise.all([
        Device.find({ ownerID: userID, status: 'approved', caps: 'air' }, { _id: 1, name: 1, roomId: 1 }).lean(),
        TadoLink.findById(userID, { rooms: 1 }).lean(),
    ]);
    const tadoIn = (roomId?: string) => (link?.rooms ?? []).filter((r) => roomId && r.roomId === roomId).map((r) => r.id);
    const tadoSince = new Date(now - WINDOW_DAYS * DAY_MS);
    const tadoAll = link
        ? await TadoReading.find({ userID, at: { $gte: tadoSince } }, { _id: 0, roomId: 1, at: 1, heating: 1, temperature: 1, target: 1 }).lean()
        : [];
    const tadoOf = (ids: number[], since: number) =>
        tadoAll
            .filter((r) => ids.includes(r.roomId) && r.at.getTime() >= since)
            .map((r) => ({ at: r.at.getTime(), heating: r.heating ?? 0, temperature: r.temperature, target: r.target }));

    const losses: { name: string; roomId?: string; perHour: number }[] = [];
    for (const air of airs) {
        const name = roomName(air.roomId) ?? air.name;
        const open = await openSpans(air._id, now - WINDOW_DAYS * DAY_MS);
        const ids = tadoIn(air.roomId);
        const whileHeating = ids.length ? heatingWhileOpen(open, tadoOf(ids, now - WINDOW_DAYS * DAY_MS)) : 0;
        if (whileHeating >= 1) {
            insights.push({
                kind: 'window',
                level: 'warn',
                title: `${name}: heating with the window open`,
                text: `tado heated for ${n1(whileHeating)} hours in the last ${WINDOW_DAYS} days while a window there was open. Turn the heating down before airing; a few minutes wide open loses less than a tilted window.`,
                roomId: air.roomId,
            });
        } else {
            const coldHours = openOnColdDays(open, outside, dayOf);
            const heated = ids.length > 0 || radiators.some((m) => m.roomId && m.roomId === air.roomId);
            if (coldHours >= 3 && heated) {
                insights.push({
                    kind: 'window',
                    level: 'info',
                    title: `${name}: windows open on cold days`,
                    text: `Open for ${n1(coldHours)} hours on cold days in the last ${WINDOW_DAYS} days. Short, wide airing keeps the walls warm; a radiator below a tilted window heats outside.`,
                    roomId: air.roomId,
                });
            }
        }

        // the night hours only: a few thousand of the minute readings
        const samples = (
            await AirReading.aggregate<{ at: Date; temperature: number }>([
                { $match: { deviceId: air._id, at: { $gte: new Date(now - LOSS_DAYS * DAY_MS) } } },
                { $project: { _id: 0, at: 1, temperature: 1, hour: { $hour: { date: '$at', timezone: TZ } } } },
                { $match: { hour: { $lt: 5 } } },
            ])
        ).map((r) => ({ at: r.at.getTime(), temperature: r.temperature }));
        // nights tado heated the room are left out: the heating hides the loss
        const heatedNights = new Set(
            tadoOf(ids, now - LOSS_DAYS * DAY_MS)
                .filter((t) => t.heating > 0)
                .map((t) => local(t.at))
                .filter((l) => l.hour < 5)
                .map((l) => l.day),
        );
        const loss = nightLoss(
            samples.filter((s) => !heatedNights.has(local(s.at).day)),
            outside,
            open,
            local,
        );
        if (loss) losses.push({ name, roomId: air.roomId, perHour: loss.perHour });
    }
    for (const t of link?.rooms ?? []) {
        const hours = heatingButCold(tadoOf([t.id], now - TADO_DAYS * DAY_MS));
        if (hours >= 4) {
            const name = roomName(t.roomId) ?? t.name;
            insights.push({
                kind: 'cold',
                level: 'warn',
                title: `${name}: heats hard but stays cold`,
                text: `For ${n1(hours)} hours in the last ${TADO_DAYS} days tado heated at 60 % or more while the room stayed a degree or more below its target. Bleed the radiator (air in it), check that its valve opens fully, or the radiator is small for the room.`,
                roomId: t.roomId,
            });
        }
    }
    if (losses.length >= 2) {
        for (const l of losses) {
            const others = median(losses.filter((x) => x !== l).map((x) => x.perHour));
            if (others > 0 && l.perHour / others >= LOSS_RATIO) {
                insights.push({
                    kind: 'loss',
                    level: 'warn',
                    title: `${l.name} loses heat fast at night`,
                    text: `It cools about ${n1(l.perHour / others)}× as fast as the other rooms for the same difference to outside, with the windows closed. Check the seals of its windows and doors for drafts, and the roller shutter box.`,
                    roomId: l.roomId,
                });
            }
        }
    }

    // what more data would show
    if (radiators.length && fewReadings === radiators.length) {
        insights.push({
            kind: 'data',
            level: 'info',
            title: 'Enter readings every week or month',
            text: "With three or more readings per radiator the page compares each one with the weather and finds a radiator that suddenly needs more, or one whose valve doesn't close.",
        });
    }
    if (!o.location) {
        insights.push({
            kind: 'data',
            level: 'info',
            title: 'Set the home location',
            text: 'In Settings: the weather outside is what the radiators are compared with.',
        });
    }
    if (airs.length < 2) {
        insights.push({
            kind: 'data',
            level: 'info',
            title: 'Rooms with a kibbl. air',
            text: 'With a kibbl. air in two or more rooms the page compares how fast each room loses heat at night and sees windows left open while heating.',
        });
    }
    return { period, ranking, insights };
}
