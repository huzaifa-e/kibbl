import express from 'express';
import { checkAuthMiddleware } from '../core/auth';
import { Device, MotionEventModel } from '../core/db';
import { freshFrame, latestFrame, subscribeStream } from '../core/frames';
import { ownedDeviceIds } from '../core/owners';
import { imageRoot, resolveInside } from '../core/storage';

const SNAPSHOT_MAX_AGE_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 6000;

const isDeviceID = (v: string) => /^[0-9A-F]{12}$/.test(v);
const isUUID = (v: string) => /^[0-9a-f-]{36}$/.test(v);

// an approved device of the logged-in user; anyone else's does not exist for them
async function approvedDevice(req: RequestWithSessionInfo, res: express.Response) {
    const deviceId = req.params.deviceID;
    const doc = isDeviceID(deviceId) ? await Device.findById(deviceId).lean() : null;
    if (!doc || doc.status !== 'approved' || doc.ownerID !== req.sessionInfo!.userID) {
        res.sendStatus(404);
        return undefined;
    }
    return doc;
}

export default function initStreamRoutes(app: express.Application) {
    app.get('/api/devices/:deviceID/stream', checkAuthMiddleware, async (req, res) => {
        const doc = await approvedDevice(req, res);
        if (doc) {
            subscribeStream(doc._id, req, res);
        }
    });

    // ?fresh=1 waits for a new frame from the device, otherwise the last one is fine
    app.get('/api/devices/:deviceID/snapshot', checkAuthMiddleware, async (req, res) => {
        const doc = await approvedDevice(req, res);
        if (!doc) {
            return;
        }
        const frame = req.query.fresh ? await freshFrame(doc._id, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_TIMEOUT_MS) : latestFrame(doc._id);
        if (!frame) {
            res.sendStatus(204);
            return;
        }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Time', String(frame.time));
        if (req.query.download) {
            const stamp = new Date(frame.time).toISOString().replace(/[:.]/g, '-');
            res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w-]+/g, '_')}-${stamp}.jpg"`);
        }
        res.send(frame.jpeg);
    });

    app.get('/api/events/:eventID/image', checkAuthMiddleware, async (req, res) => {
        const eventId = req.params.eventID;
        const doc = isUUID(eventId) ? await MotionEventModel.findById(eventId).lean() : null;
        if (!doc?.snapshot || !(await ownedDeviceIds((req as RequestWithSessionInfo).sessionInfo!.userID)).includes(doc.deviceId)) {
            res.sendStatus(404);
            return;
        }
        res.setHeader('Cache-Control', 'private, max-age=86400');
        res.sendFile(resolveInside(imageRoot(), doc.snapshot), (err) => {
            if (err && !res.headersSent) {
                res.sendStatus(404);
            }
        });
    });
}
