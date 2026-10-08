import ApexCharts from 'apexcharts';
import { baseOptions } from './activityCharts';
import { tone } from './healthCharts';
import { heartRateChart, type HrZone } from './hrChart';
import { hourlyConsumption } from './meterHours';
import { escapeHtml, timeAgo } from './utils';

/* The cards next to the cameras on the home page: each meter with its consumption per hour of
 * the last 24 hours, and the heart rate of the last 30 minutes. Each one links to its page.
 * The charts fill the card below the numbers, with their axes: the hour that used the most
 * and a heart rate in a higher zone stand out in their own colour. */

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

// the hour that used the most: the one bar in the darker colour (none while nothing was used)
export function peakHour(values: number[]) {
    const max = Math.max(0, ...values);
    return max > 0 ? values.indexOf(max) : -1;
}

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
        const peak = peakHour(values);
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
                            fillColor: j === peak ? tone('rust') : tone('mustard'),
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
    const draw = (el: HTMLElement) => heartRateChart(el, recent.points, recent.zones ?? [], Math.max(170, el.clientHeight));
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
