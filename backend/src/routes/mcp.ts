import express from 'express';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../core/logger';
import { checkToken } from '../mcp/tokens';
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

/* The MCP endpoint (Streamable HTTP), for AI assistants and other MCP clients: a token from
 * mcp-token.js in the Authorization header. Stateless: every request gets a server and
 * transport of its own, nothing is kept between them. */
export default function initMcpRoutes(app: express.Application) {
    app.post('/mcp', tokenLimiter, async (req: RequestWithSessionInfo, res) => {
        const header = req.header('authorization') ?? '';
        const session = await checkToken(header.startsWith('Bearer ') ? header.slice(7).trim() : undefined);
        if (!session) {
            log.warn('token refused', { ip: req.ip });
            res.setHeader('WWW-Authenticate', 'Bearer realm="kibbl"');
            res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
            return;
        }

        const server = createMcpServer(session);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            transport.close();
            server.close();
        });
        const method = typeof req.body?.method === 'string' ? req.body.method : 'batch';
        if (method === 'tools/call') log.info('tool called', { tool: String(req.body.params?.name ?? ''), user: session.email });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });

    // no sessions, so no stream to open and none to end
    app.all('/mcp', (_req, res) => {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    });
}
