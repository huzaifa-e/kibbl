import ApexCharts from 'apexcharts';
import { GROUPS, WORKOUT_KINDS, WORKOUT_KIND_IDS, type ActivityWeek, type ExerciseSession, type GroupWeek, type MuscleGroup } from '../../../shared/gym';
import { baseOptions } from './activityCharts';
import { heartRateChart, type HrZone } from './hrChart';
import { KIND_COLORS, r1, shortDay } from './gymCommon';
import { isDarkMode } from './utils';

/* The charts of the gym page, in the look of the other charts of the app. */

const RED = '#d4372a';

function render(el: HTMLElement, options: Record<string, unknown>) {
    const chart = new ApexCharts(el, options);
    void chart.render();
    return chart;
}

const xWeeks = (weeks: { week: number }[]) => weeks.map((w) => shortDay(w.week));

/* Minutes per week, stacked by kind: everything that was done, wherever it was logged. */
export function activityChart(el: HTMLElement, weeks: ActivityWeek[]) {
    const kinds = WORKOUT_KIND_IDS.filter((k) => weeks.some((w) => w.byKind[k]));
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: 220, stacked: true },
        series: kinds.map((k) => ({ name: WORKOUT_KINDS[k].label, data: weeks.map((w) => Math.round(w.byKind[k]?.minutes ?? 0)) })),
        colors: kinds.map((k) => KIND_COLORS[k]),
        plotOptions: { bar: { columnWidth: '62%', borderRadius: 3 } },
        xaxis: { categories: xWeeks(weeks), labels: { rotate: 0, hideOverlappingLabels: true } },
        yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` }, title: { text: 'min' } },
        legend: { position: 'bottom', fontSize: '12px' },
        tooltip: {
            ...baseOptions().tooltip,
            shared: true,
            intersect: false,
            y: { formatter: (v: number) => (v ? `${v} min` : '') },
        },
    });
}

/* A group's hard sets per week against the range that grows it. */
export function groupSetsChart(el: HTMLElement, weeks: GroupWeek[], group: MuscleGroup) {
    const [low, high] = GROUPS[group].sets;
    const dark = isDarkMode();
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: 200 },
        series: [{ name: 'Hard sets', data: weeks.map((w) => r1(w.sets[group])) }],
        colors: [RED],
        plotOptions: { bar: { columnWidth: '60%', borderRadius: 3 } },
        xaxis: { categories: xWeeks(weeks), labels: { rotate: 0, hideOverlappingLabels: true } },
        yaxis: { min: 0, max: Math.max(high + 4, ...weeks.map((w) => Math.ceil(w.sets[group]) + 2)), labels: { formatter: (v: number) => `${Math.round(v)}` } },
        annotations: {
            yaxis: [
                {
                    y: low,
                    y2: high,
                    fillColor: dark ? '#a3bd56' : '#7f9a2e',
                    opacity: 0.16,
                    borderColor: 'transparent',
                    label: { text: `${low}–${high} sets grow it`, position: 'left', textAnchor: 'start', offsetX: 6, style: { background: 'transparent', color: dark ? '#a3bd56' : '#5a6e1f', fontSize: '11px' } },
                },
            ],
        },
        tooltip: { ...baseOptions().tooltip, y: { formatter: (v: number) => `${v} sets` } },
    });
}

/* A group's strength, 100 = where each of its exercises started. */
export function strengthChart(el: HTMLElement, points: { week: number; index: number; exercises: number }[]) {
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'line', height: 180 },
        series: [{ name: 'Strength', data: points.map((p) => ({ x: p.week, y: r1(p.index) })) }],
        colors: [RED],
        stroke: { width: 3, curve: 'smooth' },
        markers: { size: 3 },
        xaxis: { type: 'datetime', labels: { datetimeUTC: false, format: 'd MMM' } },
        yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` } },
        annotations: { yaxis: [{ y: 100, borderColor: '#999', strokeDashArray: 4 }] },
        tooltip: {
            ...baseOptions().tooltip,
            x: { format: 'd MMM yyyy' },
            y: { formatter: (v: number) => `${v > 100 ? '+' : ''}${r1(v - 100)} % from the start` },
        },
    });
}

/* An exercise over time: the estimated 1RM and the heaviest set as lines, the volume as bars. */
export function exerciseChart(el: HTMLElement, sessions: ExerciseSession[], show: (kg: number) => number = (v) => v, unit = 'kg') {
    const dark = isDarkMode();
    const withWeight = sessions.filter((s) => s.topWeight > 0);
    if (!withWeight.length) {
        return render(el, {
            ...baseOptions(),
            chart: { ...baseOptions().chart, type: 'bar', height: 200 },
            series: [{ name: 'Reps', data: sessions.map((s) => ({ x: s.at, y: s.reps })) }],
            colors: [RED],
            xaxis: { type: 'datetime', labels: { datetimeUTC: false, format: 'd MMM' } },
            tooltip: { ...baseOptions().tooltip, x: { format: 'd MMM yyyy' } },
        });
    }
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'line', height: 240 },
        series: [
            { name: 'Volume', type: 'column', data: withWeight.map((s) => ({ x: s.at, y: Math.round(show(s.volume)) })) },
            { name: 'Estimated 1RM', type: 'line', data: withWeight.map((s) => ({ x: s.at, y: s.best ? r1(show(s.best.e1rm)) : null })) },
            { name: 'Heaviest', type: 'line', data: withWeight.map((s) => ({ x: s.at, y: r1(show(s.topWeight)) })) },
        ],
        colors: [dark ? 'rgba(243,230,207,0.22)' : 'rgba(42,26,18,0.14)', RED, dark ? '#e0b14a' : '#c98d12'],
        stroke: { width: [0, 3, 2], curve: 'smooth' },
        markers: { size: [0, 3, 2] },
        plotOptions: { bar: { columnWidth: '50%' } },
        xaxis: { type: 'datetime', labels: { datetimeUTC: false, format: 'd MMM' } },
        yaxis: [
            { seriesName: 'Volume', opposite: true, labels: { formatter: (v: number) => `${Math.round(v)}` }, title: { text: `${unit} × reps` } },
            { seriesName: 'Estimated 1RM', labels: { formatter: (v: number) => `${Math.round(v)}` }, title: { text: unit } },
            { seriesName: 'Estimated 1RM', show: false },
        ],
        legend: { position: 'bottom', fontSize: '12px' },
        tooltip: { ...baseOptions().tooltip, shared: true, intersect: false, x: { format: 'd MMM yyyy' } },
    });
}

/* A workout's heart rate, in the colours of its zones, each exercise a band behind the line
 * named at its start (exact from the ticks of its sets, else estimated). */
export function workoutHrChart(el: HTMLElement, points: { at: number; bpm: number }[], zones: HrZone[], windows: { name: string; from: number; to: number }[]) {
    const chart = heartRateChart(el, points, zones, 220);
    void chart.render().then(() => {
        windows.forEach((w, i) =>
            chart.addXaxisAnnotation({
                x: w.from,
                x2: w.to,
                fillColor: i % 2 ? '#7b3f61' : '#3d7a73',
                opacity: 0.08,
                borderColor: 'transparent',
                label: { text: String(i + 1), orientation: 'horizontal', position: 'top', borderWidth: 0, style: { background: 'transparent', fontSize: '10px', color: '#888' } },
            }),
        );
    });
    return chart;
}

/* An exercise's mean and peak heart rate per session. */
export function exerciseHrChart(el: HTMLElement, rows: { at: number; avg: number; max: number }[]) {
    return render(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'line', height: 180 },
        series: [
            { name: 'Mean', data: rows.map((r) => ({ x: r.at, y: r.avg })) },
            { name: 'Peak', data: rows.map((r) => ({ x: r.at, y: r.max })) },
        ],
        colors: [RED, '#a63d1f'],
        stroke: { width: [3, 1.5], curve: 'smooth', dashArray: [0, 4] },
        markers: { size: [3, 0] },
        xaxis: { type: 'datetime', labels: { datetimeUTC: false, format: 'd MMM' } },
        yaxis: { labels: { formatter: (v: number) => `${Math.round(v)}` }, title: { text: 'bpm' } },
        legend: { position: 'bottom', fontSize: '12px' },
        tooltip: { ...baseOptions().tooltip, shared: true, intersect: false, x: { format: 'd MMM yyyy' }, y: { formatter: (v: number) => `${v} bpm` } },
    });
}
