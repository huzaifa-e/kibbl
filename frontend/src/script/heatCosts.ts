import { heatBudget, type HeatCostSettings, type HeatCosts, type HeatStatementItem } from '../../../shared/heat';
import ApexCharts from 'apexcharts';
import { baseOptions } from './activityCharts';
import { tone } from './healthCharts';
import { byId, errorAlert, escapeHtml } from './utils';

/* The heating's costs on the heat page: what the use of this year costs at the report's price
 * per unit, and how much more heating the advance payments leave once the other running costs
 * and the heating's base share are paid (shared/heat.ts heatBudget). */

let costs: HeatCosts | undefined;
let editing = false;
let view: 'chart' | 'table' = 'chart';
let measure: 'share' | 'total' = 'share'; // the home's share or the building's total
let charts: ApexCharts[] = [];
let ctx: { used: (from: string) => { units: number; last?: string } | null; kWhPerUnit: () => number | undefined } = {
    used: () => null,
    kWhPerUnit: () => undefined,
};

const eur = (v: number | undefined) => (typeof v === 'number' ? v.toLocaleString([], { style: 'currency', currency: 'EUR' }) : '–');
const num = (v: number | undefined, digits = 0) =>
    typeof v === 'number' ? v.toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';
const dateText = (key?: string) => (key ? new Date(`${key}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// under the consumption tiles: the cost tiles, the sum behind them and the payments form
export function costsCard() {
    return `<div class="row row-cards mb-2" id="cost-tiles"></div><div class="mb-3" id="costs"></div>`;
}

// the running costs of the latest statement, item by item
export function statementCard() {
    return `<div id="statement"></div>`;
}

const KEYS: Record<string, string> = {
    area: 'by floor area',
    persons: 'by persons',
    flats: 'per flat',
    units: 'per unit',
    use: 'by use',
    'heating report': 'by the heating report',
};

function statementTable(st: NonNullable<HeatCosts['statement']>, items: HeatStatementItem[], total: number) {
    const row = (label: string, value: string, cls = '') =>
        `<tr class="${cls}"><td colspan="3">${label}</td><td class="text-end text-nowrap">${value}</td><td></td></tr>`;
    return `<div class="table-responsive"><table class="table table-vcenter card-table">
        <thead><tr><th>Cost</th><th class="d-none d-md-table-cell">Shared</th><th class="text-end d-none d-md-table-cell">Building</th><th class="text-end">Yours</th><th class="w-25 d-none d-sm-table-cell">Share of yours</th></tr></thead>
        <tbody>${items
            .map((i) => {
                const pct = total ? (i.share / total) * 100 : 0;
                return `<tr><td>${escapeHtml(i.name)}${i.heating ? ' <span class="badge bg-orange-lt ms-1">heating</span>' : ''}</td>
                    <td class="text-secondary d-none d-md-table-cell">${escapeHtml(KEYS[i.key ?? ''] ?? '')}</td>
                    <td class="text-end text-secondary d-none d-md-table-cell text-nowrap">${eur(i.total)}</td>
                    <td class="text-end text-nowrap fw-bold">${eur(i.share)}</td>
                    <td class="d-none d-sm-table-cell"><div class="d-flex align-items-center gap-2"><div class="progress progress-sm flex-grow-1"><div class="progress-bar${i.heating ? ' bg-orange' : ''}" style="width:${pct.toFixed(1)}%"></div></div><span class="small text-secondary" style="min-width:3em">${num(pct, 1)} %</span></div></td></tr>`;
            })
            .join('')}
        </tbody>
        <tfoot>
            ${row('<strong>Total</strong>', `<strong>${eur(total)}</strong>`)}
            ${st.advancePaid !== undefined ? row('Paid in advance', `− ${eur(st.advancePaid)}`) : ''}
            ${st.balance !== undefined ? row(st.balance >= 0 ? '<strong>To pay</strong>' : '<strong>Back to you</strong>', `<strong>${eur(Math.abs(st.balance))}</strong>`, st.balance >= 0 ? 'text-danger' : 'text-success') : ''}
            ${st.advance !== undefined ? row(`New advance${st.advanceFrom ? ` from ${dateText(st.advanceFrom)}` : ''}`, `${eur(st.advance)} a month${st.previousAdvance !== undefined ? ` <span class="text-secondary">(was ${eur(st.previousAdvance)})</span>` : ''}`) : ''}
        </tfoot></table></div>`;
}

/* Each cost as a bar, the heating in its own color, the home's share or the building's total;
 * the hover tells both, how it is shared and its part of the home's costs. */
function itemsChart(el: HTMLElement, items: HeatStatementItem[], total: number) {
    const sorted = [...items].sort((a, b) => (measure === 'share' ? b.share - a.share : (b.total ?? 0) - (a.total ?? 0)));
    const other = tone('pine');
    const heating = tone('pumpkin');
    const chart = new ApexCharts(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', height: Math.max(220, sorted.length * 30 + 40) },
        series: [
            {
                name: measure === 'share' ? 'Yours' : 'Building',
                data: sorted.map((i) => Math.round((measure === 'share' ? i.share : (i.total ?? 0)) * 100) / 100),
            },
        ],
        colors: sorted.map((i) => (i.heating ? heating : other)),
        plotOptions: { bar: { horizontal: true, distributed: true, barHeight: '70%', borderRadius: 4, borderRadiusApplication: 'end' } },
        states: { hover: { filter: { type: 'darken', value: 0.85 } } },
        dataLabels: {
            enabled: true,
            textAnchor: 'start',
            offsetX: 4,
            style: { fontWeight: 500, colors: ['var(--tblr-body-color)'] },
            formatter: (v: number) => eur(v),
        },
        legend: { show: false },
        grid: { ...baseOptions().grid, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
        xaxis: {
            categories: sorted.map((i) => i.name),
            labels: { formatter: (v: string) => eur(Number(v)).replace(/[.,]00/, '') },
            axisTicks: { show: false },
        },
        yaxis: { labels: { maxWidth: 200 } },
        tooltip: {
            ...baseOptions().tooltip,
            custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
                const i = sorted[dataPointIndex];
                const pct = total ? (i.share / total) * 100 : 0;
                return `<div class="p-2 small"><div class="fw-bold mb-1">${escapeHtml(i.name)}${i.heating ? ' · heating' : ''}</div>
                    <div>Yours: <strong>${eur(i.share)}</strong> (${num(pct, 1)} % of your costs)</div>
                    <div>Building: ${eur(i.total)}${i.total ? `, yours is ${num((i.share / i.total) * 100, 1)} %` : ''}</div>
                    ${i.key ? `<div class="text-secondary">Shared ${escapeHtml(KEYS[i.key] ?? i.key)}</div>` : ''}</div>`;
            },
        },
    });
    void chart.render();
    charts.push(chart);
}

/* What the costs were against what was paid in advance: the costs stacked as heating and the
 * rest, the advance and the balance on the second bar. */
function balanceChart(el: HTMLElement, st: NonNullable<HeatCosts['statement']>, items: HeatStatementItem[], total: number) {
    if (st.advancePaid === undefined) return;
    const heat = items.filter((i) => i.heating).reduce((a, i) => a + i.share, 0);
    const owed = Math.max(0, total - st.advancePaid);
    const back = Math.max(0, st.advancePaid - total);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const series = [
        { name: 'Heating', data: [r2(heat), 0] },
        { name: 'Other costs', data: [r2(total - heat), 0] },
        { name: 'Paid in advance', data: [0, r2(st.advancePaid - back)] },
        { name: owed ? 'To pay' : 'Back to you', data: [0, r2(owed || back)] },
    ];
    const chart = new ApexCharts(el, {
        ...baseOptions(),
        chart: { ...baseOptions().chart, type: 'bar', stacked: true, height: 170 },
        series,
        colors: [tone('pumpkin'), tone('pine'), tone('bark'), owed ? tone('rust') : tone('olive')],
        plotOptions: { bar: { horizontal: true, barHeight: '60%', borderRadius: 4, borderRadiusApplication: 'end', borderRadiusWhenStacked: 'last' } },
        stroke: { width: 2, colors: ['var(--tblr-bg-surface)'] },
        dataLabels: { enabled: true, formatter: (v: number) => (v ? eur(v) : ''), style: { fontWeight: 500 } },
        legend: { position: 'top', horizontalAlign: 'left' },
        xaxis: { categories: ['Costs', 'Paid'], labels: { formatter: (v: string) => eur(Number(v)).replace(/[.,]00/, '') }, axisTicks: { show: false } },
        tooltip: { ...baseOptions().tooltip, shared: false, y: { formatter: (v: number) => eur(v) } },
    });
    void chart.render();
    charts.push(chart);
}

function renderStatement() {
    const el = document.getElementById('statement');
    const st = costs?.statement;
    charts.forEach((c) => c.destroy());
    charts = [];
    if (!el) return;
    if (!st) {
        el.innerHTML = '';
        return;
    }
    const total = st.total ?? st.items.reduce((a, i) => a + i.share, 0);
    const items = [...st.items].filter((i) => i.share > 0).sort((a, b) => b.share - a.share);
    const none = st.items.filter((i) => !(i.share > 0));
    const year = st.period?.to.slice(0, 4) ?? '';
    const btn = (attr: string, value: string, label: string, active: boolean) =>
        `<button class="btn btn-sm${active ? ' active' : ''}" ${attr}="${value}">${label}</button>`;
    el.innerHTML = `<div class="card mb-3">
        <div class="card-header"><div><h3 class="card-title">Running costs ${escapeHtml(year)}</h3>
            <div class="text-secondary small">From the statement in <a href="/api/heat/reports/${st.reportId}/file" target="_blank" rel="noopener">${escapeHtml(st.fileName)}</a>${st.period ? `, ${dateText(st.period.from)} – ${dateText(st.period.to)}` : ''}</div></div>
            <div class="card-actions d-flex gap-2">
                ${view === 'chart' ? `<div class="btn-group">${btn('data-measure', 'share', 'Yours', measure === 'share')}${btn('data-measure', 'total', 'Building', measure === 'total')}</div>` : ''}
                <div class="btn-group">${btn('data-view', 'chart', '<i class="ti ti-chart-bar"></i>', view === 'chart')}${btn('data-view', 'table', '<i class="ti ti-table"></i>', view === 'table')}</div></div></div>
        ${
            view === 'chart'
                ? `<div class="card-body"><div class="d-flex flex-wrap gap-3 small text-secondary mb-1">
                    <span><i class="ti ti-square-filled" style="color:${tone('pumpkin')}"></i> Heating</span><span><i class="ti ti-square-filled" style="color:${tone('pine')}"></i> Other running costs</span>
                    <span class="ms-auto">Your total <strong class="text-body">${eur(total)}</strong>${st.advance !== undefined ? ` · new advance ${eur(st.advance)} a month${st.advanceFrom ? ` from ${dateText(st.advanceFrom)}` : ''}` : ''}</span></div>
                    <div id="statement-items"></div><div class="mt-2" id="statement-balance"></div></div>`
                : statementTable(st, items, total)
        }
        ${none.length ? `<div class="card-footer text-secondary small">Nothing for you: ${none.map((i) => escapeHtml(i.name)).join(', ')}.</div>` : ''}
    </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
        b.addEventListener('click', () => {
            view = b.dataset.view as typeof view;
            renderStatement();
        }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-measure]').forEach((b) =>
        b.addEventListener('click', () => {
            measure = b.dataset.measure as typeof measure;
            renderStatement();
        }),
    );
    if (view === 'chart') {
        itemsChart(byId('statement-items'), items, total);
        balanceChart(byId('statement-balance'), st, items, total);
    }
}

export function initCosts(c: typeof ctx) {
    ctx = c;
    byId('page-actions').insertAdjacentHTML('beforeend', '<button class="btn" id="costs-edit"><i class="ti ti-coin-euro me-1"></i>Payments</button>');
    byId('costs-edit').addEventListener('click', () => {
        editing = !editing;
        renderCosts();
    });
    void loadCosts();
}

export async function loadCosts() {
    const res = await fetch('/api/heat/costs', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    costs = (await res.json()) as HeatCosts;
    renderCosts();
}

export function renderCosts() {
    renderStatement();
    const el = document.getElementById('costs');
    if (!el || !costs) return;
    if (el.querySelector('form')?.contains(document.activeElement)) return; // what is being typed stays
    const s = costs.settings;
    const year = new Date().getFullYear();
    const budget = heatBudget(s, year);
    const used = ctx.used(`${year}-01-01`);
    const k = ctx.kWhPerUnit();
    const kwh = (units: number) => (k ? ` ≈ ${num(units * k)} kWh` : '');
    const stat = (label: string, value: string, sub: string, cls = '', icon = 'coin-euro') =>
        `<div class="col-sm-6 col-xl-3"><div class="card h-100"><div class="card-body">
            <div class="d-flex align-items-center gap-2 mb-1"><i class="ti ti-${icon} text-secondary"></i><span class="text-secondary small">${label}</span></div>
            <div class="stat-value ${cls}">${value}</div><div class="text-secondary small">${sub}</div></div></div></div>`;
    let tiles = '';

    let body = '';
    if (!s.perUnit) body = `<div class="text-secondary">Import a heating cost report: its price per unit prices your use.</div>`;
    else {
        const usedCost = used ? used.units * s.perUnit : undefined;
        const left = budget && used ? budget.units - used.units : budget?.units;
        const r = costs.report;
        tiles = `${stat(`Use in ${year}`, eur(usedCost), used ? `${num(used.units)} units${kwh(used.units)}, up to ${dateText(used.last)}` : 'no readings this year yet')}
            ${
                budget
                    ? stat(`Paid for use in ${year}`, eur(budget.forUse), `${num(budget.units)} units${kwh(budget.units)}`, '', 'wallet') +
                      stat(
                          'Room left',
                          left !== undefined ? eur(left * s.perUnit) : '–',
                          left !== undefined ? `${num(left)} units${kwh(left)} more until the end of ${year}` : '',
                          left !== undefined && left < 0 ? 'text-danger' : 'text-success',
                          'gauge',
                      )
                    : stat('Room left', '–', 'enter your advance under Payments', '', 'gauge')
            }
            ${r?.units !== undefined ? stat(`Last statement`, eur(r.costs), `${num(r.units)} units${kwh(r.units)}, ${r.to?.slice(0, 4) ?? ''}`, '', 'file-invoice') : ''}`;
        body = `${
            budget
                ? `<div class="text-secondary small">${eur(budget.paid)} advance in ${year} − ${eur(s.otherCosts ?? 0)} other running costs − ${eur(s.baseCost ?? 0)} heating base share
                    = ${eur(budget.forUse)} for use, at ${num(s.perUnit, 4)} € per unit.${
                        r?.units !== undefined
                            ? ` Using as much as last statement (${num(r.units)} units) would ${r.units > budget.units ? `need ${eur((r.units - budget.units) * s.perUnit)} more` : `leave ${eur((budget.units - r.units) * s.perUnit)}`}.`
                            : ''
                    } An estimate: prices and other costs change with the next statement.</div>`
                : ''
        }`;
    }
    byId('cost-tiles').innerHTML = tiles;
    el.innerHTML = body + (editing ? `<div class="card mt-2"><div class="card-body">${form(s)}</div></div>` : '');
    if (editing) wire();
}

function form(s: HeatCostSettings) {
    const r = costs?.report;
    const field = (id: keyof HeatCostSettings, label: string, hint: string, value: number | string | undefined, type = 'number') =>
        `<div class="col-sm-6 col-lg-4"><label class="form-label">${label}</label>
            <input class="form-control" id="cost-${id}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} value="${escapeHtml(String(value ?? ''))}" />
            <div class="form-hint">${hint}</div></div>`;
    return `<form id="costs-form"><div class="row g-3">
        ${field('advance', 'Advance per month (EUR)', "Vorauszahlung BK/NK/Hzg, now; empty: the statement's", s.advance)}
        ${field('previousAdvance', 'Advance before (EUR)', 'if it changed this year', s.previousAdvance)}
        ${field('advanceSince', 'Changed in', 'the first month of the new advance', s.advanceSince, 'month')}
        ${field('otherCosts', 'Other running costs per year (EUR)', "the last statement without the heating; empty: the statement's", s.otherCosts)}
        ${field('baseCost', 'Heating base share per year (EUR)', `Grundkosten${r?.baseCost !== undefined ? `, the report: ${num(r.baseCost, 2)}` : ''}`, s.baseCost)}
        ${field('perUnit', 'Price per unit (EUR)', `Verbrauchskosten${r?.perUnit !== undefined ? `, the report: ${num(r.perUnit, 6)}` : ''}`, s.perUnit)}
        </div><div id="costs-error" class="mt-2"></div><button class="btn btn-primary mt-2" type="submit">Save</button></form>`;
}

function wire() {
    byId<HTMLFormElement>('costs-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = (id: string) => byId<HTMLInputElement>(`cost-${id}`).value.trim();
        const n = (id: string) => (v(id) === '' ? null : Number(v(id)));
        const body = {
            advance: n('advance'),
            previousAdvance: n('previousAdvance'),
            advanceSince: v('advanceSince') || null,
            otherCosts: n('otherCosts'),
            baseCost: n('baseCost'),
            perUnit: n('perUnit'),
        };
        const res = await fetch('/api/heat/costs', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            byId('costs-error').innerHTML = errorAlert(await res.text());
            return;
        }
        costs = (await res.json()) as HeatCosts;
        editing = false;
        (document.activeElement as HTMLElement | null)?.blur();
        renderCosts();
    });
}
