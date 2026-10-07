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
    feeder: ['feed'],
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
    window: 'open' | 'closed';
    night: boolean;
    calibrating: boolean;
    puffs: number; // of a cigarette going on
    fire: boolean; // the fire alarm of the device sounds
}

// the settings stored on the device (air_config, fan, lamp)
export interface AirSettings {
    yellow: number;
    red: number;
    buzzer: boolean;
    asc: boolean;
    altitude: number;
    smoke: boolean;
    puffRise: number;
    nightFan: number;
}

export interface FanSettings {
    mode: FanMode;
    level: number;
    onSeconds: number;
    offSeconds: number;
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

export interface AirDevice {
    state?: AirState; // while online
    settings?: AirSettings;
    fan?: FanSettings;
    lamp?: LampSettings;
    sensorError?: string;
    schedule: NightSchedule;
}

// a minute of measurements
export interface AirReading {
    at: number;
    co2: number;
    temperature: number;
    humidity: number;
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
    // window
    state?: 'open' | 'closed';
    co2?: number;
    co2Before?: number;
    temperatureChange?: number;
    openSeconds?: number;
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
    motion: MotionSettings;
    air?: AirDevice; // a kibbl. air
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
