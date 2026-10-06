/*
 * The EMONI LoRaWAN server (ttn-chirpstack-webhook, container emoni-lorawan): it takes the
 * meters' uplinks (TTN, ChirpStack, NB-IoT) and keeps every reading. kibbl only reads from
 * it, on the docker network both run on: METER_SOURCE_URL, http://emoni-lorawan:8000.
 * New readings are announced on its live stream (/events), the history read from its api.
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

export interface SourceEvent {
    type: string; // 'up' for a new reading, '…-recalibrate' when the source corrects a meter
    devEui?: string;
}

const STALL_MS = 90_000; // the source sends a keepalive every 25 s; silence this long means a dead connection

/* The source's live stream (server-sent events, /events): it announces every reading as
 * soon as it is stored. Reconnects by itself, waiting longer after each failure; onOpen
 * runs on every (re)connect, to catch up with what came while disconnected. */
export function subscribe(onEvent: (e: SourceEvent) => void, onOpen: () => void, onError: (err: Error) => void) {
    let retryMs = 5_000;
    const connect = async () => {
        const controller = new AbortController();
        let stall: NodeJS.Timeout | undefined;
        const alive = () => {
            clearTimeout(stall);
            stall = setTimeout(() => controller.abort(new Error('no keepalive from the source')), STALL_MS);
        };
        try {
            const res = await fetch(`${sourceUrl()}/events`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
            if (!res.ok || !res.body) throw new Error(`/events: HTTP ${res.status}`);
            alive();
            retryMs = 5_000;
            onOpen();
            const decoder = new TextDecoder();
            let buffer = '';
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                alive();
                buffer += decoder.decode(chunk, { stream: true });
                let end: number;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const message = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const data = message
                        .split('\n')
                        .filter((l) => l.startsWith('data:'))
                        .map((l) => l.slice(5).trim())
                        .join('\n');
                    if (!data) continue; // a keepalive comment
                    try {
                        onEvent(JSON.parse(data) as SourceEvent);
                    } catch {
                        // not JSON: not one of ours
                    }
                }
            }
            throw new Error('the source closed the stream');
        } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
        } finally {
            clearTimeout(stall);
            controller.abort();
        }
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 5 * 60_000);
    };
    void connect();
}
