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
        ${field('advance', 'Advance per month (EUR)', 'Vorauszahlung BK/NK/Hzg, now', s.advance)}
        ${field('previousAdvance', 'Advance before (EUR)', 'if it changed this year', s.previousAdvance)}
        ${field('advanceSince', 'Changed in', 'the first month of the new advance', s.advanceSince, 'month')}
        ${field('otherCosts', 'Other running costs per year (EUR)', 'the last statement without the heating', s.otherCosts)}
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
