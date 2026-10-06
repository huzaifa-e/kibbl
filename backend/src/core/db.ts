import { Schema, Model, model, connect, connection, set as mongooseSet } from 'mongoose';
import { logger } from './logger';

const log = logger('db');

export let User: Model<User>;
export let Device: Model<DeviceDoc>;
export let MotionEventModel: Model<MotionEventDoc>;
export let HealthLink: Model<HealthLinkDoc>;
export let HealthPoint: Model<HealthPointDoc>;
export let HeartRateDay: Model<HeartRateDayDoc>;

let isConnected = false;

const motionDefaults: DeviceDoc['motion'] = { enabled: true, sensitivity: 'medium', quietFrom: 0, quietTo: 0, blink: true, keepPictures: false };

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
            keepPictures: { type: Boolean, default: motionDefaults.keepPictures },
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

    // a user's link to Google Health: the tokens encrypted (health/tokens.ts), never in clear
    const healthLinkSchema = new Schema<HealthLinkDoc>({
        _id: { type: String, required: true }, // the user's id
        provider: { type: String, required: true, enum: ['google'] },
        tokens: { type: String, required: true },
        scopes: { type: [String], default: [] },
        refreshTokenExpiresAt: Number, // only while the Google app is in testing mode (7 days)
        connectedAt: { type: Number, required: true },
        updatedAt: { type: Number, required: true },
        // the one-time fetch of everything Google has, resumable (health/history.ts)
        backfill: { type: Schema.Types.Mixed },
        discoveredTypes: { type: [String], default: [] },
    });
    HealthLink = model<HealthLinkDoc>('HealthLink', healthLinkSchema);

    /* Every data point Google sent, as it sent it, by type and civil day: the health
     * history lives here, the parsers read it again for any range. Sleep and exercise
     * have an id of their own (name); the others are replaced day by day. */
    const healthPointSchema = new Schema<HealthPointDoc>(
        {
            userID: { type: String, required: true },
            type: { type: String, required: true },
            day: { type: String, required: true }, // YYYY-MM-DD
            name: String,
            seq: { type: Number, required: true }, // the order Google sent them in
            batch: { type: String, required: true },
            point: { type: Schema.Types.Mixed, required: true },
        },
        { versionKey: false },
    );
    healthPointSchema.index({ userID: 1, type: 1, day: 1, seq: 1 });
    HealthPoint = model<HealthPointDoc>('HealthPoint', healthPointSchema);

    /* A day of heart rate at full resolution (a sample every second or two, ~37 000):
     * seconds of the civil day (uint32) and values (float32) as binary, about 300 kB a
     * day instead of 13 MB of points. */
    const heartRateDaySchema = new Schema<HeartRateDayDoc>(
        {
            _id: { type: String, required: true }, // userID|date
            userID: { type: String, required: true },
            date: { type: String, required: true },
            count: { type: Number, required: true },
            seconds: { type: Buffer, required: true },
            values: { type: Buffer, required: true },
            meta: { type: Schema.Types.Mixed },
            fetchedAt: { type: Number, required: true },
        },
        { versionKey: false },
    );
    heartRateDaySchema.index({ userID: 1, date: 1 });
    HeartRateDay = model<HeartRateDayDoc>('HeartRateDay', heartRateDaySchema);

    connection.on('connected', () => {
        isConnected = true;
        log.info('connected to MongoDB');
    });
    connection.on('disconnected', () => {
        isConnected = false;
        log.warn('disconnected from MongoDB');
    });
    connection.on('error', (err) => {
        log.error('MongoDB error', undefined, err);
    });

    await connect(process.env.MONGODB_URI as string, { serverSelectionTimeoutMS: 10000 });
}

export default {
    init,
    isConnected: () => isConnected,
    motionDefaults,
};
