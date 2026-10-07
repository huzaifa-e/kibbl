import express from 'express';
import { checkAuthMiddleware } from '../core/auth';
import { HealthLink } from '../core/db';
import { logger } from '../core/logger';
import { isAdmin } from '../core/owners';
import { accessInfo } from './healthAccess';
import { HealthError, SCOPES, configured, exchangeCode, newAuthorization } from '../health/google';
import {
    INTRADAY_TYPES,
    RANGES,
    dropCached,
    forget,
    intraday,
    latestHeartRate,
    summary,
    syncNow,
    syncStatus,
    trackers,
    recentHeartRate,
} from '../health/service';
import { deleteStoredHealth, storageStats } from '../health/store';
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

    /* The stored history for a range (?range=30|90|365|all). Shown also without a link
     * to Google (expired, disconnected): the data is on this server. */
    app.get('/api/health/summary', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        const range = typeof req.query.range === 'string' && req.query.range in RANGES ? req.query.range : '30';
        const link = configured() ? await HealthLink.findById(userID, { connectedAt: 1, refreshTokenExpiresAt: 1, scopes: 1 }).lean() : null;
        const data = await summary(userID, range);
        if (!link && !data) {
            res.json({ configured: configured(), linked: false });
            return;
        }
        const linkInfo = link
            ? {
                  connectedAt: link.connectedAt,
                  refreshTokenExpiresAt: link.refreshTokenExpiresAt ?? null,
                  scopes: link.scopes.length,
                  scopesAsked: SCOPES.length,
              }
            : null;
        if (!data) {
            const sync = await syncStatus(userID);
            res.status(sync.error ? 503 : 202).json({
                configured: true,
                linked: true,
                link: linkInfo,
                sync,
                status: sync.error ? 'error' : 'first sync in progress',
            });
            return;
        }
        res.json({ configured: configured(), linked: !!link, link: linkInfo, ...data });
    });

    /* What the setup guides on the health page need: the person connecting is told the
     * steps through Google's screens; the admin also how to set the Google app up. The
     * Google app counts as in testing mode (testers only, 7-day access) unless
     * GOOGLE_APP_PUBLISHED=true. */
    app.get('/api/health/setup', auth, async (req: RequestWithSessionInfo, res) => {
        const admin = await isAdmin(req.sessionInfo!.userID);
        res.json({
            configured: configured(),
            testing: process.env.GOOGLE_APP_PUBLISHED !== 'true',
            admin,
            ...(admin ? { redirectUri: redirectUri(req), scopes: SCOPES } : {}),
            ...(await accessInfo(req.sessionInfo!.userID, admin)),
        });
    });

    app.get('/api/health/status', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        res.json({ ...(await syncStatus(userID)), storage: await storageStats(userID) });
    });

    // the trackers paired with the Google account, for the devices page
    app.get('/api/health/trackers', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        const linked = configured() && !!(await HealthLink.exists({ _id: userID }));
        res.json({ linked, trackers: linked ? trackers(userID) : [], sync: linked ? await syncStatus(userID) : null });
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

    // the heart rate of the last minutes up to the newest sample (?minutes=30), for the home page
    app.get('/api/health/hr-recent', auth, async (req: RequestWithSessionInfo, res) => {
        const minutes = Math.min(Math.max(Number(req.query.minutes) || 30, 5), 180);
        try {
            res.json(await recentHeartRate(req.sessionInfo!.userID, minutes));
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

    /* Forgets the tokens here; the access stays listed in the Google account until removed
     * there. The stored history stays unless ?delete=1: then it is gone for good. */
    app.post('/api/health/google/disconnect', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        await HealthLink.deleteOne({ _id: userID });
        forget(userID);
        let deleted: { points: number; heartRateDays: number } | undefined;
        if (req.query.delete === '1') {
            deleted = await deleteStoredHealth(userID);
            dropCached(userID);
        }
        log.info(deleted ? 'disconnected, stored history deleted' : 'disconnected, stored history kept', { user: req.sessionInfo!.email, ...(deleted ?? {}) });
        res.json({ ok: true, deleted: deleted ?? null });
    });
}
