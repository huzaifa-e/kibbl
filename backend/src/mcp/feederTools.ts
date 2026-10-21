import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
    PETKIT_PLAN_PORTIONS,
    PETKIT_PORTIONS,
    WEEKDAYS,
    WEEKDAY_NAMES,
    mealTime,
    parseMealTime,
    type PetkitFeeder,
    type PetkitPlan,
    type PetkitPlanMeal,
} from '../../../shared/petkit';
import { PetkitError } from '../petkit/client';
import { cancelFeed, feed, getPlan, pausePlan, savePlan, skipMeal, status } from '../petkit/service';
import { localTime } from './tools';

/*
 * The PetKit feeder through the MCP endpoint (petkit/service.ts): what it gave today and its
 * weekly plan, feeding now, skipping or giving a meal of today, and changing the plan, the
 * same as the feeder page of the app. Every change is logged "via assistant".
 */

const VIA = 'assistant';

const json = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const time = z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .describe('HH:MM, 24 h, the feeder clock');
const meal = z.object({
    time,
    portions: z.number().int().min(PETKIT_PLAN_PORTIONS.min).max(PETKIT_PLAN_PORTIONS.max).describe('portions of about 10 g'),
    name: z.string().max(20).default(''),
});
const weekday = z.enum([...WEEKDAYS, 'all', 'weekdays', 'weekend']);

const failed = (err: unknown) => fail(err instanceof PetkitError ? err.message : `PetKit did not answer: ${(err as Error).message}`);

// the feeder by name or id; with one, that one
async function findFeeder(userID: string, ref: string) {
    const s = await status(userID);
    if (!s.connected) return { error: 'PetKit is not connected (Devices, Pet feeder · PetKit).' };
    const r = ref.trim().toLowerCase();
    const f = s.feeders.find((x) => String(x.id) === r || x.name.toLowerCase() === r) ?? (r ? undefined : s.feeders.length === 1 ? s.feeders[0] : undefined);
    return f
        ? { feeder: f }
        : { error: s.feeders.length ? `No PetKit feeder "${ref}". There are: ${s.feeders.map((x) => x.name).join(', ')}.` : 'No feeder read yet.' };
}

const mealOut = (m: PetkitPlanMeal) => ({ time: mealTime(m.time), portions: m.portions, name: m.name || null });

function planOut(plan: PetkitPlan) {
    return {
        paused: plan.paused,
        days: Object.fromEntries(plan.days.map((meals, i) => [WEEKDAY_NAMES[i], meals.map(mealOut)])),
        portions_a_day: Object.fromEntries(plan.days.map((meals, i) => [WEEKDAY_NAMES[i], meals.reduce((sum, m) => sum + m.portions, 0)])),
    };
}

function feederOut(f: PetkitFeeder) {
    return {
        name: f.name,
        online: f.online,
        food: f.food,
        feeding_now: f.feeding,
        problem: f.error ?? null,
        desiccant_days_left: f.desiccantDays ?? null,
        given_today_portions: f.givenToday,
        planned_today_portions: f.plannedToday,
        today: f.meals.map((m) => ({
            time: mealTime(m.time),
            name: m.name || null,
            portions: m.portions,
            given: m.given ?? null,
            state: m.state,
            from_app: m.manual,
        })),
        read: localTime(f.at),
    };
}

function indexesOf(days: z.infer<typeof weekday>[]) {
    const out = new Set<number>();
    for (const d of days) {
        if (d === 'all') [0, 1, 2, 3, 4, 5, 6].forEach((i) => out.add(i));
        else if (d === 'weekdays') [0, 1, 2, 3, 4].forEach((i) => out.add(i));
        else if (d === 'weekend') [5, 6].forEach((i) => out.add(i));
        else out.add(WEEKDAYS.indexOf(d));
    }
    return [...out].sort();
}

export function registerFeederTools(server: McpServer, session: SessionInfo) {
    const who = session.email;

    server.registerTool(
        'kibbl_feeder',
        {
            title: 'Pet feeder',
            description:
                "The PetKit feeder (Fresh Element Solo): whether its hopper has enough food, today's meals (planned, given, skipped, not given; from_app: fed now instead of by the plan), " +
                'portions given today (a portion is about 10 g), the desiccant, and its weekly feeding plan per weekday. Times are the feeder clock (local time).',
            inputSchema: { feeder: z.string().default('').describe('name, when there is more than one') },
            annotations: readOnly,
        },
        async ({ feeder }) => {
            const found = await findFeeder(session.userID, feeder);
            if (!found.feeder) return fail(found.error!);
            try {
                return json({ ...feederOut(found.feeder), plan: planOut(await getPlan(session.userID, found.feeder.id)) });
            } catch (err) {
                return json({ ...feederOut(found.feeder), plan: null, plan_error: (err as Error).message });
            }
        },
    );

    server.registerTool(
        'kibbl_feeder_feed',
        {
            title: 'Feed now',
            description: `Gives food now: ${PETKIT_PORTIONS.min} to ${PETKIT_PORTIONS.max} portions of about 10 g. stop: true stops a feed that is running.`,
            inputSchema: {
                feeder: z.string().default(''),
                portions: z.number().int().min(PETKIT_PORTIONS.min).max(PETKIT_PORTIONS.max).optional(),
                stop: z.boolean().default(false),
            },
            annotations: writes,
        },
        async ({ feeder, portions, stop }) => {
            const found = await findFeeder(session.userID, feeder);
            if (!found.feeder) return fail(found.error!);
            if (!found.feeder.online) return fail(`${found.feeder.name} is offline.`);
            try {
                if (stop) await cancelFeed(session.userID, found.feeder.id, who, VIA);
                else if (portions) await feed(session.userID, found.feeder.id, portions, who, VIA);
                else return fail('portions, or stop: true');
                return json({ ok: true, feeder: found.feeder.name, ...(stop ? { stopped: true } : { portions }) });
            } catch (err) {
                return failed(err);
            }
        },
    );

    server.registerTool(
        'kibbl_feeder_today',
        {
            title: "Skip or give a meal of today's plan",
            description:
                'skip: a meal of the plan still to come today is not given (only today, the plan stays). give: a skipped one is given after all, if its time has not passed.',
            inputSchema: { feeder: z.string().default(''), time, action: z.enum(['skip', 'give']) },
            annotations: writes,
        },
        async ({ feeder, time: at, action }) => {
            const found = await findFeeder(session.userID, feeder);
            if (!found.feeder) return fail(found.error!);
            const seconds = parseMealTime(at);
            const m = found.feeder.meals.find((x) => !x.manual && x.time === seconds);
            if (!m)
                return fail(
                    `No meal of the plan at ${at} today. Today: ${found.feeder.meals.map((x) => `${mealTime(x.time)} ${x.state}`).join(', ') || 'none'}.`,
                );
            try {
                await skipMeal(session.userID, found.feeder.id, m.id, action === 'skip', who, VIA);
                return json({ ok: true, feeder: found.feeder.name, meal: mealTime(m.time), [action === 'skip' ? 'skipped' : 'given']: true });
            } catch (err) {
                return failed(err);
            }
        },
    );

    server.registerTool(
        'kibbl_feeder_schedule',
        {
            title: 'Change the feeding plan',
            description:
                'Changes the weekly feeding plan on the given weekdays (all, weekdays, weekend or mon..sun): set replaces their meals (an empty list leaves no meal), ' +
                'add adds meals, remove takes the meals at these times away, move changes a meal: its time (to) and/or portions. Applied in that order. ' +
                `Meals at least 5 minutes apart, at most 10 a day, ${PETKIT_PLAN_PORTIONS.min}-${PETKIT_PLAN_PORTIONS.max} portions of about 10 g each. ` +
                'paused: true stops the plan on all days (no meal is given until false), without changing it. Answers the whole plan as saved.',
            inputSchema: {
                feeder: z.string().default(''),
                days: z.array(weekday).default(['all']),
                set: z.array(meal).optional(),
                add: z.array(meal).optional(),
                remove: z.array(time).optional(),
                move: z
                    .array(
                        z.object({
                            from: time,
                            to: time.optional(),
                            portions: z.number().int().min(PETKIT_PLAN_PORTIONS.min).max(PETKIT_PLAN_PORTIONS.max).optional(),
                        }),
                    )
                    .optional(),
                paused: z.boolean().optional(),
            },
            annotations: writes,
        },
        async ({ feeder, days, set, add, remove, move, paused }) => {
            const found = await findFeeder(session.userID, feeder);
            if (!found.feeder) return fail(found.error!);
            const id = found.feeder.id;
            const toMeal = (m: z.infer<typeof meal>): PetkitPlanMeal | undefined => {
                const t = parseMealTime(m.time);
                return t === undefined ? undefined : { time: t, portions: m.portions, name: m.name };
            };
            try {
                let plan = await getPlan(session.userID, id, true);
                if (set || add || remove || move) {
                    const next = plan.days.map((d) => d.map((m) => ({ ...m })));
                    for (const i of indexesOf(days)) {
                        let meals = next[i];
                        if (set) meals = set.map(toMeal).filter((m): m is PetkitPlanMeal => !!m);
                        for (const m of add ?? []) {
                            const x = toMeal(m);
                            if (x) meals = [...meals.filter((y) => y.time !== x.time), x];
                        }
                        const gone = new Set((remove ?? []).map(parseMealTime));
                        meals = meals.filter((m) => !gone.has(m.time));
                        for (const mv of move ?? []) {
                            const from = parseMealTime(mv.from);
                            const m = meals.find((y) => y.time === from);
                            if (!m) return fail(`${WEEKDAY_NAMES[i]} has no meal at ${mv.from}.`);
                            if (mv.to) m.time = parseMealTime(mv.to) ?? m.time;
                            if (mv.portions) m.portions = mv.portions;
                        }
                        next[i] = meals.sort((a, b) => a.time - b.time);
                    }
                    plan = await savePlan(session.userID, id, next, who, VIA);
                }
                if (paused !== undefined && paused !== plan.paused) {
                    await pausePlan(session.userID, id, paused, who, VIA);
                    plan = await getPlan(session.userID, id, true);
                }
                return json({ ok: true, feeder: found.feeder.name, plan: planOut(plan) });
            } catch (err) {
                return failed(err);
            }
        },
    );
}
