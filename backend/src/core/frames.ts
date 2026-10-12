import express from 'express';
import sharp from 'sharp';
import { Device } from './db';
import { changeSnapshotWaiters, changeViewers } from './devices';
import { logger } from './logger';

const log = logger('stream');
import { onFrameForMotion } from './motion';

const BOUNDARY = 'hmframe';
// a viewer more than this many bytes behind is skipped until it caught up
const MAX_BUFFERED = 512 * 1024;

interface LatestFrame {
    jpeg: Buffer;
    time: number;
}

const latest = new Map<string, LatestFrame>();
const subscribers = new Map<string, Set<express.Response>>();
const snapshotWaiters = new Map<string, Set<(frame: LatestFrame | undefined) => void>>();

// SOI marker: a binary message that is not a jpeg is dropped before it reaches a viewer
function isJpeg(buf: Buffer) {
    return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

/* A camera turned by a quarter (DeviceDoc.turn90): its sensor only flips, so the server turns
 * every frame, once, before the viewers, snapshots, motion and its pictures see it. A frame
 * arriving while the one before is still being turned is dropped: the camera waits for nothing. */
const turned = new Map<string, boolean>();
const turning = new Set<string>();

export function setTurn90(deviceId: string, on: boolean) {
    turned.set(deviceId, on);
}

export function onFrame(deviceId: string, jpeg: Buffer) {
    if (!isJpeg(jpeg)) {
        log.warn('binary message without jpeg header dropped', { device: deviceId, bytes: jpeg.length });
        return;
    }
    const turn = turned.get(deviceId);
    if (turn === undefined) {
        turned.set(deviceId, false); // until the database answers
        Device.findById(deviceId, { turn90: 1 })
            .lean()
            .then((doc) => doc?.turn90 && turned.set(deviceId, true))
            .catch(() => undefined);
    }
    if (!turn) {
        deliver(deviceId, jpeg);
        return;
    }
    if (turning.has(deviceId)) {
        return;
    }
    turning.add(deviceId);
    sharp(jpeg)
        .rotate(90)
        .jpeg({ quality: 85 })
        .toBuffer()
        .then((out) => deliver(deviceId, out))
        .catch((err) => log.warn('frame not turned', { device: deviceId, error: String(err) }))
        .finally(() => turning.delete(deviceId));
}

function deliver(deviceId: string, jpeg: Buffer) {
    const frame = { jpeg, time: Date.now() };
    latest.set(deviceId, frame);

    const subs = subscribers.get(deviceId);
    if (subs) {
        const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        for (const res of subs) {
            // a slow phone on mobile data skips frames instead of falling minutes behind
            if (res.writableLength > MAX_BUFFERED) {
                continue;
            }
            res.write(header);
            res.write(jpeg);
            res.write('\r\n');
        }
    }

    const waiters = snapshotWaiters.get(deviceId);
    if (waiters) {
        snapshotWaiters.delete(deviceId);
        for (const resolve of waiters) {
            resolve(frame);
        }
    }

    onFrameForMotion(deviceId, jpeg);
}

export function latestFrame(deviceId: string) {
    return latest.get(deviceId);
}

export function forgetFrames(deviceId: string) {
    latest.delete(deviceId);
}

/* An <img src="/api/devices/:id/stream"> shows this multipart response as video in
 * every browser, no player needed. The device streams while at least one is open. */
export function subscribeStream(deviceId: string, req: express.Request, res: express.Response) {
    res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Connection: 'close',
        'X-Accel-Buffering': 'no', // nginx: pass frames on at once
    });

    let subs = subscribers.get(deviceId);
    if (!subs) {
        subs = new Set();
        subscribers.set(deviceId, subs);
    }
    subs.add(res);
    changeViewers(deviceId, 1);

    // the last frame at once, so the picture does not stay black until the next one
    const frame = latest.get(deviceId);
    if (frame) {
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n\r\n`);
        res.write(frame.jpeg);
        res.write('\r\n');
    }

    req.on('close', () => {
        subs!.delete(res);
        if (subs!.size === 0) {
            subscribers.delete(deviceId);
        }
        changeViewers(deviceId, -1);
    });
}

/* A frame newer than maxAgeMs: the latest one when it is fresh, otherwise the device
 * is asked to stream until the next frame arrives (or timeoutMs passes). */
export async function freshFrame(deviceId: string, maxAgeMs: number, timeoutMs: number) {
    const frame = latest.get(deviceId);
    if (frame && Date.now() - frame.time <= maxAgeMs) {
        return frame;
    }

    changeSnapshotWaiters(deviceId, 1);
    try {
        return await new Promise<LatestFrame | undefined>((resolve) => {
            let waiters = snapshotWaiters.get(deviceId);
            if (!waiters) {
                waiters = new Set();
                snapshotWaiters.set(deviceId, waiters);
            }
            const done = (f: LatestFrame | undefined) => {
                clearTimeout(timer);
                resolve(f);
            };
            const timer = setTimeout(() => {
                snapshotWaiters.get(deviceId)?.delete(done);
                resolve(undefined);
            }, timeoutMs);
            waiters.add(done);
        });
    } finally {
        changeSnapshotWaiters(deviceId, -1);
    }
}
