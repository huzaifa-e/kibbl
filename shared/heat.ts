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
    energy?: { kWhPerUnit: number; from?: string; to?: string }; // from the latest imported report: a radiator unit in kWh
}

/* A report of the meter reading company (Techem's Heizkostenabrechnung), read from its PDF on
 * the server (backend/src/heat/report.ts) and checked by the person before it is imported. */

export interface HeatReportDevice {
    serial: string; // the number on the heat cost allocator
    room?: string; // the report's room code: B, S, W, Z, K …
    date: string; // YYYY-MM-DD it was read
    old: number; // the reading at the start of the period
    new: number; // the reading at its end
    use: number; // what the report counts for it (units), (new - old) × its factor
}

export interface HeatReportData {
    company: 'techem' | 'unknown';
    period?: { from: string; to: string };
    userNo?: string;
    devices: HeatReportDevice[];
    units?: number; // the home's units
    buildingUnits?: number; // all units of the building
    buildingKWh?: number; // the energy the building's heating used (gas, kWh)
    costs?: number; // the home's heating costs, EUR
    costPerUnit?: number; // EUR per unit of use
    analysisKWh?: number; // the report's weather corrected consumption of the home
    climateFactor?: number; // the weather correction it used
}

export interface HeatReportSummary {
    _id: string;
    fileName: string;
    uploadedAt: number;
    appliedAt?: number;
    data: HeatReportData;
    warnings: string[];
}

// what one unit of the heat cost allocators stands for: the building's energy shared out by its units
export function kWhPerUnit(d: Pick<HeatReportData, 'buildingKWh' | 'buildingUnits'>) {
    return d.buildingKWh && d.buildingUnits ? d.buildingKWh / d.buildingUnits : undefined;
}

// the report's room codes (Techem: B = Bad, S = Schlafzimmer, W = Wohnzimmer, Z = Zimmer …)
export const REPORT_ROOMS: Record<string, { name: string; kind?: string }> = {
    B: { name: 'Bathroom', kind: 'bathroom' },
    D: { name: 'Hall' },
    E: { name: 'Dining room' },
    F: { name: 'Hall' },
    K: { name: 'Kitchen', kind: 'kitchen' },
    KZ: { name: "Children's room", kind: 'bedroom' },
    A: { name: 'Office', kind: 'office' },
    S: { name: 'Bedroom', kind: 'bedroom' },
    W: { name: 'Living room', kind: 'living' },
    Z: { name: 'Room' },
};

/* What the heat data says (backend/src/heat/insights.ts): the radiators by their use, and hints
 * where heat may be wasted. */

export interface HeatRank {
    meterId: string;
    name: string;
    roomId?: string;
    use: number; // units with the radiator's factor
    share: number; // of all radiators, 0..1
    kWh?: number; // by the latest report's kWh per unit
}

export interface HeatInsight {
    kind: 'top' | 'weather' | 'warm' | 'window' | 'cold' | 'loss' | 'data';
    level: 'info' | 'warn';
    title: string;
    text: string;
    meterId?: string;
    roomId?: string;
}

export interface HeatInsights {
    period?: { from: string; to: string }; // of the ranking
    ranking: HeatRank[];
    insights: HeatInsight[];
}

/* What the heating costs and what the advance payments leave for it (backend/src/heat/costs.ts,
 * frontend heatCosts.ts): the monthly advance for running costs and heating (Vorauszahlung
 * BK/NK/Hzg) pays the other running costs first; what remains pays the heating's base share
 * (by the floor area) and then its use, at the report's price per unit. */

export interface HeatCostSettings {
    advance?: number; // EUR per month, now
    previousAdvance?: number; // EUR per month before advanceSince
    advanceSince?: string; // YYYY-MM the advance became what it is
    otherCosts?: number; // EUR per year, the running costs that are not heating (last statement)
    baseCost?: number; // EUR per year, the heating's base share (Grundkosten)
    perUnit?: number; // EUR per unit of the heat cost allocators (Verbrauchskosten)
}

export interface HeatCosts {
    settings: HeatCostSettings;
    // from the latest imported report, what the settings default to
    report?: { from?: string; to?: string; units?: number; costs?: number; baseCost?: number; perUnit?: number };
}

// what is paid in advance in a year: the months before advanceSince at the previous advance
export function advancePaid(s: HeatCostSettings, year: number) {
    if (s.advance === undefined) return undefined;
    const since = s.advanceSince && s.previousAdvance !== undefined ? s.advanceSince : undefined;
    let sum = 0;
    for (let m = 1; m <= 12; m++) sum += since && `${year}-${String(m).padStart(2, '0')}` < since ? s.previousAdvance! : s.advance;
    return sum;
}

// the units of use a year's advance pays for, after the other costs and the heating's base share
export function heatBudget(s: HeatCostSettings, year: number) {
    const paid = advancePaid(s, year);
    if (paid === undefined || !s.perUnit) return undefined;
    const forUse = paid - (s.otherCosts ?? 0) - (s.baseCost ?? 0);
    return { paid, forUse, units: forUse / s.perUnit };
}
