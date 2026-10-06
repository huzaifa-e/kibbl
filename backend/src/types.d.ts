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
    }

    type RequestWithSessionInfo = express.Request & { sessionInfo?: SessionInfo };
}

export {};
