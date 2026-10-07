import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkAuthMiddleware } from '../core/auth';
import { AccessToken, OAuthGrant } from '../core/db';
import { logger } from '../core/logger';
import { oauthProvider } from '../mcp/oauth';
import { createToken } from '../mcp/tokens';
import { createMcpServer } from '../mcp/tools';

const log = logger('mcp');

const MAX_TOKENS = 20;
const isHash = (v: string) => /^[0-9a-f]{64}$/.test(v);
const isUUID = (v: string) => /^[0-9a-f-]{36}$/.test(v);

// twenty wrong tokens per address in 15 minutes, then a pause
const tokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});

// ten wrong passwords on the connector's sign-in page per address in 15 minutes
const signInLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: 'Too many failed sign-ins. Try again in 15 minutes.',
});

/* The MCP endpoint (Streamable HTTP), for AI assistants and other MCP clients. A token
 * from mcp-token.js opens it; with MCP_PUBLIC_URL (the https address it is reached at
 * from the internet) OAuth is offered too, for assistants that connect themselves.
 * Stateless: every request gets a server and transport of its own. */
export default function initMcpRoutes(app: express.Application) {
    /* What a connector asks for while it sets itself up, and every refused call: without it
     * a connector that gives up says nothing about where. Successful tool calls are logged below. */
    app.use(['/mcp', '/authorize', '/token', '/register', '/revoke', '/.well-known'], (req, res, next) => {
        res.on('finish', () => {
            if (req.method === 'POST' && req.baseUrl === '/mcp' && res.statusCode < 400) return;
            log.info('connector request', {
                method: req.method,
                path: req.originalUrl.split('?')[0].slice(0, 80),
                status: res.statusCode,
                agent: (req.header('user-agent') ?? '').slice(0, 60),
                ip: req.ip,
            });
        });
        next();
    });

    const publicUrl = process.env.MCP_PUBLIC_URL?.replace(/\/+$/, '');
    let resourceMetadataUrl: string | undefined;
    if (publicUrl) {
        const resource = new URL(`${publicUrl}/mcp`);
        resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
        app.post('/authorize', signInLimiter);
        app.use(mcpAuthRouter({ provider: oauthProvider, issuerUrl: new URL(`${publicUrl}/`), resourceServerUrl: resource, resourceName: 'kibbl.' }));
        log.info('OAuth for connectors on', { url: publicUrl });
    }

    const bearer = requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl });

    app.post('/mcp', tokenLimiter, bearer, async (req, res) => {
        const session = req.auth?.extra?.session as SessionInfo;
        const server = createMcpServer(session);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            transport.close();
            server.close();
        });
        if (req.body?.method === 'tools/call')
            log.info('tool called', { tool: String(req.body.params?.name ?? ''), user: session.email, client: req.auth?.clientId });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    /* ------------------------------------------------------------------- */

    /* The settings page: the address to give an assistant, and the user's own tokens and
     * connected assistants, to create and revoke. Never another user's. */
    const auth = checkAuthMiddleware as express.RequestHandler;

    app.get('/api/mcp', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        const [tokens, grants] = await Promise.all([
            AccessToken.find({ userID }).sort({ createdAt: 1 }).lean(),
            OAuthGrant.find({ userID, refreshExpiresAt: { $gt: Date.now() } }).sort({ createdAt: 1 }).lean(),
        ]);
        res.json({
            connectorUrl: publicUrl ? `${publicUrl}/mcp` : null,
            tokens: tokens.map((t) => ({ id: t._id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt ?? null })),
            connectors: grants.map((g) => ({ id: g._id, name: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt ?? null })),
        });
    });

    // the token is in this answer only: the server keeps its hash
    app.post('/api/mcp/tokens', auth, async (req: RequestWithSessionInfo, res) => {
        const userID = req.sessionInfo!.userID;
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name || name.length > 40) {
            res.status(400).send('A name of up to 40 characters is needed.');
            return;
        }
        if (await AccessToken.exists({ userID, name })) {
            res.status(409).send(`You have a token named "${name}" already.`);
            return;
        }
        if ((await AccessToken.countDocuments({ userID })) >= MAX_TOKENS) {
            res.status(409).send(`At most ${MAX_TOKENS} tokens. Revoke one you no longer use.`);
            return;
        }
        const token = await createToken(userID, name);
        log.info('token created in the app', { name, user: req.sessionInfo!.email });
        res.json({ token });
    });

    app.delete('/api/mcp/tokens/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const { deletedCount } = isHash(req.params.id) ? await AccessToken.deleteOne({ _id: req.params.id, userID: req.sessionInfo!.userID }) : { deletedCount: 0 };
        if (deletedCount) log.info('token revoked in the app', { user: req.sessionInfo!.email });
        res.sendStatus(deletedCount ? 200 : 404);
    });

    app.delete('/api/mcp/connectors/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const { deletedCount } = isUUID(req.params.id) ? await OAuthGrant.deleteOne({ _id: req.params.id, userID: req.sessionInfo!.userID }) : { deletedCount: 0 };
        if (deletedCount) log.info('connector disconnected in the app', { user: req.sessionInfo!.email });
        res.sendStatus(deletedCount ? 200 : 404);
    });

    // no sessions, so no stream to open and none to end
    app.all('/mcp', (_req, res) => {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    });
}
