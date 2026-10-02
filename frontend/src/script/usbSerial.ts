/*
 * A device on the USB cable, through Web Serial (Chrome and Edge, on https or
 * localhost). It speaks the serial protocol of docs/protocol.md: one json command
 * per line, the response is the json line carrying the same id. Everything else the
 * device prints (its debug output) goes to onLine.
 */

interface SerialPortLike {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
}

interface SerialLike {
    requestPort(): Promise<SerialPortLike>;
    getPorts(): Promise<SerialPortLike[]>;
    addEventListener(type: 'connect' | 'disconnect', listener: (event: Event) => void): void;
}

export type DeviceResponse = { ok: boolean; error?: string; id?: number } & Record<string, unknown>;

const serial = (navigator as unknown as { serial?: SerialLike }).serial;

export function usbSupported() {
    return !!serial && window.isSecureContext;
}

// why setup over USB is not offered here, for the page to say so
export function usbUnsupportedReason() {
    if (!window.isSecureContext) return 'Setup over USB needs the app on https or on localhost.';
    if (!serial) return 'Setup over USB needs Chrome or Edge on a computer.';
    return '';
}

export function onUsbPlugged(listener: () => void) {
    serial?.addEventListener('connect', listener);
}

// ports the user already allowed for this site: a plugged device is found without asking
export async function knownPorts() {
    return serial ? serial.getPorts() : [];
}

export class UsbDevice {
    onLine?: (line: string) => void;
    private buffer = '';
    private nextId = 1;
    private waiting = new Map<number, (resp: DeviceResponse) => void>();
    private reader?: ReadableStreamDefaultReader<Uint8Array>;
    private closed = false;

    private constructor(private port: SerialPortLike) {}

    static async choose() {
        return UsbDevice.open(await serial!.requestPort());
    }

    static async open(port: SerialPortLike) {
        await port.open({ baudRate: 115200 });
        /* The ESP32-CAM-MB adapter wires RTS to EN and DTR to IO0: both released, the
         * board runs its firmware instead of sitting in reset or in the bootloader. */
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
        const device = new UsbDevice(port);
        device.readLoop();
        return device;
    }

    private async readLoop() {
        const decoder = new TextDecoder();
        while (!this.closed && this.port.readable) {
            this.reader = this.port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    this.buffer += decoder.decode(value, { stream: true });
                    let end: number;
                    while ((end = this.buffer.search(/\r?\n/)) >= 0) {
                        const line = this.buffer.slice(0, end).trim();
                        this.buffer = this.buffer.slice(end + 1);
                        if (line) this.handleLine(line);
                    }
                    if (this.buffer.length > 8192) this.buffer = '';
                }
            } catch {
                // unplugged or a framing error: try again while the port is open
            } finally {
                this.reader.releaseLock();
            }
        }
    }

    private handleLine(line: string) {
        if (line.startsWith('{')) {
            try {
                const msg = JSON.parse(line) as DeviceResponse;
                const resolve = typeof msg.id === 'number' ? this.waiting.get(msg.id) : undefined;
                if (resolve) {
                    this.waiting.delete(msg.id!);
                    resolve(msg);
                    return;
                }
            } catch {
                // a json-looking debug line
            }
        }
        this.onLine?.(line);
    }

    // sends a command and waits for its response; undefined after timeoutMs
    async send(command: Record<string, unknown>, timeoutMs = 5000): Promise<DeviceResponse | undefined> {
        const id = this.nextId++;
        const writer = this.port.writable!.getWriter();
        try {
            await writer.write(new TextEncoder().encode(JSON.stringify({ ...command, id }) + '\n'));
        } finally {
            writer.releaseLock();
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                resolve(undefined);
            }, timeoutMs);
            this.waiting.set(id, (resp) => {
                clearTimeout(timer);
                resolve(resp);
            });
        });
    }

    /* Opening the port can reset the board: asks for its info until it has booted
     * far enough to answer. */
    async info(timeoutMs = 15000): Promise<DeviceResponse | undefined> {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until && !this.closed) {
            const resp = await this.send({ cmd: 'info' }, 1500);
            if (resp?.ok) return resp;
        }
        return undefined;
    }

    async close() {
        this.closed = true;
        for (const resolve of this.waiting.values()) resolve({ ok: false, error: 'closed' });
        this.waiting.clear();
        try {
            await this.reader?.cancel();
        } catch {
            // already gone
        }
        try {
            await this.port.close();
        } catch {
            // unplugged
        }
    }
}
