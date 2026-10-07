import type { AirSettings, CameraSettings, FanSettings, LampSettings, MotionSettings, NightSchedule } from '../../shared/protocol';
import type express from 'express';
import type { HomeLocation } from '../../shared/climate';

declare global {
    interface User {
        _id: string;
        email: string;
        name: string;
        password: string; // scrypt hash, hex
        salt: string;
        tokenVersion: number;
        home?: HomeLocation; // for the weather outside (kibbl. air)
        createdAt: number;
    }

    interface SessionInfo {
        userID: string;
        email: string;
        name: string;
        tokenVersion: number;
    }

    interface DeviceDoc {
        _id: string;
        name: string;
        secretHash: string;
        status: 'pending' | 'approved';
        ownerID?: string;
        model?: string;
        board?: string;
        sensor?: string;
        fw?: string;
        caps: string[];
        camera?: CameraSettings;
        motion: MotionSettings;
        // kibbl. air: the settings the device reported, the night schedule the server keeps
        air?: AirSettings;
        fanSettings?: FanSettings;
        lamp?: LampSettings;
        night?: NightSchedule;
        // sha256 of the pairing code the device shows on its setup page (KL_portal)
        claimHash?: string;
        // the room of the home it stands in (rooms); with a tado room in the same room a kibbl. air shows tado's temperature and humidity
        roomId?: string;
        lastSeen?: number;
        createdAt: number;
    }

    interface TadoLinkDoc {
        _id: string; // the user's id
        tokens: string; // encrypted (tado/client.ts)
        homeId?: number;
        homeName?: string;
        generation?: 'classic' | 'x';
        rooms: { id: number; name: string; roomId?: string }[]; // tado's rooms, each in a room of the home
        connectedAt: number;
        lastPoll?: number;
        lastError?: string;
        rateRemaining?: number;
        rateResetAt?: number;
    }

    interface RoomDoc {
        _id: string;
        ownerID: string;
        name: string;
        createdAt: number;
    }

    interface TadoReadingDoc {
        userID: string;
        roomId: number;
        at: Date;
        temperature?: number;
        humidity?: number;
        target?: number | null;
        heating?: number;
    }

    interface AirReadingDoc {
        deviceId: string;
        at: Date; // the start of the minute
        co2: number;
        temperature: number;
        humidity: number;
    }

    interface AirEventDoc {
        _id: string;
        deviceId: string;
        kind: 'smoke' | 'window' | 'fire';
        at: number;
        data: Record<string, unknown>; // the fields of the event as the device sent them
    }

    interface MotionEventDoc {
        _id: string;
        deviceId: string;
        start: number;
        end?: number;
        peakScore: number;
        frames: number;
        snapshot?: string;
    }

    interface HealthLinkDoc {
        _id: string;
        provider: 'google';
        tokens: string; // AES-256-GCM, base64: iv.tag.ciphertext
        scopes: string[];
        refreshTokenExpiresAt?: number;
        connectedAt: number;
        updatedAt: number;
        backfill?: HealthBackfill;
        discoveredTypes: string[];
    }

    interface HealthBackfill {
        state: 'running' | 'done' | 'failed';
        startedAt: number;
        finishedAt?: number;
        oldestDay?: string; // the oldest day with data found
        reachedDay?: string; // how far back the points have been fetched
        pointsDone?: boolean; // all points fetched, heart rate is next
        heartRateDays?: number;
        heartRateDaysTotal?: number;
        error?: string;
    }

    interface HealthPointDoc {
        userID: string;
        type: string;
        day: string;
        name?: string;
        seq: number;
        batch: string;
        point: unknown;
    }

    interface HeartRateDayDoc {
        _id: string;
        userID: string;
        date: string;
        count: number;
        seconds: Buffer;
        values: Buffer;
        meta?: Record<string, unknown>;
        fetchedAt: number;
    }

    interface MeterDoc {
        _id: string;
        devEui: string;
        ownerID?: string;
        name: string;
        deviceType?: string;
        medium: string;
        unit: string;
        battery?: { fullMv: number; emptyMv: number; cycleStartAt?: string; cycleStartMv?: number };
        addedAt: number;
        importedAt?: number;
        lastSyncAt?: number;
        lastSyncError?: string;
    }

    interface MeterReadingDoc {
        meterId: string;
        at: Date;
        value: number | null;
        batteryMv: number | null;
        rssi: number | null;
    }

    interface MeterPeriodDoc {
        meterId: string;
        period: 'day' | 'month' | 'year';
        key: string;
        consumption: number | null;
        opening: number | null;
        closing: number | null;
        updatedAt: number;
    }

    interface AccessTokenDoc {
        _id: string;
        userID: string;
        name: string;
        createdAt: number;
        lastUsedAt?: number;
    }

    interface OAuthClientDoc {
        _id: string;
        info: Record<string, unknown>; // the client information as registered (RFC 7591)
        createdAt: number;
    }

    interface OAuthGrantDoc {
        _id: string;
        userID: string;
        clientId: string;
        clientName: string;
        tokenVersion: number; // the user's at sign-in: a password change ends the grant
        resource?: string;
        accessHash: string;
        accessExpiresAt: number;
        refreshHash: string;
        refreshExpiresAt: number;
        createdAt: number;
        lastUsedAt?: number;
    }

    interface PasswordResetDoc {
        _id: string; // sha256 of the token in the link
        userID: string;
        expiresAt: Date;
    }

    interface HealthAccessRequestDoc {
        _id: string; // the user's id
        googleEmail: string;
        status: 'waiting' | 'added';
        requestedAt: number;
        addedAt?: number;
    }

    type RequestWithSessionInfo = express.Request & { sessionInfo?: SessionInfo };
}

export {};
