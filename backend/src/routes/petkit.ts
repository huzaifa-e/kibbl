import express from 'express';
import { PETKIT_REGIONS } from '../../../shared/petkit';
import { checkAuthMiddleware } from '../core/auth';
import { logger } from '../core/logger';
import { PetkitError } from '../petkit/client';
import { cancelFeed, connect, disconnect, feed, pausePlan, resetDesiccant, skipMeal, status, watchWith } from '../petkit/service';

const log = logger('petkit');

function fail(res: express.Response, err: unknown) {
    const code = err instanceof PetkitError ? err.code : undefined;
    const status = code === 400 || code === 404 || code === 409 ? code : code === 122 || code === 125 ? 401 : 502;
    if (status === 502) log.warn('PetKit request failed', undefined, err);
    res.status(status).send((err as Error).message);
}

/* PetKit feeders through PetKit's cloud (petkit/service.ts). */
export default function initPetkitRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;
    const user = (req: RequestWithSessionInfo) => req.sessionInfo!.userID;
    const who = (req: RequestWithSessionInfo) => req.sessionInfo!.email;
    const feederId = (req: express.Request) => Number(req.params.id);
    const run = (fn: (req: RequestWithSessionInfo) => Promise<unknown>) => async (req: RequestWithSessionInfo, res: express.Response) => {
        if (!Number.isInteger(feederId(req))) {
            res.status(400).send('no such feeder');
            return;
        }
        try {
            await fn(req);
            res.json(await status(user(req)));
        } catch (err) {
            fail(res, err);
        }
    };

    app.get('/api/petkit', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await status(user(req)));
    });

    // { email, password, region }: the password goes to PetKit and is kept only as its login takes it
    app.post('/api/petkit/connect', auth, async (req: RequestWithSessionInfo, res) => {
        const { email, password, region } = req.body ?? {};
        if (typeof email !== 'string' || !email.includes('@') || email.length > 200 || typeof password !== 'string' || !password || password.length > 200) {
            res.status(400).send('the e-mail and the password of the PetKit account');
            return;
        }
        if (!PETKIT_REGIONS.some((r) => r.id === region)) {
            res.status(400).send(`a region: ${PETKIT_REGIONS.map((r) => r.id).join(', ')}`);
            return;
        }
        try {
            res.json(await connect(user(req), email.trim(), password, region));
        } catch (err) {
            fail(res, err);
        }
    });

    app.delete('/api/petkit', auth, async (req: RequestWithSessionInfo, res) => {
        await disconnect(user(req));
        res.json({ ok: true });
    });

    // { portions }
    app.post(
        '/api/petkit/feeders/:id/feed',
        auth,
        run((req) => feed(user(req), feederId(req), Number(req.body?.portions), who(req))),
    );
    app.post(
        '/api/petkit/feeders/:id/cancel',
        auth,
        run((req) => cancelFeed(user(req), feederId(req), who(req))),
    );
    // { skip: true } skips a meal of today's plan, { skip: false } gives it after all
    app.post(
        '/api/petkit/feeders/:id/meals/:meal',
        auth,
        run((req) => skipMeal(user(req), feederId(req), String(req.params.meal), req.body?.skip !== false, who(req))),
    );
    // { paused }
    app.post(
        '/api/petkit/feeders/:id/plan',
        auth,
        run((req) => pausePlan(user(req), feederId(req), req.body?.paused === true, who(req))),
    );
    app.post(
        '/api/petkit/feeders/:id/desiccant',
        auth,
        run((req) => resetDesiccant(user(req), feederId(req), who(req))),
    );
    // { cameraId } of a kibbl. cam that watches the feeder, or null
    app.put(
        '/api/petkit/feeders/:id/camera',
        auth,
        run((req) => {
            const cameraId = req.body?.cameraId;
            if (cameraId !== null && !(typeof cameraId === 'string' && /^[0-9A-F]{12}$/.test(cameraId))) throw new PetkitError('no such camera', 400);
            return watchWith(user(req), feederId(req), cameraId);
        }),
    );
}
