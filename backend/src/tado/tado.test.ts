import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRate } from './client';
import { classicRoom, xRoom } from './service';

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
