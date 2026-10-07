import express from 'express';
import type { HeatingCommand, HomeRoom } from '../../../shared/heating';
import { checkAuthMiddleware } from '../core/auth';
import { Device } from '../core/db';
import { getSummaries } from '../core/devices';
import { logger } from '../core/logger';
import { ROOM_NAME_MAX, createRoom, deleteRoom, listRooms, moveDevice, ownRoom, renameRoom } from '../core/rooms';
import { TadoError } from '../tado/client';
import { command, connect, disconnect, placeTadoRoom, publishPaired, readings, status } from '../tado/service';

const log = logger('heating');
const HOUR_MS = 3600_000;

const isRoomName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= ROOM_NAME_MAX;
const isRoomRef = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v));

// what the app may ask of a tado room, in tado's ranges
function cleanCommand(body: unknown): HeatingCommand | undefined {
    const b = body as Record<string, unknown> | null;
    const until = b?.until === 'next' || b?.until === 'manual' || b?.until === 'timer' ? b.until : 'next';
    const minutes = typeof b?.minutes === 'number' && b.minutes >= 5 && b.minutes <= 24 * 60 ? b.minutes : undefined;
    if (b?.mode === 'schedule') return { mode: 'schedule' };
    if (b?.mode === 'off') return { mode: 'off', until, minutes };
    if (b?.mode === 'temperature' && typeof b.celsius === 'number' && b.celsius >= 5 && b.celsius <= 25) {
        return { mode: 'temperature', celsius: Math.round(b.celsius * 2) / 2, until, minutes };
    }
    return undefined;
}

function fail(res: express.Response, err: unknown) {
    const status = err instanceof TadoError && err.status === 429 ? 429 : err instanceof TadoError && err.status === 401 ? 401 : 502;
    res.status(status).send((err as Error).message);
}

/* Heating through tado (tado/service.ts) and the rooms of the home (core/rooms.ts). */
export default function initHeatingRoutes(app: express.Application) {
    const auth = checkAuthMiddleware as express.RequestHandler;
    const user = (req: RequestWithSessionInfo) => req.sessionInfo!.userID;

    app.get('/api/heating', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await status(user(req)));
    });

    // starts the sign-in: the answer has the code and the address of tado to confirm it at
    app.post('/api/heating/connect', auth, async (req: RequestWithSessionInfo, res) => {
        try {
            res.json(await connect(user(req)));
        } catch (err) {
            fail(res, err);
        }
    });

    app.delete('/api/heating', auth, async (req: RequestWithSessionInfo, res) => {
        await disconnect(user(req));
        res.json({ ok: true });
    });

    app.post('/api/heating/rooms/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const cmd = cleanCommand(req.body);
        const id = Number(req.params.id);
        if (!cmd || !Number.isInteger(id)) {
            res.status(400).send('mode temperature (5-25 °C), off or schedule');
            return;
        }
        try {
            await command(user(req), id, cmd);
            res.json({ ok: true });
        } catch (err) {
            fail(res, err);
        }
    });

    // one of tado's rooms into another room of the home, { roomId } or { roomId: null }
    app.put('/api/heating/rooms/:id/place', auth, async (req: RequestWithSessionInfo, res) => {
        const roomId = req.body?.roomId;
        if (!isRoomRef(roomId) || !(await ownRoom(user(req), roomId))) {
            res.status(400).send('no such room');
            return;
        }
        res.json({ ok: await placeTadoRoom(user(req), Number(req.params.id), roomId) });
    });

    app.get('/api/heating/rooms/:id/readings', auth, async (req: RequestWithSessionInfo, res) => {
        const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 366 * 24);
        const to = new Date();
        res.json(await readings(user(req), Number(req.params.id), new Date(to.getTime() - hours * HOUR_MS), to));
    });

    /* ------------------------------------------------------------------- */

    app.get('/api/rooms', auth, async (req: RequestWithSessionInfo, res) => {
        res.json(await listRooms(user(req)));
    });

    /* Every room with its devices and tado's rooms in it; what is in no room comes last
     * (room: null). The rooms section of the app is built from this. */
    app.get('/api/rooms/overview', auth, async (req: RequestWithSessionInfo, res) => {
        const [rooms, devices, heating] = await Promise.all([
            listRooms(user(req)),
            getSummaries({ ownerID: user(req), status: 'approved' }),
            status(user(req)),
        ]);
        const known = new Set(rooms.map((r) => r._id));
        const of = (roomId: string | null) => ({
            devices: devices.filter((d) => (roomId ? d.roomId === roomId : !d.roomId || !known.has(d.roomId))),
            heating: heating.rooms.filter((h) => (roomId ? h.roomId === roomId : !h.roomId || !known.has(h.roomId))),
        });
        const out: { room: HomeRoom | null; devices: typeof devices; heating: typeof heating.rooms }[] = rooms.map((room) => ({ room, ...of(room._id) }));
        const rest = of(null);
        if (rest.devices.length || rest.heating.length) out.push({ room: null, ...rest });
        res.json(out);
    });

    app.post('/api/rooms', auth, async (req: RequestWithSessionInfo, res) => {
        if (!isRoomName(req.body?.name)) {
            res.status(400).send(`a name of 1 to ${ROOM_NAME_MAX} characters`);
            return;
        }
        res.json(await createRoom(user(req), req.body.name));
    });

    app.patch('/api/rooms/:id', auth, async (req: RequestWithSessionInfo, res) => {
        if (!isRoomName(req.body?.name)) {
            res.status(400).send(`a name of 1 to ${ROOM_NAME_MAX} characters`);
            return;
        }
        res.json({ ok: await renameRoom(user(req), req.params.id, req.body.name) });
    });

    app.delete('/api/rooms/:id', auth, async (req: RequestWithSessionInfo, res) => {
        const ok = await deleteRoom(user(req), req.params.id);
        if (ok) await publishPaired(user(req));
        res.json({ ok });
    });

    // a device into another room, { roomId } or { roomId: null }
    app.put('/api/devices/:id/room', auth, async (req: RequestWithSessionInfo, res) => {
        const roomId = req.body?.roomId;
        if (!isRoomRef(roomId) || !(await ownRoom(user(req), roomId))) {
            res.status(400).send('no such room');
            return;
        }
        const moved = await moveDevice(user(req), req.params.id, roomId);
        if (!moved) {
            res.sendStatus(404);
            return;
        }
        const device = await Device.findById(req.params.id, { name: 1 }).lean();
        log.info('device moved', { device: req.params.id, name: device?.name, room: roomId ?? 'none', user: req.sessionInfo!.email });
        await publishPaired(user(req));
        res.json({ ok: true });
    });
}
