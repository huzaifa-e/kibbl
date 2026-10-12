import assert from 'node:assert/strict';
import test from 'node:test';
import { isMirrored, rotationCommand, rotationOf, type CameraSettings, type Rotation } from '../../../shared/protocol';

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
