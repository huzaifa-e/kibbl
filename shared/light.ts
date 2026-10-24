/*
 * What a kibbl. light does besides one colour: moods (a colour and brightness with a name, or
 * an effect), effects the server plays on it (core/lightShow.ts), the weekly timers and the
 * alerts that flash it. The app and an assistant offer the same.
 */

export type Rgb = [number, number, number];

export const LIGHT_EFFECTS = ['candle', 'breathe', 'rainbow', 'ocean', 'aurora', 'party', 'sunrise', 'sunset'] as const;
export type LightEffect = (typeof LIGHT_EFFECTS)[number];

export const LIGHT_SPEEDS = ['slow', 'normal', 'fast'] as const;
export type LightSpeed = (typeof LIGHT_SPEEDS)[number];

export const EFFECT_INFO: Record<LightEffect, { label: string; icon: string; text: string }> = {
    candle: { label: 'Candle', icon: 'flame', text: 'a warm flicker' },
    breathe: { label: 'Breathe', icon: 'wind', text: 'the colour slowly brighter and darker' },
    rainbow: { label: 'Rainbow', icon: 'rainbow', text: 'through every hue' },
    ocean: { label: 'Ocean', icon: 'ripple', text: 'drifting blues and teals' },
    aurora: { label: 'Aurora', icon: 'sparkles', text: 'greens, teals and violet, slowly' },
    party: { label: 'Party', icon: 'confetti', text: 'bright colours, quick' },
    sunrise: { label: 'Sunrise', icon: 'sunrise', text: 'from dark red to bright warm white over minutes, then stays' },
    sunset: { label: 'Sunset', icon: 'sunset', text: 'from the light now through deep orange to off over minutes (a sleep timer)' },
};

// the minutes a sunrise or sunset takes unless given, and the range
export const RAMP_MINUTES = { min: 1, max: 120, default: 20 };

export interface LightMood {
    label: string;
    icon: string;
    color: Rgb;
    brightness: number;
    effect?: LightEffect; // played from the colour and brightness
}

export const LIGHT_MOODS: Record<string, LightMood> = {
    movie: { label: 'Movie', icon: 'movie', color: [255, 236, 215], brightness: 10 }, // neutral bias light behind the screen
    relax: { label: 'Relax', icon: 'armchair', color: [255, 120, 20], brightness: 40 },
    focus: { label: 'Focus', icon: 'bulb', color: [215, 230, 255], brightness: 100 },
    reading: { label: 'Reading', icon: 'book', color: [255, 190, 120], brightness: 80 },
    romantic: { label: 'Romantic', icon: 'heart', color: [255, 30, 80], brightness: 25 },
    gaming: { label: 'Gaming', icon: 'device-gamepad-2', color: [140, 0, 255], brightness: 70 },
    forest: { label: 'Forest', icon: 'trees', color: [40, 200, 60], brightness: 40 },
    night: { label: 'Night light', icon: 'moon', color: [255, 25, 0], brightness: 4 }, // no blue late in the evening
    candle: { label: 'Candle', icon: 'flame', color: [255, 110, 15], brightness: 60, effect: 'candle' },
    ocean: { label: 'Ocean', icon: 'ripple', color: [0, 120, 255], brightness: 50, effect: 'ocean' },
    aurora: { label: 'Aurora', icon: 'sparkles', color: [0, 255, 120], brightness: 50, effect: 'aurora' },
    party: { label: 'Party', icon: 'confetti', color: [255, 0, 120], brightness: 100, effect: 'party' },
};

/* ----------------------------------------------------------------------- */

// what a timer does when it is due
export type LightAction =
    | { kind: 'off' }
    | { kind: 'mood'; mood: string }
    | { kind: 'color'; color: Rgb; brightness: number }
    | { kind: 'effect'; effect: LightEffect; color?: Rgb; brightness?: number; speed?: LightSpeed; minutes?: number };

export interface LightTimer {
    id: string;
    enabled: boolean;
    days: number[]; // 0 Monday .. 6 Sunday
    at: string; // HH:MM, home time; a sunrise is bright then, it starts its minutes before
    action: LightAction;
    fadeMs?: number; // for off, mood and color
    name?: string;
}

export const LIGHT_TIMERS_MAX = 20;

// the alerts of kibbl. that may flash a light, each in its colour
export const LIGHT_ALERT_KINDS = ['fire', 'window', 'climate', 'cat', 'feeder', 'assistant'] as const;
export type LightAlertKind = (typeof LIGHT_ALERT_KINDS)[number];

export const ALERT_INFO: Record<LightAlertKind, { label: string; color: Rgb; flashes: number }> = {
    fire: { label: 'Possible fire', color: [255, 0, 0], flashes: 10 },
    window: { label: 'Window open (too long)', color: [0, 120, 255], flashes: 3 },
    climate: { label: 'Air hints (CO2, humidity, cold)', color: [255, 200, 0], flashes: 2 },
    cat: { label: 'Cat at the camera', color: [255, 0, 200], flashes: 2 },
    feeder: { label: 'Feeder problem (food low, a jam, a failed meal)', color: [255, 90, 0], flashes: 3 },
    assistant: { label: 'From the assistant', color: [0, 255, 255], flashes: 3 },
};

export interface LightAlerts {
    enabled: boolean;
    kinds: LightAlertKind[];
    quietFrom: number; // hours: no flashes from .. to (fire flashes always); equal: never quiet
    quietTo: number;
    onlyWhenOn: boolean; // flash only while the light is on (it does not light up a dark room)
}

export const lightAlertDefaults: LightAlerts = {
    enabled: true,
    kinds: ['fire', 'window', 'cat', 'assistant'],
    quietFrom: 23,
    quietTo: 7,
    onlyWhenOn: false,
};

export interface LightPlan {
    timers: LightTimer[];
    alerts: LightAlerts;
}

// what the server plays on a light now
export interface LightShowState {
    effect: LightEffect | 'alert';
    name: string; // what it shows: the mood or effect, or the alert
    startedAt: number;
    endsAt?: number; // a sunrise or sunset
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const timeOk = (at: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(at);

export const hexOf = (c: Rgb) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

// #rrggbb or rrggbb
export function rgbOfHex(value: string): Rgb | undefined {
    const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    return m ? ([0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb) : undefined;
}

// a timer as people read it, e.g. "Mon-Fri 07:00 sunrise 20 min"
export function actionText(a: LightAction) {
    if (a.kind === 'off') return 'off';
    if (a.kind === 'mood') return LIGHT_MOODS[a.mood]?.label ?? a.mood;
    if (a.kind === 'color') return `${hexOf(a.color)} at ${a.brightness} %`;
    const minutes = a.effect === 'sunrise' || a.effect === 'sunset' ? ` ${a.minutes ?? RAMP_MINUTES.default} min` : '';
    return `${EFFECT_INFO[a.effect].label}${minutes}`;
}

export function daysText(days: number[]) {
    const d = [...new Set(days)].sort();
    if (d.length === 7) return 'every day';
    if (d.join() === '0,1,2,3,4') return 'Mon-Fri';
    if (d.join() === '5,6') return 'weekends';
    return d.map((i) => WEEKDAYS[i]).join(', ');
}
