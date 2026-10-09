import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedOpeningAt, feedTimeline } from '../../../shared/feeder';
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
    assert.deepEqual(cleanCommand({ cmd: 'feeder_zero' }), { cmd: 'feeder_zero' });
    assert.deepEqual(cleanCommand({ cmd: 'feeder_config', closedPos: 1782 }), { cmd: 'feeder_config', closedPos: 1782 });
    assert.equal(cleanCommand({ cmd: 'feeder_config', closedPos: 0 }), undefined);
    assert.equal(parseFeederState({ opening: 2.3, busy: false, closedPos: 2100 })?.closedPos, 2100);
});

test('a feed played as the firmware runs it', () => {
    const one = feedTimeline({ portions: 1, opening: 42, openMs: 1000 });
    // fully open at 2400 steps/s: the 1.1 s of the firmware's readme
    assert.ok(Math.abs(one.segments[0].ms - 1043) < 5, String(one.segments[0].ms));
    assert.equal(feedOpeningAt(one, 0), feedOpeningAt(one, one.ms));
    assert.equal(feedOpeningAt(one, one.segments[0].ms + 500), 42);
    // every level opens as far as it says, and each portion plays again
    for (const l of feedLevels) {
        const t = feedTimeline(l);
        assert.ok(Math.abs(feedOpeningAt(t, t.segments[0].ms + l.openMs / 2) - l.opening) < 0.1, l.id);
        assert.ok(t.openMs > t.holdMs && t.holdMs === l.portions * l.openMs, l.id);
        assert.ok(Math.abs(t.ms - l.portions * feedTimeline({ ...l, portions: 1 }).ms) < 1, l.id);
    }
    // a slower feeder takes longer
    assert.ok(feedTimeline(feedLevels[0], { speed: 800 }).ms > feedTimeline(feedLevels[0]).ms);
});
