import ApexCharts from 'apexcharts';
import type { ActivityBucket } from '../../../shared/protocol';
import { isDarkMode, localDayKey } from './utils';

const ACCENT = '#2fb344';

function baseOptions() {
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
        grid: { borderColor: dark ? 'rgba(255,255,255,0.08)' : '#e6e7e9', strokeDashArray: 4 },
        dataLabels: { enabled: false },
        tooltip: { theme: dark ? 'dark' : 'light' },
    };
}

// motion events per hour of one day: when the pets and people were around
export function hourlyChart(el: HTMLElement, buckets: ActivityBucket[], day: string) {
    const counts = new Array(24).fill(0);
    for (const b of buckets) {
        if (b.day === day) counts[b.hour] += b.count;
    }
    const chart = new ApexCharts(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: 160 },
        series: [{ name: 'Motion events', data: counts }],
        colors: [ACCENT],
        plotOptions: { bar: { columnWidth: '60%', borderRadius: 3 } },
        xaxis: {
            categories: counts.map((_, h) => String(h).padStart(2, '0')),
            // every third hour labelled, the bars of a narrow card leave no room for 24
            labels: { rotate: 0, formatter: (v: string) => (Number(v) % 3 === 0 ? v : '') },
            axisBorder: { show: false },
            axisTicks: { show: false },
        },
        tooltip: { ...baseOptions().tooltip, x: { formatter: (_v: string, o: { dataPointIndex: number }) => `${String(o.dataPointIndex).padStart(2, '0')}:00` } },
        // an empty day has no scale of its own: without a max the axis reads "Infinity"
        yaxis: {
            labels: { formatter: (v: number) => Math.round(v).toString() },
            min: 0,
            max: Math.max(4, ...counts),
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
                colorScale: { ranges: [{ from: 0, to: 0, color: isDarkMode() ? '#1f2a3d' : '#eef0f3', name: 'none' }] },
            },
        },
        stroke: { width: 2, colors: [isDarkMode() ? '#1a2234' : '#ffffff'] },
        legend: { show: false },
        xaxis: { tickAmount: 12, axisBorder: { show: false }, axisTicks: { show: false } },
        tooltip: { ...baseOptions().tooltip, y: { formatter: (v: number) => `${v} event${v === 1 ? '' : 's'}` } },
    });
    chart.render();
    return chart;
}
