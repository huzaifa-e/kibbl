import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../core/logger';
import { oauthProvider } from '../mcp/oauth';
import { createMcpServer } from '../mcp/tools';

const log = logger('mcp');

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

    // no sessions, so no stream to open and none to end
    app.all('/mcp', (_req, res) => {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    });
}
