import { Device, User } from './db';
import { appUrl, mailConfigured, sendMail } from './mail';
import { logger } from './logger';

/*
 * Alerts for the owner of a device: a push message through ntfy (free, an app on the phone) when NTFY_URL names a topic,
 * e.g. https://ntfy.sh/<a long random topic> or a ntfy server of one's own, and an e-mail
 * (the SMTP account of core/mail.ts) only for those that ask for one: a window open for too
 * long and a fire. Urgent ones (fire) ring through do-not-disturb on the phone.
 */

const log = logger('notify');

export interface Alert {
    title: string;
    text: string;
    urgent?: boolean;
    email?: boolean; // also by e-mail, else only the push message
    path?: string; // the page of the app it is about
}

function escapeHtml(s: string) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

async function sendNtfy(alert: Alert) {
    const url = process.env.NTFY_URL;
    if (!url) return;
    const link = appUrl() && alert.path ? `${appUrl()}${alert.path}` : undefined;
    const headers: Record<string, string> = {
        // header values are latin-1 only: the title goes as RFC 2047
        Title: `=?UTF-8?B?${Buffer.from(alert.title).toString('base64')}?=`,
        Priority: alert.urgent ? '5' : '3',
        Tags: alert.urgent ? 'rotating_light' : 'window',
    };
    if (link) headers.Click = link;
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const res = await fetch(url, { method: 'POST', headers, body: alert.text, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
}

async function sendEmail(ownerID: string, alert: Alert) {
    if (!alert.email || !mailConfigured()) return;
    const user = await User.findById(ownerID, { email: 1 }).lean();
    if (!user) return;
    const link = appUrl() && alert.path ? `${appUrl()}${alert.path}` : undefined;
    const text = link ? `${alert.text}\n\n${link}` : alert.text;
    const html = `<p>${escapeHtml(alert.text)}</p>${link ? `<p><a href="${escapeHtml(link)}">Open kibbl.</a></p>` : ''}`;
    await sendMail(user.email, `${alert.urgent ? '⚠ ' : ''}${alert.title}`, text, html);
}

// to the owner of the device, on every channel that is set up; a failing one does not stop the others
export async function notifyOwner(deviceId: string, alert: Alert) {
    const doc = await Device.findById(deviceId, { ownerID: 1 }).lean();
    if (!doc?.ownerID) return;
    const results = await Promise.allSettled([sendEmail(doc.ownerID, alert), sendNtfy(alert)]);
    for (const r of results) {
        if (r.status === 'rejected') log.warn('alert not sent on one channel', { device: deviceId, title: alert.title }, r.reason);
    }
}
