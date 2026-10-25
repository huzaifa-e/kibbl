/*
 * Tokens for the MCP endpoint (/mcp). The token is printed once and stored only as its
 * hash; a token reads everything its user can see in the app, nothing more.
 *
 *   docker exec kibbl-app node mcp-token.js create user@example.com "laptop"
 *   docker exec kibbl-app node mcp-token.js create user@example.com "Bedroom TV" --light   (the light only, for the TV app)
 *   docker exec kibbl-app node mcp-token.js list
 *   docker exec kibbl-app node mcp-token.js revoke "laptop"
 *
 * list shows the connectors signed in through OAuth too; revoke with their name ends them.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: __dirname + '/.env' });
dotenv.config();

import { disconnect } from 'mongoose';
import db, { AccessToken, OAuthGrant, User } from './core/db';
import { createToken } from './mcp/tokens';

const usage = 'usage: node mcp-token.js create <user e-mail> <name> [--light] | list | revoke <name>';
const when = (t: number | undefined) => (t ? new Date(t).toLocaleString('sv-SE').slice(0, 16) : 'never');

async function main() {
    const [command, ...args] = process.argv.slice(2);
    await db.init();

    if (command === 'create') {
        const light = args.includes('--light');
        const [emailArg, nameArg] = args.filter((a) => a !== '--light');
        const email = emailArg?.trim().toLowerCase();
        const name = nameArg?.trim();
        if (!email || !name) throw new Error(usage);
        const user = await User.findOne({ email }).lean();
        if (!user) throw new Error(`no user ${email}`);
        if (await AccessToken.exists({ userID: user._id, name })) throw new Error(`${email} has a token named "${name}" already`);
        const token = await createToken(user._id, name, light ? 'light' : undefined);
        console.log(`token "${name}"${light ? ' (light only)' : ''} for ${email}, shown only now:\n${token}`);
    } else if (command === 'list') {
        const users = new Map((await User.find({}, { email: 1 }).lean()).map((u) => [u._id, u.email]));
        const tokens = await AccessToken.find().sort({ createdAt: 1 }).lean();
        const grants = await OAuthGrant.find().sort({ createdAt: 1 }).lean();
        if (!tokens.length && !grants.length) console.log('no tokens');
        for (const t of tokens) console.log(`${t.name}\t${users.get(t.userID) ?? '?'}\t${t.scope ? `${t.scope} token` : 'token'}\tcreated ${when(t.createdAt)}\tlast used ${when(t.lastUsedAt)}`);
        for (const g of grants)
            console.log(`${g.clientName}\t${users.get(g.userID) ?? '?'}\tconnector\tsigned in ${when(g.createdAt)}\tlast used ${when(g.lastUsedAt)}`);
    } else if (command === 'revoke') {
        const name = args[0]?.trim();
        if (!name) throw new Error(usage);
        const tokens = await AccessToken.deleteMany({ name });
        const grants = await OAuthGrant.deleteMany({ clientName: name });
        const deletedCount = tokens.deletedCount + grants.deletedCount;
        if (!deletedCount) throw new Error(`no token or connector named "${name}"`);
        console.log(`revoked ${deletedCount} token${deletedCount > 1 ? 's' : ''} named "${name}"`);
    } else {
        throw new Error(usage);
    }
    await disconnect();
}

main().catch(async (err) => {
    console.error(err.message);
    await disconnect().catch(() => undefined);
    process.exit(1);
});
