import { EventEmitter } from 'node:events';
import type { DeviceSummary, DeviceTelemetry, MotionEvent } from '../../../shared/protocol';

/* What the device side reports and the browser side forwards; the two never import
 * each other. */
interface HubEvents {
    deviceUpdate: [DeviceSummary];
    deviceRemoved: [string];
    telemetry: [string, DeviceTelemetry];
    motionEvent: [MotionEvent];
}

class Hub extends EventEmitter<HubEvents> {}

export const hub = new Hub();
hub.setMaxListeners(100);
