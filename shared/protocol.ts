/*
 * The device protocol (docs/protocol.md) as both the server and the app see it.
 * A capability a device names in its hello message unlocks the commands listed for
 * it here; the server refuses every other command from the app.
 */

export type Capability = 'camera' | 'light' | 'ota' | 'switch' | 'feeder' | 'thermostat';

export const capabilityCommands: Record<string, string[]> = {
    camera: ['camera'],
    light: ['light'],
    ota: [],
    // for the devices that are still to come: relay outputs, a pet feeder, a heating valve
    switch: ['switch'],
    feeder: ['feed'],
    thermostat: ['thermostat'],
};

// any device may get these
export const commonCommands = ['info', 'reboot'];

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

export interface ActivityBucket {
    day: string; // YYYY-MM-DD, server local time
    hour: number;
    count: number;
    seconds: number;
}
