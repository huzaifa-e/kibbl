import { heatBudget, type HeatCostSettings, type HeatCosts } from '../../../shared/heat';
import { byId, errorAlert, escapeHtml } from './utils';

/* The heating's costs on the heat page: what the use of this year costs at the report's price
 * per unit, and how much more heating the advance payments leave once the other running costs
 * and the heating's base share are paid (shared/heat.ts heatBudget). */

let costs: HeatCosts | undefined;
let editing = false;
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

function renderStatement() {
    const el = document.getElementById('statement');
    const st = costs?.statement;
    if (!el) return;
    if (!st) {
        el.innerHTML = '';
        return;
    }
    const total = st.total ?? st.items.reduce((a, i) => a + i.share, 0);
    const items = [...st.items].filter((i) => i.share > 0).sort((a, b) => b.share - a.share);
    const none = st.items.filter((i) => !(i.share > 0));
    const year = st.period?.to.slice(0, 4) ?? '';
    const row = (label: string, value: string, cls = '') =>
        `<tr class="${cls}"><td colspan="3">${label}</td><td class="text-end text-nowrap">${value}</td><td></td></tr>`;
    el.innerHTML = `<div class="card mb-3">
        <div class="card-header"><div><h3 class="card-title">Running costs ${escapeHtml(year)}</h3>
            <div class="text-secondary small">From the statement in <a href="/api/heat/reports/${st.reportId}/file" target="_blank" rel="noopener">${escapeHtml(st.fileName)}</a>${st.period ? `, ${dateText(st.period.from)} – ${dateText(st.period.to)}` : ''}</div></div></div>
        <div class="table-responsive"><table class="table table-vcenter card-table">
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
            </tfoot></table></div>
        ${none.length ? `<div class="card-footer text-secondary small">Nothing for you: ${none.map((i) => escapeHtml(i.name)).join(', ')}.</div>` : ''}
    </div>`;
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
