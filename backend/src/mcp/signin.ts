/*
 * The page a connector sends the user to: sign in with the kibbl. account and allow
 * read access. It stands alone (styles and logo inline): the public address serves only
 * the MCP and OAuth paths, not the app's assets.
 */

const PARAMS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'];

const LOGO =
    'data:image/svg+xml,' +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><pattern id="d" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="2.5" cy="2.5" r="1.1" fill="#a63d1f" opacity=".55"/></pattern></defs><rect x="2" y="2" width="60" height="60" rx="14" fill="#d9622b" stroke="#2a1a12" stroke-width="4"/><rect x="2" y="2" width="60" height="60" rx="14" fill="url(#d)"/><path d="M14 31 32 16l18 15v17a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3z" fill="#f3e6cf" stroke="#2a1a12" stroke-width="3.5" stroke-linejoin="round"/><circle cx="32" cy="37" r="8" fill="#2a1a12"/><circle cx="32" cy="37" r="4" fill="#e0a526"/><circle cx="30.5" cy="35.5" r="1.3" fill="#f3e6cf"/></svg>',
    );

export const escapeHtml = (text: string) =>
    text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function hostOf(uri: string) {
    try {
        return new URL(uri).host;
    } catch {
        return uri;
    }
}

export function signInPage(o: { client: string; redirectUri: string; fields: Record<string, unknown>; error?: string; email?: string }) {
    const hidden = PARAMS.filter((k) => typeof o.fields[k] === 'string')
        .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(o.fields[k] as string)}">`)
        .join('');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect · kibbl.</title>
<link rel="icon" href="${LOGO}">
<style>
:root { --ink: #2a1a12; --paper: #f3e6cf; --surface: #fbf4e6; --text: #2a1a12; --muted: #7a5c47; --accent: #d9622b; --accent-text: #fff8ec; --dot: rgba(166, 61, 31, .16); --error: #b8381e; color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #0f0805; --paper: #2a1a12; --surface: #3a2619; --text: #f3e6cf; --muted: #c9a98c; --dot: rgba(224, 165, 38, .10); --error: #f08a6c; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text);
  background: var(--paper) radial-gradient(var(--dot) 1.2px, transparent 1.3px) 0 0 / 10px 10px; }
main { width: 100%; max-width: 400px; }
.brand { text-align: center; margin-bottom: 20px; }
.brand img { width: 56px; height: 56px; }
.brand div { font-weight: 800; font-size: 28px; letter-spacing: .02em; }
.card { background: var(--surface); border: 3px solid var(--ink); border-radius: 14px; box-shadow: 5px 5px 0 var(--ink); padding: 24px; }
h1 { font-size: 20px; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
p strong { color: var(--text); }
ul { margin: 0 0 20px; padding-left: 20px; color: var(--muted); }
label { display: block; font-weight: 600; margin-bottom: 4px; }
input[type=email], input[type=password] { width: 100%; padding: 10px 12px; margin-bottom: 14px; font: inherit; color: var(--text);
  background: var(--paper); border: 2px solid var(--ink); border-radius: 10px; }
input:focus { outline: 3px solid var(--accent); outline-offset: 1px; }
.error { color: var(--error); font-weight: 600; margin: 0 0 14px; }
.buttons { display: flex; flex-direction: row-reverse; gap: 12px; margin-top: 6px; }
button { flex: 1; padding: 12px; font: inherit; font-weight: 700; border: 3px solid var(--ink); border-radius: 10px; cursor: pointer; box-shadow: 3px 3px 0 var(--ink); }
button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--ink); }
.allow { background: var(--accent); color: var(--accent-text); }
.deny { background: var(--surface); color: var(--text); }
.note { font-size: 13px; margin: 16px 0 0; }
</style>
</head>
<body>
<main>
  <div class="brand"><img src="${LOGO}" alt=""><div>kibbl.</div></div>
  <div class="card">
    <h1>Connect ${escapeHtml(o.client)}</h1>
    <p><strong>${escapeHtml(o.client)}</strong> asks to read your kibbl. data:</p>
    <ul><li>cameras, live pictures and motion</li><li>meters and consumption</li><li>health history</li></ul>
    <form method="post" action="/authorize" autocomplete="on">
      ${hidden}
      <label for="email">E-mail</label>
      <input type="email" id="email" name="email" value="${escapeHtml(o.email ?? '')}" autocomplete="username" required>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      ${o.error ? `<div class="error" role="alert">${escapeHtml(o.error)}</div>` : ''}
      <!-- Allow first: Enter submits with the first button; row-reverse puts it on the right -->
      <div class="buttons">
        <button class="allow" type="submit" name="decision" value="allow">Allow</button>
        <button class="deny" type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
      </div>
    </form>
    <p class="note">Read only: nothing can be changed. You return to ${escapeHtml(hostOf(o.redirectUri))}. Revoke it any time with mcp-token.js.</p>
  </div>
</main>
</body>
</html>`;
}
