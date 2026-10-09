import express from 'express';
import { HEAT_UNITS, type HeatUnit } from '../../../shared/heat';
import { checkAuthMiddleware } from '../core/auth';
import { ownRoom } from '../core/rooms';
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

const NAME_MAX = 60;
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
}
