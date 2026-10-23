import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SCHEDULE_LAYOUTS, type HeatingSchedule, type ScheduleDay, type ScheduleLayout } from '../../../shared/heating';
import { listRooms } from '../core/rooms';
import { logger } from '../core/logger';
import { TadoError } from '../tado/client';
import { dayBlocks, getSchedule, setScheduleDays } from '../tado/schedule';
import { status as heatingStatus } from '../tado/service';

/*
 * The weekly schedules of tado's rooms through the MCP endpoint (tado/schedule.ts): reading a
 * room's schedule and changing days of it, as tado's own app does. Every change is logged
 * "via assistant".
 */

const log = logger('mcp');
const VIA = 'assistant';

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const layouts = Object.keys(SCHEDULE_LAYOUTS) as [ScheduleLayout, ...ScheduleLayout[]];
const allDays = [...new Set(Object.values(SCHEDULE_LAYOUTS).flat())] as [ScheduleDay, ...ScheduleDay[]];
const lower = (s: string) => s.trim().toLowerCase();

const failed = (err: unknown) => fail(err instanceof TadoError ? err.message : `tado did not answer: ${(err as Error).message}`);

// a tado room by its name or the room of the home it is in
async function findTadoRoom(userID: string, ref: string) {
    const h = await heatingStatus(userID);
    if (!h.connected) return { error: 'tado is not connected (Devices, Heating · tado).' };
    const r = lower(ref);
    const home = (await listRooms(userID)).find((x) => x._id === ref.trim() || lower(x.name) === r);
    const room = h.rooms.find((x) => lower(x.name) === r) ?? (home ? h.rooms.find((x) => x.roomId === home._id) : undefined);
    return room ? { room, left: h.budget?.remaining } : { error: `No tado room "${ref}". tado rooms: ${h.rooms.map((x) => x.name).join(', ') || 'none'}.` };
}

const scheduleOut = (s: HeatingSchedule) => ({
    layout: s.layout,
    days: s.days.map((d) => ({ day: d.day, blocks: d.blocks.map((b) => ({ from: b.start, to: b.end, temperature: b.celsius })) })),
});

export function registerHeatingScheduleTools(server: McpServer, session: SessionInfo) {
    const who = session.email;

    server.registerTool(
        'kibbl_heating_schedule',
        {
            title: 'Heating schedule',
            description:
                "The weekly schedule of a tado room: its layout (one_day: the same every day; three_day: MONDAY_TO_FRIDAY, SATURDAY, SUNDAY; seven_day: each day) and each day's blocks " +
                'from/to (HH:MM, home time, to 24:00 for midnight) with the temperature it heats to (null: off). ' +
                "Costs 1-2 of tado's daily requests; kept 15 minutes (fresh: true reads it again). A manual setting or the adaptive control (kibbl_heating) goes before the schedule.",
            inputSchema: {
                room: z.string().describe('tado room or room of the home, e.g. "Living Room"'),
                fresh: z.boolean().default(false),
            },
            annotations: readOnly,
        },
        async ({ room, fresh }) => {
            const found = await findTadoRoom(session.userID, room);
            if (!found.room) return fail(found.error!);
            try {
                return json({ room: found.room.name, ...scheduleOut(await getSchedule(session.userID, found.room.id, fresh)) });
            } catch (err) {
                return failed(err);
            }
        },
    );

    server.registerTool(
        'kibbl_heating_schedule_set',
        {
            title: 'Change the heating schedule',
            description:
                "Replaces the blocks of days of a tado room's weekly schedule. blocks are given by when each starts: the first at 00:00, each lasts until the next starts, the last until midnight; " +
                'temperature null switches the heating off for that block. days are days of the layout (kibbl_heating_schedule shows it): MONDAY_TO_SUNDAY for one_day, ' +
                'MONDAY_TO_FRIDAY, SATURDAY or SUNDAY for three_day, MONDAY..SUNDAY for seven_day. ' +
                "layout switches a classic tado home's room to another layout first (each layout keeps its own blocks; not possible on tado X, its app decides). " +
                "One of tado's daily requests per day, one more on classic homes. A manual setting or the adaptive control of the room stays until it ends (kibbl_heating_set mode schedule ends it). " +
                'Answers the whole schedule.',
            inputSchema: {
                room: z.string().describe('tado room or room of the home, e.g. "Living Room"'),
                days: z.array(z.enum(allDays)).min(1),
                blocks: z
                    .array(
                        z.object({
                            from: z.string().describe('HH:MM, 24 h, home time'),
                            temperature: z.number().min(5).max(25).nullable().describe('°C, in steps of 0.5; null: off'),
                        }),
                    )
                    .min(1)
                    .max(24),
                layout: z.enum(layouts).optional(),
            },
            annotations: writes,
        },
        async ({ room, days, blocks, layout }) => {
            const found = await findTadoRoom(session.userID, room);
            if (!found.room) return fail(found.error!);
            const unique = [...new Set(days)];
            try {
                const day = dayBlocks(blocks.map((b) => ({ from: b.from, celsius: b.temperature })));
                const schedule = await setScheduleDays(session.userID, found.room.id, unique, day, layout);
                log.info('heating schedule set', { room: found.room.name, days: unique.join(','), layout: schedule.layout, user: who, via: VIA });
                return json({ ok: true, room: found.room.name, ...scheduleOut(schedule) });
            } catch (err) {
                return failed(err);
            }
        },
    );
}
