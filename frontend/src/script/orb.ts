import { MODE_DRAWS, resolvePreset, type OrbSize, type OrbState } from 'thinking-orbs/engine';
import { escapeHtml, isDarkMode } from './utils';

/*
 * Thinking orbs (github.com/Jakubantalik/thinking-orbs, MIT): dotted animated orbs for
 * "something is under way". The package's React component, done without React on its
 * engine: any <canvas data-orb="state"> that appears in the page starts by itself, so
 * orbHtml() works in every innerHTML. One clock and one animation frame loop for all of
 * them; an orb that is scrolled away, in a hidden tab or removed from the page costs
 * nothing. Reduced motion shows a still frame. The ink follows kibbl's theme.
 */

const LABELS: Record<OrbState, string> = {
    working: 'Working',
    searching: 'Searching',
    solving: 'Solving',
    listening: 'Listening',
    connecting: 'Connecting',
    weaving: 'Weaving',
    composing: 'Composing',
    breathing: 'Thinking',
    shaping: 'Shaping',
};

const isState = (s: string | undefined): s is OrbState => !!s && s in LABELS;

export function orbHtml(state: OrbState = 'working', size: OrbSize = 64, label?: string, className = '') {
    return `<canvas data-orb="${state}" data-orb-size="${size}" class="thinking-orb ${escapeHtml(className)}" role="img" aria-label="${escapeHtml(label ?? LABELS[state])}" width="${size}" height="${size}" style="width:${size}px;height:${size}px"></canvas>`;
}

interface Orb {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    size: OrbSize;
    dpr: number;
    draw: (typeof MODE_DRAWS)[keyof typeof MODE_DRAWS];
    opts: ReturnType<typeof resolvePreset>['opts'];
    speed: number;
    visible: boolean;
}

const orbs = new Map<HTMLCanvasElement, Orb>();
let frame = 0;
const reducedMotion = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

function paint(orb: Orb, seconds: number) {
    const { ctx, size, dpr } = orb;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    orb.draw(ctx, size, seconds * orb.speed, isDarkMode(), orb.opts);
}

const still = (orb: Orb) => paint(orb, 0.6 / orb.speed); // the package's representative frame

function tick() {
    frame = 0;
    const seconds = performance.now() / 1000;
    let animating = false;
    for (const [canvas, orb] of orbs) {
        if (!canvas.isConnected) {
            forget(canvas);
            continue;
        }
        if (!orb.visible) continue;
        paint(orb, seconds);
        animating = true;
    }
    if (animating) schedule();
}

function schedule() {
    if (!frame && !document.hidden && !reducedMotion?.matches) frame = requestAnimationFrame(tick);
}

const seen =
    typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
              for (const e of entries) {
                  const orb = orbs.get(e.target as HTMLCanvasElement);
                  if (orb) orb.visible = e.isIntersecting;
              }
              schedule();
          })
        : null;

function forget(canvas: HTMLCanvasElement) {
    orbs.delete(canvas);
    seen?.unobserve(canvas);
}

function mount(canvas: HTMLCanvasElement) {
    if (orbs.has(canvas)) return;
    const state = canvas.dataset.orb;
    const ctx = canvas.getContext('2d');
    if (!isState(state) || !ctx) return;
    const size: OrbSize = canvas.dataset.orbSize === '20' ? 20 : 64;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const { mode, speed, opts } = resolvePreset(state, size);
    const orb: Orb = { canvas, ctx, size, dpr, draw: MODE_DRAWS[mode], opts, speed, visible: !seen };
    orbs.set(canvas, orb);
    still(orb); // something to see before the first frame, and all there is with reduced motion
    seen?.observe(canvas);
    schedule();
}

function mountWithin(root: ParentNode) {
    if (root instanceof HTMLCanvasElement && root.dataset.orb) mount(root);
    root.querySelectorAll<HTMLCanvasElement>('canvas[data-orb]').forEach(mount);
}

// orbs put into the page later (innerHTML of a card, a modal) start by themselves
new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && mountWithin(n));
}).observe(document.documentElement, { childList: true, subtree: true });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountWithin(document));
else mountWithin(document);

// a theme switch or reduced motion changing: the frames shown are drawn again
const redrawStill = () => orbs.forEach((orb) => orb.canvas.isConnected && still(orb));
window.addEventListener('themechange', redrawStill);
reducedMotion?.addEventListener('change', () => (reducedMotion.matches ? redrawStill() : schedule()));
document.addEventListener('visibilitychange', schedule);
