import express from 'express';
import { checkAuthMiddleware } from '../core/auth';
import { User } from '../core/db';
import { logger } from '../core/logger';
import { forgetHome, homeOf, searchPlaces, weatherForUser } from '../core/weather';

const log = logger('home');

/* Where the home of an account is (settings), and the weather outside it (kibbl. air). */
export default function initHomeRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;

    app.get('/api/home', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await homeOf(req.sessionInfo!.userID));
    });

    // { latitude, longitude, name }, or null to forget it
    app.put('/api/home', auth, async (req: RequestWithSessionInfo, res) => {
        const body = req.body as { latitude?: unknown; longitude?: unknown; name?: unknown } | null;
        const userID = req.sessionInfo!.userID;
        if (body === null || (body as { clear?: unknown })?.clear === true) {
            await User.updateOne({ _id: userID }, { $unset: { home: 1 } });
            forgetHome(userID);
            res.json({ ok: true });
            return;
        }
        const lat = Number(body?.latitude);
        const lon = Number(body?.longitude);
        const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : '';
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            res.status(400).send('latitude -90 to 90, longitude -180 to 180');
            return;
        }
        // a few hundred metres are plenty for the weather, and the exact address is not kept
        const home = { latitude: Math.round(lat * 100) / 100, longitude: Math.round(lon * 100) / 100, name: name || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
        await User.updateOne({ _id: userID }, { home });
        forgetHome(userID);
        log.info('home location set', { user: req.sessionInfo!.email, place: home.name });
        res.json({ ok: true, home });
    });

    app.get('/api/places', auth, async (req, res) => {
        const q = String(req.query.q ?? '').trim();
        if (q.length < 2 || q.length > 80) {
            res.json([]);
            return;
        }
        try {
            res.json(await searchPlaces(q));
        } catch (err) {
            log.warn('place search failed', { q }, err);
            res.status(502).send('The place search does not answer, try again.');
        }
    });

    // the weather outside the user's home now, null without a location
    app.get('/api/weather', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await weatherForUser(req.sessionInfo!.userID));
    });
}
