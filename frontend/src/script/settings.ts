import './main';
import { load as loadAssistant } from './assistant';
import type { HomeLocation } from '../../../shared/climate';
import { byId, errorAlert, escapeHtml, isDarkMode, setTheme, successAlert } from './utils';

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
                    <div class="card-header"><h3 class="card-title"><i class="ti ti-map-pin me-1"></i> Home location</h3></div>
                    <div class="card-body">
                        <div class="text-secondary small mb-2">For the weather outside: a kibbl. air compares it with the room (mould on outer walls, whether airing helps). Rounded to about a kilometre, the address is not kept.</div>
                        <div class="mb-2" id="home-current"></div>
                        <div class="input-group mb-2">
                            <input type="search" class="form-control" id="home-search" placeholder="Search a town or city" autocomplete="off" />
                            <button class="btn" id="home-locate" type="button" title="Use the location of this device"><i class="ti ti-current-location"></i></button>
                        </div>
                        <div class="list-group" id="home-results"></div>
                        <div id="home-result"></div>
                    </div>
                </div>
                <div class="card mb-3">
                    <div class="card-header"><h3 class="card-title">Appearance</h3></div>
                    <div class="card-body">
                        <label class="form-check form-switch">
                            <input class="form-check-input" type="checkbox" id="dark-mode" ${isDarkMode() ? 'checked' : ''} />
                            <span class="form-check-label">Night mode</span>
                        </label>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header"><h3 class="card-title">Privacy</h3></div>
                    <div class="card-body text-secondary">
                        <p>The cameras stream only while someone watches, and at 2 frames a second while motion detection is on. Nothing is sent anywhere but this server.</p>
                        <p class="mb-0">Motion snapshots are deleted automatically after the retention period of the server (14 days unless set otherwise).</p>
                    </div>
                </div>
            </div>
            <div class="col-12">
                <div class="card" id="assistant-card"></div>
            </div>
        </div>`;

    void loadAssistant(byId('assistant-card'));
    void bindHome();

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

/* ----------------------------------------------------------------------- */

async function showHome() {
    const res = await fetch('/api/home');
    const home = res.ok ? ((await res.json()) as HomeLocation | null) : null;
    byId('home-current').innerHTML = home
        ? `<div class="d-flex align-items-center gap-2"><i class="ti ti-home"></i><span class="flex-fill">${escapeHtml(home.name)}</span>
            ${home.name === 'set on the server' ? '' : '<button class="btn btn-sm btn-ghost-danger" id="home-clear">Remove</button>'}</div>`
        : '<div class="text-secondary">Not set yet.</div>';
    byId('home-current')
        .querySelector('#home-clear')
        ?.addEventListener('click', () => void saveHome(null));
}

async function saveHome(home: HomeLocation | null) {
    const res = await fetch('/api/home', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(home ?? { clear: true }),
    });
    byId('home-result').innerHTML = res.ok ? successAlert(home ? 'Home location saved.' : 'Home location removed.') : errorAlert(await res.text());
    byId('home-results').innerHTML = '';
    byId<HTMLInputElement>('home-search').value = '';
    await showHome();
}

async function bindHome() {
    await showHome();
    let places: HomeLocation[] = [];
    let timer: number | undefined;
    const results = byId('home-results');

    byId('home-search').addEventListener('input', (e) => {
        const q = (e.target as HTMLInputElement).value.trim();
        window.clearTimeout(timer);
        if (q.length < 2) {
            results.innerHTML = '';
            return;
        }
        // waits for a pause in typing
        timer = window.setTimeout(async () => {
            const res = await fetch(`/api/places?q=${encodeURIComponent(q)}`);
            places = res.ok ? ((await res.json()) as HomeLocation[]) : [];
            results.innerHTML = places.length
                ? places.map((p, i) => `<a href="#" class="list-group-item list-group-item-action" data-place="${i}">${escapeHtml(p.name)}</a>`).join('')
                : `<div class="list-group-item text-secondary">${res.ok ? 'No place of that name.' : 'The search does not answer.'}</div>`;
        }, 300);
    });

    results.addEventListener('click', (e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-place]');
        if (!el) return;
        e.preventDefault();
        void saveHome(places[Number(el.dataset.place)]);
    });

    byId('home-locate').addEventListener('click', () => {
        if (!navigator.geolocation) {
            byId('home-result').innerHTML = errorAlert('This browser cannot tell its location.');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) =>
                void saveHome({
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    name: `My location (${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)})`,
                }),
            (err) => (byId('home-result').innerHTML = errorAlert(`No location: ${escapeHtml(err.message)}. Search the town instead.`)),
            { maximumAge: 600_000, timeout: 15_000 },
        );
    });
}

document.addEventListener('DOMContentLoaded', render);
