import crypto from 'node:crypto';
import { HealthPoint, HeartRateDay } from '../core/db';
import { pointDay, type FilterKind, type Row } from './extract';

/*
 * The health history on this server: Google's data points as they came, by type and
 * civil day, and the heart rate of every day at full resolution in binary.
 */

/* Stores what a fetch of the days [start, end) returned, in place of what was stored
 * for those days: a day Google revised (sleep is reprocessed after waking) is replaced
 * whole, and fetching a window twice never doubles it. Points whose day lies outside
 * the window are left to the fetch of their own window. The new points are written
 * before the old ones go, so a read in between sees the day twice at worst, never not
 * at all. */
export async function storeWindow(userID: string, type: string, kind: FilterKind, start: string, end: string, points: unknown[]) {
    const batch = crypto.randomUUID();
    const docs = points
        .map((point, seq) => ({ userID, type, day: pointDay(type, kind, point), name: (point as { name?: string })?.name, seq, batch, point }))
        .filter((d): d is typeof d & { day: string } => !!d.day && d.day >= start && d.day < end);
    if (docs.length) await HealthPoint.insertMany(docs, { ordered: false });
    await HealthPoint.deleteMany({ userID, type, day: { $gte: start, $lt: end }, batch: { $ne: batch } });
    return docs.length;
}

// the stored points of a type from a day on (all when from is undefined), in Google's order
export async function loadPoints(userID: string, type: string, from?: string, to?: string) {
    const day: Record<string, string> = {};
    if (from) day.$gte = from;
    if (to) day.$lt = to;
    const docs = await HealthPoint.find({ userID, type, ...(from || to ? { day } : {}) }, { point: 1, _id: 0 })
        .sort({ day: 1, seq: 1 })
        .lean();
    return docs.map((d) => d.point);
}

/* ----------------------------------------------------------------------- */

const hrID = (userID: string, date: string) => `${userID}|${date}`;

// heart rate values are whole beats a minute; float32 holds them, and any decimal to 1e-5
export async function saveHeartRateDay(userID: string, date: string, rows: Row[], meta: Record<string, unknown>) {
    const seconds = new Uint32Array(rows.length);
    const values = new Float32Array(rows.length);
    rows.forEach(([sec, v], i) => {
        seconds[i] = sec;
        values[i] = v;
    });
    await HeartRateDay.updateOne(
        { _id: hrID(userID, date) },
        {
            $set: {
                userID,
                date,
                count: rows.length,
                seconds: Buffer.from(seconds.buffer),
                values: Buffer.from(values.buffer),
                meta,
                fetchedAt: Date.now(),
            },
        },
        { upsert: true },
    );
}

/* A lean read returns BSON Binary, a normal one Buffer; either way the bytes are copied
 * into a fresh array, aligned for the typed arrays. */
function bytes(b: unknown): Uint8Array {
    if (Buffer.isBuffer(b)) return Uint8Array.from(b);
    const inner = (b as { buffer?: unknown })?.buffer;
    if (Buffer.isBuffer(inner) || inner instanceof Uint8Array) return Uint8Array.from(inner as Uint8Array);
    throw new Error('stored heart rate is not binary');
}

export async function loadHeartRateDay(userID: string, date: string) {
    const doc = await HeartRateDay.findById(hrID(userID, date)).lean();
    if (!doc) return undefined;
    const seconds = new Uint32Array(bytes(doc.seconds).buffer);
    const values = new Float32Array(bytes(doc.values).buffer);
    const rows: Row[] = Array.from(seconds, (sec, i) => [sec, Math.round(values[i] * 1e4) / 1e4]);
    return { rows, meta: doc.meta ?? {} };
}

export async function storedHeartRateDates(userID: string) {
    const docs = await HeartRateDay.find({ userID }, { date: 1, _id: 0 }).lean();
    return new Set(docs.map((d) => d.date));
}

/* ----------------------------------------------------------------------- */

export async function storageStats(userID: string) {
    const [points, oldest, newest, days, heartRateDays, oldestHeartRate] = await Promise.all([
        HealthPoint.countDocuments({ userID }),
        HealthPoint.findOne({ userID, type: { $ne: 'daily-heart-rate-zones' } }, { day: 1 })
            .sort({ day: 1 })
            .lean(),
        HealthPoint.findOne({ userID }, { day: 1 }).sort({ day: -1 }).lean(),
        HealthPoint.distinct('day', { userID }),
        HeartRateDay.countDocuments({ userID }),
        HeartRateDay.findOne({ userID }, { date: 1 }).sort({ date: 1 }).lean(),
    ]);
    return {
        points,
        days: days.length,
        oldestDay: oldest?.day ?? null,
        newestDay: newest?.day ?? null,
        heartRateDays,
        oldestHeartRateDay: oldestHeartRate?.date ?? null,
    };
}

export async function deleteStoredHealth(userID: string) {
    const [points, hr] = await Promise.all([HealthPoint.deleteMany({ userID }), HeartRateDay.deleteMany({ userID })]);
    return { points: points.deletedCount, heartRateDays: hr.deletedCount };
}
