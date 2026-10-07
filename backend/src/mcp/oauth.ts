import crypto from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { passwordMatches } from '../core/auth';
import { OAuthClient, OAuthGrant, User } from '../core/db';
import { logger } from '../core/logger';
import { signInPage } from './signin';
import { checkToken, hashToken } from './tokens';

/*
 * OAuth 2.1 for the MCP endpoint, so a hosted assistant can be connected to it: it
 * registers itself (RFC 7591), sends the user here to sign in with their kibbl.
 * account, and gets an access token (1 h) and a refresh token (60 days, renewed with
 * every use). Only redirect urls in MCP_REDIRECT_URIS and loopback ones are accepted.
 * The SDK's router does the protocol (mcpAuthRouter); this is what it asks for.
 */

const log = logger('mcp');

const CODE_MS = 10 * 60_000;
const ACCESS_S = 3600;
const REFRESH_MS = 60 * 24 * 3600_000;
const MAX_CLIENTS = 200;
const LAST_USED_STEP_MS = 60_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// the redirect urls a client may register: the configured ones exactly, loopback ones on any port
export function redirectAllowed(uri: string, configured = process.env.MCP_REDIRECT_URIS ?? '') {
    const allowed = configured
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);
    if (allowed.includes(uri)) return true;
    try {
        const url = new URL(uri);
        return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
    } catch {
        return false;
    }
}

const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
        const doc = await OAuthClient.findById(clientId).lean();
        return doc ? (doc.info as OAuthClientInformationFull) : undefined;
    },
    async registerClient(client) {
        const refused = client.redirect_uris.filter((u) => !redirectAllowed(String(u)));
        if (refused.length) {
            log.warn('client registration refused', { redirect: refused.join(' '), name: client.client_name ?? '' });
            throw new InvalidClientMetadataError(`redirect_uri not allowed on this server: ${refused.join(', ')}`);
        }
        if ((await OAuthClient.estimatedDocumentCount()) >= MAX_CLIENTS) {
            throw new InvalidClientMetadataError('too many registered clients');
        }
        const info = { ...client, client_id: crypto.randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) } as OAuthClientInformationFull;
        await OAuthClient.create({ _id: info.client_id, info, createdAt: Date.now() });
        log.info('client registered', { name: client.client_name ?? '', redirect: client.redirect_uris.join(' ') });
        return info;
    },
};

const clientName = (client: OAuthClientInformationFull) => (client.client_name || 'An MCP client').slice(0, 60);

/* ----------------------------------------------------------------------- */

interface PendingCode {
    clientId: string;
    userID: string;
    tokenVersion: number;
    challenge: string;
    redirectUri: string;
    resource?: string;
    expires: number;
}

// codes live a few minutes, single use: memory is enough, a restart only means signing in again
const codes = new Map<string, PendingCode>();

const random = (prefix: string) => prefix + crypto.randomBytes(32).toString('base64url');

async function issueTokens(grant: Omit<OAuthGrantDoc, 'accessHash' | 'accessExpiresAt' | 'refreshHash' | 'refreshExpiresAt'>): Promise<OAuthTokens> {
    const access = random('kat_');
    const refresh = random('krt_');
    const now = Date.now();
    await OAuthGrant.updateOne(
        { _id: grant._id },
        {
            $set: {
                ...grant,
                accessHash: hashToken(access),
                accessExpiresAt: now + ACCESS_S * 1000,
                refreshHash: hashToken(refresh),
                refreshExpiresAt: now + REFRESH_MS,
            },
        },
        { upsert: true },
    );
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_S, refresh_token: refresh };
}

/* ----------------------------------------------------------------------- */

export const oauthProvider: OAuthServerProvider = {
    get clientsStore() {
        return clientsStore;
    },

    /* The sign-in page, and its answer: the form posts back to the authorization endpoint
     * with every parameter again, so the SDK has checked client, redirect url and PKCE
     * before a password is even looked at. */
    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
        const body = (res.req.method === 'POST' ? res.req.body : {}) as Record<string, unknown>;
        const page = (status: number, error?: string, email = '') =>
            res
                .status(status)
                .type('html')
                .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'")
                .send(
                    signInPage({
                        client: clientName(client),
                        redirectUri: params.redirectUri,
                        fields: res.req.method === 'POST' ? body : res.req.query,
                        error,
                        email,
                    }),
                );

        if (body.decision === 'deny') {
            const url = new URL(params.redirectUri);
            url.searchParams.set('error', 'access_denied');
            if (params.state) url.searchParams.set('state', params.state);
            res.redirect(302, url.href);
            return;
        }
        if (body.decision !== 'allow') {
            page(200);
            return;
        }

        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
        const password = typeof body.password === 'string' ? body.password.slice(0, 256) : '';
        const user = email ? await User.findOne({ email }).lean() : null;
        if (!user || !password || !(await passwordMatches(user, password))) {
            log.warn('connector sign-in failed', { user: email, client: clientName(client), ip: res.req.ip });
            page(401, 'E-mail or password is wrong.', email);
            return;
        }

        const now = Date.now();
        for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
        const code = random('kac_');
        codes.set(code, {
            clientId: client.client_id,
            userID: user._id,
            tokenVersion: user.tokenVersion,
            challenge: params.codeChallenge,
            redirectUri: params.redirectUri,
            resource: params.resource?.href,
            expires: now + CODE_MS,
        });
        log.info('connector signed in', { user: email, client: clientName(client) });
        const url = new URL(params.redirectUri);
        url.searchParams.set('code', code);
        if (params.state) url.searchParams.set('state', params.state);
        res.redirect(302, url.href);
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
        const pending = codes.get(authorizationCode);
        if (!pending || pending.clientId !== client.client_id || pending.expires < Date.now()) throw new InvalidGrantError('invalid or expired code');
        return pending.challenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
        const pending = codes.get(authorizationCode);
        codes.delete(authorizationCode);
        if (!pending || pending.clientId !== client.client_id || pending.expires < Date.now()) throw new InvalidGrantError('invalid or expired code');
        if (redirectUri && redirectUri !== pending.redirectUri) throw new InvalidGrantError('redirect_uri differs from the authorization request');
        return issueTokens({
            _id: crypto.randomUUID(),
            userID: pending.userID,
            clientId: client.client_id,
            clientName: clientName(client),
            tokenVersion: pending.tokenVersion,
            resource: pending.resource,
            createdAt: Date.now(),
        });
    },

    // a refresh token works once: the answer carries the next one
    async exchangeRefreshToken(client, refreshToken) {
        const grant = await OAuthGrant.findOne({ refreshHash: hashToken(refreshToken) }).lean();
        if (!grant || grant.clientId !== client.client_id || grant.refreshExpiresAt < Date.now())
            throw new InvalidGrantError('invalid or expired refresh token');
        const user = await User.findById(grant.userID, { tokenVersion: 1 }).lean();
        if (!user || user.tokenVersion !== grant.tokenVersion) {
            await OAuthGrant.deleteOne({ _id: grant._id });
            throw new InvalidGrantError('the password was changed, sign in again');
        }
        return issueTokens({
            _id: grant._id,
            userID: grant.userID,
            clientId: grant.clientId,
            clientName: grant.clientName,
            tokenVersion: grant.tokenVersion,
            resource: grant.resource,
            createdAt: grant.createdAt,
            lastUsedAt: grant.lastUsedAt,
        });
    },

    // OAuth access tokens and the tokens of mcp-token.js both open the endpoint
    async verifyAccessToken(token): Promise<AuthInfo> {
        if (token.startsWith('kibbl_')) {
            const session = await checkToken(token);
            if (!session) throw new InvalidTokenError('unknown token');
            return { token, clientId: 'mcp-token', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + ACCESS_S, extra: { session } };
        }
        const grant = token.startsWith('kat_') ? await OAuthGrant.findOne({ accessHash: hashToken(token) }).lean() : null;
        if (!grant || grant.accessExpiresAt < Date.now()) throw new InvalidTokenError('invalid or expired token');
        const user = await User.findById(grant.userID).lean();
        if (!user || user.tokenVersion !== grant.tokenVersion) throw new InvalidTokenError('the password was changed, sign in again');
        const now = Date.now();
        if (!grant.lastUsedAt || now - grant.lastUsedAt > LAST_USED_STEP_MS) await OAuthGrant.updateOne({ _id: grant._id }, { $set: { lastUsedAt: now } });
        const session: SessionInfo = { userID: user._id, email: user.email, name: user.name, tokenVersion: user.tokenVersion };
        return {
            token,
            clientId: grant.clientId,
            scopes: [],
            expiresAt: Math.floor(grant.accessExpiresAt / 1000),
            resource: grant.resource ? new URL(grant.resource) : undefined,
            extra: { session },
        };
    },

    async revokeToken(client, request: OAuthTokenRevocationRequest) {
        const hash = hashToken(request.token);
        await OAuthGrant.deleteOne({ clientId: client.client_id, $or: [{ accessHash: hash }, { refreshHash: hash }] });
    },
};
