import { errorAlert, escapeHtml, timeAgo } from './utils';

/*
 * Settings: connecting an AI assistant to the MCP endpoint. A hosted assistant (web,
 * desktop, phone) adds the connector address and signs in on kibbl.'s own page; tools
 * that take an address and a header get a token. Each user sees only their own.
 */

interface Entry {
    id: string;
    name: string;
    scope?: string | null; // light: the light controls of a TV only
    createdAt: number;
    lastUsedAt: number | null;
}

interface McpInfo {
    connectorUrl: string | null;
    tokens: Entry[];
    connectors: Entry[];
}

// navigator.clipboard needs https; on the home network over plain http the field is selected instead
async function copy(input: HTMLInputElement, button: HTMLButtonElement) {
    input.select();
    try {
        await navigator.clipboard.writeText(input.value);
    } catch {
        document.execCommand('copy');
    }
    const label = button.innerHTML;
    button.innerHTML = '<i class="ti ti-check me-1"></i> Copied';
    setTimeout(() => (button.innerHTML = label), 1500);
}

function copyField(id: string, value: string) {
    return `<div class="input-group">
        <input type="text" class="form-control font-monospace" id="${id}" value="${escapeHtml(value)}" readonly />
        <button class="btn" type="button" data-copy="${id}"><i class="ti ti-copy me-1"></i> Copy</button>
    </div>`;
}

const used = (e: Entry) => (e.lastUsedAt ? `used ${timeAgo(e.lastUsedAt)}` : 'not used yet');

function list(entries: Entry[], kind: 'connector' | 'token', empty: string) {
    if (!entries.length) return `<div class="text-secondary small">${empty}</div>`;
    return `<div class="list-group list-group-flush">${entries
        .map(
            (e) => `<div class="list-group-item px-0 d-flex align-items-center gap-2">
                <i class="ti ti-${kind === 'connector' ? 'plug-connected' : 'key'} text-secondary"></i>
                <div class="flex-fill text-truncate">
                    <div class="text-truncate">${escapeHtml(e.name)}${e.scope === 'light' ? ' <span class="badge bg-secondary-lt ms-1">light only</span>' : ''}</div>
                    <div class="text-secondary small">${kind === 'connector' ? 'signed in' : 'created'} ${timeAgo(e.createdAt)} · ${used(e)}</div>
                </div>
                <button class="btn btn-sm btn-outline-danger" data-revoke="${kind}" data-id="${escapeHtml(e.id)}" data-name="${escapeHtml(e.name)}">
                    ${kind === 'connector' ? 'Disconnect' : 'Revoke'}
                </button>
            </div>`,
        )
        .join('')}</div>`;
}

function render(el: HTMLElement, info: McpInfo, newToken?: { name: string; token: string }) {
    const tokenUrl = info.connectorUrl ?? `${location.origin}/mcp`;
    el.innerHTML = `
        <div class="card-header"><h3 class="card-title"><i class="ti ti-sparkles me-2"></i>AI assistant</h3></div>
        <div class="card-body">
            <p class="text-secondary">
                Let an AI assistant answer questions about your home: cameras and motion, meters, and your health history.
                It can only read, never change anything. What it reads is sent to the assistant's provider with your conversation.
            </p>

            <h4 class="mb-2">Connect an assistant</h4>
            ${
                info.connectorUrl
                    ? `<ol class="text-secondary ps-3 mb-3">
                        <li>In your assistant's settings, open <strong>Connectors</strong> and add a <strong>custom connector</strong>.</li>
                        <li>Name it <strong>kibbl.</strong> and paste this address:</li>
                    </ol>
                    <div class="mb-3">${copyField('mcp-connector-url', info.connectorUrl)}</div>
                    <ol class="text-secondary ps-3 mb-4" start="3">
                        <li>Select <strong>Connect</strong>. A kibbl. page opens: sign in with your kibbl. e-mail and password and allow it.</li>
                        <li>Switch kibbl. on in a chat and ask, for example, <em>"How did I sleep this week?"</em></li>
                    </ol>
                    <p class="text-secondary small mb-4">Added once, it works on the web, in the desktop app and on your phone, from any network.</p>`
                    : `<div class="alert alert-info mb-4">This server has no public address for assistants yet (MCP_PUBLIC_URL, see docs/deployment.md). Tokens below still work on the home network.</div>`
            }

            <h4 class="mb-2">Connected assistants</h4>
            <div class="mb-4">${list(info.connectors, 'connector', 'None yet. An assistant shows up here once you have allowed it.')}</div>

            <h4 class="mb-1">Access tokens</h4>
            <p class="text-secondary small mb-2">
                For tools that take an address and a token instead of a sign-in: give them
                <code>${escapeHtml(tokenUrl)}</code> and the header <code>Authorization: Bearer &lt;token&gt;</code>.
            </p>
            ${
                newToken
                    ? `<div class="alert alert-warning">
                        <div class="mb-2"><strong>${escapeHtml(newToken.name)}</strong>: copy the token now, it is not shown again.</div>
                        ${copyField('mcp-new-token', newToken.token)}
                    </div>`
                    : ''
            }
            <div class="mb-3">${list(info.tokens, 'token', 'No tokens.')}</div>
            <form id="mcp-token-form" class="d-flex gap-2">
                <input type="text" class="form-control" id="mcp-token-name" placeholder="Name, e.g. laptop" maxlength="40" required />
                <button type="submit" class="btn btn-primary text-nowrap"><i class="ti ti-plus me-1"></i> New token</button>
            </form>
            <div id="mcp-result" class="mt-3"></div>
        </div>`;

    el.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
        b.addEventListener('click', () => copy(el.querySelector<HTMLInputElement>(`#${b.dataset.copy}`)!, b)),
    );

    el.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) =>
        b.addEventListener('click', async () => {
            const connector = b.dataset.revoke === 'connector';
            const question = connector
                ? `Disconnect ${b.dataset.name}? It has to sign in again to read your data.`
                : `Revoke the token ${b.dataset.name}? Tools using it stop working.`;
            if (!confirm(question)) return;
            b.disabled = true;
            const response = await fetch(`/api/mcp/${connector ? 'connectors' : 'tokens'}/${encodeURIComponent(b.dataset.id!)}`, { method: 'DELETE' });
            if (!response.ok) {
                el.querySelector('#mcp-result')!.innerHTML = errorAlert('That did not work. Reload the page and try again.');
                b.disabled = false;
                return;
            }
            await load(el);
        }),
    );

    el.querySelector('#mcp-token-form')!.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = el.querySelector<HTMLInputElement>('#mcp-token-name')!.value.trim();
        const response = await fetch('/api/mcp/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
        if (!response.ok) {
            el.querySelector('#mcp-result')!.innerHTML = errorAlert(await response.text());
            return;
        }
        const { token } = (await response.json()) as { token: string };
        await load(el, { name, token });
    });
}

export async function load(el: HTMLElement, newToken?: { name: string; token: string }) {
    const response = await fetch('/api/mcp');
    if (!response.ok) {
        el.innerHTML = `<div class="card-body">${errorAlert('The assistant settings could not be loaded.')}</div>`;
        return;
    }
    render(el, (await response.json()) as McpInfo, newToken);
}
