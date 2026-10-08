import crypto from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import { checkAuthMiddleware } from '../core/auth';
import { Device } from '../core/db';
import { getLive, sendCommand } from '../core/devices';
import { logger } from '../core/logger';

const log = logger('ota');
import { firmwareRoot, resolveInside } from '../core/storage';

const MAX_IMAGE_BYTES = 0x1e0000; // one app slot of kibbl_partition_tbl.csv
const LINK_LIFETIME_MS = 15 * 60 * 1000;

const ESP_IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432; // esp_app_desc_t, right after the image and first segment header
const APP_DESC_OFFSET = 24 + 8;

interface Download {
    file: string;
    deviceId: string;
    expires: number;
}

// a download link per update, valid for one device and 15 minutes: the device fetches it without a cookie
const downloads = new Map<string, Download>();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

// the project each product is built as (project() in firmware/<product>/CMakeLists.txt)
const PROJECTS: Record<string, string> = { 'kibbl-cam': 'KIBBL-FW', 'kibbl-air': 'KIBBL-AIR' };

// version and project of an application image, undefined when it is none
function appInfo(image: Buffer) {
    if (image.length < APP_DESC_OFFSET + 80 || image[0] !== ESP_IMAGE_MAGIC || image.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
        return undefined;
    }
    // esp_app_desc_t: magic, secure_version, reserv1[2], version[32], project_name[32]
    const text = (from: number) =>
        image
            .subarray(APP_DESC_OFFSET + from, APP_DESC_OFFSET + from + 32)
            .toString('utf-8')
            .replace(/\0.*$/s, '');
    return { version: text(16), project: text(48) };
}

function deviceBaseUrl() {
    return (process.env.DEVICE_BASE_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
}

async function expireDownloads() {
    const now = Date.now();
    for (const [token, d] of downloads) {
        if (d.expires < now) {
            downloads.delete(token);
            await rm(d.file, { force: true });
        }
    }
}

// the image for one device behind a link of its own, and the command to fetch it
async function startUpdate(deviceId: string, image: Buffer): Promise<{ ok: boolean; error?: string }> {
    const token = crypto.randomBytes(16).toString('hex');
    await mkdir(firmwareRoot(), { recursive: true });
    const file = resolveInside(firmwareRoot(), `${token}.bin`);
    await writeFile(file, image);
    downloads.set(token, { file, deviceId, expires: Date.now() + LINK_LIFETIME_MS });
    const resp = await sendCommand(deviceId, { cmd: 'ota', url: `${deviceBaseUrl()}/firmware/${token}.bin` });
    if (!resp.ok) {
        downloads.delete(token);
        await rm(file, { force: true });
        return { ok: false, error: resp.error };
    }
    return { ok: true };
}

export default function initFirmwareRoutes(app: express.Application) {
    setInterval(() => expireDownloads().catch(() => undefined), 60 * 1000);

    app.post('/api/devices/:deviceID/firmware', checkAuthMiddleware, upload.single('firmware'), async (req: RequestWithSessionInfo, res) => {
        const deviceId = req.params.deviceID;
        const doc = /^[0-9A-F]{12}$/.test(deviceId) ? await Device.findById(deviceId).lean() : null;
        if (!doc || doc.status !== 'approved' || doc.ownerID !== req.sessionInfo!.userID || !doc.caps.includes('ota')) {
            return res.status(404).send('No device that takes updates.');
        }
        if (!deviceBaseUrl()) {
            return res.status(500).send('DEVICE_BASE_URL is not set on the server.');
        }
        const image = req.file?.buffer;
        const info = image ? appInfo(image) : undefined;
        if (!image || !info) {
            return res.status(400).send('This is no kibbl. firmware file.');
        }
        // a camera image on a kibbl. air (or the other way round) would not even start
        const expected = doc.model ? PROJECTS[doc.model] : undefined;
        if (expected && info.project !== expected) {
            return res.status(400).send(`This firmware is for another product (${info.project}); this device takes ${expected}.`);
        }
        const started = await startUpdate(deviceId, image);
        if (!started.ok) return res.status(502).send(`The device did not start the update: ${started.error}`);
        log.info('update started', { device: deviceId, version: info.version, user: req.sessionInfo!.email });
        res.json({ version: info.version });
    });

    /* One file to every device of its product the person owns: each online one starts, the
     * others are listed. One already on this version is left as it is. */
    app.post('/api/firmware/rollout', checkAuthMiddleware, upload.single('firmware'), async (req: RequestWithSessionInfo, res) => {
        if (!deviceBaseUrl()) {
            return res.status(500).send('DEVICE_BASE_URL is not set on the server.');
        }
        const image = req.file?.buffer;
        const info = image ? appInfo(image) : undefined;
        const model = info ? Object.keys(PROJECTS).find((m) => PROJECTS[m] === info.project) : undefined;
        if (!image || !info || !model) {
            return res.status(400).send('This is no kibbl. firmware file.');
        }
        const docs = await Device.find({ ownerID: req.sessionInfo!.userID, status: 'approved', model, caps: 'ota' }).sort({ name: 1 }).lean();
        const devices = await Promise.all(
            docs.map(async (doc) => {
                const base = { id: doc._id, name: doc.name };
                if (doc.fw === info.version) return { ...base, result: 'current' as const };
                if (!getLive(doc._id)) return { ...base, result: 'offline' as const };
                const started = await startUpdate(doc._id, image);
                return started.ok ? { ...base, result: 'started' as const } : { ...base, result: 'failed' as const, error: started.error };
            }),
        );
        log.info('rollout', {
            version: info.version,
            started: devices.filter((d) => d.result === 'started').length,
            of: devices.length,
            user: req.sessionInfo!.email,
        });
        res.json({ version: info.version, devices });
    });

    app.get('/firmware/:token.bin', (req, res) => {
        const download = downloads.get(req.params.token);
        if (!download || download.expires < Date.now()) {
            res.sendStatus(404);
            return;
        }
        log.info('device downloads its update', { device: download.deviceId, ip: req.ip });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(download.file);
    });
}
