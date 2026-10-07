import express from 'express';
import { checkAuthMiddleware } from '../core/auth';
import { Meter } from '../core/db';
import { logger } from '../core/logger';
import { MeterTakenError, addMeter, meterPeriods, meterReadings, meterState, removeMeter } from '../meters/service';

const log = logger('meters');

const isUUID = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PERIODS = new Set(['day', 'month', 'year']);
const DAY_MS = 24 * 3600_000;

// the meter, when it is the logged-in user's; anyone else's does not exist for them
async function ownMeter(req: RequestWithSessionInfo) {
    return isUUID(req.params.id) ? await Meter.findOne({ _id: req.params.id, ownerID: req.sessionInfo!.userID }).lean() : null;
}

export default function initMeterRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;

    app.get('/api/meters', auth, async (req: RequestWithSessionInfo, res) => {
        const meters = await Meter.find({ ownerID: req.sessionInfo!.userID }).sort({ addedAt: 1 }).lean();
        res.json(await Promise.all(meters.map(meterState)));
    });

    app.get('/api/meters/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const meter = await ownMeter(req);
        if (!meter) {
            res.sendStatus(404);
            return;
        }
        res.json(await meterState(meter));
    });

    // consumption per day, month or year, as stored
    app.get('/api/meters/:id/periods', auth, async (req: RequestWithSessionInfo, res) => {
        const period = String(req.query.period ?? 'day');
        if (!PERIODS.has(period)) {
            res.sendStatus(400);
            return;
        }
        if (!(await ownMeter(req))) {
            res.sendStatus(404);
            return;
        }
        res.json(await meterPeriods(req.params.id, period as 'day' | 'month' | 'year'));
    });

    // readings of a window (?days=2, up to all), thinned for long ones
    app.get('/api/meters/:id/readings', auth, async (req: RequestWithSessionInfo, res) => {
        if (!(await ownMeter(req))) {
            res.sendStatus(404);
            return;
        }
        const days = Math.min(Math.max(Number(req.query.days) || 2, 1), 3650);
        const to = new Date();
        res.json(await meterReadings(req.params.id, new Date(to.getTime() - days * DAY_MS), to));
    });

    app.post('/api/meters', auth, async (req: RequestWithSessionInfo, res) => {
        const uuid = req.body?.uuid;
        if (!isUUID(uuid)) {
            res.status(400).json({ error: 'The device id is a uuid, as in the address of its dashboard.' });
            return;
        }
        try {
            const device = await addMeter(uuid.toLowerCase(), req.sessionInfo!.userID);
            log.info('meter added in the app', { meter: device.name, user: req.sessionInfo!.email });
            res.json({ ok: true, name: device.name });
        } catch (err) {
            if (err instanceof MeterTakenError) {
                res.status(409).json({ error: 'Another kibbl. account has added this meter already.' });
                return;
            }
            res.status(404).json({ error: `No such device on the LoRaWAN server (${(err as Error).message}).` });
        }
    });

    // removes the meter and kibbl's copy of its data; the LoRaWAN server keeps its own
    app.delete('/api/meters/:id', auth, async (req: RequestWithSessionInfo, res) => {
        if (!(await ownMeter(req))) {
            res.sendStatus(404);
            return;
        }
        await removeMeter(req.params.id);
        log.info('meter removed with its copied data', { meter: req.params.id, user: req.sessionInfo!.email });
        res.json({ ok: true });
    });
}
