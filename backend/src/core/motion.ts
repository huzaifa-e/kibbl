import crypto from 'node:crypto';
import sharp from 'sharp';
import type { MotionEvent } from '../../../shared/protocol';
import { Device, MotionEventModel } from './db';
import { motionFps, sendCommand } from './devices';
import { hub } from './hub';
import { log } from './logger';
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH, MotionDetector, inQuietHours } from './motionDetector';
import { deleteSnapshot, saveSnapshot } from './storage';

const EVENT_GAP_MS = 10_000; // calm this long ends an event
const EVENT_MAX_MS = 10 * 60_000; // a longer visit is split into several events on the timeline
const SNAPSHOT_MIN_GAP_MS = 2000; // the event picture is replaced by a better one at most this often
const SETTINGS_TTL_MS = 5000; // motion settings are read from the database at most this often

/* The white light flashes once when a movement starts, not again while it goes on. A
 * flash brightens the next frames and the camera's auto exposure takes a moment to
 * settle: those frames are skipped, and the first one after them is the new background,
 * so the settling exposure is not compared with the picture from before the flash. */
const BLINK_BLIND_MS = 2000;
const BLINK = { cmd: 'blink', count: 2, level: 30 };

interface CurrentEvent {
    doc: MotionEventDoc;
    lastMotion: number;
    bestScore: number;
    lastSnapshot: number;
}

interface DeviceMotion {
    detector: MotionDetector;
    busy: boolean;
    lastAnalysis: number;
    current?: CurrentEvent;
    settings?: DeviceDoc['motion'];
    canBlink: boolean;
    settingsTime: number;
    lastBlink: number;
    freshBackground: boolean; // after a flash: the next analysed frame becomes the background
}

const devices = new Map<string, DeviceMotion>();

export function toMotionEvent(doc: MotionEventDoc): MotionEvent {
    return {
        _id: doc._id,
        deviceId: doc.deviceId,
        start: doc.start,
        end: doc.end,
        peakScore: doc.peakScore,
        frames: doc.frames,
        hasSnapshot: !!doc.snapshot,
    };
}

function state(deviceId: string) {
    let s = devices.get(deviceId);
    if (!s) {
        s = { detector: new MotionDetector(), busy: false, lastAnalysis: 0, settingsTime: 0, canBlink: false, lastBlink: 0, freshBackground: false };
        devices.set(deviceId, s);
    }
    return s;
}

async function settingsOf(deviceId: string, s: DeviceMotion) {
    if (!s.settings || Date.now() - s.settingsTime > SETTINGS_TTL_MS) {
        const doc = await Device.findById(deviceId, { motion: 1, status: 1, caps: 1 }).lean();
        s.settings = doc?.status === 'approved' ? doc.motion : undefined;
        s.canBlink = !!doc?.caps?.includes('blink');
        s.settingsTime = Date.now();
    }
    return s.settings;
}

// the settings changed in the app: read them again on the next frame
export function invalidateMotionSettings(deviceId: string) {
    const s = devices.get(deviceId);
    if (s) {
        s.settingsTime = 0;
    }
}

/* The pictures of the camera were deleted while one of its events is still open: that
 * event takes no new one, else its file would come back after the delete. */
export function dropCurrentPicture(deviceId: string) {
    const current = devices.get(deviceId)?.current;
    if (current) {
        current.doc.snapshot = undefined;
        current.lastSnapshot = Number.POSITIVE_INFINITY;
    }
}

async function closeEvent(deviceId: string, s: DeviceMotion) {
    const current = s.current;
    if (!current) {
        return;
    }
    s.current = undefined;
    current.doc.end = current.lastMotion;
    await MotionEventModel.updateOne({ _id: current.doc._id }, { end: current.doc.end, peakScore: current.doc.peakScore, frames: current.doc.frames });
    hub.emit('motionEvent', toMotionEvent(current.doc));
}

async function analyzeFrame(deviceId: string, s: DeviceMotion, jpeg: Buffer, time: number) {
    const settings = await settingsOf(deviceId, s);
    if (!settings?.enabled) {
        await closeEvent(deviceId, s);
        return;
    }

    const gray = await sharp(jpeg).resize(ANALYSIS_WIDTH, ANALYSIS_HEIGHT, { fit: 'fill' }).greyscale().raw().toBuffer();
    if (s.freshBackground) {
        s.freshBackground = false;
        s.detector.reset();
    }
    const result = s.detector.analyze(new Uint8Array(gray.buffer, gray.byteOffset, gray.length), settings.sensitivity);

    const quiet = inQuietHours(new Date(time).getHours(), settings.quietFrom, settings.quietTo);
    if (result.motion && !quiet) {
        let current = s.current;
        if (current && time - current.doc.start > EVENT_MAX_MS) {
            await closeEvent(deviceId, s);
            current = undefined;
        }
        if (!current) {
            const doc: MotionEventDoc = { _id: crypto.randomUUID(), deviceId, start: time, peakScore: result.score, frames: 0 };
            /* A picture only when the camera's settings keep pictures: otherwise the movement
             * is logged as activity (when, how long, how much moved) and the frame is never
             * written anywhere. Settings stored before the option existed keep none, as new ones. */
            if (settings.keepPictures) {
                doc.snapshot = await saveSnapshot(deviceId, doc._id, time, jpeg);
            }
            await MotionEventModel.create(doc);
            current = { doc, lastMotion: time, bestScore: result.score, lastSnapshot: time };
            s.current = current;
            // settings stored before the option existed have no blink: they blink, as new ones do
            if ((settings.blink ?? true) && s.canBlink) {
                s.lastBlink = time;
                s.freshBackground = true;
                sendCommand(deviceId, BLINK).then((resp) => {
                    if (!resp.ok) log('debug', `${deviceId}: blink not taken (${resp.error})`);
                });
            }
            hub.emit('motionEvent', toMotionEvent(doc));
            log('debug', `${deviceId}: motion (${(result.score * 100).toFixed(1)} %)`);
        }
        current.lastMotion = time;
        current.doc.frames++;
        current.doc.peakScore = Math.max(current.doc.peakScore, result.score);

        // the picture with the most change shows the visitor best; an event without one takes the next
        const better = !current.doc.snapshot || result.score > current.bestScore * 1.2;
        if (settings.keepPictures && better && time > current.lastSnapshot + SNAPSHOT_MIN_GAP_MS) {
            current.bestScore = result.score;
            current.lastSnapshot = time;
            const old = current.doc.snapshot;
            current.doc.snapshot = await saveSnapshot(deviceId, current.doc._id, time, jpeg);
            if (old !== current.doc.snapshot) {
                // a new file (the day changed, or pictures were switched on during the event)
                await MotionEventModel.updateOne({ _id: current.doc._id }, { snapshot: current.doc.snapshot });
                await deleteSnapshot(old);
            }
        }
    } else if (s.current && time - s.current.lastMotion > EVENT_GAP_MS) {
        await closeEvent(deviceId, s);
    }
}

/* Called with every frame a camera sends; analyses at most MOTION_FPS of them and
 * never two of one camera at once (a slow decode drops frames, it does not queue). */
export function onFrameForMotion(deviceId: string, jpeg: Buffer) {
    const s = state(deviceId);
    const now = Date.now();
    if (s.busy || now - s.lastAnalysis < 1000 / motionFps() - 20 || now - s.lastBlink < BLINK_BLIND_MS) {
        return;
    }
    s.busy = true;
    s.lastAnalysis = now;
    analyzeFrame(deviceId, s, jpeg, now)
        .catch((err) => log('error', `${deviceId}: motion analysis failed: ${err.message}`))
        .finally(() => {
            s.busy = false;
        });
}

// the camera went offline or was removed: an open event ends with its last motion
export async function endMotion(deviceId: string) {
    const s = devices.get(deviceId);
    if (s) {
        await closeEvent(deviceId, s);
        devices.delete(deviceId);
    }
}

/* Events still open from before a restart (a crash, a power cut) would read "ongoing"
 * for ever: they end where they began, nothing more is known about them. */
export async function closeStaleEvents() {
    const res = await MotionEventModel.updateMany({ end: { $exists: false } }, [{ $set: { end: '$start' } }]);
    if (res.modifiedCount) {
        log('info', `Closed ${res.modifiedCount} motion events left open by the last run`);
    }
}

// events of cameras that stopped sending frames (stream stopped, wifi lost) are closed here
export function initMotionWatchdog() {
    setInterval(() => {
        const now = Date.now();
        for (const [deviceId, s] of devices) {
            if (s.current && !s.busy && now - s.current.lastMotion > EVENT_GAP_MS * 2) {
                closeEvent(deviceId, s).catch((err) => log('error', err.message));
            }
        }
    }, 5000);
}
