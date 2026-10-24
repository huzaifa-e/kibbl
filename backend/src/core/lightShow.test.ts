import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIGHT_EFFECTS, lightAlertDefaults, type LightTimer } from '../../../shared/light';
import { STEP_MAX_MS, cleanAlerts, cleanTimer, dueNow, effectFrames, hsv, nextStart, steps } from './lightShow';

const warm = { on: true, color: [255, 165, 0] as [number, number, number], brightness: 60 };

test('no step of an effect lasts long enough for the light to be stored', () => {
    for (const effect of LIGHT_EFFECTS) {
        let at = { color: warm.color, brightness: warm.brightness };
        let n = 0;
        for (const frame of effectFrames(effect, { minutes: 30, speed: 'slow' }, warm)) {
            for (const s of steps(at, frame)) {
                assert.ok(s.ms <= STEP_MAX_MS, `${effect}: a step of ${s.ms} ms`);
                assert.ok(s.brightness >= 1 && s.brightness <= 100, `${effect}: brightness ${s.brightness}`);
                assert.ok(
                    s.color.every((c) => Number.isInteger(c) && c >= 0 && c <= 255),
                    `${effect}: colour ${s.color}`,
                );
                at = s;
            }
            if (++n > 200) break;
        }
        assert.ok(n > 0, `${effect} shows something`);
    }
});

test('a slow fade is cut into even steps that end where it goes', () => {
    const out = steps({ color: [0, 0, 0], brightness: 1 }, { on: true, color: [255, 100, 0], brightness: 100, ms: 10_000 });
    assert.equal(out.length, 4);
    assert.ok(out.every((s) => s.ms === 2500));
    assert.deepEqual(out.at(-1), { on: true, color: [255, 100, 0], brightness: 100, ms: 2500 });
    assert.deepEqual(out[0].color, [64, 25, 0]);
});

test('a sunrise ends bright and stays, a sunset ends off in the light it had', () => {
    const rise = [...effectFrames('sunrise', { minutes: 20 }, { ...warm, on: false })];
    assert.equal(
        rise.reduce((s, f) => s + f.ms, 0),
        20 * 60_000,
    );
    assert.equal(rise.at(-1)!.brightness, 100);
    const set = [...effectFrames('sunset', { minutes: 10 }, warm)];
    assert.deepEqual(set.at(-1), { on: false, color: warm.color, brightness: 60, ms: 2000 });
    assert.equal([...effectFrames('sunset', {}, { ...warm, on: false })].length, 0);
});

test('hues', () => {
    assert.deepEqual(hsv(0), [255, 0, 0]);
    assert.deepEqual(hsv(120), [0, 255, 0]);
    assert.deepEqual(hsv(240), [0, 0, 255]);
});

const timer = (t: Partial<LightTimer>): LightTimer => ({
    id: 't',
    enabled: true,
    days: [0, 1, 2, 3, 4],
    at: '07:00',
    action: { kind: 'mood', mood: 'focus' },
    ...t,
});

test('a timer runs on its days at its time, a sunrise its minutes before', () => {
    const monday = new Date(2026, 9, 26, 6, 0); // Monday 26 October 2026
    assert.equal(nextStart(timer({}), monday), new Date(2026, 9, 26, 7, 0).getTime());
    const sunrise = timer({ action: { kind: 'effect', effect: 'sunrise', minutes: 20 } });
    assert.equal(nextStart(sunrise, monday), new Date(2026, 9, 26, 6, 40).getTime());
    assert.ok(dueNow(sunrise, new Date(2026, 9, 26, 6, 40, 30)));
    assert.ok(!dueNow(sunrise, new Date(2026, 9, 26, 6, 41)));
    // Saturday: next on Monday
    assert.equal(nextStart(timer({}), new Date(2026, 9, 31, 8, 0)), new Date(2026, 10, 2, 7, 0).getTime());
    // a sunrise at 00:10 on Tuesday starts on Monday evening
    const early = timer({ days: [1], at: '00:10', action: { kind: 'effect', effect: 'sunrise', minutes: 20 } });
    assert.ok(dueNow(early, new Date(2026, 9, 26, 23, 50)));
    assert.equal(nextStart(timer({ enabled: false }), monday), undefined);
});

test('a timer is checked', () => {
    assert.equal(typeof cleanTimer({ at: '7:00', days: [0], action: { kind: 'off' } }, 'a'), 'string');
    assert.equal(typeof cleanTimer({ at: '07:00', days: [], action: { kind: 'off' } }, 'a'), 'string');
    assert.equal(typeof cleanTimer({ at: '07:00', days: [7], action: { kind: 'off' } }, 'a'), 'string');
    assert.equal(typeof cleanTimer({ at: '07:00', days: [0], action: { kind: 'mood', mood: 'disco' } }, 'a'), 'string');
    assert.equal(typeof cleanTimer({ at: '07:00', days: [0], action: { kind: 'effect', effect: 'sunrise', minutes: 500 } }, 'a'), 'string');
    assert.deepEqual(cleanTimer({ at: '22:30', days: [6, 5, 5], action: { kind: 'effect', effect: 'sunset', minutes: 30, extra: 1 }, name: ' Bed ' }, 'a'), {
        id: 'a',
        enabled: true,
        days: [5, 6],
        at: '22:30',
        action: { kind: 'effect', effect: 'sunset', minutes: 30 },
        name: 'Bed',
    });
});

test('alerts change only in the fields given', () => {
    assert.deepEqual(cleanAlerts({ kinds: ['fire', 'cat', 'cat'] }, lightAlertDefaults), { ...lightAlertDefaults, kinds: ['fire', 'cat'] });
    assert.equal(typeof cleanAlerts({ kinds: ['doorbell'] }, lightAlertDefaults), 'string');
    assert.equal(typeof cleanAlerts({ quietFrom: 24 }, lightAlertDefaults), 'string');
});
