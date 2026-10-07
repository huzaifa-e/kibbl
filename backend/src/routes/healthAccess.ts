import express from 'express';
import rateLimit from 'express-rate-limit';
import { checkAuthMiddleware } from '../core/auth';
import { HealthAccessRequest, User } from '../core/db';
import { logger } from '../core/logger';
import { appUrl, mailConfigured, sendMail } from '../core/mail';
import { adminID, isAdmin } from '../core/owners';
import { escapeHtml } from '../mcp/signin';

/*
 * The tester list of the Google app has no API: the admin adds every Google e-mail by
 * hand in the Cloud console. This is everything around that step: a person asks with
 * their Google e-mail, the admin sees the list (and gets a mail), adds the address in
 * the console and marks it done here, and the person is told to connect.
 */

const log = logger('health');

const isEmail = (v: string) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isUserID = (v: string) => /^[0-9a-f-]{36}$/.test(v);
const ADDED_SHOWN_MS = 14 * 24 * 3600_000; // the admin's list keeps done requests two weeks

// one request an hour per address is plenty; the limit is against mail floods to the admin
const requestLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

// the Test users page of the Google app (GOOGLE_PROJECT_ID picks the project, else the console asks)
export function testUsersUrl() {
    const project = process.env.GOOGLE_PROJECT_ID;
    return `https://console.cloud.google.com/auth/audience${project ? `?project=${encodeURIComponent(project)}` : ''}`;
}

/* What the health page shows about access: the person's own request, and for the admin
 * the requests of everybody. */
export async function accessInfo(userID: string, admin: boolean) {
    const own = await HealthAccessRequest.findById(userID).lean();
    const info: Record<string, unknown> = {
        request: own ? { googleEmail: own.googleEmail, status: own.status, requestedAt: own.requestedAt, addedAt: own.addedAt ?? null } : null,
    };
    if (admin) {
        const requests = await HealthAccessRequest.find({ $or: [{ status: 'waiting' }, { addedAt: { $gt: Date.now() - ADDED_SHOWN_MS } }] })
            .sort({ requestedAt: 1 })
            .lean();
        const users = new Map((await User.find({ _id: { $in: requests.map((r) => r._id) } }, { name: 1, email: 1 }).lean()).map((u) => [u._id, u]));
        info.requests = requests.map((r) => ({
            userID: r._id,
            name: users.get(r._id)?.name ?? '?',
            email: users.get(r._id)?.email ?? '?',
            googleEmail: r.googleEmail,
            status: r.status,
            requestedAt: r.requestedAt,
            addedAt: r.addedAt ?? null,
        }));
        info.testUsersUrl = testUsersUrl();
    }
    return info;
}

// a mail when the server can send one; the app shows the same in any case
async function notify(to: string | undefined, subject: string, lines: string[], link?: { url: string; label: string }) {
    if (!to || !mailConfigured()) return;
    const text = lines.join('\n\n') + (link ? `\n\n${link.label}: ${link.url}\n` : '\n');
    const html =
        lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
        (link
            ? `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:10px 18px;background:#d9622b;color:#fff8ec;border:3px solid #2a1a12;border-radius:10px;font-weight:700;text-decoration:none">${escapeHtml(link.label)}</a></p>`
            : '');
    try {
        await sendMail(to, subject, text, html);
    } catch (err) {
        log.warn('access mail not sent', { to }, err);
    }
}

export default function initHealthAccessRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;

    // asks for access with a Google e-mail; asking again replaces the address and waits again
    app.post('/api/health/access', auth, requestLimiter, async (req: RequestWithSessionInfo, res) => {
        const session = req.sessionInfo!;
        const googleEmail = typeof req.body?.googleEmail === 'string' ? req.body.googleEmail.trim().toLowerCase() : '';
        if (!isEmail(googleEmail)) return void res.status(400).send('That is no e-mail address.');
        if (await isAdmin(session.userID)) return void res.status(400).send('As the admin, add yourself in the Google Cloud console.');

        const previous = await HealthAccessRequest.findById(session.userID).lean();
        if (previous?.googleEmail === googleEmail) return void res.json(await accessInfo(session.userID, false));
        await HealthAccessRequest.updateOne(
            { _id: session.userID },
            { $set: { googleEmail, status: 'waiting', requestedAt: Date.now() }, $unset: { addedAt: 1 } },
            { upsert: true },
        );
        log.info('health access requested', { user: session.email, google: googleEmail });

        const admin = await User.findById(await adminID(), { email: 1 }).lean();
        await notify(
            admin?.email,
            `${session.name} asks for health access on kibbl.`,
            [
                `${session.name} (${session.email}) wants to connect their fitness tracker to kibbl.`,
                `Add ${googleEmail} as a test user of the Google app, then mark it done on the health page.`,
            ],
            appUrl() ? { url: `${appUrl()}/health`, label: 'Open the requests' } : undefined,
        );
        res.json(await accessInfo(session.userID, false));
    });

    app.delete('/api/health/access', auth, async (req: RequestWithSessionInfo, res) => {
        await HealthAccessRequest.deleteOne({ _id: req.sessionInfo!.userID });
        res.json(await accessInfo(req.sessionInfo!.userID, false));
    });

    // the admin added the address in the console: the person is told to connect
    app.post('/api/health/access/:userID/done', auth, async (req: RequestWithSessionInfo, res) => {
        const session = req.sessionInfo!;
        if (!(await isAdmin(session.userID))) return void res.sendStatus(403);
        const id = req.params.userID;
        const request = isUserID(id)
            ? await HealthAccessRequest.findOneAndUpdate({ _id: id }, { $set: { status: 'added', addedAt: Date.now() } }).lean()
            : null;
        if (!request) return void res.sendStatus(404);
        const user = await User.findById(id, { email: 1, name: 1 }).lean();
        log.info('health access added', { user: user?.email, google: request.googleEmail, by: session.email });
        await notify(
            user?.email,
            'You can connect your tracker to kibbl. now',
            [
                `Hello ${user?.name ?? ''},`,
                `${request.googleEmail} is now allowed to connect Google Health to kibbl. Open the health page and select Connect Google Health.`,
            ],
            appUrl() ? { url: `${appUrl()}/health`, label: 'Connect now' } : undefined,
        );
        res.json(await accessInfo(session.userID, true));
    });

    // the admin drops a request (a typo, someone unknown); the person can ask again
    app.delete('/api/health/access/:userID', auth, async (req: RequestWithSessionInfo, res) => {
        const session = req.sessionInfo!;
        if (!(await isAdmin(session.userID))) return void res.sendStatus(403);
        if (isUserID(req.params.userID)) await HealthAccessRequest.deleteOne({ _id: req.params.userID });
        res.json(await accessInfo(session.userID, true));
    });
}
