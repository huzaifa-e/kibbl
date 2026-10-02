import crypto from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import { checkAuthMiddleware } from '../core/auth';
import { Device } from '../core/db';
import { sendCommand } from '../core/devices';
import { log } from '../core/logger';
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

function appVersion(image: Buffer) {
    if (image.length < APP_DESC_OFFSET + 48 || image[0] !== ESP_IMAGE_MAGIC || image.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
        return undefined;
    }
    // esp_app_desc_t: magic, secure_version, reserv1[2], version[32]
    return image
        .subarray(APP_DESC_OFFSET + 16, APP_DESC_OFFSET + 48)
        .toString('utf-8')
        .replace(/\0.*$/s, '');
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

export default function initFirmwareRoutes(app: express.Application) {
    setInterval(() => expireDownloads().catch(() => undefined), 60 * 1000);

    app.post('/api/devices/:deviceID/firmware', checkAuthMiddleware, upload.single('firmware'), async (req: RequestWithSessionInfo, res) => {
        const deviceId = req.params.deviceID;
        const doc = /^[0-9A-F]{12}$/.test(deviceId) ? await Device.findById(deviceId).lean() : null;
        if (!doc || doc.status !== 'approved' || !doc.caps.includes('ota')) {
            return res.status(404).send('No device that takes updates.');
        }
        if (!deviceBaseUrl()) {
            return res.status(500).send('DEVICE_BASE_URL is not set on the server.');
        }
        const image = req.file?.buffer;
        const version = image ? appVersion(image) : undefined;
        if (!image || !version) {
            return res.status(400).send('This is no kibbl. firmware file.');
        }

        const token = crypto.randomBytes(16).toString('hex');
        await mkdir(firmwareRoot(), { recursive: true });
        const file = resolveInside(firmwareRoot(), `${token}.bin`);
        await writeFile(file, image);
        downloads.set(token, { file, deviceId, expires: Date.now() + LINK_LIFETIME_MS });

        const resp = await sendCommand(deviceId, { cmd: 'ota', url: `${deviceBaseUrl()}/firmware/${token}.bin` });
        if (!resp.ok) {
            downloads.delete(token);
            await rm(file, { force: true });
            return res.status(502).send(`The device did not start the update: ${resp.error}`);
        }
        log('info', `${req.sessionInfo!.email}: update of ${deviceId} to ${version} started`);
        res.json({ version });
    });

    app.get('/firmware/:token.bin', (req, res) => {
        const download = downloads.get(req.params.token);
        if (!download || download.expires < Date.now()) {
            res.sendStatus(404);
            return;
        }
        log('info', `${download.deviceId}: downloading its update from ${req.ip}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(download.file);
    });
}
