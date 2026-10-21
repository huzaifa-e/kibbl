import crypto from 'node:crypto';
import { PetkitLink } from '../core/db';
import { logger } from '../core/logger';

/*
 * PetKit's cloud as its Android app uses it (the same requests as pypetkitapi, which Home
 * Assistant's PetKit integration is built on):
 * - passport.petkt.com/v1/regionservers names the cloud of an account's country, e.g.
 *   api.eu-pet.com for Germany. Everything else goes there, as form posts.
 * - user/login takes the e-mail and the md5 of the password and returns a session (X-Session),
 *   valid for days. Error 5 means it ended, also because the same account signed in elsewhere:
 *   PetKit keeps one session per account, so kibbl. should have an account of its own that
 *   the feeder is shared with, or PetKit's app and kibbl. sign each other out.
 * Answers are { result } or { error: { code, msg } }.
 * The login and the session are stored encrypted (like the tado tokens), never in clear.
 */

const log = logger('petkit');

const PASSPORT = 'https://passport.petkt.com';
const CHINA_GATEWAY = 'https://api.petkit.cn/6/';
const API_VERSION = '13.2.1';
const CLIENT = { platform: 'android', osVersion: '16.1', model: '23127PN0CG', source: 'app.petkit-android', brand: 'Xiaomi' };
const TIMEOUT_MS = 20_000;

export interface Credentials {
    username: string;
    md5: string; // of the password, what PetKit's login takes
    region: string; // the country (DE) the cloud is looked up by
    gateway: string; // its address, e.g. https://api.eu-pet.com/latest/
    session?: { id: string; expiresAt: number };
}

export class PetkitError extends Error {
    constructor(
        message: string,
        readonly code?: number,
    ) {
        super(message);
    }
}

/* ----------------------------------------------------------------------- */

function key() {
    const secret = process.env.HEALTH_TOKEN_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('HEALTH_TOKEN_KEY or JWT_SECRET is needed to store the PetKit login');
    return Buffer.from(crypto.hkdfSync('sha256', secret, 'kibbl', 'petkit-login', 32));
}

export function seal(creds: Credentials) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function unseal(stored: string): Credentials {
    const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

/* ----------------------------------------------------------------------- */

const zone = () => process.env.TZ || 'Europe/Berlin';

// the offset of the server's time zone in hours, as PetKit's app writes it ("2.0", "5.5")
export function zoneOffset(timeZone = zone(), at = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
    })
        .formatToParts(at)
        .reduce<Record<string, number>>((out, p) => (p.type === 'literal' ? out : { ...out, [p.type]: Number(p.value) }), {});
    const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const hours = Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000) / 60;
    return Number.isInteger(hours) ? hours.toFixed(1) : String(hours);
}

function headers(session?: string): Record<string, string> {
    return {
        Accept: '*/*',
        'Accept-Language': 'en-US;q=1, it-US;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'okhttp/3.14.9',
        'X-Img-Version': '1',
        'X-Locale': 'en-US',
        'X-Client': `${CLIENT.platform}(${CLIENT.osVersion};${CLIENT.model})`,
        'X-Hour': '24',
        'X-TimezoneId': zone(),
        'X-Api-Version': API_VERSION,
        'X-Timezone': zoneOffset(),
        ...(session ? { 'F-Session': session, 'X-Session': session } : {}),
    };
}

async function call<T>(
    url: string,
    opts: { method?: 'GET' | 'POST'; query?: Record<string, string | number>; form?: Record<string, string | number>; session?: string },
) {
    const target = new URL(url);
    for (const [k, v] of Object.entries(opts.query ?? {})) target.searchParams.set(k, String(v));
    const body = opts.form ? new URLSearchParams(Object.entries(opts.form).map(([k, v]) => [k, String(v)])) : undefined;
    const res = await fetch(target, {
        method: opts.method ?? 'POST',
        headers: headers(opts.session),
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => {
        throw new PetkitError(`PetKit did not answer (${(err as Error).message})`);
    });
    if (!res.ok) throw new PetkitError(`PetKit answered ${res.status}`, res.status >= 500 ? 1 : undefined);
    const json = (await res.json().catch(() => undefined)) as { result?: T; error?: { code?: number | string; msg?: string } } | undefined;
    if (!json) throw new PetkitError('PetKit sent no JSON');
    if (json.error) {
        const code = Number(json.error.code ?? 0);
        const msg = json.error.msg || 'unknown error';
        if (code === 122) throw new PetkitError('PetKit refused the e-mail or the password', code);
        if (code === 125) throw new PetkitError('PetKit knows no account with this e-mail', code);
        throw new PetkitError(`PetKit: ${msg} (${code})`, code);
    }
    if (!('result' in json)) throw new PetkitError('PetKit sent no result');
    return json.result as T;
}

/* ----------------------------------------------------------------------- */

// the cloud of a country (DE, US, ...)
async function gatewayOf(region: string) {
    if (/^(cn|china)$/i.test(region)) return CHINA_GATEWAY;
    const res = await call<{ list?: { id: string; name: string; gateway: string }[] }>(`${PASSPORT}/v1/regionservers`, { method: 'GET' });
    const found = res.list?.find((r) => r.id.toLowerCase() === region.toLowerCase() || r.name.toLowerCase() === region.toLowerCase());
    if (!found) throw new PetkitError(`PetKit has no cloud for the region ${region}`);
    return found.gateway;
}

// Python's str() of the client dict, as PetKit's app sends it
function clientInfo() {
    const info: Record<string, string> = {
        locale: 'en-US',
        name: CLIENT.model,
        osVersion: CLIENT.osVersion,
        phoneBrand: CLIENT.brand,
        platform: CLIENT.platform,
        source: CLIENT.source,
        version: API_VERSION,
        timezoneId: zone(),
        timezone: zoneOffset(),
    };
    return `{${Object.entries(info)
        .map(([k, v]) => `'${k}': '${v}'`)
        .join(', ')}}`;
}

async function signIn(creds: Credentials): Promise<Credentials> {
    const res = await call<{ session?: { id: string; expiresIn: number; createdAt?: string } }>(`${creds.gateway.replace(/\/$/, '')}/user/login`, {
        form: {
            oldVersion: API_VERSION,
            client: clientInfo(),
            encrypt: '1',
            region: creds.region.toLowerCase(),
            username: creds.username,
            password: creds.md5,
        },
    });
    if (!res.session?.id) throw new PetkitError('PetKit sent no session');
    const expiresIn = Number(res.session.expiresIn) || 7 * 86400;
    return { ...creds, session: { id: res.session.id, expiresAt: Date.now() + expiresIn * 1000 } };
}

// a first sign-in, from the app: the password is only kept as PetKit's login takes it (md5)
export async function login(username: string, password: string, region: string) {
    const md5 = crypto.createHash('md5').update(password).digest('hex');
    const gateway = await gatewayOf(region);
    return signIn({ username, md5, region, gateway });
}

/* ----------------------------------------------------------------------- */

const sessions = new Map<string, Credentials>(); // userID -> unsealed, while the server runs
const signingIn = new Map<string, Promise<Credentials>>();

async function credentials(userID: string) {
    const known = sessions.get(userID);
    if (known) return known;
    const link = await PetkitLink.findById(userID, { credentials: 1 }).lean();
    if (!link) throw new PetkitError('PetKit is not connected', 404);
    const creds = unseal(link.credentials);
    sessions.set(userID, creds);
    return creds;
}

async function renew(userID: string, creds: Credentials) {
    let pending = signingIn.get(userID);
    if (!pending) {
        pending = signIn(creds)
            .then(async (fresh) => {
                sessions.set(userID, fresh);
                await PetkitLink.updateOne({ _id: userID }, { credentials: seal(fresh) });
                log.info('signed in again', { user: userID });
                return fresh;
            })
            .finally(() => signingIn.delete(userID));
        signingIn.set(userID, pending);
    }
    return pending;
}

export function forgetSession(userID: string) {
    sessions.delete(userID);
}

/* A request of an account: a session that ended (or is about to) is renewed with the stored
 * login and the request sent once more. query goes in the address, form in the body, as the
 * app does it per endpoint. */
export async function petkitRequest<T>(
    userID: string,
    path: string,
    opts: { query?: Record<string, string | number>; form?: Record<string, string | number> } = {},
) {
    let creds = await credentials(userID);
    if (!creds.session || creds.session.expiresAt < Date.now() + 3600_000) creds = await renew(userID, creds);
    const url = `${creds.gateway.replace(/\/$/, '')}/${path}`;
    try {
        return await call<T>(url, { ...opts, session: creds.session!.id });
    } catch (err) {
        if (!(err instanceof PetkitError) || err.code !== 5) throw err;
        log.warn('session ended, PetKit signed this account in elsewhere?', { user: userID });
        creds = await renew(userID, creds);
        return call<T>(url, { ...opts, session: creds.session!.id });
    }
}
