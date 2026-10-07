import * as dotenv from 'dotenv';
dotenv.config({ path: __dirname + '/.env' });
dotenv.config(); // a .env in the working directory, for development

import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import sirv from 'sirv';
import db from './core/db';
import { ensureAdminUser } from './core/auth';
import { logger } from './core/logger';

const log = logger('server');
import { closeStaleEvents, initMotionWatchdog } from './core/motion';
import { initStorageCleanup } from './core/storage';
import { initHealthSync } from './health/service';
import { initMeterSync } from './meters/service';
import { initRoutes } from './routes';
import { sendPage } from './routes/pages';
import { initBrowserSocket } from './sockets/browser-socket';
import { initDeviceSocket } from './sockets/device-socket';

/* One process on purpose: the device sockets, the stream viewers and the motion
 * state live in its memory. A home has a handful of cameras, not thousands. */
const requiredEnvKeys = ['PORT', 'MONGODB_URI', 'JWT_SECRET'];

for (const key of requiredEnvKeys) {
    if (process.env[key] === undefined) {
        throw new Error(`Environment variable ${key} is missing`);
    }
}
if ((process.env.JWT_SECRET as string).length < 32) {
    throw new Error('JWT_SECRET needs at least 32 characters');
}

if (process.env.NODE_ENV !== 'production') {
    log.warn('running in development mode');
}

async function main() {
    await db.init();
    await ensureAdminUser();
    initStorageCleanup();
    await closeStaleEvents();
    initMotionWatchdog();
    initHealthSync();
    initMeterSync();

    const app: express.Application = express();
    app.disable('x-powered-by');
    app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
    app.use(cookieParser());
    app.use(express.json({ limit: '100kb' }));

    app.use((req, res, next) => {
        // Security headers
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

        if (!db.isConnected() && (req.path.startsWith('/api') || req.path === '/mcp')) {
            res.sendStatus(503);
            return;
        }
        next();
    });

    const httpServer = http.createServer(app);

    initRoutes(app);
    initBrowserSocket(httpServer);
    initDeviceSocket(httpServer);
    app.use(
        '/',
        sirv(__dirname + '/frontend', {
            dev: process.env.NODE_ENV !== 'production',
        }),
    );

    app.use((req, res) => {
        if (req.path.startsWith('/api') || req.header('user-agent')?.includes('KibblHW')) {
            res.sendStatus(404);
            return;
        }
        sendPage(res, '404');
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
        log.error('request failed', { method: req.method, path: req.path }, err);
        if (!res.headersSent) {
            res.status(err.name === 'MulterError' ? 400 : 500).send(err.name === 'MulterError' ? err.message : 'Internal Server Error');
        }
    });

    const port = Number(process.env.PORT);
    const ip = process.env.IP || '0.0.0.0';
    httpServer.listen(port, ip, () => {
        log.info('listening', { url: `http://${ip}:${port}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, env: process.env.NODE_ENV });
    });
}

/* The device and browser sockets start database calls nobody waits for. One that fails
 * while the database is away (restart, network) is logged; the process keeps its
 * device connections and mongoose reconnects. */
process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection', undefined, err);
});

main().catch((err) => {
    log.error('start failed', undefined, err);
    process.exit(1);
});
