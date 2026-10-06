import ApexCharts from 'apexcharts';
import type { ActivityBucket } from '../../../shared/protocol';
import { MIN_BASELINE_DAYS, hourlyQuantiles } from './activityStats';
import { isDarkMode, localDayKey } from './utils';

const ACCENT = '#d9622b';

export function baseOptions() {
    const dark = isDarkMode();
    return {
        chart: {
            fontFamily: 'inherit',
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false },
            parentHeightOffset: 0,
        },
        theme: { mode: dark ? 'dark' : 'light' },
        grid: { borderColor: dark ? 'rgba(243,230,207,0.12)' : 'rgba(42,26,18,0.14)', strokeDashArray: 4 },
        dataLabels: { enabled: false },
        tooltip: { theme: dark ? 'dark' : 'light' },
    };
}

const hourLabel = (h: number) => String(h).padStart(2, '0');
const round1 = (v: number) => Math.round(v * 10) / 10;

/* Motion events per hour of one day: when the pets and people were around. With
 * baseline days, the quantiles of those days per hour are drawn as translucent bands: the
 * band from the 10th to the 90th percentile, the 25th to 75th, and the median, so a
 * bar above the bands is an hour busier than usual. */
export function hourlyChart(el: HTMLElement, buckets: ActivityBucket[], day: string, baseline: string[] = []) {
    const counts = new Array(24).fill(0);
    for (const b of buckets) {
        if (b.day === day) counts[b.hour] += b.count;
    }
    const dark = isDarkMode();
    const withBands = baseline.length >= MIN_BASELINE_DAYS;
    const q = withBands ? hourlyQuantiles(buckets, baseline) : [];

    const bars = { name: 'This day', type: 'column', data: counts.map((y, h) => ({ x: hourLabel(h), y })) };
    const series = withBands
        ? [
              bars,
              { name: '10–90 %', type: 'rangeArea', data: q.map((v, h) => ({ x: hourLabel(h), y: [round1(v.p10), round1(v.p90)] })) },
              { name: '25–75 %', type: 'rangeArea', data: q.map((v, h) => ({ x: hourLabel(h), y: [round1(v.p25), round1(v.p75)] })) },
              { name: 'Median', type: 'line', data: q.map((v, h) => ({ x: hourLabel(h), y: round1(v.p50) })) },
          ]
        : [bars];
    const barOutline = dark ? '#0b0604' : '#2a1a12';
    const band = dark ? '#e8a77d' : '#a0471c';
    const outerBand = dark ? '#b98a6c' : '#cf8f62'; // lighter, so the legend tells the two bands apart
    // a multiple of the 4 ticks, so every grid line is a whole number of events
    const top = Math.max(4, Math.ceil(Math.max(...counts, ...q.map((v) => v.p90)) / 4) * 4);

    const chart = new ApexCharts(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: withBands ? 'rangeArea' : 'bar', height: withBands ? 200 : 160 },
        series,
        colors: withBands ? [ACCENT, outerBand, band, band] : [ACCENT],
        fill: { opacity: withBands ? [1, 0.14, 0.26, 1] : 1 },
        plotOptions: { bar: { columnWidth: '70%', borderRadius: 2 } },
        stroke: withBands
            ? { show: true, curve: 'straight', width: [1, 0, 0, 2], dashArray: [0, 0, 0, 4], colors: [barOutline, outerBand, band, band] }
            : { show: true, width: 1, colors: [barOutline] },
        markers: { size: 0, hover: { size: 0 } },
        legend: withBands
            ? { show: true, position: 'bottom', fontSize: '11px', markers: { width: 8, height: 8 }, itemMargin: { horizontal: 6 } }
            : { show: false },
        xaxis: {
            type: 'category',
            // every third hour labelled, the bars of a narrow card leave no room for 24
            labels: { rotate: 0, formatter: (v: string) => (Number(v) % 3 === 0 ? v : '') },
            axisBorder: { show: false },
            axisTicks: { show: false },
            tooltip: { enabled: false },
        },
        tooltip: withBands
            ? {
                  ...baseOptions().tooltip,
                  shared: true,
                  intersect: false,
                  followCursor: true,
                  /* One box per hour with all four values. The range area chart brings a
                   * tooltip of its own that shows one series only and calls the formatters
                   * without the data point, so it is replaced here. */
                  custom: ({ dataPointIndex: h }: { dataPointIndex: number }) => {
                      const r = q[h];
                      if (!r) return '';
                      const row = (color: string, label: string, value: string) =>
                          `<div style="display:flex;align-items:center;gap:8px;line-height:1.6">` +
                          `<span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>` +
                          `<span style="flex:1">${label}</span><strong style="margin-left:12px">${value}</strong></div>`;
                      const events = (v: number) => `${v} event${v === 1 ? '' : 's'}`;
                      return (
                          `<div style="padding:6px 10px;font-size:12px;min-width:180px">` +
                          `<div style="font-weight:600;margin-bottom:4px">${hourLabel(h)}:00 – ${hourLabel((h + 1) % 24)}:00</div>` +
                          row(ACCENT, 'This day', events(counts[h])) +
                          row(band, 'Median', String(round1(r.p50))) +
                          row(band, '25–75 %', `${round1(r.p25)} – ${round1(r.p75)}`) +
                          row(outerBand, '10–90 %', `${round1(r.p10)} – ${round1(r.p90)}`) +
                          `</div>`
                      );
                  },
              }
            : {
                  ...baseOptions().tooltip,
                  x: { formatter: (_v: string, o?: { dataPointIndex: number }) => `${hourLabel(o?.dataPointIndex ?? 0)}:00` },
              },
        // an empty day has no scale of its own: without a max the axis reads "Infinity"
        yaxis: {
            labels: { formatter: (v: number) => Math.round(v).toString() },
            min: 0,
            max: top,
            tickAmount: 4,
        },
    });
    chart.render();
    return chart;
}

/* Days by hours, the darker the busier: daily routines show up as stripes, e.g. the
 * cat at the bowl every morning at 7. */
export function heatmapChart(el: HTMLElement, buckets: ActivityBucket[], days: number, onSelectDay?: (day: string) => void) {
    const dayKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - i);
        dayKeys.push(localDayKey(d.getTime()));
    }
    const byKey = new Map(buckets.map((b) => [`${b.day} ${b.hour}`, b.count]));
    const series = dayKeys
        .map((day) => ({
            name: new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: '2-digit' }),
            data: Array.from({ length: 24 }, (_, h) => ({ x: String(h).padStart(2, '0'), y: byKey.get(`${day} ${h}`) ?? 0 })),
        }))
        .reverse(); // newest day on top

    const chart = new ApexCharts(el, {
        ...baseOptions(),
        chart: {
            ...baseOptions().chart,
            type: 'heatmap',
            height: Math.max(160, days * 22 + 50),
            events: {
                dataPointSelection: (_e: unknown, _c: unknown, cfg: { seriesIndex: number }) => {
                    onSelectDay?.([...dayKeys].reverse()[cfg.seriesIndex]);
                },
            },
        },
        series,
        colors: [ACCENT],
        plotOptions: {
            heatmap: {
                radius: 3,
                enableShades: true,
                shadeIntensity: 0.6,
                colorScale: { ranges: [{ from: 0, to: 0, color: isDarkMode() ? '#34221a' : '#efe0c3', name: 'none' }] },
            },
        },
        stroke: { width: 2, colors: [isDarkMode() ? '#2a1b13' : '#fbf4e6'] },
        legend: { show: false },
        xaxis: { tickAmount: 12, axisBorder: { show: false }, axisTicks: { show: false } },
        tooltip: { ...baseOptions().tooltip, y: { formatter: (v: number) => `${v} event${v === 1 ? '' : 's'}` } },
    });
    chart.render();
    return chart;
}
