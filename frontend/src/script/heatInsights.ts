import type { HeatInsight, HeatInsights } from '../../../shared/heat';
import type { HomeRoom } from '../../../shared/heating';
import { escapeHtml } from './utils';

/* The findings on the heat page: the radiators by their use over the last year of readings,
 * and the hints where heat may be wasted (backend/src/heat/insights.ts). */

const ICONS: Record<HeatInsight['kind'], string> = {
    top: 'trophy',
    weather: 'temperature-plus',
    warm: 'sun',
    window: 'window',
    cold: 'droplet-half-2',
    loss: 'wind',
    data: 'info-circle',
};

const fmt = (v: number, digits = 0) => v.toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits });
const dateText = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

export function insightsCard() {
    return `<div class="card mb-3">
        <div class="card-header"><h3 class="card-title">Insights</h3><div class="card-actions text-secondary small" id="insights-period"></div></div>
        <div class="card-body" id="insights"><div class="text-secondary">Looking at the data<span class="animated-dots"></span></div></div>
    </div>`;
}

export async function loadInsights(rooms: HomeRoom[], color: (meterId: string) => string) {
    const el = document.getElementById('insights');
    if (!el) return;
    let data: HeatInsights;
    try {
        const res = await fetch('/api/heat/insights', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()) as HeatInsights;
    } catch {
        el.innerHTML = '<div class="text-secondary">The insights could not be loaded.</div>';
        return;
    }
    const roomName = (id?: string) => rooms.find((r) => r._id === id)?.name;
    document.getElementById('insights-period')!.textContent = data.period ? `radiators ${dateText(data.period.from)} – ${dateText(data.period.to)}` : '';

    const max = Math.max(...data.ranking.map((r) => r.share), 0);
    const ranking = data.ranking.length
        ? `<div class="mb-3">${data.ranking
              .map(
                  (r, i) => `<div class="d-flex flex-wrap align-items-center column-gap-2 mb-2">
                <span class="text-secondary small" style="width:1.5em">${i + 1}.</span>
                <span class="text-truncate" style="flex: 1 1 30%; min-width: 14em">${escapeHtml(r.name)} <span class="text-secondary small">${escapeHtml(roomName(r.roomId) ?? '')}</span></span>
                <div style="flex: 3 1 40%; min-width: 6em"><div style="height:10px;border-radius:5px;width:${max ? (r.share / max) * 100 : 0}%;background:${color(r.meterId)}"></div></div>
                <span class="text-end small text-nowrap" style="min-width:9em">${fmt(r.share * 100)} % · ${fmt(r.use)} units${r.kWh !== undefined ? ` · ${fmt(r.kWh)} kWh` : ''}</span></div>`,
              )
              .join('')}</div>`
        : '';
    const items = data.insights
        .map(
            (x) => `<div class="d-flex gap-2 py-2 border-top">
            <i class="ti ti-${ICONS[x.kind]} mt-1 ${x.level === 'warn' ? 'text-warning' : 'text-secondary'}"></i>
            <div><div class="fw-bold">${escapeHtml(x.title)}</div><div class="text-secondary small">${escapeHtml(x.text)}</div></div></div>`,
        )
        .join('');
    el.innerHTML =
        ranking +
        (items || '<div class="text-secondary border-top pt-2">Nothing stands out: no window left open while heating, no radiator out of line.</div>');
}
