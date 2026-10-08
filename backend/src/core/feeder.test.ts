import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedLevels } from '../../../shared/protocol';
import { cleanCommand } from './control';
import { parseFeederState } from './devices';

test('a feed passes with a feeding level, and without one', () => {
    assert.deepEqual(cleanCommand({ cmd: 'feed', portions: 2 }), { cmd: 'feed', portions: 2 });
    assert.deepEqual(cleanCommand({ cmd: 'feed', portions: 1, opening: 15, openMs: 600, extra: 1 }), { cmd: 'feed', portions: 1, opening: 15, openMs: 600 });
    for (const l of feedLevels) {
        assert.ok(cleanCommand({ cmd: 'feed', portions: l.portions, opening: l.opening, openMs: l.openMs }), l.id);
    }
});

test('a feed out of range is refused', () => {
    assert.equal(cleanCommand({ cmd: 'feed', portions: 11 }), undefined);
    assert.equal(cleanCommand({ cmd: 'feed', portions: 1, opening: 3 }), undefined);
    assert.equal(cleanCommand({ cmd: 'feed', portions: 1, opening: 43 }), undefined);
    assert.equal(cleanCommand({ cmd: 'feed', portions: 1, openMs: 50 }), undefined);
});

test('the iris goes from closed to fully open, nothing beyond', () => {
    assert.deepEqual(cleanCommand({ cmd: 'iris', opening: 2 }), { cmd: 'iris', opening: 2 });
    assert.deepEqual(cleanCommand({ cmd: 'iris', opening: 21.04 }), { cmd: 'iris', opening: 21 });
    assert.equal(cleanCommand({ cmd: 'iris', opening: 1 }), undefined);
    assert.equal(cleanCommand({ cmd: 'iris', opening: 50 }), undefined);
    assert.equal(cleanCommand({ cmd: 'iris', opening: '20' }), undefined);
});

test('the feeder state is kept only as the device should send it', () => {
    assert.deepEqual(parseFeederState({ opening: 30.06, busy: false }), {
        opening: 30.1,
        busy: false,
        job: undefined,
        position: undefined,
        speed: undefined,
        accel: undefined,
        closedPos: undefined,
    });
    const state = parseFeederState({ opening: 2.3, busy: true, job: 'feed', position: 1782, speed: 800, accel: 3000 });
    assert.equal(state?.job, 'feed');
    assert.equal(state?.position, 1782);
    assert.equal(state?.speed, 800);
    assert.equal(parseFeederState({ opening: 2.3, busy: false, position: 1.5 })?.position, undefined);
    assert.equal(parseFeederState({ opening: '3', busy: false }), undefined);
    assert.equal(parseFeederState({ opening: 3 }), undefined);
    assert.equal(parseFeederState(null), undefined);
    assert.equal(parseFeederState({ opening: 3, busy: true, job: '<script>' })?.job, undefined);
});

test('tuning a feeder: speed, acceleration, steps, the zero', () => {
    assert.deepEqual(cleanCommand({ cmd: 'feeder_config', speed: 800 }), { cmd: 'feeder_config', speed: 800 });
    assert.deepEqual(cleanCommand({ cmd: 'feeder_config', speed: 1200, accel: 4000 }), { cmd: 'feeder_config', speed: 1200, accel: 4000 });
    assert.equal(cleanCommand({ cmd: 'feeder_config' }), undefined);
    assert.equal(cleanCommand({ cmd: 'feeder_config', speed: 50 }), undefined);
    assert.equal(cleanCommand({ cmd: 'feeder_config', accel: 30000 }), undefined);
    assert.deepEqual(cleanCommand({ cmd: 'feeder_move', steps: -200 }), { cmd: 'feeder_move', steps: -200 });
    assert.equal(cleanCommand({ cmd: 'feeder_move', steps: 0 }), undefined);
    assert.equal(cleanCommand({ cmd: 'feeder_move', steps: 2000000 }), undefined);
    assert.equal(cleanCommand({ cmd: 'feeder_move', steps: 1.5 }), undefined);
    assert.deepEqual(cleanCommand({ cmd: 'feeder_home', extra: true }), { cmd: 'feeder_home' });
    assert.deepEqual(cleanCommand({ cmd: 'feeder_release' }), { cmd: 'feeder_release', ms: 10000 });
    assert.equal(cleanCommand({ cmd: 'feeder_release', ms: 60000 }), undefined);
    assert.deepEqual(cleanCommand({ cmd: 'feeder_run', direction: 'close' }), { cmd: 'feeder_run', direction: 'close' });
    assert.equal(cleanCommand({ cmd: 'feeder_run', direction: 'sideways' }), undefined);
    assert.deepEqual(cleanCommand({ cmd: 'feeder_stop' }), { cmd: 'feeder_stop' });
    assert.equal(parseFeederState({ opening: 2.3, busy: false, closedPos: 2100 })?.closedPos, 2100);
});
