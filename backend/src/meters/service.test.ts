import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediumOf } from './service';

test('the medium and unit of a meter follow the device type of the LoRaWAN server', () => {
    assert.deepEqual(mediumOf('electricity_ferraris'), { medium: 'electricity', unit: 'kWh' });
    assert.deepEqual(mediumOf('lorawan-gas'), { medium: 'gas', unit: 'm³' });
    assert.deepEqual(mediumOf('wasser'), { medium: 'water', unit: 'm³' });
    assert.deepEqual(mediumOf(undefined), { medium: 'electricity', unit: 'kWh' });
});
