import crypto from 'node:crypto';
import { logger } from '../core/logger';
import type { FilterKind } from './extract';
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

    constructor(readonly userID: string) {}

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

    async get(path: string, params?: Record<string, string | number>): Promise<{ status: number; body: unknown }> {
        const url = `${BASE}${path}${params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : ''}`;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (res.status === 401 && attempt === 1) {
                await this.refresh();
                continue;
            }
            const text = await res.text();
            let body: unknown = text;
            try {
                body = JSON.parse(text);
            } catch {
                // not json: kept as text
            }
            return { status: res.status, body };
        }
        throw new HealthError('unreachable');
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

    /* Every point of the window, following nextPageToken: intraday interval types (active
     * zone minutes, sedentary periods) have many points a day, one page would cut the totals. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async dataPointsAll(dataType: string, kind: FilterKind, start: string, end: string, maxPages = 40): Promise<{ status: number; points: any[] }> {
        const params: Record<string, string | number> = { filter: buildFilter(dataType, kind, start, end), pageSize: 1000 };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const points: any[] = [];
        for (let page = 0; page < maxPages; page++) {
            const { status, body } = await this.get(`/users/me/dataTypes/${dataType}/dataPoints`, params);
            if (status !== 200 || !body || typeof body !== 'object') return { status, points };
            const b = body as { dataPoints?: unknown[]; nextPageToken?: string };
            points.push(...(b.dataPoints ?? []));
            if (!b.nextPageToken) break;
            params.pageToken = b.nextPageToken;
        }
        return { status: 200, points };
    }
}
