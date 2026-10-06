import type { CameraSettings, MotionSettings } from '../../shared/protocol';
import type express from 'express';

declare global {
    interface User {
        _id: string;
        email: string;
        name: string;
        password: string; // scrypt hash, hex
        salt: string;
        tokenVersion: number;
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
        model?: string;
        board?: string;
        sensor?: string;
        fw?: string;
        caps: string[];
        camera?: CameraSettings;
        motion: MotionSettings;
        lastSeen?: number;
        createdAt: number;
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

    type RequestWithSessionInfo = express.Request & { sessionInfo?: SessionInfo };
}

export {};
