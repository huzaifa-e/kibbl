import express from 'express';
import multer from 'multer';
import { HEAT_UNITS, type HeatUnit } from '../../../shared/heat';
import { checkAuthMiddleware } from '../core/auth';
import { logger } from '../core/logger';
import { ownRoom } from '../core/rooms';
import { OcrError } from '../heat/ocr';
import { ReportError, applyReport, listReports, removeReport, reportFile, uploadReport, type ApplyDevice } from '../heat/reports';
import {
    HeatError,
    addMeter,
    addReadings,
    listMeters,
    meterReadings,
    overview,
    removeMeter,
    removeReading,
    updateMeter,
    type MeterFields,
} from '../heat/service';

const log = logger('heat');
const NAME_MAX = 60;
const MAX_REPORT_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_REPORT_BYTES, files: 1 } }).single('report');
const isUUID = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isValue = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9;

// the fields of a heat meter the app may set; a string is what is wrong
async function cleanFields(userID: string, b: Record<string, unknown> | null): Promise<MeterFields | string> {
    const f: MeterFields = {};
    if (b?.name !== undefined) {
        if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > NAME_MAX) return `a name of 1 to ${NAME_MAX} characters`;
        f.name = b.name;
    }
    if (b?.kind !== undefined) {
        if (b.kind !== 'radiator' && b.kind !== 'meter') return 'kind radiator or meter';
        f.kind = b.kind;
    }
    if (b?.unit !== undefined) {
        if (!HEAT_UNITS.includes(b.unit as HeatUnit)) return `unit ${HEAT_UNITS.join(', ')}`;
        f.unit = b.unit as HeatUnit;
    }
    if (b?.factor !== undefined) {
        if (typeof b.factor !== 'number' || !(b.factor > 0) || b.factor > 100) return 'a factor above 0, up to 100';
        f.factor = b.factor;
    }
    if (b?.roomId !== undefined) {
        if (b.roomId !== null && (!isUUID(b.roomId) || !(await ownRoom(userID, b.roomId)))) return 'no such room';
        f.roomId = b.roomId as string | null;
    }
    if (b?.serial !== undefined) {
        if (b.serial !== null && (typeof b.serial !== 'string' || b.serial.length > 40)) return 'a serial number of up to 40 characters';
        f.serial = b.serial as string | null;
    }
    return f;
}

/* The heat used in the home (heat/service.ts): heat meters, their readings, the use per day. */
export default function initHeatRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;
    const user = (req: RequestWithSessionInfo) => req.sessionInfo!.userID;

    // the meters and the use of every day from the first reading on
    app.get('/api/heat', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await overview(user(req)));
    });

    app.get('/api/heat/meters', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await listMeters(user(req)));
    });

    app.post('/api/heat/meters', auth, async (req: RequestWithSessionInfo, res) => {
        const f = await cleanFields(user(req), req.body);
        if (typeof f === 'string' || !f.name || !f.kind) {
            res.status(400).send(typeof f === 'string' ? f : 'a name and a kind (radiator or meter)');
            return;
        }
        res.json({ _id: await addMeter(user(req), { ...f, name: f.name, kind: f.kind }) });
    });

    app.patch('/api/heat/meters/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const f = await cleanFields(user(req), req.body);
        if (typeof f === 'string' || f.kind !== undefined) {
            res.status(400).send(typeof f === 'string' ? f : 'the kind stays as it was added');
            return;
        }
        res.json({ ok: await updateMeter(user(req), req.params.id, f) });
    });

    // removes the meter with its readings
    app.delete('/api/heat/meters/:id', auth, async (req: RequestWithSessionInfo, res) => {
        res.json({ ok: await removeMeter(user(req), req.params.id) });
    });

    app.get('/api/heat/meters/:id/readings', auth, async (req: RequestWithSessionInfo, res) => {
        const rows = await meterReadings(user(req), req.params.id);
        if (!rows) {
            res.sendStatus(404);
            return;
        }
        res.json(rows);
    });

    // { date, values: [{ meterId, value }] }: the readings of one day
    app.post('/api/heat/readings', auth, async (req: RequestWithSessionInfo, res) => {
        const { date, values } = req.body ?? {};
        if (
            !isDate(date) ||
            !Array.isArray(values) ||
            !values.length ||
            values.length > 100 ||
            !values.every((v) => v && typeof v.meterId === 'string' && isValue(v.value))
        ) {
            res.status(400).send('a date (YYYY-MM-DD) and values: [{ meterId, value }] of 0 or more');
            return;
        }
        try {
            await addReadings(
                user(req),
                date,
                values.map((v: { meterId: string; value: number }) => ({ meterId: v.meterId, value: v.value })),
                'manual',
            );
            res.json({ ok: true });
        } catch (err) {
            res.status(err instanceof HeatError ? 400 : 500).send((err as Error).message);
        }
    });

    app.delete('/api/heat/meters/:id/readings/:date', auth, async (req: RequestWithSessionInfo, res) => {
        res.json({ ok: await removeReading(user(req), req.params.id, req.params.date) });
    });

    /* ------------------------------------------------------------------- */

    // a heating cost report as PDF (field "report"): stored, read on the server, its values returned to check
    app.post('/api/heat/reports', auth, (req: RequestWithSessionInfo, res) => {
        upload(req, res, async (err: unknown) => {
            if (err) {
                res.status(err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).send(
                    err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 'The PDF is larger than 25 MB.' : 'The upload failed.',
                );
                return;
            }
            const pdf = req.file?.buffer;
            if (!pdf || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
                res.status(400).send('This is no PDF.');
                return;
            }
            try {
                res.json(await uploadReport(user(req), req.file!.originalname || 'report.pdf', pdf));
            } catch (e) {
                log.warn('report not read', { user: user(req) }, e);
                res.status(e instanceof OcrError ? 500 : 502).send(e instanceof OcrError ? e.message : 'The report could not be read.');
            }
        });
    });

    app.get('/api/heat/reports', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await listReports(user(req)));
    });

    app.get('/api/heat/reports/:id/file', auth, async (req: RequestWithSessionInfo, res) => {
        const file = await reportFile(user(req), req.params.id);
        if (!file) {
            res.sendStatus(404);
            return;
        }
        res.setHeader('Content-Disposition', `inline; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`);
        res.type('application/pdf').sendFile(file.path, (err) => err && !res.headersSent && res.sendStatus(404));
    });

    // { from, devices: [{ serial, name, roomId, room, date, old, new, use }], buildingKWh, buildingUnits }: the checked values
    app.post('/api/heat/reports/:id/apply', auth, async (req: RequestWithSessionInfo, res) => {
        const b = req.body ?? {};
        const devices: unknown[] = Array.isArray(b.devices) ? b.devices : [];
        const cleaned: ApplyDevice[] = [];
        for (const d of devices as Record<string, unknown>[]) {
            if (
                !d ||
                typeof d.serial !== 'string' ||
                !/^[\w-]{1,40}$/.test(d.serial) ||
                typeof d.name !== 'string' ||
                !d.name.trim() ||
                d.name.length > NAME_MAX ||
                !isDate(d.date) ||
                !isValue(d.old) ||
                !isValue(d.new) ||
                !isValue(d.use) ||
                (d.roomId !== null && (!isUUID(d.roomId) || !(await ownRoom(user(req), d.roomId))))
            ) {
                res.status(400).send(`Check the device ${typeof d?.serial === 'string' ? d.serial : ''}: a number, a name, a date and readings of 0 or more.`);
                return;
            }
            cleaned.push({
                serial: d.serial,
                name: d.name.trim(),
                roomId: d.roomId as string | null,
                room: typeof d.room === 'string' ? d.room.slice(0, 3) : undefined,
                date: d.date,
                old: d.old,
                new: d.new,
                use: d.use,
            });
        }
        const optional = (v: unknown) => (isValue(v) && v > 0 ? v : undefined);
        if (!isDate(b.from) || !cleaned.length || cleaned.length > 100) {
            res.status(400).send('a start of the period (YYYY-MM-DD) and at least one device');
            return;
        }
        try {
            const ok = await applyReport(user(req), req.params.id, {
                from: b.from,
                devices: cleaned,
                buildingKWh: optional(b.buildingKWh),
                buildingUnits: optional(b.buildingUnits),
            });
            if (!ok) res.sendStatus(404);
            else res.json({ ok: true });
        } catch (e) {
            res.status(e instanceof ReportError || e instanceof HeatError ? 400 : 500).send((e as Error).message);
        }
    });

    // the report and its PDF; the readings it brought stay
    app.delete('/api/heat/reports/:id', auth, async (req: RequestWithSessionInfo, res) => {
        res.json({ ok: await removeReport(user(req), req.params.id) });
    });
}
