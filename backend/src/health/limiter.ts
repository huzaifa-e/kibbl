/*
 * Every request to Google goes through one limiter: a few at a time instead of one
 * after another (the latency, not the bandwidth, is what makes a fetch slow), never so
 * many that the server or Google's quota is overrun. A 429 pauses all of them, not just
 * the one that was refused. What a person waits for (a day opened on the page) goes
 * ahead of the one-time history fetch.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Limiter {
    private active = 0;
    private readonly waiting: { urgent: (() => void)[]; background: (() => void)[] } = { urgent: [], background: [] };
    private pausedUntil = 0;

    constructor(readonly concurrency: number) {}

    // no request starts before then; a longer pause wins over a shorter one
    pause(ms: number) {
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    }

    get pending() {
        return this.waiting.urgent.length + this.waiting.background.length;
    }

    get running() {
        return this.active;
    }

    async run<T>(fn: () => Promise<T>, urgent = false): Promise<T> {
        if (this.active >= this.concurrency) {
            await new Promise<void>((resolve) => (urgent ? this.waiting.urgent : this.waiting.background).push(resolve));
        } else {
            this.active++;
        }
        try {
            for (let wait = this.pausedUntil - Date.now(); wait > 0; wait = this.pausedUntil - Date.now()) await sleep(wait);
            return await fn();
        } finally {
            // the slot goes straight to the next in line, urgent ones first
            const next = this.waiting.urgent.shift() ?? this.waiting.background.shift();
            if (next) next();
            else this.active--;
        }
    }
}

/* Runs fn for every item, at most `concurrency` at once, in the order given. The first
 * error stops taking new items; the ones under way finish before it is thrown, so
 * nothing is still writing after the caller saw the failure. */
export async function forEachLimited<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
    let next = 0;
    let failed: { err: unknown } | undefined;
    const worker = async () => {
        while (!failed && next < items.length) {
            const item = items[next++];
            try {
                await fn(item);
            } catch (err) {
                failed ??= { err };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (failed) throw failed.err;
}
