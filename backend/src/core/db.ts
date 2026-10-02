import { Schema, Model, model, connect, connection, set as mongooseSet } from 'mongoose';
import { log } from './logger';

export let User: Model<User>;
export let Device: Model<DeviceDoc>;
export let MotionEventModel: Model<MotionEventDoc>;

let isConnected = false;

const motionDefaults: DeviceDoc['motion'] = { enabled: true, sensitivity: 'medium', quietFrom: 0, quietTo: 0, blink: true };

async function init() {
    mongooseSet('strictQuery', false);

    const userSchema = new Schema<User>({
        _id: { type: String, required: true },
        email: { type: String, required: true, unique: true, index: true },
        name: { type: String, required: true },
        password: { type: String, required: true },
        salt: { type: String, required: true },
        // raised on a password change: every token issued before is refused
        tokenVersion: { type: Number, required: true, default: 0 },
        createdAt: { type: Number, required: true },
    });

    const deviceSchema = new Schema<DeviceDoc>({
        _id: { type: String, required: true }, // mac address, 12 upper case hex characters
        name: { type: String, required: true },
        secretHash: { type: String, required: true },
        status: { type: String, required: true, enum: ['pending', 'approved'] },
        model: String,
        board: String,
        sensor: String,
        fw: String,
        caps: { type: [String], default: [] },
        camera: { type: Schema.Types.Mixed },
        motion: {
            enabled: { type: Boolean, default: motionDefaults.enabled },
            sensitivity: { type: String, enum: ['low', 'medium', 'high'], default: motionDefaults.sensitivity },
            quietFrom: { type: Number, default: motionDefaults.quietFrom },
            quietTo: { type: Number, default: motionDefaults.quietTo },
            blink: { type: Boolean, default: motionDefaults.blink },
        },
        lastSeen: Number,
        createdAt: { type: Number, required: true },
    });

    const motionEventSchema = new Schema<MotionEventDoc>({
        _id: { type: String, required: true },
        deviceId: { type: String, required: true, index: true },
        start: { type: Number, required: true, index: true },
        end: Number,
        peakScore: { type: Number, required: true },
        frames: { type: Number, required: true },
        snapshot: String, // file below IMAGE_DATA_PATH
    });
    motionEventSchema.index({ deviceId: 1, start: -1 });

    User = model<User>('User', userSchema);
    Device = model<DeviceDoc>('Device', deviceSchema);
    MotionEventModel = model<MotionEventDoc>('MotionEvent', motionEventSchema);

    connection.on('connected', () => {
        isConnected = true;
        log('info', 'Connected to MongoDB');
    });
    connection.on('disconnected', () => {
        isConnected = false;
        log('warn', 'Disconnected from MongoDB');
    });
    connection.on('error', (err) => {
        log('error', `MongoDB error: ${err.message}`);
    });

    await connect(process.env.MONGODB_URI as string, { serverSelectionTimeoutMS: 10000 });
}

export default {
    init,
    isConnected: () => isConnected,
    motionDefaults,
};
