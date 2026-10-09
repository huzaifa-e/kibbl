import { feedOpeningAt, feedTimeline, type FeederTuning, type FeedTimeline } from '../../../shared/feeder';
import { FEEDER_MAX_MM, type FeedLevel } from '../../../shared/protocol';

/* The iris of a feeder, drawn: six blades around the hole at an opening, and the feeding
 * levels played on it with the timing of shared/feeder.ts. The cards are redrawn with every
 * update, so the animation is not tied to an element: one loop finds the levels on the page
 * and sets each to where its feed is now, counted from a common clock. */

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

// a feeding level, played: the iris, the opening over time, how long it is open
export function feedLevelAnimHtml(l: FeedLevel, tuning: FeederTuning) {
    const key = [l.portions, l.opening, l.openMs, tuning.speed ?? 0, tuning.accel ?? 0, tuning.closedPos ?? 0].join(',');
    const t = feedTimeline(l, tuning);
    timelines.set(key, t);
    const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    startLoop();
    return `<span class="feeder-feed" data-feed-anim="${key}">
        ${irisSvg(2, 44)}
        ${graphSvg(t)}
        <span class="small text-secondary">${l.portions > 1 ? `${l.portions} × ` : ''}open ${s(t.openMs / l.portions)} · ${s(t.ms)} in all</span>
    </span>`;
}

let running = false;

function startLoop() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
}

function frame(now: number) {
    const els = document.querySelectorAll<HTMLElement>('[data-feed-anim]');
    if (!els.length) {
        running = false; // started again by the next card that has levels
        return;
    }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const el of els) {
        const t = timelineOf(el);
        const total = t.ms + PAUSE_MS;
        // without motion: the iris at the level's opening, the graph without a playhead
        const ms = still ? t.segments[0].ms : now % total;
        const svg = el.querySelector('.feeder-iris');
        if (svg) setIris(svg, feedOpeningAt(t, ms));
        const head = el.querySelector('.feeder-feed-head');
        if (head) {
            const x = still ? -1 : (100 * ms) / total;
            head.setAttribute('x1', String(x));
            head.setAttribute('x2', String(x));
        }
    }
    requestAnimationFrame(frame);
}
