import { Schema, Model, model, connect, connection, set as mongooseSet } from 'mongoose';
import { logger } from './logger';

const log = logger('db');

export let User: Model<User>;
export let Device: Model<DeviceDoc>;
export let MotionEventModel: Model<MotionEventDoc>;
export let HealthLink: Model<HealthLinkDoc>;
export let HealthPoint: Model<HealthPointDoc>;
export let HeartRateDay: Model<HeartRateDayDoc>;
export let Meter: Model<MeterDoc>;
export let MeterReading: Model<MeterReadingDoc>;
export let MeterPeriod: Model<MeterPeriodDoc>;
export let AccessToken: Model<AccessTokenDoc>;
export let OAuthClient: Model<OAuthClientDoc>;
export let OAuthGrant: Model<OAuthGrantDoc>;
export let PasswordReset: Model<PasswordResetDoc>;
export let HealthAccessRequest: Model<HealthAccessRequestDoc>;
export let AirReading: Model<AirReadingDoc>;
export let AirEventModel: Model<AirEventDoc>;
export let TadoLink: Model<TadoLinkDoc>;
export let Room: Model<RoomDoc>;
export let TadoReading: Model<TadoReadingDoc>;
export let FirmwareRelease: Model<FirmwareReleaseDoc>;
export let HeatMeterModel: Model<HeatMeterDoc>;
export let HeatReadingModel: Model<HeatReadingDoc>;

let isConnected = false;

const motionDefaults: DeviceDoc['motion'] = { enabled: true, sensitivity: 'medium', quietFrom: 0, quietTo: 0, blink: true, keepPictures: false };
const nightDefaults: NonNullable<DeviceDoc['night']> = { enabled: false, from: 22, to: 7 };

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
        // where the home is, for the weather outside (kibbl. air)
        home: { latitude: Number, longitude: Number, name: String },
        createdAt: { type: Number, required: true },
    });

    const deviceSchema = new Schema<DeviceDoc>({
        _id: { type: String, required: true }, // mac address, 12 upper case hex characters
        name: { type: String, required: true },
        secretHash: { type: String, required: true },
        status: { type: String, required: true, enum: ['pending', 'approved'] },
        // the account it belongs to; a pending device that was not set up over USB has none yet
        ownerID: { type: String, index: true },
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
        // kibbl. air
        air: { type: Schema.Types.Mixed },
        fanSettings: { type: Schema.Types.Mixed },
        lamp: { type: Schema.Types.Mixed },
        claimHash: String,
        roomId: { type: String, index: true },
        // the last update offered to it (core/firmware.ts): attempts set to 0 tries again
        ota: { version: String, attempts: Number, lastAt: Number, error: String, _id: false },
        night: {
            enabled: { type: Boolean, default: nightDefaults.enabled },
            from: { type: Number, default: nightDefaults.from },
            to: { type: Number, default: nightDefaults.to },
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

    /* Utility meters read from the EMONI LoRaWAN server (meters/): the meter, every reading
     * it sent (meter value, battery, signal) and the consumption per day, month and year
     * as that server computes it, also from manual readings before the meter reported. */
    const meterSchema = new Schema<MeterDoc>(
        {
            _id: { type: String, required: true }, // the configured device's uuid on the source
            devEui: { type: String, required: true },
            ownerID: { type: String, index: true }, // the account that added it
            name: { type: String, required: true },
            deviceType: String,
            medium: { type: String, required: true },
            unit: { type: String, required: true },
            battery: { type: Schema.Types.Mixed }, // full and empty voltage, the current cycle
            addedAt: { type: Number, required: true },
            importedAt: Number, // the one-time copy of the history is done
            lastSyncAt: Number,
            lastSyncError: String,
        },
        { versionKey: false },
    );
    Meter = model<MeterDoc>('Meter', meterSchema);

    const meterReadingSchema = new Schema<MeterReadingDoc>(
        {
            meterId: { type: String, required: true },
            at: { type: Date, required: true },
            value: { type: Number, default: null },
            batteryMv: { type: Number, default: null },
            rssi: { type: Number, default: null },
        },
        { versionKey: false },
    );
    meterReadingSchema.index({ meterId: 1, at: 1 }, { unique: true });
    MeterReading = model<MeterReadingDoc>('MeterReading', meterReadingSchema);

    const meterPeriodSchema = new Schema<MeterPeriodDoc>(
        {
            meterId: { type: String, required: true },
            period: { type: String, required: true, enum: ['day', 'month', 'year'] },
            key: { type: String, required: true }, // 2026-05-21, 2026-05, 2026
            consumption: { type: Number, default: null },
            opening: { type: Number, default: null },
            closing: { type: Number, default: null },
            updatedAt: { type: Number, required: true },
        },
        { versionKey: false },
    );
    meterPeriodSchema.index({ meterId: 1, period: 1, key: 1 }, { unique: true });
    MeterPeriod = model<MeterPeriodDoc>('MeterPeriod', meterPeriodSchema);

    // tokens for the MCP endpoint (mcp/): only their hash, the token is shown once
    const accessTokenSchema = new Schema<AccessTokenDoc>(
        {
            _id: { type: String, required: true }, // sha256 of the token, hex
            userID: { type: String, required: true, index: true },
            name: { type: String, required: true },
            createdAt: { type: Number, required: true },
            lastUsedAt: Number,
        },
        { versionKey: false },
    );
    AccessToken = model<AccessTokenDoc>('AccessToken', accessTokenSchema);

    /* OAuth for the MCP endpoint (mcp/oauth.ts): the clients that registered themselves,
     * and one grant per sign-in with its current access and refresh token, as hashes. */
    const oauthClientSchema = new Schema<OAuthClientDoc>(
        {
            _id: { type: String, required: true }, // client_id
            info: { type: Schema.Types.Mixed, required: true },
            createdAt: { type: Number, required: true },
        },
        { versionKey: false },
    );
    OAuthClient = model<OAuthClientDoc>('OAuthClient', oauthClientSchema);

    const oauthGrantSchema = new Schema<OAuthGrantDoc>(
        {
            _id: { type: String, required: true },
            userID: { type: String, required: true },
            clientId: { type: String, required: true },
            clientName: { type: String, required: true },
            tokenVersion: { type: Number, required: true },
            resource: String,
            accessHash: { type: String, required: true, index: true },
            accessExpiresAt: { type: Number, required: true },
            refreshHash: { type: String, required: true, index: true },
            refreshExpiresAt: { type: Number, required: true },
            createdAt: { type: Number, required: true },
            lastUsedAt: Number,
        },
        { versionKey: false },
    );
    OAuthGrant = model<OAuthGrantDoc>('OAuthGrant', oauthGrantSchema);

    // a password reset link sent by e-mail: the hash of its token, gone an hour later
    const passwordResetSchema = new Schema<PasswordResetDoc>(
        {
            _id: { type: String, required: true },
            userID: { type: String, required: true, index: true },
            expiresAt: { type: Date, required: true, expires: 0 },
        },
        { versionKey: false },
    );
    PasswordReset = model<PasswordResetDoc>('PasswordReset', passwordResetSchema);

    /* A person asking the admin to put their Google account on the tester list of the
     * Google app (testing mode): one per account, until it is done or withdrawn. */
    const healthAccessSchema = new Schema<HealthAccessRequestDoc>(
        {
            _id: { type: String, required: true }, // the user's id
            googleEmail: { type: String, required: true },
            status: { type: String, required: true, enum: ['waiting', 'added'] },
            requestedAt: { type: Number, required: true },
            addedAt: Number,
        },
        { versionKey: false },
    );
    HealthAccessRequest = model<HealthAccessRequestDoc>('HealthAccessRequest', healthAccessSchema);

    /* kibbl. air: a minute of CO2, temperature and humidity per device (the mean of its
     * telemetry), and what it detected (cigarettes, windows, fire). */
    const airReadingSchema = new Schema<AirReadingDoc>(
        {
            deviceId: { type: String, required: true },
            at: { type: Date, required: true },
            co2: { type: Number, required: true },
            temperature: { type: Number, required: true },
            humidity: { type: Number, required: true },
        },
        { versionKey: false },
    );
    airReadingSchema.index({ deviceId: 1, at: 1 }, { unique: true });
    AirReading = model<AirReadingDoc>('AirReading', airReadingSchema);

    const airEventSchema = new Schema<AirEventDoc>(
        {
            _id: { type: String, required: true },
            deviceId: { type: String, required: true },
            kind: { type: String, required: true, enum: ['smoke', 'window', 'fire'] },
            at: { type: Number, required: true },
            data: { type: Schema.Types.Mixed, default: {} },
        },
        { versionKey: false },
    );
    airEventSchema.index({ deviceId: 1, at: -1 });
    AirEventModel = model<AirEventDoc>('AirEvent', airEventSchema);

    /* tado: an account's link (the tokens encrypted, its home and rooms) and every reading of
     * its rooms, one per poll (every 2 to 20 minutes, by tado's daily budget). */
    const tadoLinkSchema = new Schema<TadoLinkDoc>(
        {
            _id: { type: String, required: true },
            tokens: { type: String, required: true },
            homeId: Number,
            homeName: String,
            generation: { type: String, enum: ['classic', 'x'] },
            rooms: { type: [{ id: Number, name: String, roomId: String, _id: false }], default: [] },
            connectedAt: { type: Number, required: true },
            lastPoll: Number,
            lastError: String,
            rateRemaining: Number,
            rateResetAt: Number,
        },
        { versionKey: false },
    );
    TadoLink = model<TadoLinkDoc>('TadoLink', tadoLinkSchema);

    // the rooms of an account's home: devices and tado's rooms in the same one share their readings
    const roomSchema = new Schema<RoomDoc>(
        {
            _id: { type: String, required: true },
            ownerID: { type: String, required: true, index: true },
            name: { type: String, required: true },
            kind: { type: String },
            createdAt: { type: Number, required: true },
        },
        { versionKey: false },
    );
    Room = model<RoomDoc>('Room', roomSchema);

    const firmwareReleaseSchema = new Schema<FirmwareReleaseDoc>(
        {
            _id: { type: String, required: true },
            ownerID: { type: String, required: true },
            model: { type: String, required: true },
            version: { type: String, required: true },
            file: { type: String, required: true },
            size: { type: Number, required: true },
            at: { type: Number, required: true },
            auto: { type: Boolean, default: true },
            maxAttempts: { type: Number, default: 3 },
            retryMinutes: { type: Number, default: 10 },
            only: { type: [String], default: [] },
            exclude: { type: [String], default: [] },
        },
        { versionKey: false },
    );
    FirmwareRelease = model<FirmwareReleaseDoc>('FirmwareRelease', firmwareReleaseSchema);

    const tadoReadingSchema = new Schema<TadoReadingDoc>(
        {
            userID: { type: String, required: true },
            roomId: { type: Number, required: true },
            at: { type: Date, required: true },
            temperature: Number,
            humidity: Number,
            target: { type: Number, default: null },
            heating: Number,
        },
        { versionKey: false },
    );
    tadoReadingSchema.index({ userID: 1, roomId: 1, at: 1 }, { unique: true });
    TadoReading = model<TadoReadingDoc>('TadoReading', tadoReadingSchema);

    /* Heat used in the home (heat/): the heat cost allocators on the radiators and meters of the
     * whole home, with the readings entered by hand or from the report of the meter reading company. */
    const heatMeterSchema = new Schema<HeatMeterDoc>(
        {
            _id: { type: String, required: true },
            ownerID: { type: String, required: true, index: true },
            name: { type: String, required: true },
            kind: { type: String, required: true, enum: ['radiator', 'meter'] },
            unit: { type: String, required: true },
            factor: { type: Number, default: 1 },
            roomId: String,
            serial: String,
            addedAt: { type: Number, required: true },
        },
        { versionKey: false },
    );
    HeatMeterModel = model<HeatMeterDoc>('HeatMeter', heatMeterSchema);

    const heatReadingSchema = new Schema<HeatReadingDoc>(
        {
            meterId: { type: String, required: true },
            date: { type: String, required: true }, // YYYY-MM-DD
            value: { type: Number, required: true },
            source: { type: String, required: true },
            enteredAt: { type: Number, required: true },
        },
        { versionKey: false },
    );
    heatReadingSchema.index({ meterId: 1, date: 1 }, { unique: true });
    HeatReadingModel = model<HeatReadingDoc>('HeatReading', heatReadingSchema);

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
    nightDefaults,
};
