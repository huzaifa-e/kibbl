import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRate } from './client';
import { dayBlocks, layoutOf, scheduleOf, tadoBlocks } from './schedule';
import { classicRoom, pollMinutes, xRoom } from './service';

test('a classic zone state becomes a room', () => {
    const room = classicRoom(1, 'Living Room', {
        setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 20.5 } },
        overlay: { termination: { typeSkillBasedApp: 'NEXT_TIME_BLOCK', projectedExpiry: '2026-10-07T22:00:00Z' } },
        activityDataPoints: { heatingPower: { percentage: 37 } },
        sensorDataPoints: { insideTemperature: { celsius: 21.43 }, humidity: { percentage: 51.8 } },
        openWindow: null,
    });
    assert.equal(room.temperature, 21.4);
    assert.equal(room.humidity, 51.8);
    assert.equal(room.target, 20.5);
    assert.equal(room.heating, 37);
    assert.equal(room.manual, true);
    assert.equal(room.manualUntil, Date.parse('2026-10-07T22:00:00Z'));
});

test('a classic zone that is off has no target', () => {
    const room = classicRoom(2, 'Bedroom', { setting: { type: 'HEATING', power: 'OFF', temperature: null }, sensorDataPoints: {} });
    assert.equal(room.power, 'OFF');
    assert.equal(room.target, null);
    assert.equal(room.temperature, undefined);
});

test('a tado X room becomes a room', () => {
    const room = xRoom({
        id: 3,
        name: 'Office',
        sensorDataPoints: { insideTemperature: { value: 19.96 }, humidity: { percentage: 48 } },
        setting: { power: 'ON', temperature: { value: 21 } },
        heatingPower: { percentage: 80 },
        openWindow: { activated: true, expiryInSeconds: 600 },
        manualControlTermination: null,
    });
    assert.equal(room.id, 3);
    assert.equal(room.temperature, 20);
    assert.equal(room.target, 21);
    assert.equal(room.openWindow, true);
    assert.equal(room.manual, false);
});

test('the rate limit header says what is left', () => {
    assert.equal(parseRate('"perday";r=93').remaining, 93);
    const empty = parseRate('"perday";r=0;t=120');
    assert.equal(empty.remaining, 0);
    assert.ok(empty.resetAt! > Date.now() + 100_000);
    assert.deepEqual(parseRate(null), {});
});

test('the rooms are read as often as the budget left allows', () => {
    assert.equal(pollMinutes(undefined), 20);
    assert.equal(pollMinutes(950), 2);
    assert.equal(pollMinutes(200), 5);
    assert.equal(pollMinutes(100), 20);
    assert.equal(pollMinutes(10), 60);
});

test('a day is made from when its blocks start, the last until midnight', () => {
    const blocks = dayBlocks([
        { from: '0:00', celsius: 17 },
        { from: '06:30', celsius: 21.3 },
        { from: '22:00', celsius: null },
    ]);
    assert.deepEqual(blocks, [
        { start: '00:00', end: '06:30', celsius: 17 },
        { start: '06:30', end: '22:00', celsius: 21.5 },
        { start: '22:00', end: '24:00', celsius: null },
    ]);
    assert.throws(() => dayBlocks([{ from: '01:00', celsius: 18 }]), /starts at 00:00/);
    assert.throws(
        () =>
            dayBlocks([
                { from: '00:00', celsius: 18 },
                { from: '00:00', celsius: 20 },
            ]),
        /order of time/,
    );
    assert.throws(() => dayBlocks([{ from: '00:00', celsius: 30 }]), /outside/);
    assert.throws(() => dayBlocks([{ from: '24:00', celsius: 18 }]), /not a time/);
});

test('a day goes to tado classic ending at 00:00, to tado X at 24:00', () => {
    const blocks = dayBlocks([
        { from: '00:00', celsius: 18 },
        { from: '23:00', celsius: null },
    ]);
    const classic = tadoBlocks('SATURDAY', blocks, false);
    assert.equal(classic[1].end, '00:00');
    assert.deepEqual(classic[0].setting, { type: 'HEATING', power: 'ON', temperature: { celsius: 18 } });
    assert.deepEqual(classic[1].setting, { type: 'HEATING', power: 'OFF', temperature: null });
    const x = tadoBlocks('SATURDAY', blocks, true);
    assert.equal(x[1].end, '24:00');
    assert.deepEqual(x[0].setting, { power: 'ON', temperature: { value: 18 } });
});

test('the blocks tado sends become days of the layout', () => {
    const raw = [
        { dayType: 'SUNDAY', start: '00:00', end: '00:00', setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 19 } } },
        { dayType: 'MONDAY_TO_FRIDAY', start: '07:00', end: '00:00', setting: { type: 'HEATING', power: 'OFF', temperature: null } },
        { dayType: 'MONDAY_TO_FRIDAY', start: '00:00', end: '07:00', setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 20 } } },
    ];
    const s = scheduleOf('three_day', raw);
    assert.deepEqual(
        s.days.map((d) => d.day),
        ['MONDAY_TO_FRIDAY', 'SATURDAY', 'SUNDAY'],
    );
    assert.deepEqual(s.days[0].blocks, [
        { start: '00:00', end: '07:00', celsius: 20 },
        { start: '07:00', end: '24:00', celsius: null },
    ]);
    assert.deepEqual(s.days[2].blocks, [{ start: '00:00', end: '24:00', celsius: 19 }]);
    const x = scheduleOf('one_day', [{ dayType: 'MONDAY_TO_SUNDAY', start: '00:00', end: '24:00', setting: { power: 'ON', temperature: { value: 18.5 } } }]);
    assert.deepEqual(x.days[0].blocks, [{ start: '00:00', end: '24:00', celsius: 18.5 }]);
});

test('the layout of a tado X schedule follows from its days', () => {
    assert.equal(layoutOf(['MONDAY_TO_SUNDAY']), 'one_day');
    assert.equal(layoutOf(['SUNDAY', 'MONDAY_TO_FRIDAY', 'SATURDAY']), 'three_day');
    assert.equal(layoutOf(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']), 'seven_day');
});
