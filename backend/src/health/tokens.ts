import crypto from 'node:crypto';
import { HealthLink } from '../core/db';

/*
 * The Google tokens of a user, encrypted at rest (AES-256-GCM). The key is HEALTH_TOKEN_KEY,
 * or derived from JWT_SECRET: a database copy alone does not reveal the tokens. Changing
 * the key (or JWT_SECRET without HEALTH_TOKEN_KEY) means connecting Google Health again.
 */

export interface GoogleTokens {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    obtained_at: number; // unix seconds
    scope?: string;
    token_type?: string;
    refresh_token_expires_in?: number; // only while the Google app is in testing mode
}

function key() {
    const secret = process.env.HEALTH_TOKEN_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('HEALTH_TOKEN_KEY or JWT_SECRET is needed to store health tokens');
    return Buffer.from(crypto.hkdfSync('sha256', secret, 'kibbl', 'health-tokens', 32));
}

export function encrypt(tokens: GoogleTokens) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(stored: string): GoogleTokens {
    const [iv, tag, data] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

export async function loadTokens(userID: string) {
    const link = await HealthLink.findById(userID).lean();
    return link ? decrypt(link.tokens) : undefined;
}

export async function saveTokens(userID: string, tokens: GoogleTokens) {
    const now = Date.now();
    const expiresIn = tokens.refresh_token_expires_in;
    await HealthLink.updateOne(
        { _id: userID },
        {
            $set: {
                provider: 'google',
                tokens: encrypt(tokens),
                scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
                refreshTokenExpiresAt: expiresIn ? (tokens.obtained_at + expiresIn) * 1000 : undefined,
                updatedAt: now,
            },
            $setOnInsert: { connectedAt: now },
        },
        { upsert: true },
    );
}
