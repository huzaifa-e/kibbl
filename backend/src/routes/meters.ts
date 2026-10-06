import express from 'express';
import { checkAuthMiddleware } from '../core/auth';
import { Meter } from '../core/db';
import { logger } from '../core/logger';
import { addMeter, meterPeriods, meterReadings, meterState, removeMeter, syncNow } from '../meters/service';

const log = logger('meters');

const isUUID = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PERIODS = new Set(['day', 'month', 'year']);
const DAY_MS = 24 * 3600_000;

export default function initMeterRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;

    app.get('/api/meters', auth, async (_req, res) => {
        const meters = await Meter.find().sort({ addedAt: 1 }).lean();
        res.json(await Promise.all(meters.map(meterState)));
    });

    app.get('/api/meters/:id', auth, async (req, res) => {
        const meter = isUUID(req.params.id) ? await Meter.findById(req.params.id).lean() : null;
        if (!meter) {
            res.sendStatus(404);
            return;
        }
        res.json(await meterState(meter));
    });

    // consumption per day, month or year, as stored
    app.get('/api/meters/:id/periods', auth, async (req, res) => {
        const period = String(req.query.period ?? 'day');
        if (!isUUID(req.params.id) || !PERIODS.has(period)) {
            res.sendStatus(400);
            return;
        }
        res.json(await meterPeriods(req.params.id, period as 'day' | 'month' | 'year'));
    });

    // readings of a window (?days=2, up to all), thinned for long ones
    app.get('/api/meters/:id/readings', auth, async (req, res) => {
        if (!isUUID(req.params.id)) {
            res.sendStatus(400);
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
            const device = await addMeter(uuid.toLowerCase());
            log.info('meter added in the app', { meter: device.name, user: req.sessionInfo!.email });
            res.json({ ok: true, name: device.name });
        } catch (err) {
            res.status(404).json({ error: `No such device on the LoRaWAN server (${(err as Error).message}).` });
        }
    });

    app.post('/api/meters/:id/sync', auth, (_req, res) => {
        syncNow();
        res.json({ ok: true });
    });

    // removes the meter and kibbl's copy of its data; the LoRaWAN server keeps its own
    app.delete('/api/meters/:id', auth, async (req: RequestWithSessionInfo, res) => {
        if (!isUUID(req.params.id)) {
            res.sendStatus(400);
            return;
        }
        await removeMeter(req.params.id);
        log.info('meter removed with its copied data', { meter: req.params.id, user: req.sessionInfo!.email });
        res.json({ ok: true });
    });
}
