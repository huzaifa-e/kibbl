import ApexCharts from 'apexcharts';
import { baseOptions } from './activityCharts';
import { tone } from './healthCharts';
import { hourlyConsumption } from './meterHours';
import { escapeHtml, timeAgo } from './utils';

/* The cards next to the cameras on the home page: each meter with its consumption per hour of
 * the last 24 hours, and the heart rate of the last 30 minutes. Each one links to its page.
 * The charts fill the card below the numbers, with their axes: an hour that used far more
 * than usual and a heart rate in a higher zone stand out in their own colour. */

/* eslint-disable @typescript-eslint/no-explicit-any */

const METER_HOURS = 24;
const charts: ApexCharts[] = [];

const fmt = (v: number | null | undefined, digits = 1) =>
    typeof v === 'number' ? v.toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';

async function json(url: string) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } }).catch(() => undefined);
    return res && res.ok ? res.json() : undefined;
}

function card(href: string, icon: string, color: string, title: string, sub: string, stats: string, chartId: string) {
    return `<div class="col-md-6 col-xl-4" data-home-card>
        <a class="card h-100 text-reset text-decoration-none" href="${href}">
            <div class="card-body pb-0 flex-grow-0">
                <div class="d-flex align-items-center gap-2">
                    <i class="ti ti-${icon}" style="color:${color}"></i>
                    <div class="fw-bold flex-fill text-truncate">${escapeHtml(title)}</div>
                    <span class="text-secondary small">${sub}</span>
                </div>
                <div class="d-flex flex-wrap column-gap-4 row-gap-1 mt-2">${stats}</div>
            </div>
            <div id="${chartId}" class="home-chart"></div>
        </a>
    </div>`;
}

const stat = (value: string, unit: string, label: string) =>
    `<div><div class="d-flex align-items-baseline gap-1"><span class="stat-value" style="font-size:1.3rem">${value}</span><span class="text-secondary small">${unit}</span></div><div class="hud-label text-secondary">${label}</div></div>`;

// a chart as high as the room left in the card, with small axes
function plotOptions(el: HTMLElement) {
    const base = baseOptions();
    return {
        ...base,
        chart: { ...base.chart, height: Math.max(170, el.clientHeight), zoom: { enabled: false }, selection: { enabled: false } },
        grid: { ...base.grid, padding: { top: 0, bottom: 0, left: 6, right: 10 } },
        legend: { show: false },
    };
}

const axisLabel = { style: { fontSize: '10px' } };

/* an hour that used more than twice the usual hour of the day (the median of those that used
 * anything): what stands out on the chart */
export function spikes(values: number[]) {
    const used = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (used.length < 4) return values.map(() => false);
    const median = used[Math.floor(used.length / 2)];
    return values.map((v) => v > 2 * median);
}

// the zone a heart rate is in: the index in Google's zones (light first), -1 below them
export interface HrZone {
    zone: string;
    min: number;
    max: number;
}
export function zoneOf(bpm: number, zones: HrZone[]) {
    let at = -1;
    zones.forEach((z, i) => {
        if (bpm >= z.min) at = i;
    });
    return at;
}
const ZONE_TONES = ['olive', 'mustard', 'pumpkin', 'rust'] as const;
const zoneColour = (i: number) => (i < 0 ? tone('bark') : tone(ZONE_TONES[Math.min(i, ZONE_TONES.length - 1)]));

async function meterCards() {
    const meters: any[] = (await json('/api/meters')) ?? [];
    // two days of readings: the hour before the first of the 24 needs the reading before it
    const readings = await Promise.all(meters.map((m) => json(`/api/meters/${m._id}/readings?days=2`)));
    return meters.map((m, i) => {
        const hours = hourlyConsumption(readings[i] ?? [], METER_HOURS);
        const hourLabel = (start: number) => new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const b = m.battery;
        const html = card(
            `/meter/${m._id}`,
            m.medium === 'electricity' ? 'bolt' : m.medium === 'water' ? 'droplet' : 'flame',
            tone('pumpkin'),
            m.name,
            m.latest ? `per hour, 24 h · read ${timeAgo(m.latest.at)}` : 'no reading yet',
            stat(fmt(m.latest?.value), m.unit, 'meter') +
                stat(m.powerKw === null ? '–' : fmt(m.powerKw * 1000, 0), 'W', 'power') +
                stat(fmt(m.today?.consumption, 1), m.unit, 'today') +
                (b?.percent != null ? stat(String(b.percent), '%', 'battery') : ''),
            `home-meter-${i}`,
        );
        const values = hours.map((h) => Math.round(h.consumption * 100) / 100);
        const high = spikes(values);
        const draw = (el: HTMLElement) => {
            const o = plotOptions(el);
            return new ApexCharts(el, {
                ...o,
                chart: { ...o.chart, type: 'bar' },
                series: [
                    {
                        name: 'Consumption',
                        data: hours.map((h, j) => ({
                            x: hourLabel(h.start),
                            y: values[j],
                            fillColor: high[j] ? tone('rust') : tone('mustard'),
                        })),
                    },
                ],
                plotOptions: { bar: { columnWidth: '72%', borderRadius: 2 } },
                xaxis: {
                    type: 'category',
                    tickAmount: 6,
                    labels: { ...axisLabel, rotate: 0, hideOverlappingLabels: true },
                    axisTicks: { show: false },
                    tooltip: { enabled: false },
                },
                yaxis: { tickAmount: 3, labels: { ...axisLabel, formatter: (v: number) => fmt(v, v < 10 ? 1 : 0) } },
                tooltip: {
                    ...o.tooltip,
                    x: {
                        formatter: (_v: unknown, opt: any) =>
                            `${hourLabel(hours[opt.dataPointIndex].start)}–${hourLabel(hours[opt.dataPointIndex].start + 3600_000)}`,
                    },
                    y: { formatter: (v: number) => `${fmt(v, 2)} ${m.unit}` },
                },
            });
        };
        return { html, id: `home-meter-${i}`, draw, empty: !(readings[i] ?? []).length };
    });
}

// the heart rate of the last 30 minutes up to the newest sample the tracker synced
async function healthCard() {
    const recent: { points: { at: number; bpm: number }[]; latest: { at: number; bpm: number } | null; zones?: HrZone[] } | undefined =
        await json('/api/health/hr-recent?minutes=30');
    if (!recent?.latest || !recent.points.length) return [];
    const values = recent.points.map((p) => p.bpm);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const html = card(
        '/health',
        'heart',
        tone('rust'),
        'Heart rate',
        `last 30 min · ${time(recent.latest.at)}`,
        stat(fmt(recent.latest.bpm, 0), 'bpm', 'latest') +
            stat(fmt(mean, 0), 'bpm', 'mean') +
            stat(`${fmt(Math.min(...values), 0)}–${fmt(Math.max(...values), 0)}`, 'bpm', 'range'),
        'home-health',
    );
    const zones = recent.zones ?? [];
    const low = Math.min(...values);
    const high = Math.max(...values);
    const yMin = Math.floor((low - 5) / 20) * 20;
    const yMax = Math.ceil((high + 5) / 20) * 20;
    /* the line in the colour of the zone it is in: a gradient over the height of the line,
     * from its highest point down to its lowest, with a hard step at each zone's lower bound */
    const stops: { offset: number; color: string; opacity: number }[] = [];
    const offset = (bpm: number) => (high === low ? 0 : ((high - bpm) / (high - low)) * 100);
    let colour = zoneColour(zoneOf(high, zones));
    stops.push({ offset: 0, color: colour, opacity: 1 });
    for (const z of [...zones].reverse()) {
        if (z.min <= low || z.min > high) continue;
        stops.push({ offset: offset(z.min), color: colour, opacity: 1 });
        colour = zoneColour(zoneOf(z.min - 1, zones));
        stops.push({ offset: offset(z.min), color: colour, opacity: 1 });
    }
    stops.push({ offset: 100, color: colour, opacity: 1 });
    // the zones as faint bands behind the line, named on the right
    const bands = zones
        .map((z, i) => ({ z, i }))
        .filter(({ z }) => z.max > yMin && z.min < yMax)
        .map(({ z, i }) => ({
            y: Math.max(z.min, yMin),
            y2: Math.min(z.max, yMax),
            fillColor: zoneColour(i),
            opacity: 0.1,
            borderColor: 'transparent',
            label: {
                // a zone only just in view is not named: its name would cover the next one
                text: Math.min(z.max, yMax) - Math.max(z.min, yMin) >= 8 ? z.zone : '',
                position: 'right',
                textAnchor: 'end',
                borderWidth: 0,
                offsetY: 14,
                style: { background: 'transparent', color: zoneColour(i), fontSize: '10px' },
            },
        }));
    const draw = (el: HTMLElement) => {
        const o = plotOptions(el);
        return new ApexCharts(el, {
            ...o,
            chart: { ...o.chart, type: 'line' },
            series: [{ name: 'Heart rate', data: recent.points.map((p) => [p.at, p.bpm]) }],
            colors: [zoneColour(zoneOf(high, zones))],
            stroke: { curve: 'straight', width: 2.5 },
            fill: zones.length ? { type: 'gradient', gradient: { type: 'vertical', colorStops: stops } } : { type: 'solid' },
            annotations: { yaxis: bands },
            xaxis: {
                type: 'datetime',
                tickAmount: 4,
                labels: { ...axisLabel, datetimeUTC: false, format: 'HH:mm' },
                axisTicks: { show: false },
                tooltip: { enabled: false },
            },
            yaxis: { min: yMin, max: yMax, tickAmount: (yMax - yMin) / 20, labels: { ...axisLabel, formatter: (v: number) => fmt(v, 0) } },
            tooltip: {
                ...o.tooltip,
                x: { format: 'HH:mm:ss' },
                y: {
                    formatter: (v: number) => {
                        const i = zoneOf(v, zones);
                        return `${fmt(v, 0)} bpm${i >= 0 ? ` · ${zones[i].zone}` : ''}`;
                    },
                },
            },
        });
    };
    return [{ html, id: 'home-health', draw, empty: false }];
}

/* Puts the cards after the cameras in the grid, replacing the ones drawn before. */
export async function renderHomeCards(grid: HTMLElement) {
    const cards = [...(await meterCards()), ...(await healthCard())];
    charts.splice(0).forEach((c) => c.destroy());
    grid.querySelectorAll('[data-home-card]').forEach((el) => el.remove());
    grid.insertAdjacentHTML('beforeend', cards.map((c) => c.html).join(''));
    for (const c of cards) {
        const el = document.getElementById(c.id);
        if (!el || c.empty) continue;
        const chart = c.draw(el);
        chart.render();
        charts.push(chart);
    }
}
