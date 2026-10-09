import { REPORT_ROOMS, kWhPerUnit, type HeatMeter, type HeatReportDevice, type HeatReportSummary } from '../../../shared/heat';
import type { HomeRoom } from '../../../shared/heating';
import { roomKind } from '../../../shared/roomKind';
import { byId, errorAlert, escapeHtml, successAlert } from './utils';

/* The heating cost reports on the heat page: a PDF is uploaded, read on the server (OCR, it
 * never leaves it) and its values shown in a form to check against the PDF; importing makes a
 * heat meter of each heat cost allocator with its readings, and the building's energy per unit
 * lets the page show kWh. */

let reports: HeatReportSummary[] = [];
let reviewing: string | undefined; // the report whose form is open
let uploading = false;
let message = '';
let ctx: { rooms: () => HomeRoom[]; meters: () => HeatMeter[] } = { rooms: () => [], meters: () => [] };

const fmt = (v: number | undefined, digits = 0) =>
    typeof v === 'number' ? v.toLocaleString([], { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–';
const dateText = (key?: string) => (key ? new Date(`${key}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '?');

async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('not logged in');
    }
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res.json() as Promise<T>;
}

export function reportsCard() {
    return `<div class="card mb-3">
        <div class="card-header"><h3 class="card-title">Reports</h3>
            <div class="card-actions"><label class="btn btn-sm btn-primary mb-0"><i class="ti ti-upload me-1"></i>Upload report
                <input type="file" accept="application/pdf,.pdf" id="report-file" hidden /></label></div></div>
        <div id="reports"></div>
    </div>`;
}

export function initReports(c: typeof ctx) {
    ctx = c;
    byId<HTMLInputElement>('report-file').addEventListener('change', async (e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        uploading = true;
        message = '';
        render();
        try {
            const form = new FormData();
            form.append('report', file);
            const report = await api<HeatReportSummary>('/api/heat/reports', { method: 'POST', body: form });
            reviewing = report._id;
            reports = [report, ...reports.filter((r) => r._id !== report._id)];
        } catch (err) {
            message = errorAlert(`The report was not read: ${(err as Error).message}`);
        }
        uploading = false;
        render();
    });
    void loadReports();
}

export async function loadReports() {
    try {
        reports = await api<HeatReportSummary[]>('/api/heat/reports');
    } catch {
        return;
    }
    render();
}

/* ----------------------------------------------------------------------- */

function render() {
    const el = document.getElementById('reports');
    if (!el) return;
    const keepForm = reviewing && document.getElementById('report-form')?.contains(document.activeElement);
    if (keepForm) return; // what is being typed stays
    const rows = reports
        .map(
            (r) => `<tr>
            <td><i class="ti ti-file-type-pdf me-1 text-secondary"></i>${escapeHtml(r.fileName)}
                <div class="text-secondary small">${r.data.company === 'techem' ? 'Techem · ' : ''}${r.data.period ? `${dateText(r.data.period.from)} – ${dateText(r.data.period.to)}` : 'period unknown'}</div></td>
            <td class="d-none d-md-table-cell">${r.appliedAt ? `<span class="badge bg-green-lt">Imported</span>` : '<span class="badge bg-yellow-lt">To check</span>'}</td>
            <td class="text-end text-nowrap">
                <a class="btn btn-sm btn-ghost-secondary" href="/api/heat/reports/${r._id}/file" target="_blank" rel="noopener" title="Open the PDF"><i class="ti ti-external-link"></i></a>
                <button class="btn btn-sm${r.appliedAt ? ' btn-ghost-secondary' : ' btn-primary'}" data-review="${r._id}">${reviewing === r._id ? 'Close' : r.appliedAt ? 'Values' : 'Check & import'}</button>
                <button class="btn btn-sm btn-ghost-danger" data-drop-report="${r._id}" title="Remove the report"><i class="ti ti-trash"></i></button></td></tr>
            ${reviewing === r._id ? `<tr><td colspan="3" class="p-0">${form(r)}</td></tr>` : ''}`,
        )
        .join('');
    el.innerHTML =
        (message ? `<div class="card-body pb-0">${message}</div>` : '') +
        (uploading
            ? `<div class="card-body"><div class="text-secondary mb-2">Reading the report on the server<span class="animated-dots"></span> a scan takes up to a minute.</div>
                <div class="progress progress-sm"><div class="progress-bar progress-bar-indeterminate"></div></div></div>`
            : '') +
        (reports.length
            ? `<div class="table-responsive"><table class="table table-vcenter card-table"><tbody>${rows}</tbody></table></div>`
            : uploading
              ? ''
              : `<div class="card-body text-secondary">Upload the heating cost report (Heizkostenabrechnung) of your meter reading company as PDF, a scan works too.
                    Its readings become your heat meters, and the building's energy per unit shows your use in kWh.</div>`);

    el.querySelectorAll<HTMLButtonElement>('[data-review]').forEach((b) =>
        b.addEventListener('click', () => {
            reviewing = reviewing === b.dataset.review ? undefined : b.dataset.review;
            message = '';
            render();
        }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-drop-report]').forEach((b) =>
        b.addEventListener('click', async () => {
            if (!confirm('Remove this report and its PDF? The readings it brought stay with the heat meters.')) return;
            await api(`/api/heat/reports/${b.dataset.dropReport}`, { method: 'DELETE' });
            if (reviewing === b.dataset.dropReport) reviewing = undefined;
            await loadReports();
        }),
    );
    if (reviewing) wireForm(reports.find((r) => r._id === reviewing)!);
}

/* ----------------------------------------------------------------------- */

// the room of the home a device of this code is in: the meter's, else the only room of that kind
function guessRoom(d: HeatReportDevice, meter?: HeatMeter) {
    if (meter?.roomId) return meter.roomId;
    const kind = d.room ? REPORT_ROOMS[d.room]?.kind : undefined;
    if (!kind) return '';
    const matching = ctx.rooms().filter((r) => roomKind(r) === kind);
    return matching.length === 1 ? matching[0]._id : '';
}

function deviceRow(d: HeatReportDevice) {
    const meter = ctx.meters().find((m) => m.serial === d.serial);
    const name = meter?.name ?? `${d.room ? (REPORT_ROOMS[d.room]?.name ?? 'Radiator') : 'Radiator'} ${d.serial}`;
    const room = guessRoom(d, meter);
    const options = [
        '<option value="">No room</option>',
        ...ctx.rooms().map((r) => `<option value="${r._id}"${r._id === room ? ' selected' : ''}>${escapeHtml(r.name)}</option>`),
    ].join('');
    const num = (field: string, v: number) =>
        `<input class="form-control form-control-sm text-end" style="min-width:80px" type="number" step="any" min="0" data-f="${field}" value="${v}" />`;
    return `<tr data-device>
        <td><input class="form-control form-control-sm" style="min-width:100px" data-f="serial" value="${escapeHtml(d.serial)}" />
            ${meter ? `<div class="small text-secondary mt-1">known meter</div>` : ''}</td>
        <td><input class="form-control form-control-sm" style="width:52px" data-f="room" value="${escapeHtml(d.room ?? '')}" maxlength="3" /></td>
        <td><input class="form-control form-control-sm" style="min-width:140px" data-f="name" value="${escapeHtml(name)}" maxlength="60" /></td>
        <td><select class="form-select form-select-sm" style="min-width:120px" data-f="roomId">${options}</select></td>
        <td><input class="form-control form-control-sm" type="date" data-f="date" value="${escapeHtml(d.date)}" /></td>
        <td>${num('old', d.old)}</td><td>${num('new', d.new)}</td><td>${num('use', d.use)}</td>
        <td><button type="button" class="btn btn-sm btn-ghost-danger" data-remove-row title="Leave out"><i class="ti ti-x"></i></button></td></tr>`;
}

function form(r: HeatReportSummary) {
    const d = r.data;
    const extra = [
        d.costs !== undefined ? `your heating costs ${fmt(d.costs, 2)} EUR` : '',
        d.analysisKWh !== undefined
            ? `Techem's consumption ${fmt(d.analysisKWh)} kWh${d.climateFactor ? ` (weather corrected with ${fmt(d.climateFactor, 2)})` : ''}`
            : '',
        d.userNo ? `user number ${escapeHtml(d.userNo)}` : '',
    ].filter(Boolean);
    return `<form id="report-form" class="p-3 bg-body-tertiary">
        ${r.warnings.length ? `<div class="alert alert-warning"><div class="fw-bold mb-1">Check these against the PDF</div>${r.warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join('')}</div>` : ''}
        <div class="text-secondary small mb-3">Read by OCR from the scan: compare every number with the <a href="/api/heat/reports/${r._id}/file" target="_blank" rel="noopener">PDF</a> before importing.
            Each heat cost allocator becomes a heat meter (one with the same number is updated), with its reading the day before the period starts and on the day it was read.</div>
        <div class="row g-2 mb-3"><div class="col-auto"><label class="form-label">Period from</label>
            <input type="date" class="form-control" id="report-from" value="${escapeHtml(d.period?.from ?? '')}" required /></div>
            <div class="col-auto"><label class="form-label">Building's energy</label><div class="input-group"><input type="number" step="any" min="0" class="form-control" id="report-kwh" value="${d.buildingKWh ?? ''}" style="max-width:140px" /><span class="input-group-text">kWh</span></div></div>
            <div class="col-auto"><label class="form-label">Building's units</label><input type="number" step="any" min="0" class="form-control" id="report-units" value="${d.buildingUnits ?? ''}" style="max-width:140px" /></div>
            <div class="col-auto align-self-end pb-2 small" id="report-per-unit"></div></div>
        <div class="table-responsive"><table class="table table-sm table-vcenter mb-2"><thead><tr><th>Device</th><th title="Room code of the report">Code</th><th>Name</th><th>Room</th><th>Read on</th><th class="text-end">Old</th><th class="text-end">New</th><th class="text-end">Use</th><th></th></tr></thead>
            <tbody id="report-devices">${d.devices.map(deviceRow).join('')}</tbody></table></div>
        <div class="d-flex flex-wrap align-items-center gap-3 mb-3"><button type="button" class="btn btn-sm" id="report-add-row"><i class="ti ti-plus me-1"></i>Device</button>
            <span class="small" id="report-sum"></span><span class="small text-secondary">${extra.join(' · ')}</span></div>
        <div id="report-error"></div>
        <button class="btn btn-primary" type="submit">${r.appliedAt ? 'Import again' : 'Import'}</button>
    </form>`;
}

function readRows() {
    return [...document.querySelectorAll<HTMLTableRowElement>('#report-devices [data-device]')].map((row) => {
        const v = (f: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-f="${f}"]`)!.value.trim();
        return {
            serial: v('serial'),
            room: v('room').toUpperCase() || undefined,
            name: v('name'),
            roomId: v('roomId') || null,
            date: v('date'),
            old: Number(v('old')),
            new: Number(v('new')),
            use: Number(v('use')),
        };
    });
}

function wireForm(r: HeatReportSummary) {
    const f = document.getElementById('report-form') as HTMLFormElement | null;
    if (!f) return;
    const update = () => {
        const rows = readRows();
        const sum = rows.reduce((s, d) => s + (d.use || 0), 0);
        const perUnit = kWhPerUnit({
            buildingKWh: Number(byId<HTMLInputElement>('report-kwh').value),
            buildingUnits: Number(byId<HTMLInputElement>('report-units').value),
        });
        const reported = r.data.units;
        byId('report-sum').innerHTML =
            `${rows.length} devices, ${fmt(sum, 0)} units` +
            (reported !== undefined
                ? Math.abs(sum - reported) < 0.01
                    ? ' <span class="text-success">as the report says</span>'
                    : ` <span class="text-danger">the report says ${fmt(reported, 0)}</span>`
                : '') +
            (perUnit ? ` · ≈ ${fmt(sum * perUnit, 0)} kWh` : '');
        byId('report-per-unit').textContent = perUnit ? `= ${fmt(perUnit, 3)} kWh per unit` : '';
    };
    f.addEventListener('input', update);
    f.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('[data-remove-row]');
        if (btn) {
            btn.closest('tr')!.remove();
            update();
        }
    });
    byId('report-add-row').addEventListener('click', () => {
        byId('report-devices').insertAdjacentHTML('beforeend', deviceRow({ serial: '', date: r.data.period?.to ?? '', old: 0, new: 0, use: 0 }));
        update();
    });
    f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await api(`/api/heat/reports/${r._id}/apply`, {
                method: 'POST',
                body: JSON.stringify({
                    from: byId<HTMLInputElement>('report-from').value,
                    devices: readRows(),
                    buildingKWh: Number(byId<HTMLInputElement>('report-kwh').value) || undefined,
                    buildingUnits: Number(byId<HTMLInputElement>('report-units').value) || undefined,
                }),
            });
            reviewing = undefined;
            message = successAlert('The report is imported: its readings are with the heat meters.');
            (document.activeElement as HTMLElement | null)?.blur();
            await loadReports();
        } catch (err) {
            byId('report-error').innerHTML = errorAlert((err as Error).message);
        }
    });
    update();
}
