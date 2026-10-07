import { escapeHtml } from './utils';

/*
 * The guides of the health page. Connecting is one button for everybody; what Google
 * shows on the way depends on its app being in testing mode, and setting that app up
 * is the admin's part, once per server.
 */

export interface HealthSetup {
    configured: boolean;
    testing: boolean;
    admin: boolean;
    redirectUri?: string;
    scopes?: string[];
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
