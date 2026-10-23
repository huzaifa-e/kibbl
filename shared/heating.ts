import type { RoomKind } from './roomKind';

/*
 * Heating through tado: the rooms of the account's tado home as the app shows them, and
 * what the app can ask for. tado's REST API allows 100 requests a day without Auto-Assist,
 * more with it: the server reads all rooms in one request, every 2 to 20 minutes by what is
 * left, and keeps the rest for commands (backend/src/tado).
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
    auto?: HeatingAuto; // held by the server's adaptive control
    at: number; // when it was read
}

/* A room held at a temperature by the server's adaptive PID control (backend/src/tado/pid.ts):
 * tado is set above or below the wish until the room measures it; off while a window is open. */
export interface HeatingAuto {
    celsius: number; // what the room should measure
    setTo?: number; // what tado is set to now by the control
    window: boolean; // off for an open window (tado's detection or a kibbl. air in the room)
    tau: number; // minutes, how fast the room follows tado as learned
    since: number;
}

export type HeatingUntil = 'next' | 'manual' | 'timer'; // next schedule change, until changed, for minutes

export type HeatingCommand =
    | { mode: 'temperature'; celsius: number; until: HeatingUntil; minutes?: number }
    | { mode: 'off'; until: HeatingUntil; minutes?: number }
    | { mode: 'auto'; celsius: number } // adaptive control until another command
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

/* A room's weekly schedule in tado. Classic homes choose one of three layouts (the same every
 * day, Mon-Fri / Sat / Sun, or each day), tado X keeps the layout its app made. A day is a run
 * of blocks from 00:00 to 24:00, each with the temperature it heats to (null: off). */
export const SCHEDULE_LAYOUTS = {
    one_day: ['MONDAY_TO_SUNDAY'],
    three_day: ['MONDAY_TO_FRIDAY', 'SATURDAY', 'SUNDAY'],
    seven_day: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'],
} as const;

export type ScheduleLayout = keyof typeof SCHEDULE_LAYOUTS;
export type ScheduleDay = (typeof SCHEDULE_LAYOUTS)[ScheduleLayout][number];

export interface ScheduleBlock {
    start: string; // HH:MM, home time
    end: string; // HH:MM, 24:00 for midnight
    celsius: number | null;
}

export interface HeatingSchedule {
    layout: ScheduleLayout;
    days: { day: ScheduleDay; blocks: ScheduleBlock[] }[];
}
