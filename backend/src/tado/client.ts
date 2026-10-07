import crypto from 'node:crypto';
import { TadoLink } from '../core/db';
import { logger } from '../core/logger';

/*
 * tado's REST API as its own app uses it (support.tado.com: "How do I authenticate to access
 * the REST API?", "Limitation for REST API usage"):
 * - sign-in with the device code flow: the person confirms a code on tado's site, kibbl.
 *   never sees the password. Access tokens last 10 minutes, refresh tokens up to 30 days and
 *   only once: each refresh returns a new one, stored before anything else.
 * - 100 requests a day without Auto-Assist; every answer says how many are left
 *   (ratelimit: "perday";r=93, and t= seconds until it refills when none are).
 * Classic homes answer on my.tado.com, tado X homes on hops.tado.com (PyTado does the same).
 */

const log = logger('tado');

const CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46'; // tado's public client for the device code flow
const LOGIN = 'https://login.tado.com/oauth2';
export const MY_API = 'https://my.tado.com/api/v2';
export const HOPS_API = 'https://hops.tado.com';
const TIMEOUT_MS = 15_000;

interface Tokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // ms
}

export class TadoError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
    }
}

/* ----------------------------------------------------------------------- */

function key() {
    const secret = process.env.HEALTH_TOKEN_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('HEALTH_TOKEN_KEY or JWT_SECRET is needed to store tado tokens');
    return Buffer.from(crypto.hkdfSync('sha256', secret, 'kibbl', 'tado-tokens', 32));
}

function seal(tokens: Tokens) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function unseal(stored: string): Tokens {
    const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

async function form(url: string, fields: Record<string, string>) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://app.tado.com/' },
        body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
}

function toTokens(body: Record<string, unknown>): Tokens {
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
        throw new TadoError('tado sent no tokens');
    }
    return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: Date.now() + (Number(body.expires_in) || 600) * 1000,
    };
}

/* ----------------------------------------------------------------------- */

export interface DeviceLogin {
    deviceCode: string;
    userCode: string;
    url: string;
    interval: number; // seconds between polls
    expiresAt: number;
}

export async function startDeviceLogin(): Promise<DeviceLogin> {
    const { status, body } = await form(`${LOGIN}/device_authorize`, { scope: 'offline_access' });
    if (status !== 200 || typeof body.device_code !== 'string') throw new TadoError(`tado sign-in not started (HTTP ${status})`, status);
    return {
        deviceCode: body.device_code,
        userCode: String(body.user_code ?? ''),
        url: String(body.verification_uri_complete ?? body.verification_uri ?? 'https://login.tado.com/'),
        interval: Number(body.interval) || 5,
        expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000,
    };
}

// the tokens once the person confirmed, 'pending' before, throws when it was refused or expired
export async function pollDeviceLogin(deviceCode: string): Promise<'pending' | 'slow_down' | string> {
    const { status, body } = await form(`${LOGIN}/token`, { device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (status === 200) return seal(toTokens(body));
    if (body.error === 'authorization_pending') return 'pending';
    if (body.error === 'slow_down') return 'slow_down';
    throw new TadoError(
        body.error === 'expired_token'
            ? 'The code expired.'
            : body.error === 'access_denied'
              ? 'The sign-in was refused.'
              : `tado: ${String(body.error ?? status)}`,
    );
}

/* ----------------------------------------------------------------------- */

// per account: the refresh in progress, so two requests at once do not spend the same refresh token
const refreshing = new Map<string, Promise<Tokens>>();
const cache = new Map<string, Tokens>();

async function refresh(userID: string): Promise<Tokens> {
    const link = await TadoLink.findById(userID, { tokens: 1 }).lean();
    if (!link) throw new TadoError('tado is not connected');
    const old = unseal(link.tokens);
    const { status, body } = await form(`${LOGIN}/token`, { grant_type: 'refresh_token', refresh_token: old.refresh_token });
    if (status !== 200) {
        throw new TadoError(status === 400 || status === 401 ? 'tado asks to sign in again' : `tado sign-in refresh failed (HTTP ${status})`, 401);
    }
    const tokens = toTokens(body);
    // the old refresh token is spent: the new one is stored before it is used
    await TadoLink.updateOne({ _id: userID }, { tokens: seal(tokens) });
    cache.set(userID, tokens);
    return tokens;
}

async function accessToken(userID: string) {
    const cached = cache.get(userID);
    if (cached && cached.expires_at - Date.now() > 60_000) return cached.access_token;
    let pending = refreshing.get(userID);
    if (!pending) {
        pending = refresh(userID).finally(() => refreshing.delete(userID));
        refreshing.set(userID, pending);
    }
    return (await pending).access_token;
}

export function forgetTokens(userID: string) {
    cache.delete(userID);
}

export interface RateLimit {
    remaining?: number;
    resetAt?: number;
}

// ratelimit: "perday";r=93  or  "perday";r=0;t=1234
export function parseRate(header: string | null): RateLimit {
    if (!header) return {};
    const r = /r=(\d+)/.exec(header);
    const t = /t=(\d+)/.exec(header);
    return { remaining: r ? Number(r[1]) : undefined, resetAt: t ? Date.now() + Number(t[1]) * 1000 : undefined };
}

/* One request of the daily budget. The answer, and what tado says is left of the budget. */
export async function tadoRequest<T>(userID: string, method: string, url: string, body?: unknown): Promise<{ data: T; rate: RateLimit }> {
    const token = await accessToken(userID);
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Referer: 'https://app.tado.com/',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const rate = parseRate(res.headers.get('ratelimit'));
    if (rate.remaining !== undefined) {
        await TadoLink.updateOne({ _id: userID }, { rateRemaining: rate.remaining, ...(rate.resetAt ? { rateResetAt: rate.resetAt } : {}) });
    }
    if (res.status === 429) throw new TadoError('tado allows no more requests today', 429);
    if (res.status === 401) {
        cache.delete(userID);
        throw new TadoError('tado asks to sign in again', 401);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn('request refused', { method, url: url.replace(/\/homes\/\d+/, '/homes/…'), status: res.status, body: text.slice(0, 200) });
        throw new TadoError(`tado: HTTP ${res.status}`, res.status);
    }
    const text = await res.text();
    return { data: (text ? JSON.parse(text) : {}) as T, rate };
}
