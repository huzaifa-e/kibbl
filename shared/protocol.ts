import type { RoomKind } from './roomKind';

/*
 * The device protocol (docs/protocol.md) as both the server and the app see it.
 * A capability a device names in its hello message unlocks the commands listed for
 * it here; the server refuses every other command from the app.
 */

export type Capability =
    'camera' | 'light' | 'ota' | 'switch' | 'feeder' | 'thermostat' | 'air' | 'fan' | 'lamp' | 'night' | 'calibrate' | 'buzzer' | 'smoke' | 'window' | 'fire';

export const capabilityCommands: Record<string, string[]> = {
    camera: ['camera'],
    light: ['light'],
    blink: ['blink'], // a short flash of the white light
    ota: [],
    // for the devices that are still to come: relay outputs, a pet feeder, a heating valve
    switch: ['switch'],
    feeder: ['feed', 'iris', 'feeder_config', 'feeder_move', 'feeder_home', 'feeder_release', 'feeder_run', 'feeder_stop'],
    thermostat: ['thermostat'],
    // kibbl. air (the Conny CO2 traffic light)
    air: ['air_config'],
    fan: ['fan'],
    lamp: ['lamp'],
    night: ['night'],
    calibrate: ['calibrate'],
    buzzer: [], // switched with air_config
    smoke: [], // events only
    window: [],
    fire: [], // events and the alarm on the device
};

// any device may get these: every device is on the Wi-Fi
export const commonCommands = ['info', 'reboot', 'wifi', 'wifi_scan'];

/* What a device is called in the app: the product, never the parts inside it. A
 * device reports its product as `model` in its hello message. */
export const productNames: Record<string, string> = {
    'kibbl-cam': 'kibbl. cam',
    'kibbl-air': 'kibbl. air',
    'kibbl-feeder': 'kibbl. feeder',
    'kibbl-switch': 'kibbl. switch',
    'kibbl-thermostat': 'kibbl. thermostat',
};

export function productName(model: string | undefined, caps: string[] = []) {
    if (model && productNames[model]) return productNames[model];
    if (caps.includes('camera')) return 'kibbl. cam';
    if (caps.includes('feeder')) return 'kibbl. feeder';
    if (caps.includes('air')) return 'kibbl. air';
    return 'kibbl. device';
}

export const framesizes = ['QVGA', 'CIF', 'HVGA', 'VGA', 'SVGA', 'XGA', 'HD', 'SXGA', 'UXGA'] as const;
export type Framesize = (typeof framesizes)[number];

export interface CameraSettings {
    framesize: Framesize;
    quality: number; // 4-63, lower is better
    vflip: boolean;
    hmirror: boolean;
    brightness: number; // -2..2
    contrast: number; // -2..2
    saturation: number; // -2..2
}

export type MotionSensitivity = 'low' | 'medium' | 'high';

export interface MotionSettings {
    enabled: boolean;
    sensitivity: MotionSensitivity;
    // ignore motion between these hours (0-23, local time); equal values: never ignore
    quietFrom: number;
    quietTo: number;
    blink: boolean; // flash the white light when something moves (devices with the blink capability)
    // keep a picture of each movement; off, a movement is logged as activity only and no frame is stored
    keepPictures: boolean;
}

/* ----------------------------------------------------------------------- */
/* kibbl. feeder: the iris under the hopper (hardware/feeder/iris) */

export const FEEDER_MIN_MM = 2; // closed: the hole the blades leave
export const FEEDER_MAX_MM = 42; // fully open

// where the iris is (hello, telemetry, and the answer to feed and iris)
export interface FeederState {
    opening: number; // mm
    busy: boolean; // moving or feeding now
    job?: string; // what it is doing: feed, open, close
    position?: number; // motor steps from fully open
    speed?: number; // steps/s
    accel?: number; // steps/s²
    closedPos?: number; // the closed limit taught under load, steps from the open one (0)
}

// what the app may tune on a feeder while it is being set up (firmware/feeder-motor)
export const FEEDER_SPEED = { min: 100, max: 4000 };
export const FEEDER_ACCEL = { min: 200, max: 20000 };
export const FEEDER_MOVE_MAX = 3584; // steps, either way: two strokes

// the feeding levels the app offers: portions, how far and how long the iris opens each time
export interface FeedLevel {
    id: string;
    label: string;
    portions: number;
    opening: number; // mm
    openMs: number;
}

export const feedLevels: FeedLevel[] = [
    { id: 'snack', label: 'Snack', portions: 1, opening: 15, openMs: 600 },
    { id: 'small', label: 'Small', portions: 1, opening: 22, openMs: 1000 },
    { id: 'medium', label: 'Medium', portions: 2, opening: 22, openMs: 1000 },
    { id: 'large', label: 'Large', portions: 3, opening: 30, openMs: 1500 },
];

export interface DeviceTelemetry {
    uptime: number;
    rssi?: number;
    heap: number;
    psram: number;
    cameraFps: number;
    fps: number;
    frameBytes: number;
    air?: AirState; // a kibbl. air
    time: number; // server time it arrived
}

/* ----------------------------------------------------------------------- */
/* kibbl. air: the Conny CO2 traffic light */

export type AirLevel = 'none' | 'green' | 'yellow' | 'red';
export const lampModes = ['traffic', 'off', 'white', 'warm', 'candle', 'custom'] as const;
export type LampMode = (typeof lampModes)[number];
// the leds are not RGB: four fixed colours, each on or off
export const lampColors = ['red', 'green', 'yellow', 'white'] as const;
export type LampColor = (typeof lampColors)[number];
export const fanModes = ['off', 'on', 'pulse', 'auto'] as const;
export type FanMode = (typeof fanModes)[number];

// what the device measures and does now (hello and telemetry)
export interface AirState {
    co2?: number; // ppm, mean of 3 readings; missing until the first measurement
    temperature?: number; // °C, corrected for the warmth of the board
    humidity?: number; // %RH
    level: AirLevel;
    fan: number; // pwm % now
    window: 'open' | 'closed' | 'learning' | 'paused'; // learning: its first 3 min of readings; paused: during a calibration and 15 min after
    night: boolean;
    calibrating: boolean;
    puffs: number; // of a cigarette going on
    fire: boolean; // the fire alarm of the device sounds
    settleSeconds?: number; // the detectors wait this long after a calibration (at most; steady readings end it sooner)
    sensorError?: string; // the CO2 sensor does not answer
}

/* The sensor error to show: what the device reports now. A reading means the sensor
 * answers, whatever an earlier hello said (an older firmware reports it only there). */
export function airSensorError(state: AirState | undefined, before?: string) {
    if (!state || state.co2 !== undefined) return undefined;
    return state.sensorError ?? before;
}

// the settings stored on the device (air_config, fan, lamp)
/* What a kibbl. air does for the room it stands in: a bathroom beeps after a shower until the
 * humidity is back, a bedroom keeps its light off and beeps only for a risk to health. */
export type AirRoom = 'normal' | 'bathroom' | 'bedroom';

export function airRoomFor(kind: RoomKind | undefined): AirRoom {
    return kind === 'bathroom' || kind === 'bedroom' ? kind : 'normal';
}

export interface AirSettings {
    yellow: number;
    red: number;
    buzzer: boolean;
    asc: boolean;
    altitude: number;
    smoke: boolean;
    puffRise: number;
    nightFan: number;
    tempAdjust?: number; // °C added to the corrected temperature, to match a reference thermometer
    humidityFactor?: number; // 0.7-1.3 on the humidity, to match a reference hygrometer
    remindMinutes?: number; // a beep every so many minutes while the air is bad, 0: off
    remindFrom?: 'yellow' | 'red';
    room?: AirRoom; // what the device does for its room (firmware 1.2.0 on), set by the server from the room's kind
    freshMin?: number; // the CO2 of fresh air at the open window, recorded while calibrating: the reference for open windows
    freshMax?: number;
}

export interface FanSettings {
    mode: FanMode;
    level: number;
    onSeconds: number;
    offSeconds: number;
    quietLevel?: number; // % the lowest it runs at: in fresh air with the CO2, always in a bedroom (firmware 1.2.5 on)
    freqHz?: number; // the pwm frequency, which one the fan is quiet at depends on it (firmware 1.2.6 on)
}

export interface LampSettings {
    mode: LampMode;
    colors: LampColor[];
    fade: boolean;
}

// night mode by the server's clock: from one hour to another (local time), every day
export interface NightSchedule {
    enabled: boolean;
    from: number; // 0-23
    to: number; // 0-23
}

import type { PairedRoom } from './heating';

export interface AirDevice {
    state?: AirState; // while online
    settings?: AirSettings;
    fan?: FanSettings;
    lamp?: LampSettings;
    sensorError?: string;
    schedule: NightSchedule;
    room?: PairedRoom; // a tado room in the same room: its temperature and humidity count, the CO2 is the device's
    roomKind?: RoomKind; // what the room it stands in is used for: the advice follows it
}

// a minute of measurements
export interface AirReading {
    at: number;
    co2: number;
    temperature: number;
    humidity: number;
}

// the air of a bedroom over the last night, for how well it was slept in
export interface AirNight {
    from: number;
    to: number;
    co2Mean: number;
    co2Max: number;
    minutesAbove1000: number;
    temperatureMin: number;
    temperatureMax: number;
    humidityMean: number;
}

export interface AirEvent {
    _id: string;
    deviceId: string;
    kind: 'smoke' | 'window' | 'fire';
    at: number; // when it happened, from the device's age of it
    // smoke
    source?: 'auto' | 'button';
    puffs?: number;
    durationSeconds?: number;
    peakPpm?: number;
    button?: boolean; // found by the detector, logged with the button already: counts once
    window?: boolean; // smoked at an open window (smaller puffs count then)
    // window
    state?: 'open' | 'closed';
    co2?: number;
    co2Before?: number;
    temperatureChange?: number;
    openSeconds?: number;
    atStart?: boolean; // found open right after a restart, not seen opening: no alert
    // fire: what the device saw rise
    co2Rise?: number;
    temperature?: number;
    temperatureRise?: number;
}

// cigarettes of a day: logged with the button plus the ones only the detector found
export interface SmokeDay {
    day: string; // YYYY-MM-DD, server local time
    count: number;
    button: number;
    auto: number;
}

export interface DeviceSummary {
    _id: string;
    name: string;
    update?: { version: string; installing: boolean }; // the release of its product on the server is newer than its firmware
    status: 'pending' | 'approved';
    online: boolean;
    model?: string;
    board?: string;
    sensor?: string;
    fw?: string;
    ip?: string;
    ssid?: string;
    hostname?: string;
    caps: string[];
    camera?: CameraSettings;
    cameraError?: string;
    wifiChangeFailed?: string; // the network a change from the app could not join; the device went back
    light?: number;
    feeder?: FeederState; // a kibbl. feeder
    motion: MotionSettings;
    air?: AirDevice; // a kibbl. air
    roomId?: string; // the room of the home it stands in
    telemetry?: DeviceTelemetry;
    viewers: number;
    lastSeen?: number;
    createdAt: number;
}

export interface MotionEvent {
    _id: string;
    deviceId: string;
    start: number;
    end?: number;
    peakScore: number; // share of the picture that changed, 0-1
    frames: number;
    hasSnapshot: boolean;
}

export interface WifiNetwork {
    ssid: string;
    rssi: number;
    secure: boolean;
}

export interface SetupInfo {
    deviceSocketUrl?: string; // what a device set up over USB connects to
}

export interface ActivityBucket {
    day: string; // YYYY-MM-DD, server local time
    hour: number;
    count: number;
    seconds: number;
}

/* The temperature and humidity of a kibbl. air's room: tado's when one of tado's rooms is in
 * the same room (its radiator thermostat measures without the warmth of the device), else
 * the device's own. The CO2 is always the device's. */
export function roomClimate(air: AirDevice | undefined) {
    const s = air?.state;
    const r = air?.room;
    const fromTado = !!r && (r.temperature !== undefined || r.humidity !== undefined);
    return {
        temperature: fromTado ? (r?.temperature ?? s?.temperature) : s?.temperature,
        humidity: fromTado ? (r?.humidity ?? s?.humidity) : s?.humidity,
        co2: s?.co2,
        fromTado,
        roomName: r?.name,
    };
}
