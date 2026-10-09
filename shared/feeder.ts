import type { FeedLevel } from './protocol';

/*
 * A feed as the iris runs it, for the app to show: the opening over time of a feeding level,
 * worked out the way firmware/feeder-motor does it. A portion opens to the level's opening,
 * stays open for its openMs, closes with the nudge (closed, 150 ms, back a little, closed
 * again) and rests 300 ms; a feed repeats that for every portion. The moves take the
 * feeder's own speed, acceleration and taught limit, so the animation of a level keeps
 * matching what the feeder does, whatever the levels are.
 */

// from the firmware: the opening (0.1 mm) at 15 even steps of the design's stroke, open to closed
const OPENING_TABLE = [420, 410, 387, 363, 338, 312, 284, 255, 224, 192, 158, 123, 87, 51, 20];
const STROKE = Math.floor((4096 * 1575) / 3600); // 1792 motor steps
const at = (steps: number) => Math.floor((steps * STROKE) / 1400);
const DESIGN_CLOSED = STROKE - at(8);
const NUDGE = at(60);
const NUDGE_WAIT_MS = 150;
const REST_MS = 300;

// the firmware's own settings when the feeder has not reported its
export const FEEDER_DEFAULTS = { speed: 2400, accel: 8000, closedPos: DESIGN_CLOSED };

export interface FeederTuning {
    speed?: number; // steps/s
    accel?: number; // steps/s²
    closedPos?: number; // steps from open (0) to closed
}

// the share of the stroke from open (0) to closed (1) for an opening, as stepsFor in the firmware
function strokeFor(mm: number) {
    const opening = Math.round(mm * 10);
    if (opening >= OPENING_TABLE[0]) return 0;
    for (let k = 0; k < 14; k++) {
        if (opening >= OPENING_TABLE[k + 1]) {
            const design = (k + (OPENING_TABLE[k] - opening) / (OPENING_TABLE[k] - OPENING_TABLE[k + 1])) * (STROKE / 14);
            return Math.min(design / DESIGN_CLOSED, 1);
        }
    }
    return 1;
}

// the opening (mm) at a share of the stroke, as openingAt in the firmware
function openingAt(stroke: number) {
    const steps = stroke * DESIGN_CLOSED;
    if (steps <= 0) return OPENING_TABLE[0] / 10;
    if (steps >= STROKE) return OPENING_TABLE[14] / 10;
    const scaled = (steps * 14) / STROKE;
    const k = Math.floor(scaled);
    return (OPENING_TABLE[k] + (OPENING_TABLE[k + 1] - OPENING_TABLE[k]) * (scaled - k)) / 10;
}

// a trapezoid move from rest to rest: how long it takes, and how far along it is at t
function moveTime(steps: number, speed: number, accel: number) {
    return steps >= (speed * speed) / accel ? steps / speed + speed / accel : 2 * Math.sqrt(steps / accel);
}

function moveShare(t: number, steps: number, speed: number, accel: number) {
    const total = moveTime(steps, speed, accel);
    if (t <= 0) return 0;
    if (t >= total) return 1;
    const top = Math.min(speed, Math.sqrt(steps * accel)); // the speed it reaches
    const ramp = top / accel;
    let done: number;
    if (t < ramp) done = (accel * t * t) / 2;
    else if (t < total - ramp) done = (top * ramp) / 2 + top * (t - ramp);
    else done = steps - (accel * (total - t) ** 2) / 2;
    return done / steps;
}

interface Segment {
    from: number; // share of the stroke
    to: number;
    ms: number;
    steps: number; // 0: a wait
    speed: number;
    accel: number;
}

export interface FeedTimeline {
    ms: number; // the whole feed
    openMs: number; // how long the iris is open past the closed hole, all portions
    holdMs: number; // how long it stays fully at the level's opening, all portions
    segments: Segment[];
}

// the feed of a level, from closed to closed again
export function feedTimeline(level: Pick<FeedLevel, 'portions' | 'opening' | 'openMs'>, tuning: FeederTuning = {}): FeedTimeline {
    const speed = tuning.speed || FEEDER_DEFAULTS.speed;
    const accel = tuning.accel || FEEDER_DEFAULTS.accel;
    const closed = Math.abs(tuning.closedPos || FEEDER_DEFAULTS.closedPos);
    const nudge = Math.min(NUDGE / closed, 1);
    const open = strokeFor(level.opening);
    const segments: Segment[] = [];
    const go = (from: number, to: number) => {
        const steps = Math.round(Math.abs(to - from) * closed);
        if (steps) segments.push({ from, to, steps, speed, accel, ms: moveTime(steps, speed, accel) * 1000 });
    };
    const wait = (stroke: number, ms: number) => segments.push({ from: stroke, to: stroke, steps: 0, speed, accel, ms });
    for (let p = 0; p < level.portions; p++) {
        go(1, open);
        wait(open, level.openMs);
        go(open, 1);
        wait(1, NUDGE_WAIT_MS);
        go(1, 1 - nudge);
        go(1 - nudge, 1);
        wait(1, REST_MS);
    }
    const ms = segments.reduce((sum, s) => sum + s.ms, 0);
    // the opening and closing moves count as open, the nudge does not (kibble does not fall through it)
    const holdMs = level.portions * level.openMs;
    const moveMs = segments.filter((s) => s.steps && (s.from === open || s.to === open)).reduce((sum, s) => sum + s.ms, 0);
    return { ms, openMs: holdMs + moveMs, holdMs, segments };
}

// the opening (mm) of a feed at t ms from its start
export function feedOpeningAt(timeline: FeedTimeline, t: number) {
    let left = t;
    for (const s of timeline.segments) {
        if (left < s.ms) return openingAt(s.from + (s.to - s.from) * (s.steps ? moveShare(left / 1000, s.steps, s.speed, s.accel) : 0));
        left -= s.ms;
    }
    return openingAt(1);
}
