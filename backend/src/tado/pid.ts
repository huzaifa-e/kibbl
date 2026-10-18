/*
 * Adaptive PID control of a tado room, as an outer loop: tado's thermostat regulates its
 * valve to the temperature it is set to, but it leaves an offset (a radiator thermostat
 * measures next to the radiator, a cold wall or a draft is not seen), so the room stays
 * below or above what was asked. This loop compares the room's temperature with what the
 * person wants and sets tado's temperature above or below it until the room is there.
 *
 * Adaptive: the room is a first order system to the temperature tado is set to,
 *     dT/dt = a · (u − T) + b
 * (a = 1/τ, how fast it follows; b the losses and gains tado does not see), its parameters
 * estimated after every reading by recursive least squares with forgetting, so they follow
 * the season, the weather and the radiator. The gains come from τ by IMC tuning
 * (Kp = τ / (λ + θ), Ti = τ, Td = θ / 2): a slow room gets a stronger push, a fast one a
 * gentler. Derivative on the measurement (no kick when the wish changes), filtered; the
 * integral stops while the output is at its limits (anti-windup) and while the heating is
 * off for an open window.
 *
 * Each change is one of tado's requests of the day: the output goes in steps of STEP_C, with
 * hysteresis (a raw output between two steps would flip between them every reading), and is
 * sent only when it moved by a step (tado/service.ts).
 */

export const STEP_C = 0.5; // tado's steps
export const MIN_C = 5;
export const MAX_C = 25;
const BELOW_C = 3; // the most tado is set below the wish
const ABOVE_C = 5; // and above
const LAMBDA_MIN = 60; // how fast the closed loop should settle, minutes
const THETA_MIN = 15; // dead time: tado's own loop, the valve, the radiator warming up
const TAU_MIN = 20; // the range τ is believed in, minutes
const TAU_MAX = 240;
const TAU_START = 60;
const FORGET = 0.97; // RLS: about the last 30 readings count
const MIN_EXCITE_C = 0.3; // too little between set and measured teaches nothing
const D_FILTER = 0.7; // smoothing of the derivative, 0 none
const DT_MIN = 10; // the control period, minutes: readings closer than this wait (tado's 0.1 °C would be noise)
const DT_MAX = 60; // after a gap the step counts as this long
const HYSTERESIS = 0.75; // of a step: the output changes only when it is this far from the last one

export interface PidState {
    integral: number; // °C added to the wish by the integral
    theta: [number, number]; // [a, b] of the model
    p: [number, number, number]; // covariance [p11, p12, p22]
    lastT?: number; // the reading of the last step
    lastU?: number; // what tado was set to then
    lastAt?: number; // ms
    dFiltered: number; // °C per minute
    lastOut?: number; // the last output, kept until the raw one is clearly away from it
}

export interface PidStep {
    output: number; // what tado should be set to, °C in steps of STEP_C
    raw: number; // before rounding
    tau: number; // minutes, the room's time constant as now estimated
    kp: number;
    ki: number; // per minute
    kd: number; // minutes
}

export function newPidState(): PidState {
    return { integral: 0, theta: [1 / TAU_START, 0], p: [1e-3, 0, 1e-4], dFiltered: 0 };
}

export function tauOf(s: PidState) {
    const a = s.theta[0];
    return a > 0 ? Math.min(TAU_MAX, Math.max(TAU_MIN, 1 / a)) : TAU_MAX;
}

export function gains(tau: number) {
    const kp = tau / (LAMBDA_MIN + THETA_MIN);
    return { kp, ki: kp / tau, kd: kp * (THETA_MIN / 2) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const quantize = (v: number) => Math.round(v / STEP_C) * STEP_C;

// one step of recursive least squares on dT/dt = a·(u − T) + b
function learn(s: PidState, slope: number, x: number) {
    const [p11, p12, p22] = s.p;
    const px1 = p11 * x + p12; // P·φ with φ = [x, 1]
    const px2 = p12 * x + p22;
    const denom = FORGET + x * px1 + px2;
    const k1 = px1 / denom;
    const k2 = px2 / denom;
    const err = slope - (s.theta[0] * x + s.theta[1]);
    s.theta = [s.theta[0] + k1 * err, s.theta[1] + k2 * err];
    s.p = [(p11 - k1 * px1) / FORGET, (p12 - k1 * px2) / FORGET, (p22 - k2 * px2) / FORGET];
    // forgetting without new information lets P grow: start again from the prior then
    if (!(s.p[0] + s.p[2] < 1) || !Number.isFinite(s.theta[0])) {
        const fresh = newPidState();
        s.p = fresh.p;
        if (!Number.isFinite(s.theta[0])) s.theta = fresh.theta;
    }
}

/* A step after a reading: temperature measured, wish, what tado is set to now (applied),
 * heating whether it may heat (false while off for a window: nothing learned, the integral
 * held). Changes the state; the output is what tado should be set to. */
export function pidStep(s: PidState, temperature: number, wish: number, applied: number | undefined, now: number, heating = true): PidStep {
    const dt = s.lastAt === undefined ? undefined : clamp((now - s.lastAt) / 60_000, 0, DT_MAX);
    const fresh = dt !== undefined && dt >= DT_MIN && s.lastT !== undefined;

    if (fresh && heating) {
        const slope = (temperature - s.lastT!) / dt!;
        if (s.lastU !== undefined && Math.abs(s.lastU - s.lastT!) >= MIN_EXCITE_C) learn(s, slope, s.lastU - s.lastT!);
        s.dFiltered = D_FILTER * s.dFiltered + (1 - D_FILTER) * slope;
    }

    const tau = tauOf(s);
    const { kp, ki, kd } = gains(tau);
    const error = wish - temperature;
    const lo = Math.max(MIN_C, wish - BELOW_C);
    const hi = Math.min(MAX_C, wish + ABOVE_C);
    const unclamped = (integral: number) => wish + kp * error + integral - kd * s.dFiltered;

    if (fresh && heating) {
        const next = s.integral + ki * error * dt!;
        // anti-windup: the integral grows only where the output is not at its limit
        const out = unclamped(next);
        if ((out <= hi || error < 0) && (out >= lo || error > 0)) s.integral = next;
        s.integral = clamp(s.integral, -BELOW_C, ABOVE_C);
    }

    const raw = clamp(unclamped(s.integral), lo, hi);
    const keep = s.lastOut !== undefined && s.lastOut >= lo && s.lastOut <= hi && Math.abs(raw - s.lastOut) < HYSTERESIS * STEP_C;
    const output = keep ? s.lastOut! : clamp(quantize(raw), lo, hi);
    if (heating) s.lastOut = output;
    if (fresh || s.lastAt === undefined) {
        s.lastT = temperature;
        s.lastAt = now;
        s.lastU = heating ? applied : undefined;
    }
    return { output, raw, tau, kp, ki, kd };
}
