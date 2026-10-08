import ApexCharts from 'apexcharts';
import { baseOptions } from './activityCharts';
import { tone } from './healthCharts';

/* A heart rate over time, the line in the colour of the zone it is in (Google's personal
 * zones: light, moderate, vigorous, peak) with the zones as faint bands behind it. The home
 * page's last 30 minutes and each workout of the health page. */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HrZone {
    zone: string;
    min: number;
    max: number;
}

export interface HrPoint {
    at: number;
    bpm: number;
}

// the zone a heart rate is in: the index in Google's zones (light first), -1 below them
export function zoneOf(bpm: number, zones: HrZone[]) {
    let at = -1;
    zones.forEach((z, i) => {
        if (bpm >= z.min) at = i;
    });
    return at;
}

const ZONE_TONES = ['olive', 'mustard', 'pumpkin', 'rust'] as const;
export const zoneColour = (i: number) => (i < 0 ? tone('bark') : tone(ZONE_TONES[Math.min(i, ZONE_TONES.length - 1)]));

const axisLabel = { style: { fontSize: '10px' } };
const bpm = (v: number) => (typeof v === 'number' ? String(Math.round(v)) : '–');

// the chart, not rendered yet
export function heartRateChart(el: HTMLElement, points: HrPoint[], zones: HrZone[], height: number) {
    const values = points.map((p) => p.bpm);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const yMin = Math.floor((low - 5) / 20) * 20;
    const yMax = Math.ceil((high + 5) / 20) * 20;
    /* the line in the colour of the zone it is in: a gradient over the height of the line,
     * from its highest point down to its lowest, with a hard step at each zone's lower bound */
    const stops: { offset: number; color: string; opacity: number }[] = [];
    const offset = (v: number) => (high === low ? 0 : ((high - v) / (high - low)) * 100);
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
    const base = baseOptions();
    const chart = new ApexCharts(el, {
        ...base,
        chart: { ...base.chart, type: 'line', height, zoom: { enabled: false }, selection: { enabled: false } },
        grid: { ...base.grid, padding: { top: 0, bottom: 0, left: 6, right: 10 } },
        legend: { show: false },
        series: [{ name: 'Heart rate', data: points.map((p) => [p.at, p.bpm]) }],
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
        yaxis: { min: yMin, max: yMax, tickAmount: (yMax - yMin) / 20, labels: { ...axisLabel, formatter: bpm } },
        tooltip: {
            ...base.tooltip,
            x: { format: 'HH:mm:ss' },
            y: {
                formatter: (v: number) => {
                    const i = zoneOf(v, zones);
                    return `${bpm(v)} bpm${i >= 0 ? ` · ${zones[i].zone}` : ''}`;
                },
            },
        },
    } as any);
    return chart; // rendered by the caller once it is in the page
}
