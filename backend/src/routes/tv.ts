import express from 'express';
import rateLimit from 'express-rate-limit';
import { EFFECT_INFO, LIGHT_EFFECTS, LIGHT_MOODS, RAMP_MINUTES, hexOf, type LightEffect } from '../../../shared/light';
import { runDeviceCommand } from '../core/control';
import { Device } from '../core/db';
import { summarize } from '../core/devices';
import { runAction, setMood, stopShow } from '../core/lightShow';
import { logger } from '../core/logger';
import { checkToken } from '../mcp/tokens';

/*
 * The light controls of the TV app (tv/): the user's kibbl. lights, their moods and effects.
 * The app holds a token of scope "light" (mcp-token.js create ... --light), which opens these
 * routes and nothing else. Changes are logged "via tv".
 */

const log = logger('tv');
const VIA = 'tv';

// wrong tokens per address in 15 minutes, then a pause
const tokenLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false });

async function lightAuth(req: RequestWithSessionInfo, res: express.Response, next: express.NextFunction) {
    const header = req.header('authorization') ?? '';
    const session = header.startsWith('Bearer ') ? await checkToken(header.slice(7).trim(), 'light') : undefined;
    if (!session) {
        res.sendStatus(401);
        return;
    }
    req.sessionInfo = session;
    next();
}

const lightsOf = (userID: string) => Device.find({ ownerID: userID, status: 'approved', caps: 'rgb' }).sort({ createdAt: 1 }).lean();

function lightOut(doc: DeviceDoc) {
    const s = summarize(doc);
    return {
        id: s._id,
        name: s.name,
        online: s.online,
        on: s.rgb?.on ?? false,
        color: s.rgb ? hexOf(s.rgb.color) : null,
        brightness: s.rgb?.brightness ?? null,
        playing: s.lightShow?.name ?? null,
    };
}

export default function initTvRoutes(app: express.Application) {
    const auth = [tokenLimiter, lightAuth as express.RequestHandler];

    app.get('/api/tv/light', ...auth, async (req: RequestWithSessionInfo, res: express.Response) => {
        res.json({
            lights: (await lightsOf(req.sessionInfo!.userID)).map(lightOut),
            moods: Object.entries(LIGHT_MOODS).map(([id, m]) => ({ id, label: m.label, color: hexOf(m.color) })),
            effects: LIGHT_EFFECTS.map((id) => ({ id, label: EFFECT_INFO[id].label })),
        });
    });

    // one of: on (true/false), brightness (1-100), mood, effect (with minutes for sunrise/sunset), stop
    app.post('/api/tv/light/:id', ...auth, async (req: RequestWithSessionInfo, res: express.Response) => {
        const { userID, email } = req.sessionInfo!;
        const doc = (await lightsOf(userID)).find((d) => d._id === req.params.id);
        if (!doc) {
            res.sendStatus(404);
            return;
        }
        const b = (req.body ?? {}) as Record<string, unknown>;
        let error: string | undefined;
        if (typeof b.on === 'boolean' || typeof b.brightness === 'number') {
            const cmd: Record<string, unknown> = { cmd: 'rgb' };
            if (typeof b.on === 'boolean') cmd.on = b.on;
            if (typeof b.brightness === 'number') {
                cmd.brightness = Math.min(100, Math.max(1, Math.round(b.brightness)));
                cmd.on = true;
            }
            const r = await runDeviceCommand(doc, cmd, email, VIA);
            error = r.ok ? undefined : (r.error ?? 'failed');
        } else if (typeof b.mood === 'string') {
            const r = await setMood(doc._id, b.mood, email, VIA);
            error = r.ok ? undefined : r.error;
        } else if (typeof b.effect === 'string' && LIGHT_EFFECTS.includes(b.effect as LightEffect)) {
            const minutes = typeof b.minutes === 'number' ? Math.min(RAMP_MINUTES.max, Math.max(RAMP_MINUTES.min, Math.round(b.minutes))) : undefined;
            const r = await runAction(doc._id, { kind: 'effect', effect: b.effect as LightEffect, minutes }, email, VIA);
            error = r.ok ? undefined : r.error;
        } else if (b.stop === true) {
            if (stopShow(doc._id)) log.info('light effect stopped', { device: doc._id, user: email, via: VIA });
        } else {
            res.status(400).send('on, brightness, mood, effect or stop');
            return;
        }
        if (error) {
            res.status(409).send(error);
            return;
        }
        const fresh = await Device.findById(doc._id).lean();
        res.json(lightOut(fresh ?? doc));
    });
}
