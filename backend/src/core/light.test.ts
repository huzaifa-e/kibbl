import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appInfo } from '../routes/firmware';
import { cleanCommand } from './control';
import { parseRgbState } from './devices';

test('a light change passes with the keys given, at least one', () => {
    assert.deepEqual(cleanCommand({ cmd: 'rgb', on: true }), { cmd: 'rgb', on: true });
    assert.deepEqual(cleanCommand({ cmd: 'rgb', color: [255, 80, 0], brightness: 40, fadeMs: 1000, extra: 1 }), {
        cmd: 'rgb',
        color: [255, 80, 0],
        brightness: 40,
        fadeMs: 1000,
    });
    assert.deepEqual(cleanCommand({ cmd: 'rgb', order: 'grb' }), { cmd: 'rgb', order: 'grb' });
    assert.equal(cleanCommand({ cmd: 'rgb' }), undefined);
});

test('a light change out of range is refused', () => {
    assert.equal(cleanCommand({ cmd: 'rgb', color: [256, 0, 0] }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', color: [255, 0] }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', color: '#ff0000' }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', brightness: 0 }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', brightness: 101 }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', fadeMs: 10001 }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', on: 'yes' }), undefined);
    assert.equal(cleanCommand({ cmd: 'rgb', order: 'rrb' }), undefined);
});

test('the light a device reports is taken only when it is whole', () => {
    assert.deepEqual(parseRgbState({ on: true, color: [1, 2, 3], brightness: 60, order: 'rgb' }), {
        on: true,
        color: [1, 2, 3],
        brightness: 60,
        order: 'rgb',
    });
    assert.equal(parseRgbState({ on: true, color: [1, 2], brightness: 60 }), undefined);
    assert.equal(parseRgbState({ on: true, color: [1, 2, 3], brightness: 0 }), undefined);
    assert.equal(parseRgbState({ color: [1, 2, 3], brightness: 50 }), undefined);
    assert.equal(parseRgbState({ on: true, color: [1, 2, 3], brightness: 50, order: 'xyz' })?.order, undefined);
});

test('an ESP8266 image is told by its marker', () => {
    const image = Buffer.alloc(4096);
    image[0] = 0xe9;
    image.write('KIBBL-APP:KIBBL-LIGHT:KIBBL-LIGHT-1.0.0-WIP\0', 2000, 'latin1');
    assert.deepEqual(appInfo(image), { project: 'KIBBL-LIGHT', version: 'KIBBL-LIGHT-1.0.0-WIP' });
    assert.equal(appInfo(Buffer.alloc(4096)), undefined);
    const other = Buffer.alloc(4096);
    other[0] = 0xe9;
    assert.equal(appInfo(other), undefined);
});
