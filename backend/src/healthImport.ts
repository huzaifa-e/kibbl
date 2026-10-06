/*
 * Links a user to Google Health with tokens obtained elsewhere (whoofit's gh_token.json),
 * so no new consent is needed. The token comes on stdin, never as an argument:
 *
 *   docker exec -i kibbl-app node health-import.js user@example.com < gh_token.json
 *
 * The OAuth client of the token must be the one in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET,
 * or refreshing it fails.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: __dirname + '/.env' });
dotenv.config();

import { disconnect } from 'mongoose';
import db, { HealthLink, User } from './core/db';
import { saveTokens, type GoogleTokens } from './health/tokens';

async function readStdin() {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

async function main() {
    const email = process.argv[2]?.trim().toLowerCase();
    if (!email) throw new Error('usage: node health-import.js <user e-mail> < token.json');

    const tokens = JSON.parse(await readStdin()) as Partial<GoogleTokens>;
    if (typeof tokens.refresh_token !== 'string' || typeof tokens.access_token !== 'string') {
        throw new Error('the json on stdin has no access_token and refresh_token');
    }

    await db.init();
    const user = await User.findOne({ email }).lean();
    if (!user) throw new Error(`no user ${email}`);

    await saveTokens(user._id, { ...tokens, obtained_at: tokens.obtained_at ?? 0 } as GoogleTokens);
    const link = await HealthLink.findById(user._id).lean();
    const scopes = link?.scopes.length ?? 0;
    const expires = link?.refreshTokenExpiresAt ? new Date(link.refreshTokenExpiresAt).toISOString() : 'never (production app)';
    console.log(`Google Health linked to ${email}: ${scopes} scopes, refresh token expires ${expires}`);
    await disconnect();
}

main().catch(async (err) => {
    console.error(`import failed: ${err.message}`);
    await disconnect().catch(() => undefined);
    process.exit(1);
});
