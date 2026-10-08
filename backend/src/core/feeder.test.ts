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
    assert.deepEqual(parseFeederState({ opening: 30.06, busy: false }), { opening: 30.1, busy: false, job: undefined });
    assert.deepEqual(parseFeederState({ opening: 2.3, busy: true, job: 'feed' }), { opening: 2.3, busy: true, job: 'feed' });
    assert.equal(parseFeederState({ opening: '3', busy: false }), undefined);
    assert.equal(parseFeederState({ opening: 3 }), undefined);
    assert.equal(parseFeederState(null), undefined);
    assert.equal(parseFeederState({ opening: 3, busy: true, job: '<script>' })?.job, undefined);
});
