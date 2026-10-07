import { errorAlert, escapeHtml, timeAgo } from './utils';

/*
 * The guides of the health page. Connecting is one button for everybody; what Google
 * shows on the way depends on its app being in testing mode, and setting that app up
 * is the admin's part, once per server.
 */

export interface AccessRequest {
    userID?: string;
    name?: string;
    email?: string;
    googleEmail: string;
    status: 'waiting' | 'added';
    requestedAt: number;
    addedAt: number | null;
}

export interface HealthSetup {
    configured: boolean;
    testing: boolean;
    admin: boolean;
    redirectUri?: string;
    scopes?: string[];
    request: AccessRequest | null; // the person's own request to be added as a tester
    requests?: AccessRequest[]; // the admin's list of everybody's
    testUsersUrl?: string;
}

export async function loadSetup(): Promise<HealthSetup | undefined> {
    try {
        const response = await fetch('/api/health/setup');
        return response.ok ? ((await response.json()) as HealthSetup) : undefined;
    } catch {
        return undefined;
    }
}

const steps = (items: string[], start = 1) => `<ol class="mb-0 ps-3" start="${start}">${items.map((i) => `<li class="mb-2">${i}</li>`).join('')}</ol>`;

// for the person about to press Connect
export function connectGuide(setup: HealthSetup | undefined) {
    const testing = setup?.testing ?? true;
    return `<details class="text-start mx-auto mt-4" style="max-width:560px">
        <summary class="fw-bold">How connecting works</summary>
        <div class="text-secondary mt-3">
            ${steps([
                'You need the Google account your fitness tracker syncs to (Fitbit and Pixel Watch data live in your Google account).',
                ...(testing
                    ? [
                          '<strong>Once, before your first connect:</strong> the person who runs this kibbl. server adds your Google e-mail as a tester of its Google app. Without that, Google answers <em>Access blocked</em> (error 403: access_denied).',
                      ]
                    : []),
                'Press <strong>Connect Google Health</strong> and choose that Google account.',
                ...(testing ? ["Google warns <em>Google hasn't verified this app</em>: select <strong>Continue</strong>. It is this server's own app."] : []),
                'Tick <strong>all</strong> the permissions and select <strong>Continue</strong>. You come back here and the first sync starts: the whole history takes a few minutes.',
                ...(testing
                    ? [
                          'Google ends the access of an app in testing mode after <strong>7 days</strong>. This page shows when, and a <strong>Connect again</strong> button: one click, the history stays.',
                      ]
                    : []),
            ])}
        </div>
    </details>`;
}

// for the admin: the Google app of this server, in the Google Cloud console
export function adminGuide(setup: HealthSetup) {
    const redirect = setup.redirectUri ? `<code>${escapeHtml(setup.redirectUri)}</code>` : "this server's <code>/api/health/google/callback</code>";
    const scopes = (setup.scopes ?? []).map((s) => `<code class="d-inline-block">${escapeHtml(s)}</code>`).join(' ');
    return `<details class="text-start mx-auto mt-4" style="max-width:640px" ${setup.configured ? '' : 'open'}>
        <summary class="fw-bold">Server setup: the Google app (admin only, once)</summary>
        <div class="text-secondary mt-3">
            ${steps([
                'Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project, e.g. <em>kibbl</em>.',
                '<strong>APIs &amp; Services → Library</strong>: search <em>Google Health API</em> and enable it.',
                '<strong>Google Auth Platform → Branding</strong>: app name <em>kibbl.</em> and your e-mail as support and contact address.',
                '<strong>Audience</strong>: user type <em>External</em>, publishing status <em>Testing</em>. Under <strong>Test users</strong> add the Google e-mail of everybody who connects (up to 100), yourself included.',
                `<strong>Data access → Add or remove scopes</strong>: add these, all read only:<div class="small mt-1">${scopes}</div>`,
                `<strong>Clients → Create client</strong>: type <em>Web application</em>, authorised redirect URI ${redirect}. Google takes plain http only for localhost: use the https address the app is opened at (set GOOGLE_REDIRECT_URI on the server if it differs).`,
                "Copy the client ID and secret into the server's <code>.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> and restart kibbl. (<code>docker compose up -d app</code>).",
                'Every new person: add their Google e-mail under <strong>Audience → Test users</strong> before they connect.',
            ])}
            <p class="small mt-3 mb-0">Testing mode needs no review by Google, but limits the app to its testers and ends every access after 7 days. Publishing it ends both; Google then reviews the app, which needs a domain with a home page and a privacy policy.</p>
        </div>
    </details>`;
}

/* ----------------------------------------------------------------------- */

/* Access requests: the tester list of the Google app has no API, so a person asks here
 * with their Google e-mail and the admin adds it in the console. The boxes sit in slots
 * of the page (accessSlot, requestsSlot), filled again whenever the page redraws. */

let current: HealthSetup | undefined;
let editing = false;

export const accessSlot = () => '<div data-slot="access"></div>';
export const requestsSlot = () => '<div data-slot="requests"></div>';

function accessHtml(setup: HealthSetup) {
    const r = setup.request;
    if (!setup.configured || !setup.testing || setup.admin) return '';
    if (r && !editing) {
        return r.status === 'added'
            ? `<div class="alert alert-success text-start mx-auto mt-4" style="max-width:560px"><div class="d-flex"><i class="ti ti-circle-check me-2"></i><div>
                <strong>${escapeHtml(r.googleEmail)}</strong> is on the tester list since ${timeAgo(r.addedAt ?? r.requestedAt)}: connect now with that Google account.</div></div></div>`
            : `<div class="alert alert-info text-start mx-auto mt-4" style="max-width:560px"><div class="d-flex"><i class="ti ti-hourglass me-2"></i><div class="flex-fill">
                Access asked for <strong>${escapeHtml(r.googleEmail)}</strong> ${timeAgo(r.requestedAt)}. The admin adds it to the tester list; this page says so then.
                <div class="mt-2 d-flex gap-2"><button class="btn btn-sm" data-access="edit">Change address</button><button class="btn btn-sm" data-access="withdraw">Withdraw</button></div>
            </div></div></div>`;
    }
    return `<form class="text-start mx-auto mt-4" style="max-width:560px" data-access="request">
        <label class="form-label" for="access-email">Not on the tester list yet? Ask the admin to add your Google account:</label>
        <div class="d-flex gap-2">
            <input type="email" class="form-control" id="access-email" placeholder="you@gmail.com" value="${escapeHtml(r?.googleEmail ?? '')}" required />
            <button class="btn btn-primary text-nowrap" type="submit"><i class="ti ti-send me-1"></i> Request access</button>
        </div>
        <div class="form-hint">The Google account your tracker syncs to. Already added? Just connect above.</div>
        <div data-access-error></div>
    </form>`;
}

function requestsHtml(setup: HealthSetup) {
    const list = setup.admin ? (setup.requests ?? []) : [];
    if (!list.length) return '';
    const waiting = list.filter((r) => r.status === 'waiting').length;
    return `<div class="card mb-3"><div class="card-header">
            <h3 class="card-title"><i class="ti ti-user-plus me-2"></i>Health access requests${waiting ? ` <span class="badge bg-orange text-orange-fg ms-1">${waiting}</span>` : ''}</h3>
            <div class="card-actions"><a class="btn btn-sm" href="${escapeHtml(setup.testUsersUrl ?? 'https://console.cloud.google.com/auth/audience')}" target="_blank" rel="noopener"><i class="ti ti-external-link me-1"></i> Test users in Google Cloud</a></div>
        </div>
        <div class="card-body pt-2 pb-2">
            <p class="text-secondary small mb-2">Copy each address into <strong>Test users</strong> (Add users, Save), then mark it done: they are told to connect.</p>
            <div class="list-group list-group-flush">${list
                .map(
                    (r) => `<div class="list-group-item px-0 d-flex flex-wrap align-items-center gap-2">
                <div class="flex-fill" style="min-width:220px">
                    <div><strong class="font-monospace">${escapeHtml(r.googleEmail)}</strong>
                        <button class="btn btn-sm btn-ghost-secondary px-1" data-access="copy" data-value="${escapeHtml(r.googleEmail)}" title="Copy"><i class="ti ti-copy"></i></button></div>
                    <div class="text-secondary small">${escapeHtml(r.name ?? '')} · ${escapeHtml(r.email ?? '')} · asked ${timeAgo(r.requestedAt)}</div>
                </div>
                ${
                    r.status === 'waiting'
                        ? `<button class="btn btn-sm btn-primary" data-access="done" data-user="${escapeHtml(r.userID ?? '')}"><i class="ti ti-check me-1"></i> Done</button>`
                        : `<span class="text-success small"><i class="ti ti-circle-check"></i> added ${timeAgo(r.addedAt ?? r.requestedAt)}</span>`
                }
                <button class="btn btn-sm btn-ghost-danger" data-access="remove" data-user="${escapeHtml(r.userID ?? '')}" title="Remove">${r.status === 'waiting' ? 'Decline' : 'Clear'}</button>
            </div>`,
                )
                .join('')}</div>
        </div></div>`;
}

// a filled slot is marked, so the observer leaves it be (an empty box stays empty)
function fill(root: ParentNode) {
    if (!current) return;
    const html = { access: accessHtml, requests: requestsHtml };
    root.querySelectorAll<HTMLElement>('[data-slot]').forEach((el) => {
        el.innerHTML = html[el.dataset.slot as keyof typeof html]?.(current!) ?? '';
        el.dataset.filled = '1';
    });
}

async function act(method: string, url: string, body?: unknown) {
    const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as Partial<HealthSetup>;
}

/* Fills the slots now and after every redraw of the container, and handles their buttons
 * (one listener for the page: the slots come and go with the redraws). */
let watching = false;

export function watchAccess(container: HTMLElement, setup: HealthSetup | undefined) {
    current = setup;
    fill(container);
    if (watching) return;
    watching = true;
    new MutationObserver(() => {
        if (container.querySelector('[data-slot]:not([data-filled])')) fill(container);
    }).observe(container, { childList: true, subtree: true });

    const refresh = (update: Partial<HealthSetup>) => {
        current = { ...current!, ...update };
        fill(container);
    };

    container.addEventListener('submit', async (e) => {
        const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-access="request"]');
        if (!form) return;
        e.preventDefault();
        const googleEmail = form.querySelector<HTMLInputElement>('#access-email')!.value.trim();
        try {
            editing = false;
            refresh(await act('POST', '/api/health/access', { googleEmail }));
        } catch (err) {
            editing = true;
            form.querySelector('[data-access-error]')!.innerHTML = `<div class="mt-2">${errorAlert((err as Error).message)}</div>`;
        }
    });

    container.addEventListener('click', async (e) => {
        const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-access]');
        if (!button) return;
        const action = button.dataset.access;
        if (action === 'copy') {
            await navigator.clipboard?.writeText(button.dataset.value ?? '').catch(() => undefined);
            button.innerHTML = '<i class="ti ti-check"></i>';
            setTimeout(() => (button.innerHTML = '<i class="ti ti-copy"></i>'), 1200);
            return;
        }
        if (action === 'edit') {
            editing = true;
            fill(container);
            return;
        }
        button.disabled = true;
        try {
            if (action === 'withdraw') refresh(await act('DELETE', '/api/health/access'));
            if (action === 'done') refresh(await act('POST', `/api/health/access/${encodeURIComponent(button.dataset.user!)}/done`));
            if (action === 'remove' && confirm('Remove this request? They can ask again.')) {
                refresh(await act('DELETE', `/api/health/access/${encodeURIComponent(button.dataset.user!)}`));
            }
        } catch (err) {
            alert((err as Error).message || 'That did not work.');
        }
        button.disabled = false;
    });
}
