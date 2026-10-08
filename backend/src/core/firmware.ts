import crypto from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { DeviceSummary } from '../../../shared/protocol';
import { isNewer } from '../../../shared/firmware';
import { Device, FirmwareRelease } from './db';
import { getLive, sendCommand } from './devices';
import { hub } from './hub';
import { logger } from './logger';
import { firmwareRoot, resolveInside } from './storage';

/*
 * The firmware of each product an account uses lives on the server (the last one uploaded
 * with "Update all"), with its rules in the database (FirmwareReleaseDoc: automatic or not,
 * tries, minutes between them, the devices that take it), read again every minute so a change
 * there counts without a restart. A device on an older version updates as soon as it is
 * online: right away when it is, else when it connects next. It fetches the image over a link
 * of its own that ends after 15 minutes. Every try is kept on the device (DeviceDoc.ota): one
 * that comes back on its old version is tried again until maxAttempts, then it waits for
 * "Install" in the app (or attempts set back to 0).
 */

const log = logger('ota');

const LINK_LIFETIME_MS = 15 * 60 * 1000;
const RELOAD_MS = 60 * 1000;

interface Download {
    file: string;
    deviceId: string;
    expires: number;
    temporary: boolean; // a one-off image of a single device's update, removed when the link ends
}

const downloads = new Map<string, Download>();
const releases = new Map<string, FirmwareReleaseDoc>(); // owner|model, as in the database

const key = (ownerID: string, model: string) => `${ownerID}|${model}`;

export function deviceBaseUrl() {
    return (process.env.DEVICE_BASE_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
}

export function downloadFor(token: string) {
    const d = downloads.get(token);
    return d && d.expires >= Date.now() ? d : undefined;
}

async function expireDownloads() {
    const now = Date.now();
    for (const [token, d] of downloads) {
        if (d.expires < now) {
            downloads.delete(token);
            if (d.temporary) await rm(d.file, { force: true });
        }
    }
}

/* The command to fetch an image: a stored release, or a one-off one (image) that is written
 * for this device alone. */
export async function startUpdate(deviceId: string, from: { file: string } | { image: Buffer }): Promise<{ ok: boolean; error?: string }> {
    const token = crypto.randomBytes(16).toString('hex');
    let file: string;
    if ('image' in from) {
        await mkdir(firmwareRoot(), { recursive: true });
        file = resolveInside(firmwareRoot(), `${token}.bin`);
        await writeFile(file, from.image);
    } else {
        file = from.file;
    }
    downloads.set(token, { file, deviceId, expires: Date.now() + LINK_LIFETIME_MS, temporary: 'image' in from });
    const resp = await sendCommand(deviceId, { cmd: 'ota', url: `${deviceBaseUrl()}/firmware/${token}.bin` });
    if (!resp.ok) {
        downloads.delete(token);
        if ('image' in from) await rm(file, { force: true });
        return { ok: false, error: resp.error };
    }
    return { ok: true };
}

/* ----------------------------------------------------------------------- */

// the release of a product for an account (from the database, read every minute)
export function releaseFor(ownerID: string | undefined, model: string | undefined) {
    return ownerID && model ? releases.get(key(ownerID, model)) : undefined;
}

// the version a device should take, undefined when it is up to date, takes no updates or is left out
export function updateFor(doc: Pick<DeviceDoc, '_id' | 'ownerID' | 'model' | 'fw' | 'caps' | 'status'>) {
    if (doc.status !== 'approved' || !doc.caps?.includes('ota')) return undefined;
    const release = releaseFor(doc.ownerID, doc.model);
    if (!release || (release.only.length && !release.only.includes(doc._id))) return undefined;
    return isNewer(release.version, doc.fw) ? release.version : undefined;
}

async function loadReleases() {
    const docs = await FirmwareRelease.find({}).lean();
    releases.clear();
    for (const r of docs) {
        releases.set(r._id, {
            ...r,
            auto: r.auto ?? true,
            maxAttempts: r.maxAttempts ?? 3,
            retryMinutes: r.retryMinutes ?? 10,
            only: r.only ?? [],
            exclude: r.exclude ?? [],
        });
    }
}

// a new release: the image on disk, its version in the database; the rules of the last one stay
export async function publishRelease(ownerID: string, model: string, version: string, image: Buffer) {
    const dir = resolveInside(firmwareRoot(), 'releases');
    await mkdir(dir, { recursive: true });
    const file = resolveInside(dir, `${ownerID}-${model}.bin`);
    await writeFile(file, image);
    await FirmwareRelease.updateOne(
        { _id: key(ownerID, model) },
        { $set: { ownerID, model, version, file, size: image.length, at: Date.now() } },
        { upsert: true, setDefaultsOnInsert: true },
    );
    await loadReleases();
    log.info('release stored', { model, version, owner: ownerID });
}

/* A device that should take the release: started when it is online, by itself only when the
 * release is automatic, the device not excluded, not again within retryMinutes and at most
 * maxAttempts times for one version. force: asked for in the app. */
export async function offerUpdate(
    device: Pick<DeviceSummary, '_id' | 'online'>,
    force = false,
): Promise<'started' | 'current' | 'offline' | 'waiting' | 'failed'> {
    const doc = await Device.findById(device._id, { ownerID: 1, model: 1, fw: 1, caps: 1, status: 1, ota: 1 }).lean();
    const version = doc ? updateFor(doc) : undefined;
    const release = doc ? releaseFor(doc.ownerID, doc.model) : undefined;
    if (!doc || !version || !release) return 'current';
    if (!device.online) return 'offline';
    const now = Date.now();
    const count = doc.ota?.version === version ? doc.ota.attempts : 0;
    if (!force) {
        if (!release.auto || release.exclude.includes(doc._id) || count >= release.maxAttempts) return 'waiting';
        if (doc.ota?.version === version && now - doc.ota.lastAt < release.retryMinutes * 60_000) return 'waiting';
    }
    const started = await startUpdate(device._id, { file: release.file });
    await Device.updateOne({ _id: doc._id }, { ota: { version, attempts: count + 1, lastAt: now, ...(started.ok ? {} : { error: started.error }) } });
    log.info(started.ok ? 'update started' : 'update not started', { device: device._id, from: doc.fw, to: version, attempt: count + 1, error: started.error });
    return started.ok ? 'started' : 'failed';
}

// an update of this version was started on the device within the retry time: it installs
export function installing(doc: Pick<DeviceDoc, 'ota' | 'ownerID' | 'model'>, version: string) {
    const release = releaseFor(doc.ownerID, doc.model);
    return doc.ota?.version === version && !doc.ota.error && Date.now() - doc.ota.lastAt < (release?.retryMinutes ?? 10) * 60_000;
}

/* Every online device that should take a release: a changed rule in the database, or a try
 * whose retry time is over, while the device stays online. */
async function offerAll() {
    const docs = await Device.find({ status: 'approved', caps: 'ota' }, { ownerID: 1, model: 1, fw: 1, caps: 1, status: 1 }).lean();
    for (const doc of docs) {
        if (getLive(doc._id) && updateFor(doc)) await offerUpdate({ _id: doc._id, online: true });
    }
}

export async function initFirmware() {
    await loadReleases();
    setInterval(() => {
        loadReleases()
            .then(offerAll)
            .catch((err) => log.warn('releases not read', {}, err));
    }, RELOAD_MS);
    setInterval(() => expireDownloads().catch(() => undefined), 60 * 1000);
    // a device that comes online on an older version takes the release
    hub.on('deviceUpdate', (device) => {
        if (device.online && device.update) {
            offerUpdate(device).catch((err) => log.warn('update not offered', { device: device._id }, err));
        }
    });
}
