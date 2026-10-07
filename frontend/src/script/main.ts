import '@tabler/core/dist/css/tabler.min.css';
import '@tabler/core/dist/js/tabler.min.js';
import '@tabler/icons-webfont/tabler-icons.min.css';
import '@fontsource/bungee/400.css';
import '@fontsource/press-start-2p/400.css';
import '@fontsource-variable/rubik';
import '../style.css';
import '../theme.css';
import { version } from '../../../shared/version';
import './orb';
import { isDarkMode, setTheme } from './utils';

const bc = new BroadcastChannel('kibbl');

bc.addEventListener('message', (event) => {
    if (event.data === 'logout') {
        window.location.href = '/login';
    }
});

async function checkLoggedIn() {
    // the pages before a login: log in, sign up, forgotten and new password, errors
    if (document.querySelector('#loginForm, form[data-form], #errorPage')) {
        return;
    }
    const response = await fetch('/api/loggedIn');
    if (response.status === 401) {
        window.location.href = '/login';
        return;
    }
    if (response.ok) {
        const user = await response.json();
        const greet = document.getElementById('greet-name');
        if (greet) greet.textContent = `(${user.name})`;
    }
}

function highlightNav() {
    const path = window.location.pathname;
    for (const item of document.querySelectorAll<HTMLElement>('[data-nav-href]')) {
        const href = item.dataset.navHref!;
        // a device page belongs to the rooms, where its room is
        const active =
            href === '/'
                ? path === '/'
                : href === '/rooms'
                  ? path.startsWith('/rooms') || path.startsWith('/air') || path.startsWith('/camera/')
                  : path.startsWith(href);
        item.classList.toggle('active', active);
    }
}

/* A menu is at most as tall as the larger room, below or above its button, and
 * scrolls the rest; set before it opens, so the placement can flip it to that side.
 * In a short window (a phone held sideways) its last items stay reachable. */
document.addEventListener('show.bs.dropdown', (e) => {
    const toggle = e.target as HTMLElement;
    const menu = toggle.parentElement?.querySelector<HTMLElement>('.dropdown-menu');
    if (menu) {
        const r = toggle.getBoundingClientRect();
        const room = Math.max(window.innerHeight - r.bottom, r.top) - 12;
        menu.style.maxHeight = `${Math.max(120, room)}px`;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    checkLoggedIn();
    highlightNav();

    const year = document.getElementById('year');
    if (year) year.textContent = String(new Date().getFullYear());
    const versionTxt = document.getElementById('versionTxt');
    if (versionTxt) versionTxt.textContent = version;

    document.getElementById('theme-toggle')?.addEventListener('click', (e) => {
        e.preventDefault();
        setTheme(isDarkMode() ? 'light' : 'dark');
    });

    document.getElementById('logout-btn')?.addEventListener('click', async (e) => {
        e.preventDefault();
        await fetch('/api/logout', { method: 'POST' });
        bc.postMessage('logout');
        window.location.href = '/login';
    });
});
