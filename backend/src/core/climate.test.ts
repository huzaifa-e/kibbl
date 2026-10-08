import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absoluteHumidity, climateHints, dewPoint, wallSurface, roomHints } from '../../../shared/climate';
import { roomKind } from '../../../shared/roomKind';

const ids = (hints: { id: string; level: string }[]) => hints.map((h) => `${h.id}:${h.level}`);

test('absolute humidity and dew point match the tables', () => {
    // 20 °C at 50 %: 8.6 g/m³, dew point 9.3 °C
    assert.ok(Math.abs(absoluteHumidity(20, 50) - 8.6) < 0.1);
    assert.ok(Math.abs(dewPoint(20, 50) - 9.3) < 0.1);
});

test('the wall of a heated room in frost is damp at its surface', () => {
    // 20 °C and 60 % inside, 0 °C outside: the wall at 14 °C holds the air at about 88 %
    const wall = wallSurface(20, 60, 0);
    assert.ok(Math.abs(wall.temperature - 14) < 0.01);
    assert.ok(wall.humidity > 85 && wall.humidity < 90);
    const hints = climateHints({ temperature: 20, humidity: 60 }, { temperature: 0, humidity: 90, at: Date.now() });
    assert.ok(ids(hints).includes('mould:alert'));
});

test('no mould warning when it is as warm outside', () => {
    const hints = climateHints({ temperature: 22, humidity: 65 }, { temperature: 22, humidity: 50, at: Date.now() });
    assert.ok(!hints.some((h) => h.id === 'mould'));
    // drier outside: airing dries
    assert.ok(hints.some((h) => h.id === 'airing' && h.title.includes('dries')));
});

test('cold, hot, dry and stale air are named, the worst first', () => {
    assert.deepEqual(ids(climateHints({ temperature: 15 })), ['cold:alert']);
    assert.deepEqual(ids(climateHints({ temperature: 17 })), ['cold:warn']);
    assert.deepEqual(ids(climateHints({ temperature: 27 })), ['hot:warn']);
    assert.deepEqual(ids(climateHints({ temperature: 21, humidity: 25, co2: 2400 })), ['co2:alert', 'dry:warn', 'temperature:good']);
    assert.deepEqual(ids(climateHints({ temperature: 21, humidity: 50, co2: 600 })), ['temperature:good', 'humidity:good', 'co2:good']);
});

test('warm and humid is muggy', () => {
    assert.ok(climateHints({ temperature: 28, humidity: 65 }).some((h) => h.id === 'muggy'));
});

test('a room is a bathroom or bedroom by its name until another kind is chosen', () => {
    assert.equal(roomKind({ name: 'Bathroom' }), 'bathroom');
    assert.equal(roomKind({ name: 'Badezimmer' }), 'bathroom');
    assert.equal(roomKind({ name: 'Schlafzimmer' }), 'bedroom');
    assert.equal(roomKind({ name: 'Living Room' }), 'living');
    assert.equal(roomKind({ name: 'Hallway' }), 'other');
    assert.equal(roomKind({ name: 'Bathroom', kind: 'kitchen' }), 'kitchen');
});

test('a quick rise of the humidity in a bathroom is a shower: open the window', () => {
    const now = Date.now();
    const recent = [
        { at: now - 15 * 60_000, humidity: 52 },
        { at: now - 5 * 60_000, humidity: 58 },
        { at: now, humidity: 64 },
    ];
    const day = { hour: 8, night: false };
    const { hints, replaces } = roomHints('bathroom', { humidity: 64, temperature: 22 }, recent, day, now);
    assert.equal(hints[0].id, 'shower');
    assert.ok(replaces.includes('humid'));
    // the same humidity without a rise and below the damp line: nothing to do
    assert.equal(roomHints('bathroom', { humidity: 58 }, [{ at: now, humidity: 58 }], day, now).hints[0].id, 'bathroom-dry');
    // in a living room the shower rule does not apply
    assert.equal(roomHints('living', { humidity: 64 }, recent, day, now).hints.length, 0);
});

test('a bedroom asks to air in the evening and warns of stuffy air at night', () => {
    const evening = roomHints('bedroom', { co2: 950, temperature: 21 }, [], { hour: 21, night: false });
    assert.equal(evening.hints[0].id, 'bedtime');
    const night = roomHints('bedroom', { co2: 1300, temperature: 19 }, [], { hour: 2, night: true });
    assert.deepEqual(
        night.hints.map((h) => h.id),
        ['sleep-co2'],
    );
    assert.equal(roomHints('bedroom', { co2: 600, temperature: 18 }, [], { hour: 21, night: false }).hints.length, 0);
});
