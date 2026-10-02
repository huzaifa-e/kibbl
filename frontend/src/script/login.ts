import './main';
import { byId, errorAlert } from './utils';

document.addEventListener('DOMContentLoaded', () => {
    const form = byId<HTMLFormElement>('loginForm');
    const button = byId<HTMLButtonElement>('loginBtn');
    const alertContainer = byId('alertContainer');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = byId<HTMLInputElement>('email').value.trim();
        const password = byId<HTMLInputElement>('password').value;
        if (!email || !password) {
            alertContainer.innerHTML = errorAlert('Enter your e-mail and password.');
            return;
        }

        button.disabled = true;
        button.classList.add('btn-loading');
        alertContainer.innerHTML = '';
        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            if (response.ok) {
                window.location.href = '/';
                return;
            }
            alertContainer.innerHTML = errorAlert(await response.text());
        } catch {
            alertContainer.innerHTML = errorAlert('The server cannot be reached.');
        }
        button.disabled = false;
        button.classList.remove('btn-loading');
    });
});
