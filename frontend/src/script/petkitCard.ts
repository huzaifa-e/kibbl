import { PETKIT_PORTIONS, PETKIT_REGIONS, mealTime, type PetkitFeeder, type PetkitMeal, type PetkitStatus } from '../../../shared/petkit';
import type { DeviceSummary } from '../../../shared/protocol';
import { errorAlert, escapeHtml, timeAgo } from './utils';

/* A PetKit feeder (petkit/service.ts on the server): a card with its hopper, today's meals
 * (skip one to come, give a skipped one after all), feeding now and pausing the plan, on the
 * home page and on the page of the camera that watches it; and on the devices page the
 * connection to PetKit, with the camera of each feeder. */

let status: PetkitStatus | undefined;
const portionsChosen = new Map<number, number>(); // per feeder, while the page is open
const busy = new Set<string>();

export async function loadPetkit() {
    const res = await fetch('/api/petkit', { headers: { Accept: 'application/json' } }).catch(() => undefined);
    status = res?.ok ? ((await res.json()) as PetkitStatus) : undefined;
    return status;
}

export const petkitStatus = () => status;
export const feederWatchedBy = (deviceId: string) => status?.feeders.find((f) => f.cameraId === deviceId);

/* ----------------------------------------------------------------------- */

const stateBadge: Record<PetkitMeal['state'], string> = {
    planned: '<span class="badge bg-secondary-lt">to come</span>',
    given: '<span class="badge bg-green-lt">given</span>',
    skipped: '<span class="badge bg-yellow-lt">skipped</span>',
    feeding: '<span class="badge bg-blue-lt">feeding…</span>',
    failed: '<span class="badge bg-red-lt">not given</span>',
    missed: '<span class="badge bg-red-lt">did not start</span>',
};

const secondsNow = () => {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};

const portions = (n: number) => `${n % 1 ? n.toFixed(1) : n} portion${n === 1 ? '' : 's'}`;

function mealRow(f: PetkitFeeder, m: PetkitMeal) {
    const key = `${f.id}|${m.id}`;
    const action =
        m.manual || busy.has(key)
            ? ''
            : m.state === 'planned'
              ? `<button class="btn btn-sm btn-ghost-secondary" data-petkit-skip="${escapeHtml(m.id)}" data-feeder="${f.id}">Skip</button>`
              : m.state === 'skipped' && !m.at && m.time > secondsNow()
                ? `<button class="btn btn-sm btn-ghost-secondary" data-petkit-restore="${escapeHtml(m.id)}" data-feeder="${f.id}">Give</button>`
                : '';
    const amount = m.given !== undefined && m.given !== m.portions ? `${portions(m.given)} of ${m.portions}` : portions(m.portions);
    return `<div class="list-group-item px-0 py-2 d-flex align-items-center gap-2">
        <span class="text-mono fw-bold">${mealTime(m.time)}</span>
        <span class="flex-fill text-truncate">${m.manual ? '<i class="ti ti-hand-finger me-1 text-secondary" title="fed from an app"></i>' : ''}${escapeHtml(m.name || (m.manual ? 'Fed now' : 'Meal'))}
            <span class="text-secondary small">· ${amount}</span></span>
        ${stateBadge[m.state]} ${action}
    </div>`;
}

// a feeder's card: on the home page with its name, on its camera's page without
export function petkitFeederHtml(f: PetkitFeeder, opts: { title?: boolean } = {}) {
    const chosen = portionsChosen.get(f.id) ?? 1;
    const feeding = f.feeding || f.meals.some((m) => m.state === 'feeding');
    const disabled = f.online ? '' : 'disabled';
    const desiccant =
        f.desiccantDays !== undefined
            ? `<div class="datagrid-item"><div class="datagrid-title">Desiccant</div><div class="datagrid-content ${f.desiccantDays <= 3 ? 'text-warning' : ''}">${f.desiccantDays} day${f.desiccantDays === 1 ? '' : 's'}
                ${f.desiccantDays <= 3 ? `<a href="#" class="ms-1 small" data-petkit-desiccant="${f.id}">replaced</a>` : ''}</div></div>`
            : '';
    const body = `
        ${f.error ? errorAlert(escapeHtml(f.error)) : ''}
        <div class="datagrid mb-3">
            <div class="datagrid-item"><div class="datagrid-title">Food</div><div class="datagrid-content">${
                f.food === 'low'
                    ? '<span class="text-warning"><i class="ti ti-alert-triangle me-1"></i>running low</span>'
                    : f.food === 'enough'
                      ? '<span class="text-green"><i class="ti ti-check me-1"></i>enough</span>'
                      : '–'
            }</div></div>
            <div class="datagrid-item"><div class="datagrid-title">Today</div><div class="datagrid-content">${portions(f.givenToday)} given${f.plannedToday ? ` <span class="text-secondary">of ${f.plannedToday} planned</span>` : ''}</div></div>
            ${desiccant}
        </div>
        <div class="list-group list-group-flush mb-3">${f.meals.length ? f.meals.map((m) => mealRow(f, m)).join('') : '<div class="text-secondary small">No meals today.</div>'}</div>
        <label class="form-label">Feed now</label>
        <div class="d-flex gap-2 align-items-center mb-3">
            <div class="btn-group flex-fill" role="group">
                ${Array.from({ length: PETKIT_PORTIONS.max - PETKIT_PORTIONS.min + 1 }, (_, i) => i + PETKIT_PORTIONS.min)
                    .map(
                        (
                            n,
                        ) => `<input type="radio" class="btn-check" name="petkit-portions-${f.id}" id="petkit-p-${f.id}-${n}" value="${n}" data-petkit-portions="${f.id}" ${n === chosen ? 'checked' : ''} ${disabled} />
                        <label for="petkit-p-${f.id}-${n}" class="btn btn-sm">${n}</label>`,
                    )
                    .join('')}
            </div>
            ${
                feeding
                    ? `<button class="btn btn-sm btn-outline-danger" data-petkit-cancel="${f.id}" ${disabled}><i class="ti ti-player-stop me-1"></i> Stop</button>`
                    : `<button class="btn btn-sm btn-primary ${busy.has(`${f.id}|feed`) ? 'btn-loading' : ''}" data-petkit-feed="${f.id}" ${disabled}><i class="ti ti-bowl me-1"></i> Feed</button>`
            }
        </div>
        <label class="form-check form-switch mb-1">
            <input class="form-check-input" type="checkbox" data-petkit-plan="${f.id}" ${f.planPaused ? '' : 'checked'} ${disabled} />
            <span class="form-check-label">Feed on PetKit's plan</span>
        </label>
        <div class="form-hint">The plan's times and amounts are set in PetKit's app; a portion is about 10 g.</div>
        <div class="petkit-result mt-2" data-petkit-result="${f.id}"></div>
        <div class="text-secondary small mt-2">${f.online ? '' : '<i class="ti ti-wifi-off me-1"></i>offline · '}read ${timeAgo(f.at)}</div>`;
    const badge = `<span class="badge ${!f.online ? 'bg-secondary-lt' : feeding ? 'bg-blue-lt' : 'bg-green-lt'}">${!f.online ? 'offline' : feeding ? 'feeding' : 'online'}</span>`;
    return `<div class="card" data-petkit-card="${f.id}">
        <div class="card-header"><h3 class="card-title"><i class="ti ti-bowl me-1 text-orange"></i> ${opts.title === false ? 'Feeder' : escapeHtml(f.name)}</h3><div class="card-actions">${badge}</div></div>
        <div class="card-body">${body}</div>
    </div>`;
}

/* ----------------------------------------------------------------------- */

// the devices page: connecting PetKit, its feeders and the camera of each
export function petkitPanelHtml(cameras: DeviceSummary[]) {
    const s = status;
    let body: string;
    if (!s?.connected) {
        body = `<div class="card-body">
            <p class="text-secondary">Feed from here, see what your PetKit feeder gave today and when its hopper runs low, and let a kibbl. cam over it tell you when the cat comes to eat.</p>
            <div class="alert alert-info small"><b>Use a second PetKit account, with an e-mail and a password.</b> PetKit keeps one sign-in per account: with the account of your phone, PetKit's app and kibbl. would sign each other out, and an account made with Apple or Google has no password to give here. Register a new account with an e-mail in PetKit's app, share the feeder with it from your own account (device settings → Share), and connect the new one here.</div>
            <form class="row g-2" id="petkit-connect">
                <div class="col-md-4"><label class="form-label">PetKit e-mail</label><input class="form-control" type="email" id="petkit-email" autocomplete="off" required maxlength="200" /></div>
                <div class="col-md-3"><label class="form-label">Password</label><input class="form-control" type="password" id="petkit-password" autocomplete="new-password" required maxlength="200" /></div>
                <div class="col-md-3"><label class="form-label">Region</label><select class="form-select" id="petkit-region">${PETKIT_REGIONS.map((r) => `<option value="${r.id}">${r.label}</option>`).join('')}</select></div>
                <div class="col-md-2 d-flex align-items-end"><button class="btn btn-primary w-100" type="submit"><i class="ti ti-link me-1"></i> Connect</button></div>
            </form>
            <div class="form-hint mt-2">The password goes to PetKit; kibbl. keeps only the encrypted login PetKit needs to stay signed in.</div>
            <div id="petkit-connect-result" class="mt-2">${s?.error ? errorAlert(escapeHtml(s.error)) : ''}</div>
        </div>`;
    } else {
        const options = (selected?: string) =>
            '<option value="">No camera</option>' +
            cameras.map((c) => `<option value="${c._id}" ${c._id === selected ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
        const rows = s.feeders
            .map(
                (f) => `<tr>
                    <td><div class="fw-bold">${escapeHtml(f.name)}</div><div class="text-secondary small">${f.type === 'd4' ? 'Fresh Element Solo' : escapeHtml(f.type)}${f.firmware ? ` · firmware ${escapeHtml(f.firmware)}` : ''}</div></td>
                    <td><span class="badge ${f.online ? 'bg-green-lt' : 'bg-secondary-lt'}">${f.online ? 'online' : 'offline'}</span></td>
                    <td style="min-width:170px"><select class="form-select form-select-sm" data-petkit-camera="${f.id}">${options(f.cameraId)}</select></td>
                </tr>`,
            )
            .join('');
        body = `${
            rows
                ? `<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>Feeder</th><th>State</th><th>Watched by</th></tr></thead><tbody>${rows}</tbody></table></div>`
                : '<div class="card-body text-secondary">No feeder in this PetKit account. Share the feeder with it in PetKit\'s app; it shows up here within a few minutes.</div>'
        }
            <div class="card-body d-flex flex-wrap align-items-center gap-2 text-secondary small">
                <span class="flex-fill">${escapeHtml(s.account ?? '')}${s.lastPoll ? ` · read ${timeAgo(s.lastPoll)}` : ''}</span>
                <button class="btn btn-sm btn-ghost-danger" data-petkit-disconnect>Disconnect</button>
            </div>
            ${s.error ? `<div class="card-body pt-0">${errorAlert(escapeHtml(s.error))}</div>` : ''}
            <div class="card-body pt-0 text-secondary small">The camera that watches a feeder shows it on its page, and a cat it sees is at the feeder. To give it the picture of another camera, use <i>Same view as</i> on its page.</div>`;
    }
    return `<div class="card mb-4">
        <div class="card-header"><h3 class="card-title"><i class="ti ti-bowl me-1"></i> Pet feeder · PetKit</h3></div>
        ${body}
    </div>`;
}

/* ----------------------------------------------------------------------- */

async function post(url: string, body: unknown, method = 'POST') {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined);
    if (!res) return { ok: false, error: 'The server did not answer.' };
    if (!res.ok) return { ok: false, error: (await res.text()) || 'PetKit did not answer.' };
    const data = await res.json().catch(() => undefined);
    if (data && 'feeders' in data) status = data as PetkitStatus;
    return { ok: true };
}

/* The clicks of the cards and the panel; bound once on a container, redraw puts them in again. */
export function bindPetkit(root: HTMLElement, redraw: () => void) {
    const show = (feederId: string | undefined, error: string) => {
        const out = root.querySelector(`[data-petkit-result="${feederId}"]`) ?? document.getElementById('petkit-connect-result');
        if (out) out.innerHTML = errorAlert(escapeHtml(error));
    };
    const act = async (key: string, feederId: string | undefined, url: string, body: unknown, method?: string) => {
        busy.add(key);
        redraw();
        const res = await post(url, body, method);
        busy.delete(key);
        redraw();
        if (!res.ok) show(feederId, res.error!);
    };

    root.addEventListener('click', async (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>(
            '[data-petkit-feed],[data-petkit-cancel],[data-petkit-skip],[data-petkit-restore],[data-petkit-desiccant],[data-petkit-disconnect]',
        );
        if (!el) return;
        e.preventDefault();
        const d = el.dataset;
        if (d.petkitFeed) {
            const n = portionsChosen.get(Number(d.petkitFeed)) ?? 1;
            await act(`${d.petkitFeed}|feed`, d.petkitFeed, `/api/petkit/feeders/${d.petkitFeed}/feed`, { portions: n });
        } else if (d.petkitCancel) {
            await act(`${d.petkitCancel}|cancel`, d.petkitCancel, `/api/petkit/feeders/${d.petkitCancel}/cancel`, {});
        } else if (d.petkitSkip) {
            await act(`${d.feeder}|${d.petkitSkip}`, d.feeder, `/api/petkit/feeders/${d.feeder}/meals/${encodeURIComponent(d.petkitSkip)}`, { skip: true });
        } else if (d.petkitRestore) {
            await act(`${d.feeder}|${d.petkitRestore}`, d.feeder, `/api/petkit/feeders/${d.feeder}/meals/${encodeURIComponent(d.petkitRestore)}`, {
                skip: false,
            });
        } else if (d.petkitDesiccant) {
            if (!confirm('Was the desiccant replaced? Its days start again.')) return;
            await act(`${d.petkitDesiccant}|desiccant`, d.petkitDesiccant, `/api/petkit/feeders/${d.petkitDesiccant}/desiccant`, {});
        } else if (el.hasAttribute('data-petkit-disconnect')) {
            if (!confirm('Disconnect PetKit? The feeder keeps feeding on its plan.')) return;
            await fetch('/api/petkit', { method: 'DELETE' }).catch(() => undefined);
            await loadPetkit();
            redraw();
        }
    });

    root.addEventListener('change', async (e) => {
        const el = e.target as HTMLInputElement;
        const d = el.dataset;
        if (d.petkitPortions) {
            portionsChosen.set(Number(d.petkitPortions), Number(el.value));
        } else if (d.petkitPlan) {
            await act(`${d.petkitPlan}|plan`, d.petkitPlan, `/api/petkit/feeders/${d.petkitPlan}/plan`, { paused: !el.checked });
        } else if (d.petkitCamera) {
            await act(`${d.petkitCamera}|camera`, d.petkitCamera, `/api/petkit/feeders/${d.petkitCamera}/camera`, { cameraId: el.value || null }, 'PUT');
        }
    });

    root.addEventListener('submit', async (e) => {
        if ((e.target as HTMLElement).id !== 'petkit-connect') return;
        e.preventDefault();
        const button = (e.target as HTMLElement).querySelector('button');
        button?.classList.add('btn-loading');
        const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
        const res = await post('/api/petkit/connect', { email: value('petkit-email'), password: value('petkit-password'), region: value('petkit-region') });
        button?.classList.remove('btn-loading');
        if (!res.ok) {
            show(undefined, res.error!);
            return;
        }
        redraw();
    });
}
