import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANALYSIS_HEIGHT, ANALYSIS_WIDTH, MotionDetector, inQuietHours } from './motionDetector';

const N = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;

function scene(level: number, noise = 4) {
    const gray = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
        gray[i] = Math.max(0, Math.min(255, level + Math.round((Math.random() - 0.5) * 2 * noise)));
    }
    return gray;
}

// a dark square of size x size pixels on the scene, like a cat walking by
function withObject(gray: Uint8Array, x0: number, size: number) {
    const out = Uint8Array.from(gray);
    for (let y = 10; y < 10 + size; y++) {
        for (let x = x0; x < x0 + size; x++) {
            out[y * ANALYSIS_WIDTH + x] = 20;
        }
    }
    return out;
}

test('a still scene is no motion', () => {
    const d = new MotionDetector();
    for (let i = 0; i < 20; i++) {
        assert.equal(d.analyze(scene(120), 'high').motion, false);
    }
});

test('an object entering is motion after two frames', () => {
    const d = new MotionDetector();
    for (let i = 0; i < 5; i++) d.analyze(scene(120), 'medium');
    const first = d.analyze(withObject(scene(120), 10, 14), 'medium');
    assert.equal(first.motion, false, 'one frame is not enough');
    assert.ok(first.score > 0.03);
    const second = d.analyze(withObject(scene(120), 12, 14), 'medium');
    assert.equal(second.motion, true);
});

test('a light switched on resets the background instead of reporting motion', () => {
    const d = new MotionDetector();
    for (let i = 0; i < 5; i++) d.analyze(scene(60), 'high');
    const r = d.analyze(scene(160), 'high');
    assert.equal(r.motion, false);
    assert.equal(r.reset, true);
    assert.equal(d.analyze(scene(160), 'high').motion, false);
});

test('a small object is seen on high sensitivity only', () => {
    const run = (sensitivity: 'low' | 'high') => {
        const d = new MotionDetector();
        for (let i = 0; i < 5; i++) d.analyze(scene(120), sensitivity);
        d.analyze(withObject(scene(120), 20, 8), sensitivity);
        return d.analyze(withObject(scene(120), 21, 8), sensitivity).motion;
    };
    assert.equal(run('low'), false);
    assert.equal(run('high'), true);
});

test('quiet hours wrap past midnight', () => {
    assert.equal(inQuietHours(23, 22, 6), true);
    assert.equal(inQuietHours(3, 22, 6), true);
    assert.equal(inQuietHours(12, 22, 6), false);
    assert.equal(inQuietHours(10, 9, 17), true);
    assert.equal(inQuietHours(17, 9, 17), false);
    assert.equal(inQuietHours(5, 0, 0), false);
});
