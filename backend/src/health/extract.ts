/*
 * Google Health API v4 data points as simple series, ported from whoofit's extractor.py.
 *
 * The shapes were captured live from a Fitbit Air; each parser follows the real nesting
 * rather than the docs. Numbers sometimes arrive as strings ("73"), so everything goes
 * through num(). Rounding follows Python's round() (half to even), so the series match
 * whoofit's to the last digit.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface Point {
    date: string;
    value: number | null;
    [key: string]: unknown;
}

/* Python's round(): half to even, decided on the exact decimal value of the float, as
 * CPython does (round(2.675, 2) is 2.67: the float is 2.67499...). toFixed() is exact. */
export function pyRound(value: number, digits = 0) {
    if (!Number.isFinite(value)) return value;
    const sign = value < 0 ? -1 : 1;
    const [whole, fraction = ''] = Math.abs(value)
        .toFixed(digits + 30)
        .split('.');
    const kept = whole + fraction.slice(0, digits);
    const rest = fraction.slice(digits);
    const up = /^50*$/.test(rest) ? Number(kept[kept.length - 1]) % 2 === 1 : rest[0] >= '5';
    const n = (BigInt(kept) + (up ? 1n : 0n)).toString().padStart(digits + 1, '0');
    return sign * parseFloat(digits ? `${n.slice(0, -digits)}.${n.slice(-digits)}` : n);
}

// a JSON-safe number or null; the Air sends NaN for a baseline not yet established
export function num(x: unknown): number | null {
    if (x === null || x === undefined || typeof x === 'object') return null;
    if (typeof x === 'string' && x.trim() === '') return null;
    const v = typeof x === 'boolean' ? (x ? 1 : 0) : Number(x);
    return Number.isFinite(v) ? pyRound(v, 2) : null;
}

const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, '0');

export function dateStr(d: Json): string | null {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    return `${pad(d.year ?? 0, 4)}-${pad(d.month ?? 0)}-${pad(d.day ?? 0)}`;
}

function civilDate(sampleTime: Json) {
    return dateStr(sampleTime?.civilTime?.date);
}

// Python's str.title() for the upper case enum names of the API
function title(text: string) {
    return text.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, before, letter) => before + letter.toUpperCase());
}

const byDate = (a: { date: string | null }, b: { date: string | null }) => ((a.date ?? '') < (b.date ?? '') ? -1 : (a.date ?? '') > (b.date ?? '') ? 1 : 0);

function parseTime(iso: unknown) {
    if (typeof iso !== 'string') return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : t;
}

/* ----------------------------------------------------------------------- */

function daily(innerKey: string, valueFn: (d: Json) => Record<string, number | null> | null) {
    return (points: Json[]): Point[] => {
        const out: Point[] = [];
        for (const p of points) {
            const d = p?.[innerKey] ?? {};
            const v = valueFn(d);
            if (v !== null) out.push({ date: dateStr(d.date) as string, ...v } as Point);
        }
        return out.sort(byDate);
    };
}

export const PARSERS: Record<string, { dataType: string; kind: FilterKind; parse: (points: Json[]) => Point[] }> = {
    resting_hr: {
        dataType: 'daily-resting-heart-rate',
        kind: 'daily',
        parse: daily('dailyRestingHeartRate', (d) => (d.beatsPerMinute ? { value: num(d.beatsPerMinute) } : null)),
    },
    hrv: {
        dataType: 'daily-heart-rate-variability',
        kind: 'daily',
        parse: daily('dailyHeartRateVariability', (d) => ({ value: num(d.averageHeartRateVariabilityMilliseconds) })),
    },
    spo2: {
        dataType: 'daily-oxygen-saturation',
        kind: 'daily',
        parse: daily('dailyOxygenSaturation', (d) => ({
            value: num(d.averagePercentage),
            low: num(d.lowerBoundPercentage),
            high: num(d.upperBoundPercentage),
        })),
    },
    respiratory_rate: {
        dataType: 'daily-respiratory-rate',
        kind: 'daily',
        parse: daily('dailyRespiratoryRate', (d) => ({ value: num(d.breathsPerMinute) })),
    },
    skin_temp: {
        dataType: 'daily-sleep-temperature-derivations',
        kind: 'daily',
        parse: daily('dailySleepTemperatureDerivations', (d) => ({
            value: num(d.nightlyTemperatureCelsius),
            baseline: num(d.baselineTemperatureCelsius),
        })),
    },
};

/* ----------------------------------------------------------------------- */

// local clock time of a timestamp as minutes since 18:00, so a night never wraps mid-sleep
export function localMinutesFrom18(iso: string, offset: string) {
    const t = parseTime(iso) as number;
    const off = offset.endsWith('s') ? parseInt(offset.slice(0, -1), 10) || 0 : 0;
    const local = new Date(t + off * 1000);
    const clock = local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60; // whole seconds, as whoofit
    return (clock - 1080 + 1440) % 1440;
}

export const SLEEP_STAGES = ['DEEP', 'LIGHT', 'REM', 'AWAKE'] as const;

// per night: hours asleep, minutes per stage, and each stage segment's clock times
export function parseSleep(points: Json[]): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        const s = p?.sleep ?? {};
        const start = parseTime(s.interval?.startTime);
        const end = parseTime(s.interval?.endTime);
        if (start === null || end === null) continue;
        const stageMin: Record<string, number> = { DEEP: 0, LIGHT: 0, REM: 0, AWAKE: 0 };
        const seg: { st: string; s: number; e: number }[] = [];
        for (const st of s.stages ?? []) {
            const a = parseTime(st.startTime);
            const b = parseTime(st.endTime);
            if (a === null || b === null) continue;
            const type = st.type ?? 'AWAKE';
            stageMin[type] = (stageMin[type] ?? 0) + (b - a) / 60000;
            seg.push({
                st: type,
                s: pyRound(localMinutesFrom18(st.startTime, st.startUtcOffset ?? '0s'), 1),
                e: pyRound(localMinutesFrom18(st.endTime, st.endUtcOffset ?? '0s'), 1),
            });
        }
        out.push({
            date: new Date(end).toISOString().slice(0, 10), // the UTC date the night ended, as whoofit
            value: pyRound((end - start) / 3600000, 2),
            stages: Object.fromEntries(Object.entries(stageMin).map(([k, v]) => [k, pyRound(v)])),
            seg,
        });
    }
    return out.sort(byDate);
}

// daily active zone minutes, summed from the intraday intervals
export function parseAzm(points: Json[]): Point[] {
    const perDay = new Map<string, number>();
    for (const p of points) {
        const a = p?.activeZoneMinutes ?? {};
        const d = dateStr(a.interval?.civilStartTime?.date);
        const v = num(a.activeZoneMinutes);
        if (d && v !== null) perDay.set(d, (perDay.get(d) ?? 0) + v);
    }
    return [...perDay.keys()].sort().map((d) => ({ date: d, value: pyRound(perDay.get(d)!) }));
}

// daily sedentary hours, summed from the period durations
export function parseSedentary(points: Json[]): Point[] {
    const perDay = new Map<string, number>();
    for (const p of points) {
        const iv = p?.sedentaryPeriod?.interval ?? {};
        const d = dateStr(iv.civilStartTime?.date);
        const a = parseTime(iv.startTime);
        const b = parseTime(iv.endTime);
        if (a === null || b === null) continue;
        if (d) perDay.set(d, (perDay.get(d) ?? 0) + (b - a) / 3600000);
    }
    return [...perDay.keys()].sort().map((d) => ({ date: d, value: pyRound(perDay.get(d)!, 1) }));
}

// the latest personal heart rate zones (min and max bpm per zone)
export function parseHrZones(points: Json[]) {
    if (!points.length) return [];
    const latest = [...points].sort((a, b) => {
        const da = dateStr(a?.dailyHeartRateZones?.date) ?? '';
        const db = dateStr(b?.dailyHeartRateZones?.date) ?? '';
        return da < db ? -1 : da > db ? 1 : 0;
    })[points.length - 1];
    const z = latest?.dailyHeartRateZones ?? {};
    const zones = (z.heartRateZones ?? []).map((zn: Json) => ({
        zone: title(zn.heartRateZoneType ?? ''),
        min: num(zn.minBeatsPerMinute),
        max: num(zn.maxBeatsPerMinute),
    }));
    return [{ date: dateStr(z.date), zones }];
}

// breathing rate per night, by sleep stage
export function parseBreathingStages(points: Json[]): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        const r = p?.respiratoryRateSleepSummary ?? {};
        const d = civilDate(r.sampleTime ?? {});
        if (!d) continue;
        out.push({
            date: d,
            value: num(r.fullSleepStats?.breathsPerMinute),
            deep: num(r.deepSleepStats?.breathsPerMinute),
            light: num(r.lightSleepStats?.breathsPerMinute),
            rem: num(r.remSleepStats?.breathsPerMinute),
        });
    }
    return out.sort(byDate);
}

export function parseExercise(points: Json[]) {
    const out = [];
    for (const p of points) {
        const e = p?.exercise ?? {};
        const m = e.metricsSummary ?? {};
        const start: string = e.interval?.startTime ?? '';
        const end: string = e.interval?.endTime ?? '';
        out.push({
            date: start.slice(0, 10),
            type: title(String(e.exerciseType ?? 'WORKOUT').replace(/_/g, ' ')),
            // when it ran, ms: the heart rate of the workout is read for this time
            start: start ? Date.parse(start) : null,
            end: end ? Date.parse(end) : null,
            calories: num(m.caloriesKcal),
            avg_hr: num(m.averageHeartRateBeatsPerMinute),
            azm: num(m.activeZoneMinutes),
        });
    }
    return out.sort(byDate);
}

/* ----------------------------------------------------------------------- */

export type FilterKind = 'daily' | 'interval' | 'sample' | 'sleep' | 'ecg';

/* Every data type the API defines, with its filter family. Those with a parser of their
 * own (KNOWN) are skipped by discovery; any other that starts returning data is shown
 * generically, no code change needed. floors and total-calories are roll-up only. */
export const CATALOG: Record<string, FilterKind> = {
    steps: 'interval',
    distance: 'interval',
    'active-energy-burned': 'interval',
    'active-minutes': 'interval',
    'activity-level': 'interval',
    altitude: 'interval',
    'time-in-heart-rate-zone': 'interval',
    'calories-in-heart-rate-zone': 'interval',
    'swim-lengths-data': 'interval',
    'irregular-rhythm-notification': 'interval',
    'nutrition-log': 'interval',
    'hydration-log': 'interval',
    'heart-rate': 'sample',
    'oxygen-saturation': 'sample',
    'heart-rate-variability': 'sample',
    'core-body-temperature': 'sample',
    weight: 'sample',
    'body-fat': 'sample',
    height: 'sample',
    'vo2-max': 'sample',
    'run-vo2-max': 'sample',
    'daily-vo2-max': 'daily',
    'blood-glucose': 'sample',
    electrocardiogram: 'ecg',
    'menstrual-period': 'interval',
    'ovulation-test': 'sample',
    moods: 'sample',
    symptoms: 'interval',
    food: 'interval',
};

// local calendar date of a UTC time and its offset ("7200s")
function localDate(iso: unknown, offset: unknown) {
    const t = parseTime(iso);
    if (t === null) return null;
    const off = typeof offset === 'string' && offset.endsWith('s') ? parseInt(offset.slice(0, -1), 10) || 0 : 0;
    return new Date(t + off * 1000).toISOString().slice(0, 10);
}

/* The civil day a data point belongs to, the way the API's filter for its family counts
 * it: daily types by their date, intervals by their civil start, samples by their civil
 * time, sleep by the civil END of the night. Sleep and exercise carry no civil date: it
 * is their UTC time moved by its offset. */
export function pointDay(dataType: string, kind: FilterKind, point: Json): string | null {
    const inner = point?.[camel(dataType)] ?? {};
    switch (kind) {
        case 'daily':
            return dateStr(inner.date);
        case 'sample':
            return civilDate(inner.sampleTime ?? {});
        case 'sleep':
            return dateStr(inner.interval?.civilEndTime?.date) ?? localDate(inner.interval?.endTime, inner.interval?.endUtcOffset);
        case 'ecg':
            return typeof inner.interval?.startTime === 'string' ? inner.interval.startTime.slice(0, 10) : null;
        case 'interval':
            return dateStr(inner.interval?.civilStartTime?.date) ?? localDate(inner.interval?.startTime, inner.interval?.startUtcOffset);
    }
}

export const KNOWN = new Set([
    'daily-resting-heart-rate',
    'daily-heart-rate-variability',
    'daily-oxygen-saturation',
    'daily-respiratory-rate',
    'daily-sleep-temperature-derivations',
    'sleep',
    'exercise',
    'active-zone-minutes',
    'sedentary-period',
    'daily-heart-rate-zones',
    'respiratory-rate-sleep-summary',
]);

export function camel(dataType: string) {
    const [first, ...rest] = dataType.split('-');
    return first + rest.map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : '')).join('');
}

const isDict = (x: unknown): x is Record<string, Json> => !!x && typeof x === 'object' && !Array.isArray(x);

// a YYYY-MM-DD in any of the shapes v4 uses for a data point
function findDate(node: Json): string | null {
    if (!isDict(node)) return null;
    if (isDict(node.date)) return dateStr(node.date);
    const iv = node.interval;
    if (isDict(iv) && iv.civilStartTime) return dateStr(iv.civilStartTime.date);
    const st = node.sampleTime;
    if (isDict(st)) return civilDate(st);
    return null;
}

const SKIP_KEYS = new Set(['date', 'interval', 'sampleTime', 'startTime', 'endTime', 'civilStartTime', 'civilEndTime', 'utcOffset']);

/* The first finite numeric leaf (value, field name): shallow keys first, then one level
 * deeper; time and date subtrees are skipped at every level, so a calendar year is never
 * taken for a measurement. Booleans count, as in Python. */
export function firstNumber(node: Json, depth = 0): [number | null, string | null] {
    if (depth > 4 || !isDict(node)) return [null, null];
    for (const [k, v] of Object.entries(node)) {
        if (SKIP_KEYS.has(k)) continue;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
            const n = num(v);
            if (n !== null) return [n, k];
        }
    }
    for (const [k, v] of Object.entries(node)) {
        if (SKIP_KEYS.has(k) || !isDict(v)) continue;
        const [n, name] = firstNumber(v, depth + 1);
        if (n !== null) return [n, `${k}.${name}`];
    }
    return [null, null];
}

export function genericSeries(dataType: string, points: Json[]) {
    const key = camel(dataType);
    const seen = new Map<string, { date: string; value: number; label: string | null }>();
    for (const p of points) {
        let inner = p?.[key];
        if (!isDict(inner)) {
            const rest = Object.fromEntries(Object.entries(p ?? {}).filter(([k]) => k !== 'name' && k !== 'dataSource'));
            inner = Object.values(rest).find(isDict) ?? rest;
        }
        const date = findDate(inner) ?? findDate(p);
        const [value, label] = firstNumber(inner);
        if (date && value !== null) seen.set(date, { date, value, label });
    }
    return [...seen.keys()].sort().map((d) => seen.get(d)!);
}

/* ----------------------------------------------------------------------- */

// high resolution types; heart rate alone is ~23 000 points a day, bucket-averaged
export const INTRADAY: Record<string, { kind: FilterKind; unit: string }> = {
    'heart-rate': { kind: 'sample', unit: 'bpm' },
    'oxygen-saturation': { kind: 'sample', unit: '%' },
    steps: { kind: 'interval', unit: 'steps' },
    distance: { kind: 'interval', unit: 'mm' },
    'active-zone-minutes': { kind: 'interval', unit: 'min' },
};

// period types are blocks of time (start to end), shown as a day timeline
export const BLOCK_TYPES = new Set(['sedentary-period']);

export function hhmm(minutes: number) {
    const m = Math.trunc(pyRound(minutes));
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function hhmmss(seconds: number) {
    const s = Math.trunc(pyRound(seconds));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const timeMin = (t: Json) => (t?.hours ?? 0) * 60 + (t?.minutes ?? 0) + (t?.seconds ?? 0) / 60;

// a day's period blocks as a timeline; blocks past midnight end at 24:00
export function blocksFromPoints(dataType: string, date: string, points: Json[]) {
    const key = camel(dataType);
    const blocks = [];
    for (const p of points) {
        const iv = p?.[key]?.interval ?? {};
        const sm = timeMin(iv.civilStartTime?.time ?? {});
        const a = parseTime(iv.startTime);
        const b = parseTime(iv.endTime);
        if (a === null || b === null) continue;
        const dur = (b - a) / 60000;
        const em = Math.min(sm + dur, 1440);
        blocks.push({ sm: pyRound(sm), em: pyRound(em), s: hhmm(sm), e: hhmm(em), dur: pyRound(dur) });
    }
    blocks.sort((x, y) => x.sm - y.sm);
    const total = blocks.reduce((sum, x) => sum + x.dur, 0) / 60;
    return { type: dataType, date, mode: 'blocks', blocks, total_h: pyRound(total, 1), count: blocks.length };
}

// the dataSource of a series (constant) and the sample's utc offset
export function datasourceMeta(points: Json[]) {
    if (!points.length) return {};
    const ds = points[0]?.dataSource ?? {};
    const inner: Json = Object.entries(points[0] ?? {}).find(([k, v]) => k !== 'name' && k !== 'dataSource' && isDict(v))?.[1] ?? {};
    const off: string = inner.sampleTime?.utcOffset ?? '';
    let tz = '';
    if (off.endsWith('s') && /^-?\d+$/.test(off.slice(0, -1))) {
        const h = parseInt(off.slice(0, -1), 10) / 3600;
        tz = `UTC${h >= 0 ? '+' : ''}${Number.isInteger(h) ? h : parseFloat(h.toPrecision(6))}`;
    }
    return {
        recording_method: ds.recordingMethod ?? null,
        device: ds.device?.displayName ?? null,
        platform: ds.platform ?? null,
        utc_offset: tz || off || null,
    };
}

export type Row = [number, number]; // second of the civil day, value

// the (second, value) of each point of an intraday type, sorted as whoofit sorts them
export function intradayRows(dataType: string, points: Json[]): Row[] {
    const spec = INTRADAY[dataType];
    const key = camel(dataType);
    const rows: Row[] = [];
    for (const p of points) {
        const node = p?.[key] ?? {};
        const t = spec?.kind === 'sample' ? (node.sampleTime?.civilTime?.time ?? {}) : (node.interval?.civilStartTime?.time ?? {});
        const [val] = firstNumber(node);
        if (val === null) continue;
        rows.push([(t.hours ?? 0) * 3600 + (t.minutes ?? 0) * 60 + (t.seconds ?? 0), val]);
    }
    return rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function intradayFromPoints(dataType: string, date: string, points: Json[], options: { target?: number; raw?: boolean } = {}) {
    if (!INTRADAY[dataType]) return { error: `${dataType} has no intraday support` };
    return intradayFromRows(dataType, date, intradayRows(dataType, points), datasourceMeta(points), options);
}

/* One civil day at high resolution, bucket-averaged when dense (summed for interval
 * types), or every sample with raw. rows sorted as intradayRows() returns them. */
export function intradayFromRows(dataType: string, date: string, rows: Row[], meta: Record<string, unknown>, options: { target?: number; raw?: boolean } = {}) {
    const target = options.target ?? 320;
    const spec = INTRADAY[dataType];
    if (!spec) return { error: `${dataType} has no intraday support` };

    if (options.raw) {
        return {
            type: dataType,
            date,
            unit: spec.unit,
            raw_count: rows.length,
            bucket_min: 0,
            resolution: 'full',
            meta,
            points: rows.map(([sec, v]) => ({ t: hhmmss(sec), value: pyRound(v, 1) })),
        };
    }

    const aggregate = spec.kind === 'sample';
    let out: { t: string; value: number }[];
    let bucketMin = 0;
    if (rows.length && rows.length > target * 1.5) {
        const spanMin = (rows[rows.length - 1][0] - rows[0][0]) / 60;
        const size = Math.max(1, Math.ceil(spanMin / target));
        const buckets = new Map<number, number[]>();
        for (const [sec, v] of rows) {
            const b = Math.floor(sec / 60 / size);
            if (!buckets.has(b)) buckets.set(b, []);
            buckets.get(b)!.push(v);
        }
        out = [...buckets.keys()]
            .sort((a, b) => a - b)
            .map((b) => {
                const vs = buckets.get(b)!;
                const sum = vs.reduce((s, v) => s + v, 0);
                return { t: hhmm(b * size), value: pyRound(aggregate ? sum / vs.length : sum, 1) };
            });
        bucketMin = size;
    } else {
        out = rows.map(([sec, v]) => ({ t: hhmm(sec / 60), value: pyRound(v, 1) }));
    }
    return { type: dataType, date, unit: spec.unit, raw_count: rows.length, bucket_min: bucketMin, meta, points: out };
}

/* A minute-by-minute day: a heart rate sample proves the tracker was worn; worn without
 * steps is truly sedentary; no heart rate is off the wrist (not counted as sedentary). */
export function sedentaryGranularFromPoints(date: string, hrPoints: Json[], stepPoints: Json[]) {
    const wornMinutes = hrPoints.map((p) => {
        const t = p?.heartRate?.sampleTime?.civilTime?.time ?? {};
        return (t.hours ?? 0) * 60 + (t.minutes ?? 0);
    });
    return sedentaryGranular(date, wornMinutes, stepPoints);
}

// the same day from stored heart rate rows (every stored sample has a value)
export function sedentaryGranularFromRows(date: string, hrRows: Row[], stepPoints: Json[]) {
    return sedentaryGranular(
        date,
        hrRows.map(([sec]) => Math.floor(sec / 60)),
        stepPoints,
    );
}

function sedentaryGranular(date: string, wornMinutes: number[], stepPoints: Json[]) {
    const worn = new Array<boolean>(1440).fill(false);
    const active = new Array<boolean>(1440).fill(false);
    for (const m of wornMinutes) {
        if (m >= 0 && m < 1440) worn[m] = true;
    }
    for (const p of stepPoints) {
        const t = p?.steps?.interval?.civilStartTime?.time ?? {};
        const [val] = firstNumber(p?.steps ?? {});
        const m = (t.hours ?? 0) * 60 + (t.minutes ?? 0);
        if (m >= 0 && m < 1440 && val) active[m] = true;
    }
    const state = (m: number) => (!worn[m] ? 'off' : active[m] ? 'active' : 'sedentary');

    const runs: { sm: number; em: number; s: string; e: string; state: string; min: number }[] = [];
    let cur: string | null = state(0);
    let start = 0;
    for (let m = 1; m <= 1440; m++) {
        const st = m < 1440 ? state(m) : null;
        if (st !== cur) {
            runs.push({ sm: start, em: m, s: hhmm(start), e: hhmm(m), state: cur as string, min: m - start });
            cur = st;
            start = m;
        }
    }
    const totals = Object.fromEntries(['sedentary', 'active', 'off'].map((k) => [k, runs.filter((r) => r.state === k).reduce((s, r) => s + r.min, 0)]));
    return { type: 'sedentary-granular', date, mode: 'states', runs, totals, worn_min: 1440 - totals.off };
}
