import { feedOpeningAt, feedTimeline, type FeederTuning, type FeedTimeline } from '../../../shared/feeder';
import { FEEDER_MAX_MM, type DeviceTelemetry, type FeederState, type FeedLevel } from '../../../shared/protocol';
import { socket } from './socket';

/* The iris of a feeder, drawn: six blades around the hole at an opening, and the feeding
 * levels played on it with the timing of shared/feeder.ts, the real iris while it moves. The
 * cards are redrawn with every update, so the animation is not tied to an element: one loop
 * finds the irises on the page and sets each to where it is now, counted from a common clock. */

const R = 46; // the housing, in a viewBox of -50..50
const HOLE = 40; // the hole's inner radius fully open
const PAUSE_MS = 900; // closed between two plays of a feed

// the blades (with the hole cut out) and their seams at an opening
function irisPaths(mm: number) {
    const open = Math.min(Math.max(mm / FEEDER_MAX_MM, 0), 1);
    const r = Math.max(HOLE * open, 0.6);
    const turn = ((1 - open) * Math.PI) / 3; // the blades turn a sixth while closing
    const corner = r / Math.cos(Math.PI / 6);
    const v = [...Array(6).keys()].map((i) => {
        const a = turn + (i * Math.PI) / 3;
        return [corner * Math.cos(a), corner * Math.sin(a)];
    });
    const f = (n: number) => n.toFixed(2);
    const hole = `M${v.map((p) => `${f(p[0])},${f(p[1])}`).join('L')}Z`;
    // each edge of the hole goes on past its corner to the housing: the edge of a blade
    const seams = v
        .map((p, i) => {
            const q = v[(i + 5) % 6];
            const len = Math.hypot(p[0] - q[0], p[1] - q[1]);
            const d = [(p[0] - q[0]) / len, (p[1] - q[1]) / len];
            const b = p[0] * d[0] + p[1] * d[1];
            const t = -b + Math.sqrt(b * b - (corner * corner - R * R));
            return `M${f(p[0])},${f(p[1])}L${f(p[0] + t * d[0])},${f(p[1] + t * d[1])}`;
        })
        .join('');
    return { blades: `M${R},0A${R},${R} 0 1 0 ${-R},0A${R},${R} 0 1 0 ${R},0Z${hole}`, seams };
}

export function irisSvg(mm: number, size: number, attrs = '') {
    const p = irisPaths(mm);
    return `<svg class="feeder-iris" width="${size}" height="${size}" viewBox="-50 -50 100 100" aria-hidden="true" ${attrs}>
        <circle r="49" class="feeder-iris-housing" />
        <path d="${p.blades}" class="feeder-iris-blades" fill-rule="evenodd" />
        <path d="${p.seams}" class="feeder-iris-seams" />
    </svg>`;
}

export function setIris(svg: Element, mm: number) {
    const p = irisPaths(mm);
    svg.querySelector('.feeder-iris-blades')?.setAttribute('d', p.blades);
    svg.querySelector('.feeder-iris-seams')?.setAttribute('d', p.seams);
}

// the timelines by level and tuning: the loop asks for them every frame
const timelines = new Map<string, FeedTimeline>();

function timelineOf(el: HTMLElement) {
    const key = el.dataset.feedAnim ?? '';
    let t = timelines.get(key);
    if (!t) {
        const [portions, opening, openMs, speed, accel, closedPos] = key.split(',').map(Number);
        t = feedTimeline({ portions, opening, openMs }, { speed, accel, closedPos });
        timelines.set(key, t);
    }
    return t;
}

// the opening over the feed as a line, under the iris, with a playhead
function graphSvg(t: FeedTimeline) {
    const total = t.ms + PAUSE_MS;
    const points: string[] = [];
    for (let i = 0; i <= 160; i++) {
        const ms = (total * i) / 160;
        points.push(`${((100 * ms) / total).toFixed(1)},${(20 - (18 * feedOpeningAt(t, ms)) / FEEDER_MAX_MM).toFixed(1)}`);
    }
    return `<svg class="feeder-feed-graph" viewBox="0 0 100 21" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="0,21 ${points.join(' ')} 100,21" class="feeder-feed-area" />
        <line x1="0" x2="0" y1="0" y2="21" class="feeder-feed-head" />
    </svg>`;
}

// a feeding level, played: the iris, the opening over time, how long it is open. While the
// feeder runs this feed, it shows the real iris and where the feed is instead
export function feedLevelAnimHtml(deviceId: string, l: FeedLevel, tuning: FeederTuning) {
    const key = [l.portions, l.opening, l.openMs, tuning.speed ?? 0, tuning.accel ?? 0, tuning.closedPos ?? 0].join(',');
    const t = feedTimeline(l, tuning);
    timelines.set(key, t);
    const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    startLoop();
    return `<span class="feeder-feed" data-feed-anim="${key}" data-feed-device="${deviceId}">
        ${irisSvg(2, 44)}
        ${graphSvg(t)}
        <span class="small text-secondary">${l.portions > 1 ? `${l.portions} × ` : ''}open ${s(t.openMs / l.portions)} · ${s(t.ms)} in all</span>
    </span>`;
}

/* The real iris: the feeder reports where it is several times a second while it moves
 * (telemetry), and the drawing eases towards each report so it moves as smoothly as the blades. */
interface Live {
    target: number; // mm, the last report
    shown: number; // mm, drawn now
    busy: boolean;
    feed?: FeederState['feed'];
    elapsedMs: number; // of the job at the last report
    at: number; // when it came, performance.now()
}
const live = new Map<string, Live>();
const EASE_MS = 70;

function report(deviceId: string, f: FeederState) {
    const was = live.get(deviceId);
    live.set(deviceId, {
        target: f.opening,
        shown: was?.shown ?? f.opening,
        busy: f.busy,
        feed: f.busy ? f.feed : undefined,
        elapsedMs: f.elapsedMs ?? 0,
        at: performance.now(),
    });
}

// a card drawn from the device: its state, unless the reports are newer (a redraw for another reason)
export function followFeeder(deviceId: string, f: FeederState | undefined) {
    const was = live.get(deviceId);
    if (f && (!was || (!was.busy && !f.busy))) report(deviceId, f);
    startLoop();
}

// the slider dragged: the iris shows where it will go
export function previewIris(deviceId: string, mm: number) {
    const was = live.get(deviceId);
    if (was && !was.busy) was.target = mm;
}

socket.on('telemetry', (deviceId: string, t: DeviceTelemetry) => {
    if (t.feeder) report(deviceId, t.feeder);
});

let running = false;
let last = 0;

function startLoop() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
}

function frame(now: number) {
    const els = document.querySelectorAll<HTMLElement>('[data-feed-anim]');
    const irises = document.querySelectorAll<HTMLElement>('[data-feeder-iris]');
    if (!els.length && !irises.length) {
        running = false; // started again by the next card of a feeder
        return;
    }
    const ease = 1 - Math.exp(-(now - last) / EASE_MS);
    last = now;
    for (const l of live.values()) l.shown += (l.target - l.shown) * ease;
    for (const svg of irises) {
        const l = live.get(svg.dataset.feederIris ?? '');
        if (l) setIris(svg, l.shown);
    }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const el of els) {
        const t = timelineOf(el);
        const total = t.ms + PAUSE_MS;
        const l = live.get(el.dataset.feedDevice ?? '');
        const [portions, opening, openMs] = (el.dataset.feedAnim ?? '').split(',').map(Number);
        const mine = l?.feed && l.feed.portions === portions && l.feed.opening === opening && l.feed.openMs === openMs;
        let mm: number;
        let x: number;
        if (l?.busy && mine) {
            // this feed is running: the real iris, the playhead where the feed is
            mm = l.shown;
            x = (100 * Math.min(l.elapsedMs + now - l.at, t.ms)) / total;
        } else if (l?.busy) {
            // the iris is doing something else: the levels wait, closed
            mm = 2;
            x = -1;
        } else {
            // without motion: the iris at the level's opening, the graph without a playhead
            const ms = still ? t.segments[0].ms : now % total;
            mm = feedOpeningAt(t, ms);
            x = still ? -1 : (100 * ms) / total;
        }
        const svg = el.querySelector('.feeder-iris');
        if (svg) setIris(svg, mm);
        el.classList.toggle('feeder-feed-waiting', !!l?.busy && !mine);
        const head = el.querySelector('.feeder-feed-head');
        if (head) {
            head.setAttribute('x1', String(x));
            head.setAttribute('x2', String(x));
        }
    }
    requestAnimationFrame(frame);
}
