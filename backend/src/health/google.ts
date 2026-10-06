import crypto from 'node:crypto';
import { logger } from '../core/logger';
import { datasourceMeta, intradayRows, type FilterKind, type Row } from './extract';
import { Limiter } from './limiter';
import { loadTokens, saveTokens, type GoogleTokens } from './tokens';

/*
 * Google Health API v4, the successor of the Fitbit Web API (deprecated September 2026),
 * ported from whoofit's gh_auth.py and gh_client.py. Credentials come from the Google
 * Cloud console: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
 */

const log = logger('health');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BASE = 'https://health.googleapis.com/v4';
const TIMEOUT_MS = 30_000;
const PAGE_SIZE = 10_000; // the api's maximum (sleep and exercise: 25, it truncates); 1440 when not given

// requests to Google under way at once, for all users together (HEALTH_CONCURRENCY)
const limiter = new Limiter(Math.max(1, Number(process.env.HEALTH_CONCURRENCY) || 4));

/* Heart rate only needs the value and its time: a partial response (the standard fields
 * parameter) leaves out the data source repeated in every one of ~37 000 points a day,
 * less to download and to parse. If Google refuses the mask, it is not used again. */
const HEART_RATE_FIELDS =
    'nextPageToken,dataPoints(dataSource(recordingMethod,platform,device/displayName),heartRate(beatsPerMinute,sampleTime(civilTime/time,utcOffset)))';
let heartRateMask = true;

const SCOPE_BASE = 'https://www.googleapis.com/auth/googlehealth';
export const SCOPES = [
    'profile.readonly',
    'activity_and_fitness.readonly',
    'sleep.readonly',
    'health_metrics_and_measurements.readonly',
    'ecg.readonly',
    'irn.readonly',
    'location.readonly',
    'nutrition.readonly',
    'settings.readonly',
].map((s) => `${SCOPE_BASE}.${s}`);

export class HealthError extends Error {
    // true when only connecting Google again helps (refresh token expired or revoked)
    constructor(
        message: string,
        readonly reconnect = false,
    ) {
        super(message);
    }
}

export function configured() {
    return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

/* ----------------------------------------------------------------------- */

// PKCE: the code is useless without the verifier, which never leaves the server
export function newAuthorization(redirectUri: string) {
    const verifier = crypto.randomBytes(64).toString('base64url').slice(0, 128);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const url =
        AUTH_URL +
        '?' +
        new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID as string,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: SCOPES.join(' '),
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            access_type: 'offline', // a refresh token
            prompt: 'consent', // one even on a repeated consent
        });
    return { url, state, verifier };
}

async function tokenRequest(params: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID as string, client_secret: process.env.GOOGLE_CLIENT_SECRET as string, ...params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<GoogleTokens> {
    const { status, body } = await tokenRequest({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
    if (status !== 200 || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
        throw new HealthError(`token exchange failed (${status} ${String(body.error ?? '')})`);
    }
    return { ...(body as unknown as GoogleTokens), obtained_at: Math.floor(Date.now() / 1000) };
}

/* ----------------------------------------------------------------------- */

const pad = (n: number) => String(n).padStart(2, '0');

// YYYY-MM-DD of today plus offset days, in the server's time zone (the home's)
export function day(offset = 0) {
    const d = new Date();
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nextDay(date: string) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* The filter grammar differs per family: daily summaries filter on .date, intervals on
 * their civil start, samples on their civil time, sleep on its civil END time, and ECG
 * only supports >= on a physical start. Data types are hyphenated in paths, snake case
 * in filters. */
export function buildFilter(dataType: string, kind: FilterKind, start: string, end: string) {
    const f = dataType.replace(/-/g, '_');
    switch (kind) {
        case 'daily':
            return `${f}.date >= "${start}" AND ${f}.date < "${end}"`;
        case 'interval':
            return `${f}.interval.civil_start_time >= "${start}" AND ${f}.interval.civil_start_time < "${end}"`;
        case 'sample':
            return `${f}.sample_time.civil_time >= "${start}" AND ${f}.sample_time.civil_time < "${end}"`;
        case 'sleep':
            return `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${end}"`;
        case 'ecg':
            return `electrocardiogram.interval.start_time >= "${start}T00:00:00Z"`;
    }
}

// one refresh per user at a time: parallel requests that all see an expired token share it
const refreshing = new Map<string, Promise<GoogleTokens>>();

export class GoogleHealth {
    private tokens?: GoogleTokens;

    // urgent: a person waits for it, it goes ahead of the history fetch
    constructor(
        readonly userID: string,
        readonly urgent = false,
    ) {}

    private async token() {
        if (!this.tokens) {
            this.tokens = await loadTokens(this.userID);
            if (!this.tokens) throw new HealthError('Google Health is not connected', true);
        }
        // a minute early, so a request never starts with a token about to expire
        const expires = this.tokens.obtained_at + (this.tokens.expires_in ?? 3600) - 60;
        if (Date.now() / 1000 > expires) await this.refresh();
        return this.tokens.access_token;
    }

    private async refresh() {
        let pending = refreshing.get(this.userID);
        if (!pending) {
            pending = (async () => {
                const current = await loadTokens(this.userID);
                if (!current) throw new HealthError('Google Health is not connected', true);
                const { status, body } = await tokenRequest({ refresh_token: current.refresh_token, grant_type: 'refresh_token' });
                if (status !== 200 || typeof body.access_token !== 'string') {
                    // invalid_grant: expired (7 days while the Google app is in testing) or revoked
                    throw new HealthError(`token refresh failed (${status} ${String(body.error ?? '')})`, body.error === 'invalid_grant');
                }
                // Google leaves the refresh token out of a refresh: the old one stays valid
                const next: GoogleTokens = {
                    ...current,
                    ...(body as unknown as GoogleTokens),
                    refresh_token: current.refresh_token,
                    obtained_at: Math.floor(Date.now() / 1000),
                };
                if (body.refresh_token_expires_in === undefined) next.refresh_token_expires_in = current.refresh_token_expires_in;
                await saveTokens(this.userID, next);
                log.debug('access token refreshed', { user: this.userID });
                return next;
            })().finally(() => refreshing.delete(this.userID));
            refreshing.set(this.userID, pending);
        }
        this.tokens = await pending;
    }

    /* One request, the access token refreshed once on a 401. A 429 (rate limit) or 503
     * pauses every request as long as Google asks (Retry-After, else 30 s) and tries again,
     * up to 5 times. A network error, a timeout or a 500/502/504 is tried again after 2, 4,
     * 8 s: one of them should not end a fetch of thousands of requests. */
    async get(path: string, params?: Record<string, string | number>): Promise<{ status: number; body: unknown }> {
        const url = `${BASE}${path}${params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : ''}`;
        let refreshed = false;
        let limited = 0;
        let failed = 0;
        for (;;) {
            const outcome = await limiter.run(async () => {
                let res: Response;
                try {
                    res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
                } catch (err) {
                    if (err instanceof HealthError) throw err;
                    return { again: 'failed' as const, err };
                }
                if (res.status === 401 && !refreshed) {
                    await res.body?.cancel();
                    return { again: 'refresh' as const };
                }
                if ((res.status === 429 || res.status === 503) && limited < 5) {
                    const wait = Math.min(Number(res.headers.get('retry-after')) || 30, 300);
                    log.warn('google asks to wait', { status: res.status, seconds: wait, attempt: limited + 1 });
                    await res.body?.cancel();
                    limiter.pause(wait * 1000);
                    return { again: 'limited' as const };
                }
                if ((res.status === 500 || res.status === 502 || res.status === 504) && failed < 3) {
                    await res.body?.cancel();
                    return { again: 'failed' as const, err: new Error(`HTTP ${res.status}`) };
                }
                const text = await res.text();
                let body: unknown = text;
                try {
                    body = JSON.parse(text);
                } catch {
                    // not json: kept as text
                }
                return { status: res.status, body };
            }, this.urgent);

            if (!('again' in outcome)) return outcome;
            if (outcome.again === 'refresh') {
                refreshed = true;
                await this.refresh();
            } else if (outcome.again === 'limited') {
                if (++limited >= 5) throw new HealthError('Google Health kept refusing requests (rate limit)');
            } else {
                if (++failed > 3) throw outcome.err;
                log.debug('request failed, trying again', { path, attempt: failed, error: (outcome.err as Error)?.message });
                await new Promise((r) => setTimeout(r, 1000 * 2 ** failed));
            }
        }
    }

    profile() {
        return this.get('/users/me/profile');
    }

    pairedDevices() {
        return this.get('/users/me/pairedDevices');
    }

    dataPoints(dataType: string, kind: FilterKind, start: string, end: string, pageSize = 50) {
        return this.get(`/users/me/dataTypes/${dataType}/dataPoints`, { filter: buildFilter(dataType, kind, start, end), pageSize });
    }

    /* Every page of the window, following nextPageToken, each handed to onPage as it
     * arrives and then let go: a day of heart rate is ~37 000 points, never all in memory
     * at once as Google sent them. Intraday interval types (active zone minutes, sedentary
     * periods) have many points a day, one page would cut the totals. */
    async dataPointsPages(
        dataType: string,
        kind: FilterKind,
        start: string,
        end: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onPage: (points: any[], page: number) => void | Promise<void>,
        options: { maxPages?: number; fields?: string } = {},
    ): Promise<{ status: number; pages: number; complete: boolean }> {
        const maxPages = options.maxPages ?? 40;
        const params: Record<string, string | number> = { filter: buildFilter(dataType, kind, start, end), pageSize: PAGE_SIZE };
        if (options.fields) params.fields = options.fields;
        for (let page = 0; page < maxPages; page++) {
            const { status, body } = await this.get(`/users/me/dataTypes/${dataType}/dataPoints`, params);
            if (status !== 200 || !body || typeof body !== 'object') return { status, pages: page, complete: false };
            const b = body as { dataPoints?: unknown[]; nextPageToken?: string };
            await onPage(b.dataPoints ?? [], page);
            if (!b.nextPageToken) return { status: 200, pages: page + 1, complete: true };
            params.pageToken = b.nextPageToken;
        }
        log.warn('more pages than expected, the rest left out', { dataType, start, end, pages: maxPages });
        return { status: 200, pages: maxPages, complete: false };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async dataPointsAll(dataType: string, kind: FilterKind, start: string, end: string, maxPages = 40): Promise<{ status: number; points: any[] }> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const points: any[] = [];
        const { status } = await this.dataPointsPages(
            dataType,
            kind,
            start,
            end,
            (page) => {
                for (const p of page) points.push(p);
            },
            { maxPages },
        );
        return { status, points };
    }

    /* The heart rate of one civil day as [second of the day, bpm] rows, sorted: each page
     * becomes rows right away. */
    async heartRateDay(date: string, maxPages = 12): Promise<{ status: number; rows: Row[]; meta: Record<string, unknown> }> {
        const masked = heartRateMask;
        const rows: Row[] = [];
        let meta: Record<string, unknown> = {};
        const { status } = await this.dataPointsPages(
            'heart-rate',
            'sample',
            date,
            nextDay(date),
            (points, page) => {
                if (page === 0) meta = datasourceMeta(points);
                for (const row of intradayRows('heart-rate', points)) rows.push(row);
            },
            { maxPages, fields: masked ? HEART_RATE_FIELDS : undefined },
        );
        if (status === 400 && masked) {
            heartRateMask = false;
            log.warn('google refused the partial response for heart rate, fetching whole points');
            return this.heartRateDay(date, maxPages);
        }
        rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        return { status, rows, meta };
    }
}

// for the status page and the logs
export function requestQueue() {
    return { running: limiter.running, waiting: limiter.pending };
}
