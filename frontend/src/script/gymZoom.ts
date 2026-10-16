import { MUSCLES, type Muscle } from '../../../shared/gym';
import type { Region, View } from './gymBody';
import { esc, openLayer } from './gymCommon';

/* A drawing of the muscles full screen: front or back, the upper or lower body or all of it,
 * zoomed with two fingers, the wheel, a double tap or the buttons, moved by dragging. A muscle
 * tapped says its name. */

export interface ZoomSource {
    title: string;
    render: (view: View, region: Region) => string;
    view: View;
    region: Region;
    legend?: string; // under the drawing
}

const MIN = 1;
const MAX = 6;

export function openZoom(src: ZoomSource) {
    let view = src.view;
    let region = src.region;
    let scale = 1;
    let tx = 0;
    let ty = 0;

    const root = document.createElement('div');
    root.className = 'gym-zoom';
    root.innerHTML = `<div class="gym-zoom-head">
            <button class="btn btn-icon btn-ghost-secondary" data-z="back" aria-label="Back"><i class="ti ti-arrow-left"></i></button>
            <div class="fw-bold text-truncate flex-fill">${esc(src.title)}</div>
        </div>
        <div class="gym-zoom-bar">
            <div class="btn-group btn-group-sm" role="group" data-group="view">
                <button class="btn" data-view="front">Front</button><button class="btn" data-view="back">Back</button>
            </div>
            <div class="btn-group btn-group-sm" role="group" data-group="region">
                <button class="btn" data-region="upper">Upper</button><button class="btn" data-region="lower">Lower</button><button class="btn" data-region="full">Whole</button>
            </div>
        </div>
        <div class="gym-zoom-stage gym-plate"><div class="gym-zoom-inner"></div><div class="gym-zoom-name" hidden></div></div>
        <div class="gym-zoom-foot">
            <div class="small flex-fill">${src.legend ?? ''}</div>
            <div class="btn-group btn-group-sm">
                <button class="btn" data-z="out" aria-label="Zoom out"><i class="ti ti-zoom-out"></i></button>
                <button class="btn" data-z="reset" aria-label="Fit"><i class="ti ti-arrows-minimize"></i></button>
                <button class="btn" data-z="in" aria-label="Zoom in"><i class="ti ti-zoom-in"></i></button>
            </div>
        </div>`;
    document.body.appendChild(root);
    document.body.classList.add('gym-logging');
    const stage = root.querySelector<HTMLElement>('.gym-zoom-stage')!;
    const inner = root.querySelector<HTMLElement>('.gym-zoom-inner')!;
    const nameEl = root.querySelector<HTMLElement>('.gym-zoom-name')!;

    const apply = () => {
        // never moved off the stage
        const r = stage.getBoundingClientRect();
        const maxX = ((scale - 1) * r.width) / 2;
        const maxY = ((scale - 1) * r.height) / 2;
        tx = Math.max(-maxX, Math.min(maxX, tx));
        ty = Math.max(-maxY, Math.min(maxY, ty));
        inner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };
    const draw = () => {
        inner.innerHTML = src.render(view, region);
        root.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.view === view));
        root.querySelectorAll<HTMLElement>('[data-region]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.region === region));
        nameEl.hidden = true;
        apply();
    };
    // zoom about a point of the stage (its centre without one)
    const zoomTo = (next: number, cx?: number, cy?: number) => {
        const r = stage.getBoundingClientRect();
        const px = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2);
        const py = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
        const s = Math.max(MIN, Math.min(MAX, next));
        tx = px - ((px - tx) * s) / scale;
        ty = py - ((py - ty) * s) / scale;
        scale = s;
        if (scale === 1) tx = ty = 0;
        apply();
    };

    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        root.remove();
        if (!document.querySelector('.gym-logger')) document.body.classList.remove('gym-logging');
    };
    const closed = openLayer(close);

    root.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement;
        const z = t.closest<HTMLElement>('[data-z]')?.dataset.z;
        if (z === 'back') {
            close();
            closed();
        } else if (z === 'in') zoomTo(scale * 1.6);
        else if (z === 'out') zoomTo(scale / 1.6);
        else if (z === 'reset') zoomTo(1);
        const v = t.closest<HTMLElement>('[data-view]')?.dataset.view as View | undefined;
        if (v) {
            view = v;
            draw();
        }
        const g = t.closest<HTMLElement>('[data-region]')?.dataset.region as Region | undefined;
        if (g) {
            region = g;
            scale = 1;
            tx = ty = 0;
            draw();
        }
    });

    /* touch and mouse: one pointer drags, two pinch; a tap names the muscle, a double tap zooms */
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; scale: number } | null = null;
    let moved = false;
    let lastTap = 0;
    stage.addEventListener('pointerdown', (e) => {
        stage.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = false;
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale };
        }
    });
    stage.addEventListener('pointermove', (e) => {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2 && pinch) {
            const [a, b] = [...pointers.values()];
            zoomTo((pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        } else if (pointers.size === 1 && scale > 1) {
            tx += dx;
            ty += dy;
            apply();
        }
    });
    const up = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (moved || pointers.size) return;
        const now = Date.now();
        if (now - lastTap < 300) {
            zoomTo(scale > 1.2 ? 1 : 2.5, e.clientX, e.clientY);
            lastTap = 0;
            return;
        }
        lastTap = now;
        // the muscle under the finger
        const hit = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest('[data-muscle]');
        const m = hit?.getAttribute('data-muscle') as Muscle | null;
        nameEl.hidden = !m;
        if (m) nameEl.textContent = MUSCLES[m].label;
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
    stage.addEventListener(
        'wheel',
        (e) => {
            e.preventDefault();
            zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
        },
        { passive: false },
    );
    draw();
}
