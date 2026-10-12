import assert from 'node:assert/strict';
import test from 'node:test';
import { isMirrored, rotationCommand, rotationOf, viewRect, type CameraSettings, type Rotation } from '../../../shared/protocol';

const camera = (vflip: boolean, hmirror: boolean) =>
    ({ framesize: 'VGA', quality: 12, vflip, hmirror, brightness: 0, contrast: 0, saturation: 0 }) as CameraSettings;

test('every turn and mirror comes back as it was set', () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
        for (const mirror of [false, true]) {
            const cmd = rotationCommand(rotation, mirror);
            const cam = camera(cmd.vflip, cmd.hmirror);
            assert.equal(rotationOf(cam, cmd.turn90), rotation);
            assert.equal(isMirrored(cam), mirror);
        }
    }
});

test("a quarter turn is the server's, half of it the camera's flips", () => {
    assert.deepEqual(rotationCommand(90, false), { vflip: false, hmirror: false, turn90: true });
    assert.deepEqual(rotationCommand(180, false), { vflip: true, hmirror: true, turn90: false });
    assert.deepEqual(rotationCommand(180, true), { vflip: true, hmirror: false, turn90: false });
});

test('a zoom cuts the middle out and stays inside the picture', () => {
    assert.deepEqual(viewRect(600, 800, { zoom: 1, x: 0.5, y: 0.5 }), { left: 0, top: 0, width: 600, height: 800 });
    assert.deepEqual(viewRect(600, 800, { zoom: 2, x: 0.5, y: 0.5 }), { left: 150, top: 200, width: 300, height: 400 });
    // pushed to an edge, it stops there
    assert.deepEqual(viewRect(600, 800, { zoom: 2, x: 1, y: 0 }), { left: 300, top: 0, width: 300, height: 400 });
});
