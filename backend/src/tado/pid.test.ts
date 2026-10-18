import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_C, STEP_C, gains, newPidState, pidStep, tauOf } from './pid';

const MIN = 60_000;

/* A room that follows what tado is set to with a time constant, but stays offset below it
 * (tado measures at the radiator): what the control is for. One step per poll. */
function simulate(opts: { tau: number; offset: number; start: number; wish: number; hours: number; pollMin?: number; windowAt?: [number, number] }) {
    const s = newPidState();
    const poll = opts.pollMin ?? 5;
    let t = opts.start;
    let setTo: number | undefined;
    let sends = 0;
    const out: { min: number; t: number; setTo?: number }[] = [];
    for (let min = 0; min <= opts.hours * 60; min += poll) {
        const open = opts.windowAt !== undefined && min >= opts.windowAt[0] && min < opts.windowAt[1];
        const step = pidStep(s, Math.round(t * 10) / 10, opts.wish, open ? undefined : setTo, min * MIN, !open);
        const next = open ? undefined : step.output;
        if (next !== setTo) sends++;
        setTo = next;
        // the room over the poll: towards tado's setting minus the offset, cooling towards 10 °C when off
        const goal = setTo === undefined ? 10 : setTo - opts.offset;
        const rate = open ? 1 / 30 : 1 / opts.tau;
        for (let k = 0; k < poll; k++) t += (goal - t) * rate;
        out.push({ min, t, setTo });
    }
    return { s, t, out, sends };
}

test('a room that tado leaves 1.6 °C too cold reaches the wish', () => {
    const { t, out } = simulate({ tau: 90, offset: 1.6, start: 18.4, wish: 20, hours: 10 });
    assert.ok(Math.abs(t - 20) <= 0.3, `ends at ${t.toFixed(2)}`);
    // tado is set above the wish to make up for its offset
    assert.ok(out.at(-1)!.setTo! >= 21);
});

test('the output goes in tado steps and stays in its range', () => {
    const { out } = simulate({ tau: 60, offset: 4, start: 12, wish: 22, hours: 6 });
    for (const o of out) {
        assert.ok(o.setTo! <= MAX_C && o.setTo! >= 5);
        assert.equal(o.setTo! % STEP_C, 0);
    }
});

test('it does not overshoot much and settles without changing all the time', () => {
    const { out, sends } = simulate({ tau: 90, offset: 1.6, start: 17, wish: 20, hours: 12 });
    const peak = Math.max(...out.map((o) => o.t));
    assert.ok(peak < 20.8, `peak ${peak.toFixed(2)}`);
    // each change is a request: no flipping between two steps
    assert.ok(sends < 15, `${sends} changes`);
});

test('the time constant of the room is learned', () => {
    const slow = simulate({ tau: 150, offset: 1, start: 16, wish: 21, hours: 8 });
    const fast = simulate({ tau: 30, offset: 1, start: 16, wish: 21, hours: 8 });
    assert.ok(tauOf(slow.s) > tauOf(fast.s), `slow ${tauOf(slow.s).toFixed(0)}, fast ${tauOf(fast.s).toFixed(0)}`);
    // a slow room is pushed harder
    assert.ok(gains(tauOf(slow.s)).kp > gains(tauOf(fast.s)).kp);
});

test('an open window holds the integral and the control comes back after', () => {
    const before = simulate({ tau: 90, offset: 1.6, start: 18.4, wish: 20, hours: 4 });
    const integral = before.s.integral;
    const s = before.s;
    let at = 4 * 60;
    for (let k = 0; k < 6; k++) pidStep(s, 16, 20, undefined, (at += 5) * MIN, false);
    assert.equal(s.integral, integral);
    const back = simulate({ tau: 90, offset: 1.6, start: 18.4, wish: 20, hours: 10, windowAt: [240, 270] });
    assert.ok(Math.abs(back.t - 20) <= 0.3, `ends at ${back.t.toFixed(2)}`);
});

test('the integral does not wind up when tado cannot heat enough', () => {
    // a radiator that brings the room only to 15 °C: the output sits at its top
    const { s } = simulate({ tau: 60, offset: 12, start: 13, wish: 20, hours: 24 });
    assert.ok(s.integral <= 5);
    // the wish drops: the output follows at once instead of unwinding hours of integral
    const down = pidStep(s, 13, 10, 25, 25 * 60 * MIN);
    assert.ok(down.output <= 15, `${down.output}`);
});
