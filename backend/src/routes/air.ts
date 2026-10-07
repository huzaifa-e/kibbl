import express from 'express';
import { airEvents, airReadings, smokeDays } from '../core/air';
import { checkAuthMiddleware } from '../core/auth';
import { Device } from '../core/db';
import { summarize } from '../core/devices';
import { outdoorWeather } from '../core/weather';

const isDeviceID = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-F]{12}$/.test(v);
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// the kibbl. air, when it is the logged-in user's; anyone else's does not exist for them
async function ownAir(req: RequestWithSessionInfo) {
    if (!isDeviceID(req.params.id)) return null;
    const doc = await Device.findOne({ _id: req.params.id, ownerID: req.sessionInfo!.userID, status: 'approved' }).lean();
    return doc?.caps.includes('air') ? doc : null;
}

/* The history of a kibbl. air (core/air.ts); the live state comes over the socket. */
export default function initAirRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;

    app.get('/api/air/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const doc = await ownAir(req);
        if (!doc) {
            res.sendStatus(404);
            return;
        }
        res.json(summarize(doc));
    });

    // the weather outside the home now, null without HOME_LATITUDE/HOME_LONGITUDE
    app.get('/api/weather', auth, (req, res) => {
        res.json(outdoorWeather());
    });

    // a minute each, means of longer steps for long windows (?hours=24, up to a year)
    app.get('/api/air/:id/readings', auth, async (req: RequestWithSessionInfo, res) => {
        if (!(await ownAir(req))) {
            res.sendStatus(404);
            return;
        }
        const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 366 * 24);
        const to = new Date();
        res.json(await airReadings(req.params.id, new Date(to.getTime() - hours * HOUR_MS), to));
    });

    // cigarettes, windows and fire alerts of the last days (?days=7), newest first
    app.get('/api/air/:id/events', auth, async (req: RequestWithSessionInfo, res) => {
        if (!(await ownAir(req))) {
            res.sendStatus(404);
            return;
        }
        const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 366);
        res.json(await airEvents(req.params.id, Date.now() - days * DAY_MS));
    });

    // cigarettes per day (?days=30)
    app.get('/api/air/:id/smoke', auth, async (req: RequestWithSessionInfo, res) => {
        if (!(await ownAir(req))) {
            res.sendStatus(404);
            return;
        }
        const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 366);
        res.json(await smokeDays(req.params.id, days));
    });
}
