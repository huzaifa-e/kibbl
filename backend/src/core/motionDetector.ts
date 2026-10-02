import type { MotionSensitivity } from '../../../shared/protocol';

export const ANALYSIS_WIDTH = 64;
export const ANALYSIS_HEIGHT = 48;

// a pixel counts as changed when it differs from the background by more than this (0-255)
const PIXEL_THRESHOLD = 22;
// a mean brightness jump this large is a light switched on or off, not a visitor
const LIGHTING_THRESHOLD = 28;
// more than this share of the picture changed at once: auto exposure or the camera moved
const GLOBAL_CHANGE = 0.55;
// how fast the background takes in what stays: quickly when calm, slowly during motion
const LEARN_CALM = 0.08;
const LEARN_MOTION = 0.01;
// frames in a row over the threshold before it counts: one noisy frame is no visitor
const CONFIRM_FRAMES = 2;

export const sensitivityThresholds: Record<MotionSensitivity, number> = {
    low: 0.06,
    medium: 0.03,
    high: 0.015,
};

export interface MotionResult {
    score: number; // share of the picture that differs from the background, 0-1
    motion: boolean;
    reset: boolean; // the background was replaced (first frame, lighting or global change)
}

/* Background subtraction on a small grey picture (64x48): cheap enough to run on every
 * analysed frame of every camera, and blind to jpeg noise and small flicker. */
export class MotionDetector {
    private background: Float32Array | null = null;
    private overThreshold = 0;

    analyze(gray: Uint8Array, sensitivity: MotionSensitivity): MotionResult {
        const n = gray.length;
        if (!this.background || this.background.length !== n) {
            this.background = Float32Array.from(gray);
            this.overThreshold = 0;
            return { score: 0, motion: false, reset: true };
        }

        let changed = 0;
        let meanNow = 0;
        let meanBackground = 0;
        for (let i = 0; i < n; i++) {
            const diff = Math.abs(gray[i] - this.background[i]);
            if (diff > PIXEL_THRESHOLD) {
                changed++;
            }
            meanNow += gray[i];
            meanBackground += this.background[i];
        }
        const score = changed / n;
        const brightnessJump = Math.abs(meanNow - meanBackground) / n;

        if (score > GLOBAL_CHANGE || brightnessJump > LIGHTING_THRESHOLD) {
            this.background = Float32Array.from(gray);
            this.overThreshold = 0;
            return { score, motion: false, reset: true };
        }

        const over = score >= sensitivityThresholds[sensitivity];
        this.overThreshold = over ? this.overThreshold + 1 : 0;
        const motion = this.overThreshold >= CONFIRM_FRAMES;

        const rate = over ? LEARN_MOTION : LEARN_CALM;
        for (let i = 0; i < n; i++) {
            this.background[i] += (gray[i] - this.background[i]) * rate;
        }

        return { score, motion, reset: false };
    }
}

// true when hour (0-23) falls in the quiet window from-to, which may wrap past midnight
export function inQuietHours(hour: number, from: number, to: number) {
    if (from === to) {
        return false;
    }
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
