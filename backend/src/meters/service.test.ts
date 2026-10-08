import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediumOf, valueAt } from './service';

test('the medium and unit of a meter follow the device type of the LoRaWAN server', () => {
    assert.deepEqual(mediumOf('electricity_ferraris'), { medium: 'electricity', unit: 'kWh' });
    assert.deepEqual(mediumOf('lorawan-gas'), { medium: 'gas', unit: 'm³' });
    assert.deepEqual(mediumOf('wasser'), { medium: 'water', unit: 'm³' });
    assert.deepEqual(mediumOf(undefined), { medium: 'electricity', unit: 'kWh' });
});

test("the meter's value at midnight lies between the readings around it", () => {
    assert.equal(valueAt(1000, { at: 0, value: 10 }, { at: 2000, value: 12 }), 11);
    assert.equal(valueAt(1000, { at: 0, value: 10 }), 10);
    assert.equal(valueAt(1000, undefined, { at: 2000, value: 12 }), 12);
    assert.equal(valueAt(1000), null);
});
