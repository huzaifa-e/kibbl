import { Meter, MeterPeriod, MeterReading } from '../core/db';
import { logger } from '../core/logger';
import * as source from './source';

/*
 * Meters copied from the EMONI LoRaWAN server: once everything it has (every reading,
 * and the consumption per day, month and year, back to the manual readings before the
 * meter reported), then every 2 minutes only what is new. The copy is kibbl's own: the
 * page reads it, also while the source is down.
 */

const log = logger('meters');

const SYNC_MS = 2 * 60_000;
const FULL_DAYS = 3650; // the source starts its days at the first reading, never earlier
const FULL_MONTHS = 120;
const FULL_YEARS = 50;
const RECENT_DAYS = 3; // a day is complete only after its last reading; the latest ones are read again
const DAY_MS = 24 * 3600_000;
const POWER_WINDOW_MS = 2 * 3600_000; // power is the mean over this window of readings

// the unit a medium is counted in, from the source's device type
export function mediumOf(deviceType: string | undefined) {
    const t = (deviceType ?? '').toLowerCase();
    if (t.includes('gas')) return { medium: 'gas', unit: 'm³' };
    if (t.includes('water') || t.includes('wasser')) return { medium: 'water', unit: 'm³' };
    if (t.includes('heat') || t.includes('waerme')) return { medium: 'heat', unit: 'kWh' };
    return { medium: 'electricity', unit: 'kWh' };
}

/* ----------------------------------------------------------------------- */

async function storeReadings(meterId: string, rows: source.SourceReading[]) {
    if (!rows.length) return 0;
    // the unique (meterId, at) index drops what is already stored; the rest goes in
    const ops = rows.map((r) => ({
        updateOne: {
            filter: { meterId, at: new Date(r.at) },
            update: { $set: { value: r.meter_value ?? null, batteryMv: r.battery_mv ?? null, rssi: r.rssi ?? null } },
            upsert: true,
        },
    }));
    const res = await MeterReading.bulkWrite(ops, { ordered: false });
    return res.upsertedCount;
}

async function storePeriods(
    meterId: string,
    period: 'day' | 'month' | 'year',
    rows: { key: string; consumption: number | null; opening?: number | null; closing: number | null }[],
) {
    if (!rows.length) return;
    const now = Date.now();
    await MeterPeriod.bulkWrite(
        rows.map((r) => ({
            updateOne: {
                filter: { meterId, period, key: r.key },
                update: { $set: { consumption: r.consumption, opening: r.opening ?? null, closing: r.closing, updatedAt: now } },
                upsert: true,
            },
        })),
        { ordered: false },
    );
}

async function syncMeter(meter: MeterDoc) {
    const full = !meter.importedAt;
    const last = full ? null : await MeterReading.findOne({ meterId: meter._id }, { at: 1 }).sort({ at: -1 }).lean();

    // readings from the newest stored one on (it comes again, the index skips it)
    const rows = await source.readings(meter.devEui, last ? last.at.toISOString() : undefined);
    const added = await storeReadings(meter._id, rows);

    // the periods: everything once, then the latest ones (a day changes until it is over)
    const days = full ? FULL_DAYS : RECENT_DAYS;
    const [daily, monthly, yearly] = await Promise.all([
        source.daily(meter.devEui, days),
        source.monthly(meter.devEui, full ? FULL_MONTHS : 2),
        source.yearly(meter.devEui, full ? FULL_YEARS : 2),
    ]);
    await storePeriods(
        meter._id,
        'day',
        daily.map((d) => ({ key: d.date, consumption: d.consumption, closing: d.closing })),
    );
    await storePeriods(
        meter._id,
        'month',
        monthly.map((m) => ({ key: m.period, consumption: m.consumption, opening: m.opening, closing: m.closing })),
    );
    await storePeriods(
        meter._id,
        'year',
        yearly.map((y) => ({ key: y.period, consumption: y.consumption, opening: y.opening, closing: y.closing })),
    );

    const update: Partial<MeterDoc> = { lastSyncAt: Date.now() };
    try {
        const b = await source.batteryCycles(meter.devEui);
        const cycle = b.cycles.find((c) => c.ongoing) ?? b.cycles[0];
        update.battery = { fullMv: b.full_mv, emptyMv: b.empty_mv, cycleStartAt: cycle?.start_at, cycleStartMv: cycle?.start_mv };
    } catch {
        // battery cycles are an extra; the readings carry the voltage anyway
    }
    if (full) update.importedAt = Date.now();
    await Meter.updateOne({ _id: meter._id }, { $set: update, $unset: { lastSyncError: 1 } });

    if (full) {
        log.info('history copied', { meter: meter.name, readings: added, days: daily.length, months: monthly.length, years: yearly.length });
    } else if (added) {
        log.info('new readings', { meter: meter.name, readings: added });
    }
    return added;
}

let running = false;

export async function syncAll() {
    if (running) return;
    running = true;
    try {
        for (const meter of await Meter.find().lean()) {
            try {
                await syncMeter(meter);
            } catch (err) {
                const message = (err as Error).message;
                if (meter.lastSyncError !== message) log.warn('sync failed', { meter: meter.name }, err);
                await Meter.updateOne({ _id: meter._id }, { $set: { lastSyncError: message } });
            }
        }
    } finally {
        running = false;
    }
}

/* Meters named in METERS (uuids of configured devices on the source, comma separated)
 * are added on start; more can be added in the app. */
async function seedFromEnv() {
    const uuids = (process.env.METERS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const uuid of uuids) {
        if (await Meter.exists({ _id: uuid })) continue;
        try {
            await addMeter(uuid);
        } catch (err) {
            log.warn('meter from METERS not added', { uuid }, err);
        }
    }
}

export function initMeterSync() {
    const run = () =>
        seedFromEnv()
            .then(syncAll)
            .catch((err) => log.error('meter sync failed', undefined, err));
    run();
    setInterval(run, SYNC_MS);
}

/* ----------------------------------------------------------------------- */

export async function addMeter(uuid: string) {
    const device = await source.configuredDevice(uuid);
    const { medium, unit } = mediumOf(device.device_type);
    await Meter.updateOne(
        { _id: uuid },
        { $setOnInsert: { devEui: device.dev_eui, name: device.name, deviceType: device.device_type, medium, unit, addedAt: Date.now() } },
        { upsert: true },
    );
    log.info('meter added', { meter: device.name, devEui: device.dev_eui });
    void syncAll();
    return device;
}

export async function removeMeter(uuid: string) {
    await Promise.all([Meter.deleteOne({ _id: uuid }), MeterReading.deleteMany({ meterId: uuid }), MeterPeriod.deleteMany({ meterId: uuid })]);
}

export function syncNow() {
    void syncAll();
}

/* ----------------------------------------------------------------------- */

function batteryPercent(mv: number | null | undefined, battery: MeterDoc['battery']) {
    if (typeof mv !== 'number' || !battery || battery.fullMv <= battery.emptyMv) return null;
    return Math.max(0, Math.min(100, Math.round(((mv - battery.emptyMv) / (battery.fullMv - battery.emptyMv)) * 100)));
}

/* The latest state of a meter: its reading, the power between the last two readings,
 * today's consumption, and the battery with its drain in the current cycle. */
export async function meterState(meter: MeterDoc) {
    /* Power over about the last 2 hours: a meter counting in 0.1 kWh steps every half hour
     * shows the same value twice in a row more often than not, so two readings say 0 kW. */
    const latest = await MeterReading.findOne({ meterId: meter._id, value: { $ne: null } })
        .sort({ at: -1 })
        .lean();
    let powerKw: number | null = null;
    if (latest && meter.unit === 'kWh') {
        const earlier = await MeterReading.findOne({ meterId: meter._id, value: { $ne: null }, at: { $lte: new Date(latest.at.getTime() - POWER_WINDOW_MS) } })
            .sort({ at: -1 })
            .lean();
        const hours = earlier ? (latest.at.getTime() - earlier.at.getTime()) / 3600_000 : 0;
        if (earlier && hours > 0 && hours < 12) {
            powerKw = Math.round((((latest.value as number) - (earlier.value as number)) / hours) * 1000) / 1000;
        }
    }
    const lastBattery = await MeterReading.findOne({ meterId: meter._id, batteryMv: { $ne: null } }, { batteryMv: 1, at: 1 })
        .sort({ at: -1 })
        .lean();
    const today = await MeterPeriod.findOne({ meterId: meter._id, period: 'day' }).sort({ key: -1 }).lean();
    const count = await MeterReading.countDocuments({ meterId: meter._id });
    const first = await MeterReading.findOne({ meterId: meter._id }, { at: 1 }).sort({ at: 1 }).lean();

    // drain: from the start of the current cycle to now, per day, and the days left at that pace
    let drainMvPerDay: number | null = null;
    let daysLeft: number | null = null;
    const b = meter.battery;
    if (b?.cycleStartAt && typeof b.cycleStartMv === 'number' && lastBattery?.batteryMv) {
        const days = (lastBattery.at.getTime() - Date.parse(b.cycleStartAt)) / DAY_MS;
        if (days >= 1 && b.cycleStartMv > lastBattery.batteryMv) {
            drainMvPerDay = Math.round((b.cycleStartMv - lastBattery.batteryMv) / days);
            daysLeft = Math.max(0, Math.round((lastBattery.batteryMv - b.emptyMv) / drainMvPerDay));
        }
    }

    return {
        _id: meter._id,
        name: meter.name,
        devEui: meter.devEui,
        deviceType: meter.deviceType ?? null,
        medium: meter.medium,
        unit: meter.unit,
        latest: latest ? { at: latest.at.getTime(), value: latest.value, rssi: latest.rssi } : null,
        powerKw,
        today: today ? { date: today.key, consumption: today.consumption } : null,
        battery: lastBattery
            ? {
                  mv: lastBattery.batteryMv,
                  at: lastBattery.at.getTime(),
                  percent: batteryPercent(lastBattery.batteryMv, b),
                  fullMv: b?.fullMv ?? null,
                  emptyMv: b?.emptyMv ?? null,
                  cycleStartAt: b?.cycleStartAt ?? null,
                  drainMvPerDay,
                  daysLeft,
              }
            : null,
        readings: count,
        since: first ? first.at.getTime() : null,
        importedAt: meter.importedAt ?? null,
        lastSyncAt: meter.lastSyncAt ?? null,
        lastSyncError: meter.lastSyncError ?? null,
    };
}

export async function meterPeriods(meterId: string, period: 'day' | 'month' | 'year') {
    const rows = await MeterPeriod.find({ meterId, period }, { _id: 0, key: 1, consumption: 1, opening: 1, closing: 1 }).sort({ key: 1 }).lean();
    return rows;
}

/* Readings of a window for the live and battery charts; a long window is thinned to
 * about one reading in `every` so a year stays a few thousand points. */
export async function meterReadings(meterId: string, from: Date, to: Date, maxPoints = 3000) {
    const filter = { meterId, at: { $gte: from, $lt: to } };
    const count = await MeterReading.countDocuments(filter);
    const every = Math.max(1, Math.ceil(count / maxPoints));
    const rows = await MeterReading.find(filter, { _id: 0, at: 1, value: 1, batteryMv: 1, rssi: 1 }).sort({ at: 1 }).lean();
    return rows
        .filter((_, i) => i % every === 0 || i === rows.length - 1)
        .map((r) => ({ at: r.at.getTime(), value: r.value, batteryMv: r.batteryMv, rssi: r.rssi }));
}
