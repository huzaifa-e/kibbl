/*
 * A PetKit feeder (Fresh Element Solo, PetKit's "d4") through PetKit's cloud, as the app and
 * the assistant see it. A kibbl. cam may watch it: that camera's page shows the feeder, and
 * a cat it sees is "at the feeder".
 */

// what a meal of today is: still to come, given, skipped (in the app or by PetKit), being given, or failed
export type PetkitMealState = 'planned' | 'given' | 'skipped' | 'feeding' | 'failed' | 'missed';

export interface PetkitMeal {
    id: string; // PetKit's id of the meal of today (skip and restore name it)
    time: number; // seconds after midnight, the feeder's clock
    name: string;
    portions: number;
    given?: number; // portions it gave
    state: PetkitMealState;
    manual: boolean; // fed from an app now, not from the plan
    at?: number; // when it was given (ms)
}

export interface PetkitFeeder {
    id: number; // PetKit's device id
    name: string;
    type: string; // PetKit's family, d4 for the Fresh Element Solo
    online: boolean;
    food: 'enough' | 'low' | null; // what the hopper's sensor says
    feeding: boolean; // giving food right now
    error?: string; // what PetKit reports wrong, e.g. a jam
    desiccantDays?: number; // days left on the desiccant
    battery?: 'mains' | 'battery' | 'low'; // what it runs on
    wifi?: number; // signal, dBm
    firmware?: string;
    planPaused: boolean; // the feeding plan is suspended
    meals: PetkitMeal[]; // today, planned and manual, by time
    givenToday: number; // portions
    plannedToday: number;
    cameraId?: string; // the kibbl. cam that watches it
    at: number; // when it was read
}

export interface PetkitStatus {
    connected: boolean;
    account?: string; // the PetKit login
    feeders: PetkitFeeder[];
    error?: string; // the last read failed
    lastPoll?: number;
}

// a feed from the app: PetKit's Solo gives 1 to 5 portions of about 10 g at a time
export const PETKIT_PORTIONS = { min: 1, max: 5 };
// what PetKit counts per portion on the wire, unless the feeder reports its own factor
export const PETKIT_PORTION_AMOUNT = 10;

// PetKit's clouds; an account lives on one, by the country it was made in
export const PETKIT_REGIONS = [
    { id: 'DE', label: 'Europe' },
    { id: 'US', label: 'Americas and the rest of the world' },
    { id: 'SG', label: 'Asia' },
    { id: 'RU', label: 'Russia' },
    { id: 'CN', label: 'China' },
] as const;

export function mealTime(seconds: number) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
