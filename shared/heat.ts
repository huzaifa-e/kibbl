/*
 * The heat used in a home, from readings entered by hand or from a report of the meter
 * reading company (Techem): the heat cost allocator on each radiator (units, counted with
 * the radiator's factor), or a meter of the whole home (kWh, m³). What was used between two
 * readings is spread over the days between them: by the heating time of the tado room in
 * the same room, else by how cold it was outside (degree days), else evenly
 * (backend/src/heat).
 */

export type HeatKind = 'radiator' | 'meter';
export const HEAT_UNITS = ['units', 'kWh', 'MWh', 'm³'] as const;
export type HeatUnit = (typeof HEAT_UNITS)[number];

export interface HeatMeter {
    _id: string;
    name: string;
    kind: HeatKind;
    unit: HeatUnit; // radiators count units
    factor: number; // what one unit shown counts for (the radiator's rating), 1 for a meter
    roomId?: string; // the room of the home it is in
    serial?: string; // the number on the device, as the report lists it
    latest?: { date: string; value: number };
    readings: number;
}

export interface HeatReading {
    meterId: string;
    date: string; // YYYY-MM-DD, the day it was read
    value: number; // what the device showed, a running total
    source: 'manual' | 'report' | 'assistant';
}

// how the consumption between two readings was spread over its days
export type HeatSpread = 'tado' | 'weather' | 'even';

export interface HeatDay {
    date: string;
    use: Record<string, number>; // per meter, in its unit with its factor
    spread: Record<string, HeatSpread>;
    heatingHours?: number; // tado: the hours at full power of all its rooms (heating % × time)
    outside?: number; // °C, the day's mean outside
}

export interface HeatOverview {
    meters: HeatMeter[];
    days: HeatDay[];
    location: boolean; // a home location is set: the weather helps spread
}
