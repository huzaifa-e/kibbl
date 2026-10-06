/*
 * The EMONI LoRaWAN server (ttn-chirpstack-webhook, container emoni-lorawan): it takes the
 * meters' uplinks (TTN, ChirpStack, NB-IoT) and keeps every reading. kibbl only reads from
 * it, on the docker network both run on: METER_SOURCE_URL, http://emoni-lorawan:8000.
 */

const TIMEOUT_MS = 30_000;

export function sourceUrl() {
    return (process.env.METER_SOURCE_URL || 'http://emoni-lorawan:8000').replace(/\/+$/, '');
}

async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
    const res = await fetch(`${sourceUrl()}${path}?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
}

export interface SourceDevice {
    uuid: string;
    dev_eui: string;
    name: string;
    device_type: string;
}

export interface SourceReading {
    at: string;
    meter_value: number | null;
    battery_mv: number | null;
    rssi: number | null;
}

export interface SourceDay {
    date: string;
    consumption: number | null;
    closing: number | null;
}

export interface SourcePeriod {
    period: string;
    consumption: number | null;
    opening: number | null;
    closing: number | null;
}

export async function configuredDevice(uuid: string) {
    return (await get<{ device: SourceDevice }>(`/api/configured-devices/${encodeURIComponent(uuid)}`, {})).device;
}

// every reading from (inclusive) on, all of them without from
export async function readings(devEui: string, from?: string) {
    return (await get<{ readings: SourceReading[] }>('/api/readings', { devEui, from })).readings;
}

// days, months and years in the home's time zone, as the source's own dashboard shows them
export async function daily(devEui: string, days: number) {
    return (await get<{ series: SourceDay[] }>('/api/consumption/daily', { devEui, days, tz: 'Europe/Berlin' })).series;
}

export async function monthly(devEui: string, months: number) {
    return (await get<{ series: SourcePeriod[] }>('/api/consumption/monthly', { devEui, months, tz: 'Europe/Berlin' })).series;
}

export async function yearly(devEui: string, years: number) {
    return (await get<{ series: SourcePeriod[] }>('/api/consumption/yearly', { devEui, years, tz: 'Europe/Berlin' })).series;
}

// the battery's full and empty voltage and its charge cycles, as the source detects them
export async function batteryCycles(devEui: string) {
    return get<{ full_mv: number; empty_mv: number; cycles: { start_at: string; start_mv: number; ongoing: boolean }[] }>('/api/battery-cycles', {
        devEui,
        cycles: 1,
    });
}
