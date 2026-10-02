import './main';
import { version } from '../../../shared/version';
import { byId, errorAlert, isDarkMode, setTheme, successAlert } from './utils';

function render() {
    byId('container').innerHTML = `
        <div class="row row-cards">
            <div class="col-lg-6">
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Change password</h3></div>
                    <div class="card-body">
                        <form id="password-form" autocomplete="on">
                            <input type="text" autocomplete="username" class="d-none" />
                            <div class="mb-3">
                                <label class="form-label" for="pw-current">Current password</label>
                                <input type="password" class="form-control" id="pw-current" autocomplete="current-password" required />
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="pw-next">New password</label>
                                <input type="password" class="form-control" id="pw-next" autocomplete="new-password" minlength="10" required />
                                <div class="form-hint">At least 10 characters. Every other browser is logged out.</div>
                            </div>
                            <div class="mb-3">
                                <label class="form-label" for="pw-repeat">Repeat new password</label>
                                <input type="password" class="form-control" id="pw-repeat" autocomplete="new-password" required />
                            </div>
                            <div id="pw-result"></div>
                            <button type="submit" class="btn btn-primary"><i class="ti ti-lock me-1"></i> Change password</button>
                        </form>
                    </div>
                </div>
            </div>
            <div class="col-lg-6">
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Appearance</h3></div>
                    <div class="card-body">
                        <label class="form-check form-switch">
                            <input class="form-check-input" type="checkbox" id="dark-mode" ${isDarkMode() ? 'checked' : ''} />
                            <span class="form-check-label">Dark mode</span>
                        </label>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Privacy</h3></div>
                    <div class="card-body text-secondary">
                        <p>The cameras stream only while someone watches, and at 2 frames a second while motion detection is on. Nothing is sent anywhere but this server.</p>
                        <p class="mb-0">Motion snapshots are deleted automatically after the retention period of the server (14 days unless set otherwise).</p>
                    </div>
                    <div class="card-footer text-secondary small">Home Monitor ${version}</div>
                </div>
            </div>
        </div>`;

    byId('dark-mode').addEventListener('change', (e) => setTheme((e.target as HTMLInputElement).checked ? 'dark' : 'light'));

    byId('password-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const current = byId<HTMLInputElement>('pw-current').value;
        const next = byId<HTMLInputElement>('pw-next').value;
        const out = byId('pw-result');
        if (next !== byId<HTMLInputElement>('pw-repeat').value) {
            out.innerHTML = errorAlert('The new passwords differ.');
            return;
        }
        const response = await fetch('/api/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current, next }),
        });
        out.innerHTML = response.ok ? successAlert('Password changed.') : errorAlert(await response.text());
        if (response.ok) (e.target as HTMLFormElement).reset();
    });
}

document.addEventListener('DOMContentLoaded', render);
