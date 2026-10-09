import { randomUUID } from 'node:crypto';
import { kWhPerUnit, type HeatDay, type HeatKind, type HeatMeter, type HeatOverview, type HeatReading, type HeatUnit } from '../../../shared/heat';
import { HeatMeterModel, HeatReadingModel, HeatReportModel, TadoLink, TadoReading } from '../core/db';
import { hub } from '../core/hub';
import { logger } from '../core/logger';
import { homeOf } from '../core/weather';
import { dayKeys, spread } from './estimate';
import { outsideMeans } from './outside';

/*
 * The heat used in a home (shared/heat.ts): its heat meters, the readings entered for them
 * (in the app, from a report, by an assistant) and the use per day, spread between the
 * readings by tado's heating time in the room, else the weather outside.
 */

const log = logger('heat');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone; // the home's (the server's, TZ)
const DAY_MS = 24 * 3600_000;
const SHOWN_DAYS = 60; // without readings, or after the last: tado's heating and the weather of these days
const FULL_DAY_HOURS = 20; // tado's readings of a day must span this much for the day to count

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const daysBefore = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

export class HeatError extends Error {}

/* ----------------------------------------------------------------------- */

export async function listMeters(userID: string): Promise<HeatMeter[]> {
    const meters = await HeatMeterModel.find({ ownerID: userID }).sort({ kind: -1, name: 1 }).lean();
    const stats = await HeatReadingModel.aggregate<{ _id: string; count: number; date: string; value: number }>([
        { $match: { meterId: { $in: meters.map((m) => m._id) } } },
        { $sort: { date: 1 } },
        { $group: { _id: '$meterId', count: { $sum: 1 }, date: { $last: '$date' }, value: { $last: '$value' } } },
    ]);
    const of = new Map(stats.map((s) => [s._id, s]));
    return meters.map((m) => ({
        _id: m._id,
        name: m.name,
        kind: m.kind,
        unit: m.unit as HeatUnit,
        factor: m.factor ?? 1,
        roomId: m.roomId,
        serial: m.serial,
        latest: of.get(m._id) ? { date: of.get(m._id)!.date, value: of.get(m._id)!.value } : undefined,
        readings: of.get(m._id)?.count ?? 0,
    }));
}

export interface MeterFields {
    name?: string;
    kind?: HeatKind;
    unit?: HeatUnit;
    factor?: number;
    roomId?: string | null;
    serial?: string | null;
}

export async function addMeter(userID: string, f: MeterFields & { name: string; kind: HeatKind }) {
    const _id = randomUUID();
    await HeatMeterModel.create({
        _id,
        ownerID: userID,
        name: f.name.trim(),
        kind: f.kind,
        unit: f.kind === 'radiator' ? 'units' : (f.unit ?? 'kWh'),
        factor: f.kind === 'radiator' ? (f.factor ?? 1) : 1,
        ...(f.roomId ? { roomId: f.roomId } : {}),
        ...(f.serial ? { serial: f.serial.trim() } : {}),
        addedAt: Date.now(),
    });
    log.info('heat meter added', { user: userID, name: f.name, kind: f.kind });
    hub.emit('heatUpdate', userID);
    return _id;
}

export async function updateMeter(userID: string, id: string, f: MeterFields) {
    const set: Record<string, unknown> = {};
    const unset: Record<string, 1> = {};
    if (f.name !== undefined) set.name = f.name.trim();
    if (f.factor !== undefined) set.factor = f.factor;
    if (f.unit !== undefined) set.unit = f.unit;
    for (const k of ['roomId', 'serial'] as const) {
        if (f[k] === null || f[k] === '') unset[k] = 1;
        else if (f[k] !== undefined) set[k] = f[k];
    }
    const res = await HeatMeterModel.updateOne({ _id: id, ownerID: userID }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    if (res.matchedCount) hub.emit('heatUpdate', userID);
    return res.matchedCount > 0;
}

export async function removeMeter(userID: string, id: string) {
    const res = await HeatMeterModel.deleteOne({ _id: id, ownerID: userID });
    if (!res.deletedCount) return false;
    await HeatReadingModel.deleteMany({ meterId: id });
    log.info('heat meter removed with its readings', { user: userID, meter: id });
    hub.emit('heatUpdate', userID);
    return true;
}

/* ----------------------------------------------------------------------- */

export async function meterReadings(userID: string, id: string): Promise<HeatReading[] | undefined> {
    if (!(await HeatMeterModel.exists({ _id: id, ownerID: userID }))) return undefined;
    return HeatReadingModel.find({ meterId: id }, { _id: 0, meterId: 1, date: 1, value: 1, source: 1 }).sort({ date: 1 }).lean();
}

/* Readings of a day for several meters at once, as read on a walk through the home or taken
 * from a report; a reading of the same meter and day replaces the one there. */
export async function addReadings(userID: string, date: string, values: { meterId: string; value: number }[], source: HeatReading['source']) {
    if (date > today()) throw new HeatError('A reading cannot be in the future.');
    const own = new Set((await HeatMeterModel.find({ ownerID: userID, _id: { $in: values.map((v) => v.meterId) } }, { _id: 1 }).lean()).map((m) => m._id));
    const unknown = values.filter((v) => !own.has(v.meterId));
    if (unknown.length) throw new HeatError(`No such heat meter: ${unknown.map((v) => v.meterId).join(', ')}`);
    await HeatReadingModel.bulkWrite(
        values.map((v) => ({
            updateOne: {
                filter: { meterId: v.meterId, date },
                update: { $set: { value: v.value, source, enteredAt: Date.now() } },
                upsert: true,
            },
        })),
        { ordered: false },
    );
    log.info('heat readings stored', { user: userID, date, count: values.length, source });
    hub.emit('heatUpdate', userID);
}

export async function removeReading(userID: string, meterId: string, date: string) {
    if (!(await HeatMeterModel.exists({ _id: meterId, ownerID: userID }))) return false;
    const res = await HeatReadingModel.deleteOne({ meterId, date });
    if (res.deletedCount) hub.emit('heatUpdate', userID);
    return res.deletedCount > 0;
}

/* ----------------------------------------------------------------------- */

/* tado's heating per room and day: the mean heating power of the day's readings times 24
 * hours, for days its readings span (the first, partly read day of a room does not count;
 * today counts its hours so far). */
async function tadoHours(userID: string, from: string, now: string) {
    const docs = await TadoReading.aggregate<{ _id: { room: number; day: string }; mean: number; first: Date; last: Date }>([
        { $match: { userID, at: { $gte: new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS) } } },
        {
            $group: {
                _id: { room: '$roomId', day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: TZ } } },
                mean: { $avg: '$heating' },
                first: { $min: '$at' },
                last: { $max: '$at' },
            },
        },
    ]);
    const perRoom = new Map<number, Map<string, number>>();
    for (const d of docs) {
        const span = (d.last.getTime() - d.first.getTime()) / 3600_000;
        const isToday = d._id.day === now;
        if (d._id.day < from || (!isToday && span < FULL_DAY_HOURS)) continue;
        const hours = isToday ? span : 24;
        if (!perRoom.has(d._id.room)) perRoom.set(d._id.room, new Map());
        perRoom.get(d._id.room)!.set(d._id.day, ((d.mean ?? 0) / 100) * hours);
    }
    return perRoom;
}

const sumOf = (maps: Map<string, number>[]) => {
    const out = new Map<string, number>();
    for (const m of maps) for (const [d, v] of m) out.set(d, (out.get(d) ?? 0) + v);
    return out;
};

/* The use per day of every heat meter, in its unit with its factor, from its first reading
 * (or the last SHOWN_DAYS) to today, with tado's heating and the weather of each day. */
export async function overview(userID: string): Promise<HeatOverview> {
    const meters = await listMeters(userID);
    const readings = await HeatReadingModel.find({ meterId: { $in: meters.map((m) => m._id) } }, { _id: 0, meterId: 1, date: 1, value: 1 })
        .sort({ date: 1 })
        .lean();
    const now = today();
    const from = [daysBefore(now, SHOWN_DAYS), ...readings.map((r) => r.date)].sort()[0];

    const [link, perRoom, home, energy] = await Promise.all([
        TadoLink.findById(userID, { rooms: 1 }).lean(),
        tadoHours(userID, from, now),
        homeOf(userID),
        latestEnergy(userID),
    ]);
    const outside = home ? await outsideMeans(home.latitude, home.longitude, from, now, now) : new Map<string, number>();
    const tadoIn = (roomId?: string) =>
        roomId ? (link?.rooms ?? []).filter((r) => r.roomId === roomId && perRoom.has(r.id)).map((r) => perRoom.get(r.id)!) : [];

    const days = new Map<string, HeatDay>(dayKeys(from, now).map((d) => [d, { date: d, use: {}, spread: {} }]));
    for (const m of meters) {
        const rooms = tadoIn(m.roomId);
        const s = spread(
            readings.filter((r) => r.meterId === m._id),
            rooms.length ? sumOf(rooms) : undefined,
            outside,
        );
        for (const [d, v] of s.use) {
            const day = days.get(d);
            if (!day) continue;
            day.use[m._id] = Math.round(v * m.factor * 1000) / 1000;
            day.spread[m._id] = s.how.get(d)!;
        }
    }
    const allTado = sumOf([...perRoom.values()]);
    for (const day of days.values()) {
        if (allTado.has(day.date)) day.heatingHours = Math.round(allTado.get(day.date)! * 100) / 100;
        if (outside.has(day.date)) day.outside = outside.get(day.date);
    }
    return { meters, days: [...days.values()], location: !!home, energy };
}

// a radiator unit in kWh, from the latest imported report that has the building's figures
async function latestEnergy(userID: string) {
    const reports = await HeatReportModel.find({ ownerID: userID, appliedAt: { $exists: true } }, { data: 1 })
        .sort({ 'data.period.to': -1 })
        .lean();
    for (const r of reports) {
        const k = kWhPerUnit(r.data);
        if (k) return { kWhPerUnit: Math.round(k * 10_000) / 10_000, from: r.data.period?.from, to: r.data.period?.to };
    }
    return undefined;
}
