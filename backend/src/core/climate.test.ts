import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absoluteHumidity, climateHints, dewPoint, wallSurface } from '../../../shared/climate';

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
