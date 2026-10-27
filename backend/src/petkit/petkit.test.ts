import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zoneOffset } from './client';
import { dayProblem, parseMealTime } from '../../../shared/petkit';
import { feedDailyListFor, feederClock, feederFrom, feederOffset, mealFrom, planFrom } from './service';

const NOON = 12 * 3600;

test('a meal still to come is planned', () => {
    const m = mealFrom({ id: 's64800', time: 64800, amount: 20, name: 'Dinner', src: 1, status: 0 }, NOON);
    assert.equal(m.state, 'planned');
    assert.equal(m.portions, 2);
    assert.equal(m.manual, false);
    assert.equal(m.name, 'Dinner');
});

test('a meal with a result and food is given', () => {
    const m = mealFrom(
        { id: 's28800', time: 28800, amount: 20, src: 1, status: 0, state: { result: 0, realAmount: 20, completedAt: '2026-10-21T06:00:03.000+0000' } },
        NOON,
    );
    assert.equal(m.state, 'given');
    assert.equal(m.given, 2);
    assert.equal(m.at, Date.parse('2026-10-21T06:00:03.000+0000'));
});

test('skipped, cancelled, being given and failed meals', () => {
    assert.equal(mealFrom({ time: 64800, amount: 10, status: 1 }, NOON).state, 'skipped');
    assert.equal(mealFrom({ time: 28800, amount: 10, state: { result: 7, realAmount: 0 } }, NOON).state, 'skipped');
    assert.equal(mealFrom({ time: 43190, amount: 10, status: 3 }, NOON).state, 'feeding');
    assert.equal(mealFrom({ time: 28800, amount: 10, state: { result: 3, realAmount: 0 } }, NOON).state, 'failed');
    assert.equal(mealFrom({ time: 28800, amount: 10, state: { result: 0, realAmount: 0 } }, NOON).state, 'failed');
});

test('a past meal without a result is being given at first, then missed', () => {
    assert.equal(mealFrom({ time: NOON - 60, amount: 10, status: 0 }, NOON).state, 'feeding');
    assert.equal(mealFrom({ time: NOON - 3600, amount: 10, status: 0 }, NOON).state, 'missed');
    assert.equal(mealFrom({ time: 28800, amount: 10, status: 2 }, NOON).state, 'missed');
});

test('a feed from an app is manual', () => {
    assert.equal(mealFrom({ id: 'r1', time: 40000, amount: 30, src: 4, state: { result: 0, realAmount: 30 } }, NOON).manual, true);
});

test('the feeder clock is that of its offset', () => {
    const at = Date.parse('2026-10-21T22:30:00Z');
    assert.deepEqual(feederClock(2, at), { day: '20261022', seconds: 30 * 60 });
    assert.deepEqual(feederClock(0, at), { day: '20261021', seconds: 22.5 * 3600 });
});

test('the feeder offset follows its zone, not the timezone PetKit kept from summer', () => {
    const winter = Date.parse('2026-10-27T10:50:00Z');
    assert.equal(feederOffset({ timezone: 2, locale: 'Europe/Berlin' }, winter), 1);
    assert.equal(feederOffset({ timezone: 2, locale: 'Europe/Berlin' }, Date.parse('2026-07-01T12:00:00Z')), 2);
    assert.equal(feederOffset({ timezone: 2, locale: 'not a zone' }, winter), 2);
    assert.equal(feederOffset({ timezone: 2 }, winter), 2);
    // 11:50 CET: breakfast at 12:00 is still to come
    const f = feederFrom(
        { id: 1, type: 'd4', name: 'solo' },
        { timezone: 2, locale: 'Europe/Berlin', state: {} },
        { feed: [{ day: 20261027, items: [{ id: 's43200', time: 43200, amount: 10, src: 1, status: 0 }] }] },
        winter,
    );
    assert.equal(f.meals[0].state, 'planned');
});

test('the offset of a zone, as PetKit writes it', () => {
    assert.equal(zoneOffset('Europe/Berlin', new Date('2026-07-01T12:00:00Z')), '2.0');
    assert.equal(zoneOffset('Europe/Berlin', new Date('2026-12-01T12:00:00Z')), '1.0');
    assert.equal(zoneOffset('Asia/Kolkata', new Date('2026-12-01T12:00:00Z')), '5.5');
});

test('a Fresh Element Solo from its detail and today', () => {
    const at = Date.parse('2026-10-21T10:00:00Z'); // 12:00 on the feeder
    const f = feederFrom(
        { id: 42, type: 'd4', name: 'solo', cameraId: 'AABBCCDDEEFF' },
        {
            name: 'Kibble',
            firmware: 1.6,
            timezone: 2,
            settings: { factor: 10 },
            state: { pim: 1, food: 0, feeding: 0, desiccantLeftDays: 21, batteryStatus: 0, wifi: { rsq: -58 }, errorMsg: '' },
            multiFeedItem: { feedDailyList: [{ suspended: 0 }, { suspended: 0 }] },
        },
        {
            feed: [
                {
                    day: 20261021,
                    items: [
                        { id: 's64800', time: 64800, amount: 20, name: 'Dinner', src: 1, status: 0 },
                        { id: 's28800', time: 28800, amount: 20, name: 'Breakfast', src: 1, status: 0, state: { result: 0, realAmount: 20 } },
                        { id: 'm1', time: 36000, amount: 10, src: 4, status: 0, state: { result: 0, realAmount: 10 } },
                    ],
                },
            ],
        },
        at,
    );
    assert.equal(f.name, 'Kibble');
    assert.equal(f.online, true);
    assert.equal(f.food, 'low');
    assert.equal(f.error, undefined);
    assert.equal(f.battery, 'mains');
    assert.equal(f.wifi, -58);
    assert.equal(f.planPaused, false);
    assert.deepEqual(
        f.meals.map((m) => [m.time, m.state]),
        [
            [28800, 'given'],
            [36000, 'given'],
            [64800, 'planned'],
        ],
    );
    assert.equal(f.givenToday, 3);
    assert.equal(f.plannedToday, 4);
    assert.equal(f.cameraId, 'AABBCCDDEEFF');
});

test('a feeder that is offline, with a paused plan', () => {
    const f = feederFrom(
        { id: 1, type: 'd4', name: 'solo' },
        { state: { pim: 0, food: 1 }, multiFeedItem: { feedDailyList: [{ suspended: 1 }] } },
        { feed: [] },
    );
    assert.equal(f.online, false);
    assert.equal(f.food, 'enough');
    assert.equal(f.planPaused, true);
    assert.deepEqual(f.meals, []);
});

const D4_PLAN = {
    feedDailyList: [
        { repeats: '1', suspended: 0, count: 1, items: [{ id: 's28800', time: 28800, amount: 20, name: 'Breakfast', deviceId: 42, deviceType: 11 }] },
        {
            repeats: '2',
            suspended: 0,
            count: 2,
            items: [
                { id: 's64800', time: 64800, amount: 10, name: 'Dinner' },
                { id: 's25200', time: 25200, amount: 30, name: 'Breakfast' },
            ],
        },
        { repeats: '3', suspended: 0, items: [] },
    ],
};

test('the plan of a d4 by weekday, Monday first', () => {
    const plan = planFrom(42, D4_PLAN);
    assert.equal(plan.paused, false);
    assert.deepEqual(plan.days[6], [{ time: 28800, portions: 2, name: 'Breakfast' }]); // repeats 1 is Sunday
    assert.deepEqual(
        plan.days[0].map((m) => [m.time, m.portions]),
        [
            [25200, 3],
            [64800, 1],
        ],
    );
    assert.deepEqual(plan.days[1], []);
    assert.deepEqual(plan.days[5], []);
});

test('a paused plan', () => {
    assert.equal(planFrom(1, { feedDailyList: [{ repeats: '1', suspended: 1, items: [] }] }).paused, true);
});

test('the seven days to save keep ids and what else a day has', () => {
    const days = planFrom(42, D4_PLAN).days;
    days[0] = [
        { time: 25200, portions: 2, name: 'Breakfast' },
        { time: 70200, portions: 1, name: 'Late' },
    ];
    const list = feedDailyListFor(D4_PLAN, days, 42, 11);
    assert.equal(list.length, 7);
    const monday = list[0] as Record<string, unknown> & { items: { id: unknown; time: number; amount: number; deviceType: number }[] };
    assert.equal(monday.repeats, '2');
    assert.deepEqual(
        monday.items.map((i) => [i.time, i.amount, i.id]),
        [
            [25200, 20, 's25200'],
            [70200, 10, 70200],
        ],
    );
    assert.equal(monday.items[0].deviceType, 11);
    assert.equal(monday.count, 2);
    assert.equal(monday.totalAmount, 30);
    // a day PetKit did not send is made, with its weekday
    assert.equal((list[3] as { repeats: string }).repeats, '5');
    assert.equal((list[6] as { repeats: string }).repeats, '1');
});

test('a day of meals is checked as PetKit does', () => {
    assert.equal(dayProblem([{ time: 25200, portions: 2, name: '' }]), undefined);
    assert.match(
        dayProblem([
            { time: 25200, portions: 2, name: '' },
            { time: 25380, portions: 1, name: '' },
        ]) ?? '',
        /5 minutes apart/,
    );
    assert.match(dayProblem([{ time: 25200, portions: 11, name: '' }]) ?? '', /portions/);
    assert.equal(parseMealTime('7:30'), 27000);
    assert.equal(parseMealTime('24:00'), undefined);
});
