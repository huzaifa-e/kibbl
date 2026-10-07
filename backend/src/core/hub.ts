import { EventEmitter } from 'node:events';
import type { AirEvent, DeviceSummary, DeviceTelemetry, MotionEvent } from '../../../shared/protocol';

/* What the device side reports and the browser side forwards; the two never import
 * each other. */
interface HubEvents {
    deviceUpdate: [DeviceSummary];
    deviceRemoved: [string, string | null]; // the device and who owned it
    telemetry: [string, DeviceTelemetry];
    motionEvent: [MotionEvent];
    meterUpdate: [string]; // a meter's id, after new readings were stored
    airEvent: [AirEvent]; // a kibbl. air detected something
}

class Hub extends EventEmitter<HubEvents> {}

export const hub = new Hub();
hub.setMaxListeners(100);
