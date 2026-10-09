import './main';
import { LEVEL_ORDER, type AnalysisReport, type Finding, type FindingLevel } from '../../../shared/analysis';
import { socket } from './socket';
import { byId, errorAlert, escapeHtml, timeAgo } from './utils';

/* Everything the home's data says now, from all its parts: the heat, the air of each room,
 * the heating, the meters, the devices and health (backend/src/analysis). What needs
 * attention first; the server keeps a report 2 minutes. */

const LEVELS: Record<FindingLevel, { label: string; color: string; icon: string }> = {
    alert: { label: 'Alerts', color: 'var(--tblr-danger)', icon: 'alert-octagon' },
    warn: { label: 'Worth a look', color: 'var(--tblr-warning)', icon: 'alert-triangle' },
    info: { label: 'Hints', color: 'var(--tblr-azure)', icon: 'info-circle' },
    good: { label: 'Fine', color: 'var(--tblr-success)', icon: 'circle-check' },
};

let report: AnalysisReport | undefined;
let onlyAttention = false;
let loading = false;

function remember() {
    try {
        onlyAttention = localStorage.getItem('kibbl.analysisAttention') === '1';
    } catch {
        /* no storage: everything shown */
    }
}

function finding(f: Finding) {
    const l = LEVELS[f.level];
    return `<div class="d-flex gap-3 py-2 border-top">
        <span class="avatar avatar-sm flex-shrink-0" style="background:transparent;color:${l.color}"><i class="ti ti-${escapeHtml(f.icon)}" style="font-size:1.25rem"></i></span>
        <div class="flex-fill">
            <div class="fw-bold">${escapeHtml(f.title)}</div>
            <div class="text-secondary small">${escapeHtml(f.text)}</div>
        </div>
        ${f.link ? `<a class="btn btn-sm btn-ghost-secondary align-self-center flex-shrink-0" href="${escapeHtml(f.link)}" title="Open"><i class="ti ti-arrow-right"></i></a>` : ''}
    </div>`;
}

function render() {
    if (!report) return;
    const c = report.counts;
    const tile = (level: FindingLevel) => `<div class="col-6 col-lg-3"><div class="card"><div class="card-body d-flex align-items-center gap-3">
        <i class="ti ti-${LEVELS[level].icon}" style="font-size:1.75rem;color:${LEVELS[level].color}"></i>
        <div><div class="stat-value">${c[level]}</div><div class="text-secondary small">${LEVELS[level].label}</div></div></div></div></div>`;

    const sections = report.sections
        .map((s) => {
            const list = onlyAttention ? s.findings.filter((f) => f.level === 'alert' || f.level === 'warn') : s.findings;
            if (onlyAttention && !list.length && !s.error) return '';
            const worst = s.findings.reduce<FindingLevel>((w, f) => (LEVEL_ORDER.indexOf(f.level) < LEVEL_ORDER.indexOf(w) ? f.level : w), 'good');
            return `<div class="card mb-3">
                <div class="card-header"><h3 class="card-title d-flex align-items-center gap-2">
                    <span class="d-inline-block rounded-circle" style="width:9px;height:9px;background:${s.findings.length ? LEVELS[worst].color : 'var(--tblr-secondary)'}"></span>${escapeHtml(s.title)}</h3>
                    <div class="card-actions text-secondary small">${s.findings.length} finding${s.findings.length === 1 ? '' : 's'}</div></div>
                <div class="card-body py-1">
                    ${s.error ? `<div class="py-2">${errorAlert(`Not analysed now: ${s.error}`)}</div>` : ''}
                    ${list.map(finding).join('') || '<div class="text-secondary py-2">Nothing to report.</div>'}
                </div></div>`;
        })
        .join('');

    byId('container').innerHTML = `
        <div class="row row-cards mb-3">${LEVEL_ORDER.map(tile).join('')}</div>
        <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
            <div class="btn-group"><button class="btn btn-sm${onlyAttention ? '' : ' active'}" data-filter="all">Everything</button>
                <button class="btn btn-sm${onlyAttention ? ' active' : ''}" data-filter="attention">Needs attention</button></div>
            <span class="text-secondary small ms-auto" id="analysis-at">analysed ${timeAgo(report.at)}</span>
            <button class="btn btn-sm" id="analysis-refresh"${loading ? ' disabled' : ''}><i class="ti ti-refresh me-1"></i>Analyse again</button>
        </div>
        ${sections || '<div class="text-secondary">Nothing needs attention.</div>'}`;

    document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) =>
        b.addEventListener('click', () => {
            onlyAttention = b.dataset.filter === 'attention';
            try {
                localStorage.setItem('kibbl.analysisAttention', onlyAttention ? '1' : '0');
            } catch {
                /* only for this visit */
            }
            render();
        }),
    );
    byId('analysis-refresh').addEventListener('click', () => load(true));
}

async function load(fresh = false) {
    if (loading) return;
    loading = true;
    if (report) render();
    try {
        const res = await fetch(`/api/analysis${fresh ? '?fresh=1' : ''}`, { headers: { Accept: 'application/json' } });
        if (res.status === 401) {
            window.location.href = '/login';
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        report = (await res.json()) as AnalysisReport;
        loading = false;
        render();
    } catch (err) {
        loading = false;
        if (!report) byId('container').innerHTML = errorAlert(`The analysis could not be loaded: ${(err as Error).message}`);
    }
}

remember();
socket.on('connect', () => load());
// the data changed: analysed again at most every 2 minutes (the server keeps a report as long)
let soon: ReturnType<typeof setTimeout> | undefined;
for (const event of ['heatUpdate', 'meterUpdate', 'airEvent', 'deviceRemoved'] as const) {
    socket.on(event, () => {
        soon ??= setTimeout(() => {
            soon = undefined;
            void load();
        }, 2 * 60_000);
    });
}
window.setInterval(() => {
    if (!document.hidden) void load();
}, 5 * 60_000);
window.setInterval(() => {
    const at = document.getElementById('analysis-at');
    if (at && report) at.textContent = `analysed ${timeAgo(report.at)}`;
}, 30_000);
