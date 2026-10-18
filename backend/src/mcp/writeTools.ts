import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HeatingCommand } from '../../../shared/heating';
import {
    RGB_FADE_MAX_MS,
    framesizes,
    lampColors,
    lampModes,
    fanModes,
    isMirrored,
    rgbPresets,
    rotationCommand,
    rotationOf,
    ZOOM_MAX,
} from '../../../shared/protocol';
import { setNightSchedule } from '../core/air';
import { applyMotionSettings, runDeviceCommand } from '../core/control';
import { Device, User } from '../core/db';
import { publishDevice } from '../core/devices';
import { logger } from '../core/logger';
import { createRoom, listRooms, moveDevice, renameRoom, setRoomKind } from '../core/rooms';
import { ROOM_KINDS, type RoomKind } from '../../../shared/roomKind';
import { forgetHome, searchPlaces } from '../core/weather';
import { HEAT_UNITS } from '../../../shared/heat';
import { HeatError, addMeter as addHeatMeter, addReadings as addHeatReadings, listMeters as listHeatMeters } from '../heat/service';
import { command as heatingCommand, placeTadoRoom, publishPaired, status as heatingStatus } from '../tado/service';

/*
 * What an assistant may change through the MCP endpoint: the settings the person changes in
 * the app, through the same checks (core/control.ts). Not offered, on purpose: calibrating
 * (the device must stand in fresh air), firmware updates, Wi-Fi, restarts, removing devices,
 * factory resets and deleting events or pictures. Every change is logged "via assistant".
 */

const log = logger('mcp');
const VIA = 'assistant';

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const hour = z.number().int().min(0).max(23);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const lower = (s: string) => s.trim().toLowerCase();

async function findOwnDevice(userID: string, ref: string, cap: string) {
    const docs = await Device.find({ ownerID: userID, status: 'approved', caps: cap }).lean();
    const r = lower(ref);
    return docs.find((d) => d._id.toLowerCase() === r) ?? docs.find((d) => lower(d.name) === r) ?? (r ? undefined : docs.length === 1 ? docs[0] : undefined);
}

async function findRoom(userID: string, ref: string) {
    const r = lower(ref);
    return (await listRooms(userID)).find((x) => x._id === ref.trim() || lower(x.name) === r);
}

export function registerWriteTools(server: McpServer, session: SessionInfo) {
    const who = session.email;

    server.registerTool(
        'kibbl_heating_set',
        {
            title: 'Set the heating',
            description:
                'Changes a tado room: a temperature, off, or back to its schedule. A temperature or off lasts 60 minutes unless until says otherwise ' +
                '(until next_change: to the next change of the schedule; until_changed: until changed again). ' +
                'adaptive holds the room at the temperature by the adaptive PID control of the server: tado is set above or below it until the room measures it, ' +
                'off while a window is open (tado or a kibbl. air in the room), until another mode is set for the room (until is not used). ' +
                'The room is a tado room name or the room of the home it is in (kibbl_heating lists them).',
            inputSchema: {
                room: z.string().describe('tado room or room of the home, e.g. "Living Room"'),
                mode: z.enum(['temperature', 'adaptive', 'off', 'schedule']),
                temperature: z.number().min(5).max(25).optional().describe('°C, for mode temperature or adaptive'),
                until: z.enum(['timer', 'next_change', 'until_changed']).default('timer'),
                minutes: z.number().int().min(5).max(1440).default(60).describe('for until timer'),
            },
            annotations: writes,
        },
        async ({ room, mode, temperature, until, minutes }) => {
            const h = await heatingStatus(session.userID);
            if (!h.connected) return fail('tado is not connected (Devices, Heating · tado).');
            const home = await findRoom(session.userID, room);
            const target = h.rooms.find((x) => lower(x.name) === lower(room)) ?? (home ? h.rooms.find((x) => x.roomId === home._id) : undefined);
            if (!target) return fail(`No tado room "${room}". tado rooms: ${h.rooms.map((x) => x.name).join(', ') || 'none'}.`);
            if ((mode === 'temperature' || mode === 'adaptive') && temperature === undefined) return fail(`mode ${mode} needs a temperature (5-25 °C).`);
            const u = until === 'next_change' ? 'next' : until === 'until_changed' ? 'manual' : 'timer';
            const cmd: HeatingCommand =
                mode === 'schedule'
                    ? { mode: 'schedule' }
                    : mode === 'adaptive'
                      ? { mode: 'auto', celsius: Math.round(temperature! * 10) / 10 }
                      : mode === 'off'
                        ? { mode: 'off', until: u, minutes }
                        : { mode: 'temperature', celsius: Math.round(temperature! * 2) / 2, until: u, minutes };
            try {
                await heatingCommand(session.userID, target.id, cmd);
            } catch (err) {
                return fail((err as Error).message);
            }
            log.info('heating set', { room: target.name, ...cmd, user: who, via: VIA });
            const note =
                cmd.mode === 'auto'
                    ? 'the adaptive control sets tado now and after every read; it learns the room over the first hours (kibbl_heating shows what tado is set to)'
                    : 'tado reports the new state within a minute (kibbl_heating)';
            return json({ ok: true, room: target.name, set: cmd, note });
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_air_set',
        {
            title: 'Set a kibbl. air',
            description:
                'Changes a kibbl. air (CO2 traffic light): any of the light (lamp_mode traffic shows the air, white, warm, candle, off, custom with lamp_colors), fading, ' +
                'night mode now (light off, quiet), the fan, the thresholds of yellow and red (ppm), beeps at yellow/red, the reminder to air (a beep every so many minutes while the air is bad), ' +
                'cigarette detection and its sensitivity, the fan limit at night, and the match of temperature (°C added) and humidity (a factor) to a reference. blink flashes it to find it. ' +
                'Only the fields given change. Calibration is not possible from here: the device has to stand in fresh air.',
            inputSchema: {
                device: z.string().default('').describe('the kibbl. air by name or id; the only one if left empty'),
                lamp_mode: z.enum(lampModes).optional(),
                lamp_colors: z.array(z.enum(lampColors)).max(4).optional().describe('for lamp_mode custom'),
                lamp_fade: z.boolean().optional(),
                night: z.boolean().optional().describe('night mode now; the night schedule switches it again later (kibbl_air_night_schedule)'),
                fan_mode: z.enum(fanModes).optional(),
                fan_level: z.number().int().min(1).max(100).optional(),
                fan_freq_hz: z
                    .number()
                    .int()
                    .min(5)
                    .max(30000)
                    .optional()
                    .describe('the pwm frequency of the fan, Hz: the one it is quietest at depends on the fan'),
                fan_quiet: z
                    .number()
                    .int()
                    .min(10)
                    .max(60)
                    .optional()
                    .describe('% the fan runs at least, in fresh air with the CO2 and in a bedroom; the speed that is not heard'),
                fan_on_seconds: z.number().int().min(1).max(3600).optional(),
                fan_off_seconds: z.number().int().min(1).max(3600).optional(),
                yellow: z.number().int().min(400).max(5000).optional(),
                red: z.number().int().min(400).max(10000).optional(),
                buzzer: z.boolean().optional().describe('beep when it turns yellow or red'),
                remind_minutes: z.number().int().min(0).max(60).optional().describe('beep every so many minutes while the air is bad, 0 off'),
                remind_from: z.enum(['yellow', 'red']).optional(),
                smoke_detection: z.boolean().optional(),
                smoke_sensitivity: z.enum(['high', 'medium', 'low']).optional(),
                night_fan: z.number().int().min(0).max(100).optional(),
                temperature_adjust: z.number().min(-5).max(5).optional().describe('°C on top of the correction for the warmth of the device'),
                humidity_factor: z.number().min(0.7).max(1.3).optional(),
                blink: z.boolean().optional().describe('flash the white light 5 times'),
            },
            annotations: writes,
        },
        async (args) => {
            const doc = await findOwnDevice(session.userID, args.device, 'air');
            if (!doc) return fail(`No kibbl. air "${args.device}". kibbl_devices lists the devices.`);
            const cmds: Record<string, unknown>[] = [];
            const lamp: Record<string, unknown> = { cmd: 'lamp' };
            if (args.lamp_mode) lamp.mode = args.lamp_mode;
            if (args.lamp_colors) lamp.colors = args.lamp_colors;
            if (args.lamp_fade !== undefined) lamp.fade = args.lamp_fade;
            if (Object.keys(lamp).length > 1) cmds.push(lamp);
            if (args.night !== undefined) cmds.push({ cmd: 'night', on: args.night });
            const fan: Record<string, unknown> = { cmd: 'fan' };
            if (args.fan_mode) fan.mode = args.fan_mode;
            if (args.fan_level !== undefined) fan.level = args.fan_level;
            if (args.fan_quiet !== undefined) fan.quietLevel = args.fan_quiet;
            if (args.fan_freq_hz !== undefined) fan.freqHz = args.fan_freq_hz;
            if (args.fan_on_seconds !== undefined) fan.onSeconds = args.fan_on_seconds;
            if (args.fan_off_seconds !== undefined) fan.offSeconds = args.fan_off_seconds;
            if (Object.keys(fan).length > 1) cmds.push(fan);
            const config: Record<string, unknown> = { cmd: 'air_config' };
            const rise = { high: 100, medium: 150, low: 250 } as const;
            for (const [key, value] of Object.entries({
                yellow: args.yellow,
                red: args.red,
                buzzer: args.buzzer,
                remindMinutes: args.remind_minutes,
                remindFrom: args.remind_from,
                smoke: args.smoke_detection,
                puffRise: args.smoke_sensitivity ? rise[args.smoke_sensitivity] : undefined,
                nightFan: args.night_fan,
                tempAdjust: args.temperature_adjust,
                humidityFactor: args.humidity_factor,
            })) {
                if (value !== undefined) config[key] = value;
            }
            if (Object.keys(config).length > 1) cmds.push(config);
            if (args.blink) cmds.push({ cmd: 'blink', count: 5 });
            if (!cmds.length) return fail('Nothing to change: give at least one setting.');
            const results = [];
            for (const c of cmds) {
                const resp = await runDeviceCommand(doc, c, who, VIA);
                results.push({ command: c.cmd, ok: resp.ok, error: resp.error });
            }
            return json({ device: doc.name, results });
        },
    );

    server.registerTool(
        'kibbl_air_night_schedule',
        {
            title: 'Night schedule of a kibbl. air',
            description:
                'Night mode every night (light off, quiet, fan limited) from one hour to another, local time; enabled false switches the schedule off.',
            inputSchema: { device: z.string().default(''), enabled: z.boolean(), from: hour.default(22), to: hour.default(7) },
            annotations: writes,
        },
        async ({ device, enabled, from, to }) => {
            const doc = await findOwnDevice(session.userID, device, 'night');
            if (!doc) return fail(`No kibbl. air "${device}".`);
            await setNightSchedule(doc._id, { enabled, from, to });
            await publishDevice(doc._id);
            log.info('night schedule', { device: doc._id, night: enabled ? `${from}-${to}h` : 'off', user: who, via: VIA });
            return json({ ok: true, device: doc.name, schedule: { enabled, from, to } });
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_light_set',
        {
            title: 'Set a light',
            description:
                'Changes a kibbl. light (an RGB strip, one colour for all of it): on or off, the colour as #rrggbb or a name (' +
                Object.keys(rgbPresets).join(', ') +
                '), the brightness in %, and how long the change fades. blink flashes it white to find it. Only the fields given change; the light comes back like this after a power cut.',
            inputSchema: {
                light: z.string().default('').describe('the kibbl. light by name or id; the only one if left empty'),
                on: z.boolean().optional(),
                color: z.string().optional().describe('#rrggbb, or a name such as warm or blue'),
                brightness: z.number().int().min(1).max(100).optional().describe('%'),
                fade_ms: z.number().int().min(0).max(RGB_FADE_MAX_MS).optional().describe('how long the change takes, 400 ms unless given'),
                vivid: z
                    .boolean()
                    .optional()
                    .describe('vivid colours: mixed colours (warm, white) at the full light of the strip; false: natural, the hues as the eye expects them'),
                blink: z.boolean().optional().describe('flash white 3 times'),
            },
            annotations: writes,
        },
        async (args) => {
            const doc = await findOwnDevice(session.userID, args.light, 'rgb');
            if (!doc) return fail(`No kibbl. light "${args.light}". kibbl_light lists them.`);
            const cmd: Record<string, unknown> = { cmd: 'rgb' };
            if (args.on !== undefined) cmd.on = args.on;
            if (args.color !== undefined) {
                const name = lower(args.color);
                const hex = /^#?([0-9a-f]{6})$/.exec(name);
                const color = rgbPresets[name] ?? (hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) : undefined);
                if (!color) return fail(`Colour "${args.color}" is no #rrggbb and none of ${Object.keys(rgbPresets).join(', ')}.`);
                cmd.color = color;
                // a colour asked for is meant to be seen
                if (args.on === undefined) cmd.on = true;
            }
            if (args.brightness !== undefined) cmd.brightness = args.brightness;
            if (args.fade_ms !== undefined) cmd.fadeMs = args.fade_ms;
            if (args.vivid !== undefined) cmd.vivid = args.vivid;
            const results: { change: string; ok: boolean; error?: string; rgb?: unknown }[] = [];
            if (Object.keys(cmd).length > 1) {
                const r = await runDeviceCommand(doc, cmd, who, VIA);
                results.push({ change: 'light', ok: r.ok, error: r.error, rgb: r.rgb });
            }
            if (args.blink) {
                const r = await runDeviceCommand(doc, { cmd: 'blink', count: 3, level: 60 }, who, VIA);
                results.push({ change: 'blink', ok: r.ok, error: r.error });
            }
            if (!results.length) return fail('Nothing to change: give at least one setting.');
            return json({ light: doc.name, results });
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_camera_set',
        {
            title: 'Set a camera',
            description:
                'Changes a kibbl. cam: its white light (0-100), picture (framesize, quality 4-63 lower is better, rotation clockwise 0/90/180/270 and mirror, zoom into the middle, brightness/contrast/saturation -2..2) and motion detection ' +
                '(on/off, sensitivity, quiet hours from-to local time, flashing the light on motion, keeping a picture of each event, only counting movement with a cat in it, an e-mail on each visit). Only the fields given change.',
            inputSchema: {
                camera: z.string().describe('the camera by name or id'),
                light: z.number().int().min(0).max(100).optional(),
                blink: z.boolean().optional().describe('flash the light to find it'),
                framesize: z.enum(framesizes).optional(),
                quality: z.number().int().min(4).max(63).optional(),
                rotation: z
                    .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
                    .optional()
                    .describe('turn of the picture, clockwise'),
                mirror: z.boolean().optional().describe('mirror the picture left to right'),
                zoom: z.number().min(1).max(ZOOM_MAX).optional().describe('show only the middle of the picture, 1 (all) to 2.5; cut out on the server'),
                zoom_x: z.number().min(0).max(1).optional().describe('the middle of the zoomed part, left 0 to right 1'),
                zoom_y: z.number().min(0).max(1).optional().describe('the middle of the zoomed part, top 0 to bottom 1'),
                brightness: z.number().int().min(-2).max(2).optional(),
                contrast: z.number().int().min(-2).max(2).optional(),
                saturation: z.number().int().min(-2).max(2).optional(),
                motion: z.boolean().optional(),
                motion_sensitivity: z.enum(['low', 'medium', 'high']).optional(),
                quiet_from: hour.optional(),
                quiet_to: hour.optional(),
                motion_blink: z.boolean().optional(),
                keep_pictures: z.boolean().optional(),
                cat_only: z
                    .boolean()
                    .optional()
                    .describe('only log movement as activity when the server sees a cat in it (good for the feeder); needs the detection model'),
                email_on_visit: z
                    .boolean()
                    .optional()
                    .describe('e-mail the owner when a cat comes (the server detects it in the picture), once a visit, with the picture'),
            },
            annotations: writes,
        },
        async (args) => {
            const doc = await findOwnDevice(session.userID, args.camera, 'camera');
            if (!doc) return fail(`No camera "${args.camera}". kibbl_devices lists them.`);
            const results: { change: string; ok: boolean; error?: string }[] = [];
            if (args.light !== undefined) {
                const r = await runDeviceCommand(doc, { cmd: 'light', level: args.light }, who, VIA);
                results.push({ change: 'light', ok: r.ok, error: r.error });
            }
            if (args.blink) {
                const r = await runDeviceCommand(doc, { cmd: 'blink', count: 5, level: 60 }, who, VIA);
                results.push({ change: 'blink', ok: r.ok, error: r.error });
            }
            const picture: Record<string, unknown> = { cmd: 'camera' };
            for (const key of ['framesize', 'quality', 'brightness', 'contrast', 'saturation'] as const) {
                if (args[key] !== undefined) picture[key] = args[key];
            }
            // turn and mirror together: the camera flips for 180, the server turns the quarter
            if (args.rotation !== undefined || args.mirror !== undefined) {
                const rotation = args.rotation ?? rotationOf(doc.camera, doc.turn90);
                Object.assign(picture, rotationCommand(rotation, args.mirror ?? isMirrored(doc.camera)));
            }
            if (args.zoom !== undefined || args.zoom_x !== undefined || args.zoom_y !== undefined) {
                const view = doc.view ?? { zoom: 1, x: 0.5, y: 0.5 };
                picture.view = { zoom: args.zoom ?? view.zoom, x: args.zoom_x ?? view.x, y: args.zoom_y ?? view.y };
            }
            if (Object.keys(picture).length > 1) {
                const r = await runDeviceCommand(doc, picture, who, VIA);
                results.push({ change: 'picture', ok: r.ok, error: r.error });
            }
            const motion = {
                enabled: args.motion,
                sensitivity: args.motion_sensitivity,
                quietFrom: args.quiet_from,
                quietTo: args.quiet_to,
                blink: args.motion_blink,
                keepPictures: args.keep_pictures,
                notify: args.email_on_visit,
                catOnly: args.cat_only,
            };
            if (Object.values(motion).some((v) => v !== undefined)) {
                const m = await applyMotionSettings(doc, motion, who, VIA);
                results.push({ change: `motion detection ${m.enabled ? 'on' : 'off'}`, ok: true });
            }
            if (!results.length) return fail('Nothing to change: give at least one setting.');
            return json({ camera: doc.name, results });
        },
    );

    /* ------------------------------------------------------------------- */

    server.registerTool(
        'kibbl_rooms_edit',
        {
            title: 'Rooms of the home',
            description:
                'Makes a room, renames one, sets what it is used for (kind), or moves a device (kibbl. air, camera) or a tado room into a room. A kibbl. air in the same room as a tado room shows the temperature of tado and ' +
                'humidity and switches its heating off while a window is open. room "" with move takes it out of every room. The kind sets the advice on the air of the room: ' +
                'a bathroom says when to air after a shower, a bedroom when to air before the night (and shows the last night), a kitchen when to turn on the hood.',
            inputSchema: {
                action: z.enum(['create', 'rename', 'set_kind', 'move']),
                room: z.string().describe('the room (for create: its name)'),
                new_name: z.string().max(40).optional().describe('for rename'),
                kind: z
                    .enum(Object.keys(ROOM_KINDS) as [RoomKind, ...RoomKind[]])
                    .optional()
                    .describe('for set_kind: what the room is used for'),
                device: z.string().optional().describe('for move: a device by name or id'),
                tado_room: z.string().optional().describe('for move: a tado room by name'),
            },
            annotations: writes,
        },
        async ({ action, room, new_name, kind, device, tado_room }) => {
            if (action === 'create') {
                if (!room.trim() || room.trim().length > 40) return fail('A name of 1 to 40 characters.');
                const made = await createRoom(session.userID, room);
                log.info('room made', { room: made.name, user: who, via: VIA });
                return json({ ok: true, room: made.name });
            }
            const target = room.trim() ? await findRoom(session.userID, room) : null;
            if (room.trim() && !target) return fail(`No room "${room}". Rooms: ${(await listRooms(session.userID)).map((r) => r.name).join(', ') || 'none'}.`);
            if (action === 'rename') {
                if (!target || !new_name?.trim()) return fail('rename needs the room and a new_name.');
                await renameRoom(session.userID, target._id, new_name);
                await publishPaired(session.userID);
                log.info('room renamed', { from: target.name, to: new_name.trim(), user: who, via: VIA });
                return json({ ok: true, room: new_name.trim() });
            }
            if (action === 'set_kind') {
                if (!target || !kind) return fail('set_kind needs the room and a kind.');
                await setRoomKind(session.userID, target._id, kind);
                await publishPaired(session.userID);
                log.info('room kind set', { room: target.name, kind, user: who, via: VIA });
                return json({ ok: true, room: target.name, kind });
            }
            if (device) {
                const docs = await Device.find({ ownerID: session.userID, status: 'approved' }).lean();
                const doc = docs.find((d) => d._id.toLowerCase() === lower(device)) ?? docs.find((d) => lower(d.name) === lower(device));
                if (!doc) return fail(`No device "${device}".`);
                await moveDevice(session.userID, doc._id, target?._id ?? null);
                await publishPaired(session.userID);
                log.info('device moved', { device: doc._id, room: target?.name ?? 'none', user: who, via: VIA });
                return json({ ok: true, device: doc.name, room: target?.name ?? null });
            }
            if (tado_room) {
                const h = await heatingStatus(session.userID);
                const t = h.rooms.find((x) => lower(x.name) === lower(tado_room));
                if (!t) return fail(`No tado room "${tado_room}".`);
                await placeTadoRoom(session.userID, t.id, target?._id ?? null);
                log.info('tado room moved', { tado: t.name, room: target?.name ?? 'none', user: who, via: VIA });
                return json({ ok: true, tado_room: t.name, room: target?.name ?? null });
            }
            return fail('move needs a device or a tado_room.');
        },
    );

    server.registerTool(
        'kibbl_home_location_set',
        {
            title: 'Home location',
            description:
                'Sets where the home is, by the name of a town or city, for the weather outside (the climate hints of a kibbl. air). Kept to about a kilometre.',
            inputSchema: { place: z.string().min(2).max(80) },
            annotations: writes,
        },
        async ({ place }) => {
            const found = (await searchPlaces(place).catch(() => []))[0];
            if (!found) return fail(`No place "${place}" found.`);
            const home = { latitude: Math.round(found.latitude * 100) / 100, longitude: Math.round(found.longitude * 100) / 100, name: found.name };
            await User.updateOne({ _id: session.userID }, { home });
            forgetHome(session.userID);
            log.info('home location set', { place: home.name, user: who, via: VIA });
            return json({ ok: true, home: home.name });
        },
    );

    server.registerTool(
        'kibbl_heat_meter_add',
        {
            title: 'Add a heat meter',
            description:
                'Adds a heat meter: the heat cost allocator on a radiator (kind radiator, counted in units; factor: what one unit counts for, as the ' +
                'Techem report lists it, 1 if unknown) or a meter of the whole home (kind meter, kWh, MWh or m³). room: the room of the home it is in.',
            inputSchema: {
                name: z.string().min(1).max(60),
                kind: z.enum(['radiator', 'meter']),
                unit: z.enum(HEAT_UNITS).optional().describe('for a meter; a radiator counts units'),
                factor: z.number().positive().max(100).optional(),
                room: z.string().optional(),
                serial: z.string().max(40).optional().describe('the number on the device'),
            },
            annotations: { ...writes, idempotentHint: false },
        },
        async ({ name, kind, unit, factor, room, serial }) => {
            const home = room ? await findRoom(session.userID, room) : undefined;
            if (room && !home) return fail(`No room "${room}". Rooms: ${(await listRooms(session.userID)).map((r) => r.name).join(', ')}.`);
            if ((await listHeatMeters(session.userID)).some((m) => lower(m.name) === lower(name))) return fail(`A heat meter "${name}" is there already.`);
            const id = await addHeatMeter(session.userID, { name, kind, unit, factor, roomId: home?._id, serial });
            log.info('heat meter added', { name, user: who, via: VIA });
            return json({ ok: true, id });
        },
    );

    server.registerTool(
        'kibbl_heat_readings_add',
        {
            title: 'Add heat readings',
            description:
                'Stores what heat meters showed on a day (a running total, as on the device or the report; a lower value than before counts as a reset). ' +
                'A reading of the same meter and day is replaced. Meters by name or id (kibbl_heat lists them).',
            inputSchema: {
                date: day.describe('the day they were read'),
                readings: z
                    .array(z.object({ meter: z.string(), value: z.number().min(0) }))
                    .min(1)
                    .max(100),
                from_report: z.boolean().default(false).describe('taken from a report of the meter reading company'),
            },
            annotations: writes,
        },
        async ({ date, readings, from_report }) => {
            const meters = await listHeatMeters(session.userID);
            const values: { meterId: string; value: number }[] = [];
            for (const r of readings) {
                const m = meters.find((x) => x._id === r.meter.trim() || lower(x.name) === lower(r.meter) || (x.serial && lower(x.serial) === lower(r.meter)));
                if (!m) return fail(`No heat meter "${r.meter}". Heat meters: ${meters.map((x) => x.name).join(', ') || 'none (kibbl_heat_meter_add)'}.`);
                values.push({ meterId: m._id, value: r.value });
            }
            try {
                await addHeatReadings(session.userID, date, values, from_report ? 'report' : 'assistant');
            } catch (err) {
                return fail(err instanceof HeatError ? err.message : 'Not stored.');
            }
            log.info('heat readings added', { date, count: values.length, user: who, via: VIA });
            return json({ ok: true, stored: values.length });
        },
    );
}
