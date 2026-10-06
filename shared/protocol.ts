/*
 * The device protocol (docs/protocol.md) as both the server and the app see it.
 * A capability a device names in its hello message unlocks the commands listed for
 * it here; the server refuses every other command from the app.
 */

export type Capability = 'camera' | 'light' | 'ota' | 'switch' | 'feeder' | 'thermostat';

export const capabilityCommands: Record<string, string[]> = {
    camera: ['camera'],
    light: ['light'],
    blink: ['blink'], // a short flash of the white light
    ota: [],
    // for the devices that are still to come: relay outputs, a pet feeder, a heating valve
    switch: ['switch'],
    feeder: ['feed'],
    thermostat: ['thermostat'],
};

// any device may get these: every device is on the Wi-Fi
export const commonCommands = ['info', 'reboot', 'wifi', 'wifi_scan'];

/* What a device is called in the app: the product, never the parts inside it. A
 * device reports its product as `model` in its hello message. */
export const productNames: Record<string, string> = {
    'kibbl-cam': 'kibbl. cam',
    'kibbl-feeder': 'kibbl. feeder',
    'kibbl-switch': 'kibbl. switch',
    'kibbl-thermostat': 'kibbl. thermostat',
};

export function productName(model: string | undefined, caps: string[] = []) {
    if (model && productNames[model]) return productNames[model];
    if (caps.includes('camera')) return 'kibbl. cam';
    if (caps.includes('feeder')) return 'kibbl. feeder';
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
    time: number; // server time it arrived
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
