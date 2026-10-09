import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MotionEventModel } from './db';
import { logger } from './logger';

const log = logger('storage');

const DAY_MS = 24 * 3600 * 1000;

export function imageRoot() {
    return path.resolve(process.env.IMAGE_DATA_PATH || './data/images');
}

export function firmwareRoot() {
    return path.resolve(process.env.FIRMWARE_DATA_PATH || './data/firmware');
}

// heating cost reports (heat/reports.ts), next to the images unless set
export function reportRoot() {
    return path.resolve(process.env.REPORT_DATA_PATH || path.join(path.dirname(imageRoot()), 'reports'));
}

// resolves a stored relative path and refuses anything that leaves the root
export function resolveInside(root: string, relative: string) {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) {
        throw new Error('path outside the data directory');
    }
    return full;
}

function localDay(time: number) {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function saveSnapshot(deviceId: string, eventId: string, time: number, jpeg: Buffer) {
    const relative = path.join(deviceId, localDay(time), `${eventId}.jpg`);
    const full = resolveInside(imageRoot(), relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, jpeg);
    return relative;
}

export async function deleteSnapshot(relative: string | undefined) {
    if (!relative) {
        return;
    }
    try {
        await rm(resolveInside(imageRoot(), relative), { force: true });
    } catch (err) {
        log.warn('picture not deleted', { file: relative }, err);
    }
}

export async function deleteDeviceImages(deviceId: string) {
    await rm(resolveInside(imageRoot(), deviceId), { recursive: true, force: true });
}

/* Snapshots are what a camera in a home keeps about the people living there: they
 * are deleted after RETENTION_DAYS (default 14) together with their events. */
export async function cleanupOldEvents() {
    const days = Number(process.env.RETENTION_DAYS) || 14;
    const before = Date.now() - days * DAY_MS;

    const old = await MotionEventModel.find({ start: { $lt: before } }, { snapshot: 1 }).lean();
    for (const event of old) {
        await deleteSnapshot(event.snapshot);
    }
    await MotionEventModel.deleteMany({ start: { $lt: before } });

    // the day folders that are empty now
    try {
        for (const device of await readdir(imageRoot())) {
            const deviceDir = resolveInside(imageRoot(), device);
            for (const day of await readdir(deviceDir).catch(() => [])) {
                await rmdir(path.join(deviceDir, day)).catch(() => undefined); // fails while not empty
            }
        }
    } catch {
        // no image folder yet
    }

    if (old.length) {
        log.info('old events deleted', { events: old.length, olderThanDays: days });
    }
}

export function initStorageCleanup() {
    cleanupOldEvents().catch((err) => log.error('cleanup failed', undefined, err));
    setInterval(
        () => {
            cleanupOldEvents().catch((err) => log.error('cleanup failed', undefined, err));
        },
        6 * 3600 * 1000,
    );
}
