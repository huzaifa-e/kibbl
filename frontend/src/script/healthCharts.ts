import ApexCharts from 'apexcharts';
import { baseOptions } from './activityCharts';
import { clockLabel, perMinute, type SeriesPoint, type StageQuantiles } from './healthStats';
import { isDarkMode } from './utils';

/* The charts of the health page, in the look of the activity charts: the autumn
 * palette of the theme, lighter tints of it on the dark background. */

const PALETTE = {
    pumpkin: ['#d9622b', '#ec8a55'],
    rust: ['#a63d1f', '#d96a47'],
    mustard: ['#c98d12', '#e0b14a'],
    olive: ['#6d8526', '#a3bd56'],
    plum: ['#7b3f61', '#c47aa3'],
    pine: ['#3d7a73', '#6fb3aa'],
    bark: ['#6b5444', '#a8917e'],
} as const;

export type Tone = keyof typeof PALETTE;

export function tone(name: Tone) {
    return PALETTE[name][isDarkMode() ? 1 : 0];
}

export const STAGE_TONES: Record<string, Tone> = { DEEP: 'plum', LIGHT: 'pine', REM: 'mustard', AWAKE: 'pumpkin' };
export const STAGE_LABELS: Record<string, string> = { DEEP: 'Deep', LIGHT: 'Light', REM: 'REM', AWAKE: 'Awake' };

const round1 = (v: number) => Math.round(v * 10) / 10;
const shortDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
const hhmm = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(Math.round(minute) % 60).padStart(2, '0')}`;

function render(el: HTMLElement, options: Record<string, unknown>) {
    const chart = new ApexCharts(el, options);
    chart.render();
    return chart;
}

// a metric's last 30 days, small; spo2 with its nightly low-high range behind the line
export function sparkline(el: HTMLElement, series: (SeriesPoint & { low?: number | null; high?: number | null })[], color: Tone, unit: string, band = false) {
    const points = series.filter((p) => typeof p.value === 'number');
    const withBand = band && points.some((p) => typeof p.low === 'number' && typeof p.high === 'number');
    const line = { name: 'value', type: 'line', data: points.map((p) => ({ x: p.date, y: p.value })) };
    const range = { name: 'range', type: 'rangeArea', data: points.map((p) => ({ x: p.date, y: [p.low ?? p.value, p.high ?? p.value] })) };
    /* ApexCharts draws no range band in sparkline mode (its paths come out NaN): a banded
     * sparkline is a normal chart with every axis and the grid hidden, its y range tight
     * around the band, so 95-100 % does not lie flat on an axis from 0. */
    const lows = points.map((p) => (typeof p.low === 'number' ? p.low : (p.value as number)));
    const highs = points.map((p) => (typeof p.high === 'number' ? p.high : (p.value as number)));
    const bare = {
        grid: { show: false, padding: { left: 0, right: 0, top: 0, bottom: 0 } },
        // floating: hidden x labels still take the height of a 64 px chart otherwise
        xaxis: { floating: true, labels: { show: false }, axisBorder: { show: false }, axisTicks: { show: false }, tooltip: { enabled: false } },
        yaxis: { show: false, min: Math.floor(Math.min(...lows)) - 0.5, max: Math.ceil(Math.max(...highs)) + 0.5 },
        legend: { show: false },
        markers: { size: 0, hover: { size: 0 } },
    };
    return render(el, {
        ...baseOptions(),
        ...(withBand ? bare : {}),
        chart: {
            ...baseOptions().chart,
            type: withBand ? 'rangeArea' : 'line',
            height: 64,
            parentHeightOffset: 0,
            ...(withBand ? {} : { sparkline: { enabled: true } }),
        },
        series: withBand ? [range, line] : [line],
        colors: [tone(color), tone(color)],
        fill: { opacity: withBand ? [0.18, 1] : 1 },
        stroke: { curve: withBand ? 'straight' : 'smooth', width: withBand ? [0, 2] : 2 },
        tooltip: {
            ...baseOptions().tooltip,
            followCursor: true,
            custom: ({ dataPointIndex: i }: { dataPointIndex: number }) => {
                const p = points[i];
                if (!p) return '';
                const range = withBand && typeof p.low === 'number' ? ` <span style="opacity:.7">(${p.low}–${p.high})</span>` : '';
                return `<div style="padding:4px 8px;font-size:12px"><b>${shortDate(p.date)}</b> · ${round1(p.value as number)} ${unit}${range}</div>`;
            },
        },
    });
}

// hours per night by stage, the last nights side by side
export function sleepNightsChart(el: HTMLElement, nights: { date: string; value: number; stages?: Record<string, number> }[]) {
    const last = nights.slice(-14);
    const stages = ['DEEP', 'LIGHT', 'REM', 'AWAKE'];
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: 240, stacked: true },
        series: stages.map((st) => ({ name: STAGE_LABELS[st], data: last.map((n) => round1((n.stages?.[st] ?? 0) / 60)) })),
        colors: stages.map((st) => tone(STAGE_TONES[st])),
        plotOptions: { bar: { columnWidth: '62%', borderRadius: 2 } },
        stroke: { width: 1, colors: [isDarkMode() ? '#0b0604' : '#2a1a12'] },
        xaxis: {
            categories: last.map((n) => shortDate(n.date)),
            labels: { rotate: 0, hideOverlappingLabels: true },
            axisBorder: { show: false },
            axisTicks: { show: false },
        },
        yaxis: { labels: { formatter: (v: number) => `${Math.round(v)} h` }, min: 0, tickAmount: 4 },
        legend: { position: 'bottom', fontSize: '11px', markers: { width: 8, height: 8 } },
        tooltip: {
            ...baseOptions().tooltip,
            shared: true,
            intersect: false,
            y: { formatter: (v: number) => `${Math.floor(v)} h ${Math.round((v % 1) * 60)} min` },
        },
    });
}

/* How much of the night a stage takes, per half hour of the clock, over the last nights:
 * the median line in the 25-75 % and 10-90 % bands, as on the activity page. */
export function sleepFanChart(el: HTMLElement, stats: StageQuantiles[], stage: string) {
    const c = tone(STAGE_TONES[stage]);
    const x = (b: number) => clockLabel(b);
    const top = Math.max(30, Math.ceil(Math.max(...stats.map((s) => s.p90)) / 10) * 10);
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'rangeArea', height: 240 },
        series: [
            { name: '10–90 %', type: 'rangeArea', data: stats.map((s) => ({ x: x(s.bin), y: [round1(s.p10), round1(s.p90)] })) },
            { name: '25–75 %', type: 'rangeArea', data: stats.map((s) => ({ x: x(s.bin), y: [round1(s.p25), round1(s.p75)] })) },
            { name: 'Median', type: 'line', data: stats.map((s) => ({ x: x(s.bin), y: round1(s.p50) })) },
        ],
        colors: [c, c, c],
        fill: { opacity: [0.14, 0.28, 1] },
        stroke: { curve: 'straight', width: [0, 0, 2.5] },
        markers: { size: 0, hover: { size: 0 } },
        legend: { show: false },
        // every second full hour: half-hour labels overlap on a phone
        xaxis: {
            type: 'category',
            labels: { rotate: 0, formatter: (v: string) => (typeof v === 'string' && v.endsWith(':00') && Number(v.slice(0, 2)) % 2 === 0 ? v : '') },
            axisBorder: { show: false },
            axisTicks: { show: false },
            tooltip: { enabled: false },
        },
        yaxis: {
            labels: { formatter: (v: number) => `${Math.round(v)}` },
            min: 0,
            max: top,
            tickAmount: 3,
            title: { text: 'min per half hour', style: { fontWeight: 400 } },
        },
        tooltip: {
            ...baseOptions().tooltip,
            shared: true,
            intersect: false,
            followCursor: true,
            custom: ({ dataPointIndex: i }: { dataPointIndex: number }) => {
                const s = stats[i];
                if (!s) return '';
                const row = (label: string, value: string) => `<div style="display:flex;gap:12px"><span style="flex:1">${label}</span><b>${value}</b></div>`;
                return (
                    `<div style="padding:6px 10px;font-size:12px;min-width:170px"><div style="font-weight:600;margin-bottom:4px">${x(s.bin)} – ${x(s.bin + 30)}</div>` +
                    row('Median', `${Math.round(s.p50)} min`) +
                    row('25–75 %', `${Math.round(s.p25)}–${Math.round(s.p75)} min`) +
                    row('10–90 %', `${Math.round(s.p10)}–${Math.round(s.p90)} min`) +
                    row('From', `${s.nights} nights`) +
                    '</div>'
                );
            },
        },
    });
}

// breathing rate per night, for the whole night and by stage
export function breathingChart(
    el: HTMLElement,
    rows: { date: string; value: number | null; deep?: number | null; light?: number | null; rem?: number | null }[],
) {
    // two records a night are common (two sources): the last one of a date counts
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const nights = [...byDate.values()].slice(-21);
    // 0 breaths a minute is a stage without a reading (no deep sleep that night), not a value
    const line = (name: string, key: 'value' | 'deep' | 'light' | 'rem') => ({ name, data: nights.map((n) => ({ x: shortDate(n.date), y: n[key] || null })) });
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'line', height: 220 },
        series: [line('Whole night', 'value'), line('Deep', 'deep'), line('Light', 'light'), line('REM', 'rem')],
        colors: [tone('bark'), tone('plum'), tone('pine'), tone('mustard')],
        stroke: { curve: 'smooth', width: [3, 2, 2, 2], dashArray: [0, 0, 0, 0] },
        markers: { size: 0 },
        xaxis: { type: 'category', labels: { rotate: 0, hideOverlappingLabels: true }, axisBorder: { show: false }, axisTicks: { show: false } },
        yaxis: { labels: { formatter: (v: number) => (v === null || v === undefined ? '' : round1(v).toString()) }, tickAmount: 4 },
        legend: { position: 'bottom', fontSize: '11px', markers: { width: 8, height: 8 } },
        tooltip: {
            ...baseOptions().tooltip,
            shared: true,
            y: { formatter: (v: number | null) => (v === null || v === undefined ? '–' : `${round1(v)} br/min`) },
        },
    });
}

/* A day of heart rate: the minute's mean as the line, its lowest to highest as a band,
 * the personal zones as coloured stripes behind it. */
export function heartRateDayChart(el: HTMLElement, points: { t: string; value: number }[], zones: { zone: string; min: number | null; max: number | null }[]) {
    const minutes = perMinute(points);
    const zoneTones: Tone[] = ['olive', 'mustard', 'pumpkin', 'rust'];
    return render(el, {
        ...baseOptions(),
        chart: {
            ...baseOptions().chart,
            type: 'rangeArea',
            height: 300,
            zoom: { enabled: true, type: 'x' },
            toolbar: { show: true, tools: { zoom: true, zoomin: true, zoomout: true, reset: true, pan: false, download: false, selection: false } },
        },
        series: [
            { name: 'Range', type: 'rangeArea', data: minutes.map((m) => ({ x: m.minute, y: [m.min, m.max] })) },
            { name: 'Heart rate', type: 'line', data: minutes.map((m) => ({ x: m.minute, y: m.mean })) },
        ],
        colors: [tone('pumpkin'), tone('rust')],
        fill: { opacity: [0.2, 1] },
        stroke: { curve: 'straight', width: [0, 1.5] },
        markers: { size: 0, hover: { size: 0 } },
        legend: { show: false },
        annotations: {
            yaxis: zones
                .filter((z) => z.min !== null && z.max !== null)
                .map((z, i) => ({
                    y: z.min,
                    y2: z.max,
                    fillColor: tone(zoneTones[i] ?? 'rust'),
                    opacity: 0.07,
                    borderColor: 'transparent',
                    label: {
                        text: z.zone,
                        position: 'left',
                        textAnchor: 'start',
                        offsetX: 6,
                        style: { background: 'transparent', color: tone(zoneTones[i] ?? 'rust'), fontSize: '10px' },
                    },
                })),
        },
        xaxis: { type: 'numeric', min: 0, max: 1440, tickAmount: 8, labels: { formatter: (v: number) => hhmm(v) }, tooltip: { enabled: false } },
        yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` }, tickAmount: 5, min: (min: number) => Math.max(0, Math.floor(min / 10) * 10 - 5) },
        tooltip: {
            ...baseOptions().tooltip,
            shared: true,
            intersect: false,
            custom: ({ dataPointIndex: i }: { dataPointIndex: number }) => {
                const m = minutes[i];
                return m
                    ? `<div style="padding:4px 8px;font-size:12px"><b>${hhmm(m.minute)}</b> · ${m.mean} bpm <span style="opacity:.7">(${m.min}–${m.max})</span></div>`
                    : '';
            },
        },
    });
}

// a bucketed day of another metric (blood oxygen, steps, zone minutes)
export function dayChart(el: HTMLElement, points: { t: string; value: number }[], color: Tone, unit: string, bars: boolean) {
    const minute = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
    };
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: bars ? 'bar' : 'line', height: 260 },
        series: [{ name: unit, data: points.map((p) => ({ x: minute(p.t), y: p.value })) }],
        colors: [tone(color)],
        stroke: bars ? { width: 0 } : { curve: 'smooth', width: 2 },
        plotOptions: { bar: { columnWidth: '80%' } },
        xaxis: { type: 'numeric', min: 0, max: 1440, tickAmount: 8, labels: { formatter: (v: number) => hhmm(v) }, tooltip: { enabled: false } },
        yaxis: { labels: { formatter: (v: number) => `${round1(v)}` }, tickAmount: 4 },
        tooltip: { ...baseOptions().tooltip, x: { formatter: (v: number) => hhmm(v) }, y: { formatter: (v: number) => `${round1(v)} ${unit}` } },
    });
}
