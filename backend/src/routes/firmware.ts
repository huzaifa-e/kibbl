import express from 'express';
import multer from 'multer';
import { checkAuthMiddleware } from '../core/auth';
import { Device } from '../core/db';
import { getLive } from '../core/devices';
import { deviceBaseUrl, downloadFor, offerUpdate, publishRelease, releaseFor, startUpdate } from '../core/firmware';
import { logger } from '../core/logger';

const log = logger('ota');

const MAX_IMAGE_BYTES = 0x1e0000; // one app slot of kibbl_partition_tbl.csv

const ESP_IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432; // esp_app_desc_t, right after the image and first segment header
const APP_DESC_OFFSET = 24 + 8;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

// the project each product is built as (project() in firmware/<product>/CMakeLists.txt)
const PROJECTS: Record<string, string> = { 'kibbl-cam': 'KIBBL-FW', 'kibbl-air': 'KIBBL-AIR', 'kibbl-feeder': 'KIBBL-FEEDER', 'kibbl-light': 'KIBBL-LIGHT' };

/* An ESP8266 image (kibbl. light, Arduino core) has no esp_app_desc_t: it carries
 * "KIBBL-APP:<project>:<version>" (firmware/light/main/KL_product.cpp) instead. */
const APP_MARKER = Buffer.from('KIBBL-APP:');

function markerInfo(image: Buffer) {
    const at = image.indexOf(APP_MARKER);
    if (at < 0) return undefined;
    const end = image.indexOf(0, at);
    const m = /^KIBBL-APP:([A-Z0-9-]{1,31}):([A-Za-z0-9.-]{1,31})$/.exec(image.subarray(at, end < 0 ? at + 80 : end).toString('latin1'));
    return m ? { project: m[1], version: m[2] } : undefined;
}

// version and project of an application image, undefined when it is none
export function appInfo(image: Buffer) {
    if (image.length < APP_DESC_OFFSET + 80 || image[0] !== ESP_IMAGE_MAGIC) {
        return undefined;
    }
    if (image.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
        return markerInfo(image);
    }
    // esp_app_desc_t: magic, secure_version, reserv1[2], version[32], project_name[32]
    const text = (from: number) =>
        image
            .subarray(APP_DESC_OFFSET + from, APP_DESC_OFFSET + from + 32)
            .toString('utf-8')
            .replace(/\0.*$/s, '');
    return { version: text(16), project: text(48) };
}

/* Updates (core/firmware.ts): a file for one device, a file published for every device of
 * its product (stored, offline ones take it when they connect), and the stored one now. */
export default function initFirmwareRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;
    const user = (req: RequestWithSessionInfo) => req.sessionInfo!.userID;

    // a file for this one device, not stored
    app.post('/api/devices/:deviceID/firmware', auth, upload.single('firmware'), async (req: RequestWithSessionInfo, res) => {
        const deviceId = req.params.deviceID;
        const doc = /^[0-9A-F]{12}$/.test(deviceId) ? await Device.findById(deviceId).lean() : null;
        if (!doc || doc.status !== 'approved' || doc.ownerID !== user(req) || !doc.caps.includes('ota')) {
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
        const started = await startUpdate(deviceId, { image });
        if (!started.ok) return res.status(502).send(`The device did not start the update: ${started.error}`);
        log.info('update started', { device: deviceId, version: info.version, user: req.sessionInfo!.email });
        res.json({ version: info.version });
    });

    /* A file for every device of its product the person owns: stored on the server, each one
     * on an older version that is online starts now, the others when they connect. */
    app.post('/api/firmware/rollout', auth, upload.single('firmware'), async (req: RequestWithSessionInfo, res) => {
        if (!deviceBaseUrl()) {
            return res.status(500).send('DEVICE_BASE_URL is not set on the server.');
        }
        const image = req.file?.buffer;
        const info = image ? appInfo(image) : undefined;
        const model = info ? Object.keys(PROJECTS).find((m) => PROJECTS[m] === info.project) : undefined;
        if (!image || !info || !model) {
            return res.status(400).send('This is no kibbl. firmware file.');
        }
        await publishRelease(user(req), model, info.version, image);
        const docs = await Device.find({ ownerID: user(req), status: 'approved', model, caps: 'ota' })
            .sort({ name: 1 })
            .lean();
        const devices = await Promise.all(
            docs.map(async (doc) => ({ id: doc._id, name: doc.name, result: await offerUpdate({ _id: doc._id, online: !!getLive(doc._id) }, true) })),
        );
        log.info('release published', { version: info.version, started: devices.filter((d) => d.result === 'started').length, of: devices.length });
        res.json({ version: info.version, devices });
    });

    // the stored release on this device now, also after tries that did not take
    app.post('/api/devices/:deviceID/update', auth, async (req: RequestWithSessionInfo, res) => {
        const doc = await Device.findOne({ _id: req.params.deviceID, ownerID: user(req), status: 'approved' }, { _id: 1 }).lean();
        if (!doc) return res.status(404).send('No such device.');
        const result = await offerUpdate({ _id: doc._id, online: !!getLive(doc._id) }, true);
        res.json({ result });
    });

    // the releases stored for the person's products
    app.get('/api/firmware', auth, (req: RequestWithSessionInfo, res) => {
        res.json(
            Object.keys(PROJECTS)
                .map((model) => ({ model, ...releaseFor(user(req), model) }))
                .filter((r) => r.version)
                .map(({ model, version, at }) => ({ model, version, at })),
        );
    });

    app.get('/firmware/:token.bin', (req, res) => {
        const download = downloadFor(req.params.token);
        if (!download) {
            res.sendStatus(404);
            return;
        }
        log.info('device downloads its update', { device: download.deviceId, ip: req.ip });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.sendFile(download.file);
    });
}
