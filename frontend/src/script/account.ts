import './main';
import { byId, errorAlert, successAlert } from './utils';

/* The pages around the login: sign-up, forgotten password, and the new password from
 * the link of the e-mail. */

const value = (id: string) => document.getElementById(id) as HTMLInputElement | null;

// the token of the reset link, read once: then it leaves the address bar and the history
const resetToken = new URLSearchParams(location.search).get('token') ?? '';
if (resetToken) history.replaceState(null, '', location.pathname);

async function post(url: string, body: Record<string, unknown>) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// what each form checks and sends; an error message, or the answer of the server
const forms: Record<string, () => Promise<string | Response>> = {
    async signup() {
        const name = value('name')!.value.trim();
        const email = value('email')!.value.trim();
        const password = value('password')!.value;
        if (!name || !email) return 'Enter your name and e-mail.';
        if (password.length < 10) return 'The password needs at least 10 characters.';
        if (password !== value('password2')!.value) return 'The passwords differ.';
        return post('/api/signup', { name, email, password });
    },
    async forgot() {
        const email = value('email')!.value.trim();
        if (!email) return 'Enter your e-mail.';
        return post('/api/password/forgot', { email });
    },
    async reset() {
        const password = value('password')!.value;
        if (!resetToken) return 'This page needs the link from the e-mail.';
        if (password.length < 10) return 'The password needs at least 10 characters.';
        if (password !== value('password2')!.value) return 'The passwords differ.';
        return post('/api/password/reset', { token: resetToken, password });
    },
};

document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector<HTMLFormElement>('form[data-form]')!;
    const kind = form.dataset.form!;
    const button = byId<HTMLButtonElement>('submitBtn');
    const alert = byId('alertContainer');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        button.disabled = true;
        button.classList.add('btn-loading');
        alert.innerHTML = '';
        try {
            const result = await forms[kind]();
            if (typeof result === 'string') {
                alert.innerHTML = errorAlert(result);
            } else if (!result.ok) {
                alert.innerHTML = errorAlert(await result.text());
            } else if (kind === 'forgot') {
                alert.innerHTML = successAlert('If there is an account with this e-mail, the link is on its way. Look in the spam folder too.');
                form.reset();
            } else {
                location.href = '/'; // signed up, or the new password set: logged in
                return;
            }
        } catch {
            alert.innerHTML = errorAlert('The server cannot be reached.');
        }
        button.disabled = false;
        button.classList.remove('btn-loading');
    });
});
