import express from 'express';
import { checkAuthMiddleware } from '../core/auth';
import { HealthLink } from '../core/db';
import { logger } from '../core/logger';
import { HealthError, SCOPES, configured, exchangeCode, newAuthorization } from '../health/google';
import { INTRADAY_TYPES, forget, intraday, latestHeartRate, summary, syncNow, syncStatus, trackers } from '../health/service';
import { saveTokens } from '../health/tokens';

const log = logger('health');

const AUTH_PENDING_MS = 10 * 60_000;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// a Google consent in progress: state -> who started it, with the PKCE verifier
const pending = new Map<string, { userID: string; verifier: string; redirectUri: string; expires: number }>();

/* Where Google sends the user back: GOOGLE_REDIRECT_URI, else this server as the browser
 * reached it (behind the tunnel: https and its host). The url must be listed in the
 * OAuth client of the Google Cloud console. */
function redirectUri(req: express.Request) {
    return process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/health/google/callback`;
}

function sendError(res: express.Response, err: unknown) {
    if (err instanceof HealthError) {
        res.status(503).json({ error: err.message, reconnect: err.reconnect });
        return;
    }
    log.error('request failed', undefined, err);
    res.status(502).json({ error: 'Google Health did not answer' });
}

export default function initHealthRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;

    app.get('/api/health/summary', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        if (!configured()) {
            res.json({ configured: false, linked: false });
            return;
        }
        const link = await HealthLink.findById(userID, { connectedAt: 1, refreshTokenExpiresAt: 1, scopes: 1 }).lean();
        if (!link) {
            res.json({ configured: true, linked: false });
            return;
        }
        const data = summary(userID);
        const sync = syncStatus(userID);
        const linkInfo = {
            connectedAt: link.connectedAt,
            refreshTokenExpiresAt: link.refreshTokenExpiresAt ?? null,
            scopes: link.scopes.length,
            scopesAsked: SCOPES.length,
        };
        if (!data) {
            res.status(sync.error ? 503 : 202).json({
                configured: true,
                linked: true,
                link: linkInfo,
                sync,
                status: sync.error ? 'error' : 'first sync in progress',
            });
            return;
        }
        res.json({ configured: true, linked: true, link: linkInfo, ...data });
    });

    app.get('/api/health/status', auth, (req: RequestWithSessionInfo, res) => {
        res.json(syncStatus(req.sessionInfo!.userID));
    });

    // the trackers paired with the Google account, for the devices page
    app.get('/api/health/trackers', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        const linked = configured() && !!(await HealthLink.exists({ _id: userID }));
        res.json({ linked, trackers: linked ? trackers(userID) : [], sync: linked ? syncStatus(userID) : null });
    });

    app.get('/api/health/intraday', auth, async (req: RequestWithSessionInfo, res) => {
        const { type, date } = req.query;
        if (typeof type !== 'string' || !INTRADAY_TYPES.has(type) || !isDate(date)) {
            res.status(400).json({ error: 'type or date not supported' });
            return;
        }
        try {
            res.json(await intraday(req.sessionInfo!.userID, type, date));
        } catch (err) {
            sendError(res, err);
        }
    });

    app.get('/api/health/hr-latest', auth, async (req: RequestWithSessionInfo, res) => {
        try {
            res.json(await latestHeartRate(req.sessionInfo!.userID));
        } catch (err) {
            sendError(res, err);
        }
    });

    /* ------------------------------------------------------------------- */

    app.get('/api/health/google/connect', auth, (req: RequestWithSessionInfo, res) => {
        if (!configured()) {
            res.status(503).send('Google Health is not configured on this server.');
            return;
        }
        const now = Date.now();
        for (const [k, v] of pending) if (v.expires < now) pending.delete(k);

        const uri = redirectUri(req);
        const { url, state, verifier } = newAuthorization(uri);
        pending.set(state, { userID: req.sessionInfo!.userID, verifier, redirectUri: uri, expires: now + AUTH_PENDING_MS });
        res.redirect(302, url);
    });

    /* Google's redirect back is a cross-site navigation: the SameSite=Strict login cookie
     * is not sent with it. The one-time state (random, single use, 10 min) says whose
     * consent this is; the answer is a page that moves on to /health itself, a same-site
     * navigation that has the cookie again. */
    app.get('/api/health/google/callback', async (req, res) => {
        const done = (result: string) =>
            res
                .status(200)
                .type('html')
                .set('Cache-Control', 'no-store')
                .send(
                    `<!doctype html><meta charset="utf-8"><title>kibbl.</title><script>location.replace('/health?connect=${result}')</script><a href="/health?connect=${result}">Continue</a>`,
                );

        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const started = pending.get(state);
        pending.delete(state);
        if (!started || started.expires < Date.now()) {
            done('expired');
            return;
        }
        if (typeof req.query.code !== 'string') {
            log.warn('consent not given', { user: started.userID, error: String(req.query.error ?? '') });
            done('denied');
            return;
        }
        try {
            const tokens = await exchangeCode(req.query.code, started.verifier, started.redirectUri);
            await saveTokens(started.userID, tokens);
            log.info('connected', { user: started.userID, scopes: (tokens.scope ?? '').split(' ').filter(Boolean).length });
            forget(started.userID);
            syncNow(started.userID);
            done('ok');
        } catch (err) {
            log.warn('connect failed', { user: started.userID }, err);
            done('failed');
        }
    });

    // forgets the tokens here; the access stays listed in the Google account until removed there
    app.post('/api/health/google/disconnect', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        await HealthLink.deleteOne({ _id: userID });
        forget(userID);
        log.info('disconnected', { user: req.sessionInfo!.email });
        res.json({ ok: true });
    });
}
