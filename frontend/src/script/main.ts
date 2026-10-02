import '@tabler/core/dist/css/tabler.min.css';
import '@tabler/core/dist/js/tabler.min.js';
import '@tabler/icons-webfont/tabler-icons.min.css';
import '@fontsource/bungee/400.css';
import '@fontsource/press-start-2p/400.css';
import '@fontsource-variable/rubik';
import '../style.css';
import '../theme.css';
import { version } from '../../../shared/version';
import { isDarkMode, setTheme } from './utils';

const bc = new BroadcastChannel('home-monitor');

bc.addEventListener('message', (event) => {
    if (event.data === 'logout') {
        window.location.href = '/login';
    }
});

async function checkLoggedIn() {
    if (document.getElementById('loginForm') || document.getElementById('errorPage')) {
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
        const active = href === '/' ? path === '/' || path.startsWith('/camera/') : path.startsWith(href);
        item.classList.toggle('active', active);
    }
}

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
