import crypto from 'node:crypto';
import { AccessToken, User } from '../core/db';

/*
 * Tokens for the MCP endpoint: a random secret shown once, stored only as its hash.
 * A token acts as its user, read only. Created and revoked with mcp-token.js.
 */

const PREFIX = 'kibbl_';
const LAST_USED_STEP_MS = 60_000; // lastUsedAt is written at most once a minute

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function newToken() {
    return PREFIX + crypto.randomBytes(32).toString('base64url');
}

export async function createToken(userID: string, name: string) {
    const token = newToken();
    await AccessToken.create({ _id: hashToken(token), userID, name, createdAt: Date.now() });
    return token;
}

// the token's user, or undefined for a token that is unknown, revoked or of a removed user
export async function checkToken(token: string | undefined): Promise<SessionInfo | undefined> {
    if (typeof token !== 'string' || !token.startsWith(PREFIX) || token.length > 128) return undefined;
    const doc = await AccessToken.findById(hashToken(token)).lean();
    if (!doc) return undefined;
    const user = await User.findById(doc.userID).lean();
    if (!user) return undefined;
    const now = Date.now();
    if (!doc.lastUsedAt || now - doc.lastUsedAt > LAST_USED_STEP_MS) {
        await AccessToken.updateOne({ _id: doc._id }, { $set: { lastUsedAt: now } });
    }
    return { userID: user._id, email: user.email, name: user.name, tokenVersion: user.tokenVersion };
}
