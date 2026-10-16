import type { View } from './gymBody';

/* A drawing that turns like a figure on a turntable: front, the right side, the back, the left
 * side (the right one mirrored). A swipe turns it with the finger and on past a quarter turn,
 * a tap turns it on; the change of view happens at the quarter turn, where the figure is edge
 * on, so it reads as one body turning in space. */

export const ANGLES = ['front', 'side', 'back', 'left'] as const;
export type Angle = (typeof ANGLES)[number];
export const viewOf = (a: Angle): View => (a === 'left' ? 'side' : a);
export const angleOf = (v: View): Angle => v;

const TURN_MS = 170;

export interface Turntable {
    angle(): Angle;
    set(a: Angle): void;
    turn(dir: 1 | -1): void;
    drag(dx: number): void; // the finger moved this far since it went down
    release(dx: number): void;
    redraw(): void;
}

/* `holder` gets a turning element with the drawing of `draw(angle)` in it. With `bind`, its
 * own pointer handling (taps and swipes on it); else the caller passes drag and release. */
export function turntable(holder: HTMLElement, draw: (a: Angle) => string, start: Angle, opts: { bind?: boolean; onChange?: (a: Angle) => void } = {}): Turntable {
    let index = Math.max(0, ANGLES.indexOf(start));
    let busy = false;
    holder.classList.add('gym-turn-holder');
    const el = document.createElement('div');
    el.className = 'gym-turn';
    holder.innerHTML = '';
    holder.appendChild(el);

    const paint = () => {
        el.innerHTML = draw(ANGLES[index]);
        el.classList.toggle('mirrored', ANGLES[index] === 'left');
    };
    const rotate = (deg: number, animated: boolean) => {
        el.style.transition = animated ? `transform ${TURN_MS}ms ease-in` : 'none';
        el.style.transform = `rotateY(${deg}deg)`;
    };
    const turn = (dir: 1 | -1, from = 0) => {
        if (busy) return;
        busy = true;
        rotate(from, false);
        requestAnimationFrame(() => {
            // to edge on, the next view, from edge on the other way back to facing
            rotate(-dir * 90, true);
            setTimeout(() => {
                index = (index + dir + ANGLES.length) % ANGLES.length;
                paint();
                rotate(dir * 90, false);
                void el.offsetWidth;
                el.style.transition = `transform ${TURN_MS}ms ease-out`;
                el.style.transform = 'rotateY(0deg)';
                setTimeout(() => {
                    busy = false;
                    opts.onChange?.(ANGLES[index]);
                }, TURN_MS);
            }, TURN_MS);
        });
    };
    const api: Turntable = {
        angle: () => ANGLES[index],
        set: (a) => {
            index = ANGLES.indexOf(a);
            paint();
            opts.onChange?.(a);
        },
        turn: (dir) => turn(dir),
        drag: (dx) => {
            if (!busy) rotate(Math.max(-85, Math.min(85, -dx / 2)), false);
        },
        release: (dx) => {
            if (busy) return;
            // swiping to the left turns the figure to its right, as a body turned by the hand
            if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1, Math.max(-85, Math.min(85, -dx / 2)));
            else rotate(0, true);
        },
        redraw: paint,
    };
    paint();

    if (opts.bind) {
        let down: { x: number; y: number } | null = null;
        let swiping = false;
        holder.addEventListener('pointerdown', (e) => {
            down = { x: e.clientX, y: e.clientY };
            swiping = false;
        });
        holder.addEventListener('pointermove', (e) => {
            if (!down) return;
            const dx = e.clientX - down.x;
            const dy = e.clientY - down.y;
            if (!swiping && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
                swiping = true;
                holder.setPointerCapture(e.pointerId);
            }
            if (swiping) api.drag(dx);
        });
        const up = (e: PointerEvent) => {
            if (!down) return;
            const dx = e.clientX - down.x;
            down = null;
            if (swiping) api.release(dx);
            else if (!(e.target as HTMLElement).closest('[data-turn-ignore]')) turn(1);
        };
        holder.addEventListener('pointerup', up);
        holder.addEventListener('pointercancel', () => {
            down = null;
            rotate(0, true);
        });
    }
    return api;
}

// the dots under a turning drawing: where it stands now
export const angleDots = (a: Angle) =>
    `<div class="gym-turn-dots" aria-hidden="true">${ANGLES.map((x) => `<span class="${x === a ? 'on' : ''}" title="${x === 'left' ? 'left side' : x === 'side' ? 'right side' : x}"></span>`).join('')}</div>`;
