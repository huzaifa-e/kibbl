import type { RoomKind } from './roomKind';

/*
 * Heating through tado: the rooms of the account's tado home as the app shows them, and
 * what the app can ask for. tado's REST API allows 100 requests a day without Auto-Assist:
 * the server reads all rooms in one request every 20 minutes and keeps the rest for
 * commands (backend/src/tado).
 */

export interface HeatingRoom {
    id: number; // the zone (classic) or room (tado X) id
    name: string;
    roomId?: string; // the room of the home it is in
    temperature?: number; // °C, measured by tado
    humidity?: number; // %RH
    target?: number | null; // °C it heats to, null while off
    power: 'ON' | 'OFF';
    heating: number; // % heating power now
    openWindow: boolean; // tado's own open window detection
    manual: boolean; // a manual setting (overlay) instead of the schedule
    manualUntil?: number | null; // when it ends, null: until changed
    at: number; // when it was read
}

export type HeatingUntil = 'next' | 'manual' | 'timer'; // next schedule change, until changed, for minutes

export type HeatingCommand =
    | { mode: 'temperature'; celsius: number; until: HeatingUntil; minutes?: number }
    | { mode: 'off'; until: HeatingUntil; minutes?: number }
    | { mode: 'schedule' };

export interface HeatingStatus {
    connected: boolean;
    pending?: { userCode: string; url: string; expiresAt: number }; // a sign-in waits for the person
    home?: { id: number; name: string; generation: 'classic' | 'x' };
    rooms: HeatingRoom[];
    budget?: { remaining?: number; pollMinutes: number; paused?: boolean };
    lastPoll?: number;
    error?: string;
}

// a room of the home: devices and tado's rooms in the same one share their readings
export interface HomeRoom {
    _id: string;
    name: string;
    kind?: RoomKind; // chosen, or guessed from the name (shared/roomKind.ts)
}

// a room of the home with what stands in it, for the rooms section of the app
export interface RoomOverview<Device> {
    room: HomeRoom | null; // null: what is in no room
    devices: Device[];
    heating: HeatingRoom[];
}

// the room values a kibbl. air shows when a tado room is in its room
export interface PairedRoom extends HeatingRoom {
    source: 'tado';
}
