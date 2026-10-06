import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Limiter, forEachLimited } from './limiter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('never more than the limit run at once, and all of them run', async () => {
    const limiter = new Limiter(3);
    let running = 0;
    let most = 0;
    const done = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
            limiter.run(async () => {
                most = Math.max(most, ++running);
                await sleep(5);
                running--;
                return i;
            }),
        ),
    );
    assert.equal(most, 3);
    assert.deepEqual(done, [...Array(12).keys()]);
    assert.equal(limiter.running, 0);
    assert.equal(limiter.pending, 0);
});

test('urgent work goes ahead of the background queue', async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];
    const first = limiter.run(() => sleep(10).then(() => order.push('first')));
    const later = [1, 2].map((i) => limiter.run(async () => void order.push(`background ${i}`)));
    const urgent = limiter.run(async () => void order.push('urgent'), true);
    await Promise.all([first, ...later, urgent]);
    assert.deepEqual(order, ['first', 'urgent', 'background 1', 'background 2']);
});

test('a pause holds every request, also the ones already waiting', async () => {
    const limiter = new Limiter(2);
    limiter.pause(60);
    const started = Date.now();
    await Promise.all([1, 2, 3].map(() => limiter.run(async () => undefined)));
    assert.ok(Date.now() - started >= 55);
});

test('a failing slot is given back', async () => {
    const limiter = new Limiter(1);
    await assert.rejects(limiter.run(() => Promise.reject(new Error('boom'))));
    assert.equal(await limiter.run(async () => 'next'), 'next');
    assert.equal(limiter.running, 0);
});

test('forEachLimited stops taking items after an error, and waits for the ones under way', async () => {
    const seen: number[] = [];
    let finished = 0;
    await assert.rejects(
        forEachLimited([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
            seen.push(n);
            if (n === 2) throw new Error('two');
            await sleep(10);
            finished++;
        }),
        /two/,
    );
    assert.ok(seen.length < 8, `took ${seen.length} items`);
    assert.equal(finished, seen.length - 1); // all but the failing one ran to the end
    await forEachLimited([], 3, async () => assert.fail('no items'));
});
