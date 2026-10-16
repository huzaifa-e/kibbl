import { MUSCLES, type Muscle } from '../../../shared/gym';

/* The drawings of the gym, in the look of an anatomy chart: a light grey body, its muscles parted
 * by white gaps, the muscle an exercise trains in red with dark red fibres and white tendons, the
 * ones that help in a lighter red. A figure from the front and one from the back, male or female;
 * an exercise shows the area around its target, the progress page the whole body by how much
 * each muscle was trained.
 *
 * Shapes are drawn for one half only, x from the middle of the body outwards, y from the top of
 * the head (0) to the feet (472); the other half is the mirror. A female figure is the same
 * drawing with narrower shoulders, a narrower waist and wider hips (`warp`). */

type Pt = [number, number];
type View = 'front' | 'back';
export type Sex = 'male' | 'female';

const MID = 104; // where the middle of the body is drawn
/* the shapes are drawn wide for working on them; drawn at 0.8 of that width the body has a
 * person's proportions (shoulders about a quarter of the height, the hips a fifth) */
const XS = 0.8;

/* ----------------------------------------------------------------------- */
/* Smooth paths through points (Catmull-Rom as cubic Béziers)               */

const f = (v: number) => Math.round(v * 10) / 10;

function smooth(pts: Pt[], closed: boolean) {
    const n = pts.length;
    const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
        const p0 = at(i - 1);
        const p1 = at(i);
        const p2 = at(i + 1);
        const p3 = at(i + 2);
        const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
    }
    return closed ? d + 'Z' : d;
}

const bump = (v: number, at: number, width: number) => Math.exp(-(((v - at) / width) ** 2));

/* the female figure: shoulders and arms in by up to 6, the waist 9 % narrower, the hips and
 * thighs up to 9 % wider; the male one as drawn */
function warp(sex: Sex): (p: Pt) => Pt {
    if (sex === 'male') return (p) => p;
    return ([x, y]) => {
        const arm = y > 84 && y < 305 && x > 54 + (y - 84) * 0.04;
        const shoulder = arm ? -6 : x > 40 && y > 80 && y < 130 ? -6 * ((x - 40) / 20) * bump(y, 95, 25) : 0;
        const k = 1 - 0.09 * bump(y, 196, 26) + 0.09 * bump(y, 262, 34) + 0.03 * bump(y, 320, 30);
        return [arm ? x + shoulder - 2 * bump(y, 200, 40) : x * k + shoulder, y];
    };
}

/* ----------------------------------------------------------------------- */
/* The outline: from the top of the head down one side, round the arm and the leg, to the
 * crotch; with its mirror it closes. */

const OUTLINE: Pt[] = [
    [0, 0], [15, 4], [21, 20], [21, 38], [17, 52], [11, 61],
    [12, 74], [26, 84], [46, 89], [62, 93], [75, 100], [82, 116],
    [86, 144], [89, 174], [90, 198], [95, 224], [97, 250], [97, 266],
    [101, 276], [103, 290], [100, 306], [95, 316], [90, 316], [85, 306], [83, 290], [83, 270],
    [79, 242], [73, 214], [68, 197], [63, 172], [61, 150], [59, 134],
    [56, 150], [52, 176], [48, 198], [53, 222], [58, 246],
    [60, 268], [56, 302], [50, 334], [46, 352], [46, 370], [48, 392], [44, 420], [36, 445], [34, 456],
    [42, 466], [37, 472], [12, 472], [13, 461], [14, 448], [14, 428], [12, 400], [14, 376], [12, 352], [9, 328], [6, 298], [2, 266], [0, 260],
];

/* gaps that are not the edge of a muscle: the middle line, joints, the fingers */
const GAPS: Record<View, Pt[][]> = {
    front: [
        [[0, 92], [0, 254]],
        [[4, 93], [22, 90], [40, 90], [54, 93]], // collar bone
        [[82, 266], [90, 268], [98, 266]], // wrist
        [[88, 296], [88, 314]], // fingers
        [[92, 294], [93, 314]],
        [[96, 292], [97, 308]],
        [[84, 282], [86, 294]],
    ],
    back: [
        [[0, 62], [0, 256]],
        [[82, 266], [90, 268], [98, 266]],
        [[88, 296], [88, 314]],
        [[92, 294], [93, 314]],
        [[96, 292], [97, 308]],
    ],
};

/* ----------------------------------------------------------------------- */
/* The muscles. `muscle` null: drawn, never trained on its own (the sartorius, the shin).
 * `fibres` are drawn inside it, `tendons` are its white ends. */

type Shape = { muscle: Muscle | null; pts: Pt[]; fibres?: Pt[][]; tendons?: Pt[][] };

const FRONT: Shape[] = [
    { muscle: null, pts: [[3, 64], [10, 62], [17, 80], [11, 88], [5, 78]] }, // the neck
    { muscle: 'traps', pts: [[12, 72], [28, 82], [50, 89], [32, 91], [16, 86]] },
    {
        muscle: 'chest_upper',
        pts: [[3, 96], [28, 94], [54, 97], [61, 110], [63, 122], [40, 116], [20, 113], [3, 112]],
        fibres: [[[10, 104], [40, 108], [58, 116]]],
    },
    {
        muscle: 'chest_mid',
        pts: [[3, 114], [20, 115], [40, 118], [63, 124], [64, 129], [44, 132], [22, 134], [3, 133]],
        fibres: [[[8, 124], [36, 125], [60, 127]]],
    },
    {
        muscle: 'chest_lower',
        pts: [[3, 135], [22, 136], [44, 134], [64, 131], [57, 142], [41, 152], [21, 156], [4, 152]],
        fibres: [[[10, 146], [34, 144], [56, 136]]],
        tendons: [[[58, 124], [65, 122], [66, 132], [59, 134]]],
    },
    {
        muscle: 'delts_front',
        pts: [[52, 92], [62, 95], [67, 110], [70, 132], [71, 149], [63, 136], [57, 117], [53, 103]],
        fibres: [[[58, 100], [64, 120], [69, 142]]],
    },
    {
        muscle: 'delts_side',
        pts: [[64, 93], [75, 100], [81, 117], [80, 137], [74, 151], [71, 129], [68, 108]],
        fibres: [[[72, 102], [77, 122], [75, 144]]],
    },
    { muscle: null, pts: [[46, 136], [55, 142], [57, 150], [50, 150]] }, // serratus
    { muscle: null, pts: [[45, 152], [53, 152], [54, 162], [48, 163]] },
    {
        muscle: 'biceps',
        pts: [[66, 142], [74, 144], [80, 158], [82, 176], [79, 190], [73, 193], [68, 178], [65, 158]],
        fibres: [[[73, 150], [74, 172], [75, 188]]],
        tendons: [[[71, 188], [78, 188], [77, 200], [73, 200]], [[67, 140], [74, 140], [72, 148], [68, 148]]],
    },
    { muscle: null, pts: [[80, 166], [85, 170], [88, 194], [82, 196]] }, // brachialis
    {
        muscle: 'forearms',
        pts: [[83, 199], [90, 200], [95, 220], [96, 242], [94, 258], [91, 258], [89, 236], [86, 214]],
        tendons: [[[90, 250], [94, 250], [95, 264], [91, 264]]],
    },
    {
        muscle: 'forearms',
        pts: [[77, 204], [83, 203], [87, 222], [89, 244], [90, 262], [86, 262], [83, 240], [79, 220]],
        fibres: [[[82, 210], [86, 236]]],
        tendons: [[[84, 248], [89, 248], [89, 264], [85, 264]]],
    },
    {
        muscle: 'forearms',
        pts: [[71, 202], [77, 205], [81, 226], [84, 248], [84, 262], [81, 262], [77, 240], [73, 220]],
        tendons: [[[78, 246], [83, 246], [83, 263], [80, 263]]],
    },
    {
        muscle: 'abs',
        pts: [[2, 158], [19, 157], [24, 172], [24, 200], [22, 228], [14, 244], [2, 248]],
        fibres: [[[2, 177], [23, 176]], [[2, 198], [24, 197]], [[2, 220], [22, 219]]],
    },
    {
        muscle: 'obliques',
        pts: [[27, 161], [42, 154], [52, 160], [50, 180], [46, 198], [50, 218], [40, 234], [26, 237], [26, 200]],
        fibres: [[[30, 172], [46, 186]], [[30, 196], [46, 210]], [[30, 218], [42, 228]]],
    },
    { muscle: 'abductors', pts: [[51, 228], [57, 244], [59, 264], [54, 272], [49, 252]] },
    { muscle: 'adductors', pts: [[4, 264], [14, 258], [26, 263], [20, 287], [12, 306], [7, 296], [5, 280]], fibres: [[[8, 270], [16, 290]]] },
    { muscle: 'adductors', pts: [[3, 292], [8, 300], [11, 328], [12, 350], [8, 350], [5, 326]] },
    {
        muscle: 'quads',
        pts: [[44, 262], [54, 266], [58, 284], [56, 306], [50, 330], [43, 347], [38, 342], [42, 318], [45, 290]],
        fibres: [[[50, 276], [50, 306], [44, 334]]],
    },
    {
        muscle: 'quads',
        pts: [[30, 262], [39, 258], [44, 270], [44, 300], [40, 326], [35, 342], [29, 330], [27, 300], [27, 278]],
        fibres: [[[36, 266], [36, 300], [34, 330]]],
        tendons: [[[29, 336], [38, 336], [36, 350], [30, 350]]],
    },
    { muscle: 'quads', pts: [[16, 306], [24, 302], [30, 318], [33, 344], [24, 350], [15, 340], [13, 322]], fibres: [[[20, 314], [26, 336]]] },
    { muscle: null, pts: [[50, 243], [53, 248], [42, 260], [28, 278], [20, 304], [16, 330], [15, 354], [11, 353], [11, 330], [15, 302], [24, 275], [38, 255], [46, 244]] }, // sartorius
    { muscle: null, pts: [[24, 352], [33, 350], [38, 358], [32, 366], [25, 362]] }, // the knee cap
    { muscle: 'calves', pts: [[13, 374], [21, 368], [23, 396], [18, 422], [13, 404]] },
    { muscle: null, pts: [[26, 368], [36, 366], [38, 392], [34, 430], [30, 446], [27, 420], [25, 392]] }, // the shin
    { muscle: 'calves', pts: [[40, 372], [46, 384], [45, 412], [40, 428], [38, 400]] },
];

const BACK: Shape[] = [
    {
        muscle: 'upper_back',
        pts: [[20, 118], [34, 108], [50, 106], [58, 116], [56, 132], [42, 136], [26, 132]],
        fibres: [[[28, 124], [42, 118], [54, 122]]],
    },
    { muscle: 'upper_back', pts: [[44, 136], [56, 133], [62, 141], [57, 149], [46, 146]] },
    {
        muscle: 'lats',
        pts: [[22, 140], [40, 146], [55, 148], [61, 142], [57, 156], [53, 176], [47, 198], [30, 212], [10, 218], [6, 200], [15, 180], [19, 160]],
        fibres: [[[28, 158], [44, 172], [36, 200]], [[44, 154], [50, 176], [44, 196]]],
    },
    { muscle: 'lower_back', pts: [[2, 176], [10, 174], [16, 196], [18, 222], [14, 240], [4, 243], [2, 220]], fibres: [[[8, 182], [10, 236]]] },
    {
        muscle: 'traps',
        pts: [[1, 64], [12, 69], [17, 80], [36, 86], [56, 92], [40, 101], [25, 118], [13, 150], [5, 178], [1, 184]],
        fibres: [[[6, 80], [30, 92], [50, 94]], [[6, 120], [22, 112]], [[4, 150], [14, 136]]],
        tendons: [[[1, 102], [5, 112], [6, 122], [1, 132]]],
    },
    {
        muscle: 'delts_rear',
        pts: [[53, 94], [64, 97], [70, 112], [72, 134], [70, 150], [62, 133], [56, 113]],
        fibres: [[[58, 104], [65, 122], [69, 142]]],
    },
    { muscle: 'delts_side', pts: [[64, 93], [75, 100], [81, 117], [80, 137], [73, 150], [71, 128], [68, 108]], fibres: [[[72, 102], [77, 122], [75, 144]]] },
    {
        muscle: 'triceps',
        pts: [[63, 136], [70, 132], [74, 150], [75, 176], [72, 190], [66, 178], [64, 156]],
        fibres: [[[68, 142], [70, 176]]],
    },
    {
        muscle: 'triceps',
        pts: [[71, 130], [79, 136], [84, 158], [84, 184], [77, 190], [76, 168], [75, 148]],
        fibres: [[[79, 142], [80, 178]]],
        tendons: [[[68, 184], [80, 186], [79, 198], [71, 198]]],
    },
    { muscle: 'forearms', pts: [[83, 199], [90, 200], [95, 220], [96, 242], [94, 258], [91, 258], [89, 236], [86, 214]] },
    { muscle: 'forearms', pts: [[77, 204], [83, 203], [87, 222], [89, 244], [90, 262], [86, 262], [83, 240], [79, 220]], fibres: [[[82, 212], [86, 238]]] },
    { muscle: 'forearms', pts: [[71, 202], [77, 205], [81, 226], [84, 248], [84, 262], [81, 262], [77, 240], [73, 220]] },
    { muscle: 'abductors', pts: [[30, 228], [48, 221], [56, 232], [55, 250], [42, 245], [30, 240]], fibres: [[[36, 232], [52, 236]]] },
    {
        muscle: 'glutes',
        pts: [[2, 244], [20, 240], [42, 246], [55, 255], [57, 276], [47, 293], [27, 299], [9, 297], [2, 282]],
        fibres: [[[8, 254], [30, 270], [48, 288]], [[16, 248], [40, 262], [54, 276]]],
    },
    { muscle: 'adductors', pts: [[4, 292], [12, 300], [14, 322], [11, 340], [6, 322]] },
    {
        muscle: 'hamstrings',
        pts: [[31, 302], [46, 298], [50, 316], [46, 338], [40, 352], [33, 346], [31, 322]],
        fibres: [[[40, 306], [40, 342]]],
        tendons: [[[38, 344], [44, 344], [43, 358], [39, 358]]],
    },
    {
        muscle: 'hamstrings',
        pts: [[15, 302], [29, 302], [29, 324], [30, 346], [22, 352], [16, 344], [12, 322]],
        fibres: [[[22, 306], [22, 344]]],
        tendons: [[[16, 344], [23, 346], [22, 358], [17, 356]]],
    },
    {
        muscle: 'calves',
        pts: [[14, 372], [28, 364], [29, 390], [28, 414], [22, 418], [15, 402]],
        fibres: [[[21, 372], [22, 410]]],
    },
    {
        muscle: 'calves',
        pts: [[30, 364], [44, 372], [47, 392], [41, 412], [32, 418], [30, 392]],
        fibres: [[[38, 372], [38, 410]]],
    },
    { muscle: 'calves', pts: [[14, 404], [20, 416], [24, 426], [22, 440], [16, 430]] },
    { muscle: 'calves', pts: [[42, 410], [41, 426], [36, 442], [33, 428]] },
    { muscle: null, pts: [[24, 418], [33, 418], [32, 450], [26, 450]] }, // the heel's tendon
];

const SHAPES: Record<View, Shape[]> = { front: FRONT, back: BACK };

/* the view an exercise is shown in: where the muscle it trains first is seen best */
const SEEN_FROM: Record<Muscle, View> = {
    chest_upper: 'front', chest_mid: 'front', chest_lower: 'front', delts_front: 'front', delts_side: 'front', biceps: 'front', forearms: 'front',
    abs: 'front', obliques: 'front', quads: 'front', adductors: 'front',
    traps: 'back', lats: 'back', upper_back: 'back', lower_back: 'back', delts_rear: 'back', triceps: 'back', glutes: 'back', abductors: 'back',
    hamstrings: 'back', calves: 'back',
};

// the breast of the female figure, over the chest muscles
const BREAST: Pt[] = [[6, 118], [16, 140], [32, 152], [48, 148], [58, 132]];

/* ----------------------------------------------------------------------- */

export interface Shading {
    fill: (m: Muscle) => string | null; // a colour, or null for the grey of the body
    stroke?: (m: Muscle) => string | null;
}

/* One view as svg markup, cropped to viewBox `box` (the whole figure without). */
function figure(view: View, sex: Sex, shading: Shading, box: [number, number, number, number] | null, label: string) {
    const w = warp(sex);
    const right = (pts: Pt[]): Pt[] => pts.map((p) => w(p)).map(([x, y]) => [MID + x * XS, y]);
    const left = (pts: Pt[]): Pt[] => pts.map((p) => w(p)).map(([x, y]) => [MID - x * XS, y]);
    const outline = smooth([...right(OUTLINE), ...left(OUTLINE).reverse().slice(1)], true);
    const shapes: string[] = [];
    const over: string[] = []; // fibres and tendons, above every shape
    for (const side of [left, right]) {
        for (const s of SHAPES[view]) {
            const fill = s.muscle ? shading.fill(s.muscle) : null;
            const stroke = s.muscle && fill ? (shading.stroke?.(s.muscle) ?? null) : null;
            const title = s.muscle ? `<title>${MUSCLES[s.muscle].label}</title>` : '';
            shapes.push(
                `<path d="${smooth(side(s.pts), true)}" class="gb-m${fill ? ' gb-on' : ''}"${s.muscle ? ` data-muscle="${s.muscle}"` : ''}` +
                    `${fill ? ` style="fill:${fill}${stroke ? `;stroke:${stroke}` : ''}"` : ''}>${title}</path>`,
            );
            for (const l of s.fibres ?? []) over.push(`<path d="${smooth(side(l), false)}" class="${fill ? 'gb-fon' : 'gb-f'}"${stroke ? ` style="stroke:${stroke}"` : ''}/>`);
            for (const t of s.tendons ?? []) over.push(`<path d="${smooth(side(t), true)}" class="gb-t"/>`);
        }
        for (const l of GAPS[view]) over.push(`<path d="${smooth(side(l), false)}" class="gb-g"/>`);
        if (sex === 'female' && view === 'front') over.push(`<path d="${smooth(side(BREAST), false)}" class="gb-g gb-soft"/>`);
    }
    const [x, y, bw, bh] = box ?? REGIONS.full;
    return (
        `<svg class="gym-body" viewBox="${f(x)} ${f(y)} ${f(bw)} ${f(bh)}" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">` +
        `<path d="${outline}" class="gb-skin"/>` +
        `<g>${shapes.join('')}${over.join('')}</g>` +
        `<path d="${outline}" class="gb-line"/>` +
        `</svg>`
    );
}

export const RED = '#e2574c';
export const RED_DARK = '#a3241b';
export const RED_LIGHT = '#f0aaa3';

function viewFor(primary: Muscle[]): View {
    const votes = { front: 0, back: 0 };
    for (const m of primary) votes[SEEN_FROM[m]]++;
    return votes.back > votes.front ? 'back' : votes.front > votes.back ? 'front' : SEEN_FROM[primary[0]];
}

/* An exercise's drawing: the area around the muscles it trains, those in red, the helpers lighter. */
export type Region = 'upper' | 'lower' | 'full';
export type { View };

// the halves of the body: the head to the hips, the hips to the feet
const REGIONS: Record<Region, [number, number, number, number]> = {
    upper: [MID - 92, -8, 184, 274],
    lower: [MID - 92, 222, 184, 260],
    full: [MID - 90, -6, 180, 486],
};
const LOWER: Muscle[] = ['glutes', 'abductors', 'quads', 'adductors', 'hamstrings', 'calves'];

// where an exercise is seen best: the view and the half of the body of most of its targets
export function placeOf(primary: Muscle[]): { view: View; region: Region } {
    if (!primary.length) return { view: 'front', region: 'full' };
    const lower = primary.filter((m) => LOWER.includes(m)).length;
    return { view: viewFor(primary), region: lower * 2 > primary.length ? 'lower' : lower * 2 === primary.length ? 'full' : 'upper' };
}

const exerciseShading = (primary: Muscle[], secondary: Muscle[]): Shading => ({
    fill: (m) => (primary.includes(m) ? RED : secondary.includes(m) ? RED_LIGHT : null),
    stroke: (m) => (primary.includes(m) ? RED_DARK : secondary.includes(m) ? '#c9675e' : null),
});

/* An exercise's drawing: the half of the body its targets are in (the whole body when they are
 * in both), from where they are seen, the targets red, the helpers lighter. A view or a region
 * asked for (the zoomed drawing) is drawn as asked. */
export function exerciseFigure(primary: Muscle[], secondary: Muscle[], sex: Sex = 'male', label = '', at: { view?: View; region?: Region } = {}) {
    const place = placeOf(primary);
    const view = at.view ?? place.view;
    const region = at.region ?? place.region;
    return figure(view, sex, exerciseShading(primary, secondary), REGIONS[region], label);
}

/* The whole body from the front and the back, each muscle tinted by `level` (0 to 1, null: not trained). */
function levelShading(level: (m: Muscle) => number | null): Shading {
    const fill = (m: Muscle) => {
        const v = level(m);
        if (v === null || v <= 0) return null;
        const t = Math.min(1, v);
        // from the light red of a helper to the red of a target
        const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
        return `rgb(${mix(244, 226)}, ${mix(200, 87)}, ${mix(195, 76)})`;
    };
    return { fill, stroke: (m: Muscle) => ((level(m) ?? 0) >= 0.6 ? RED_DARK : '#c9675e') };
}

export function bodyMap(level: (m: Muscle) => number | null, sex: Sex = 'male') {
    const shading = levelShading(level);
    return { front: figure('front', sex, shading, null, 'Front'), back: figure('back', sex, shading, null, 'Back') };
}

// one view and half of a body map, for the zoomed drawing
export function bodyMapView(level: (m: Muscle) => number | null, sex: Sex, view: View, region: Region) {
    return figure(view, sex, levelShading(level), REGIONS[region], view === 'front' ? 'Front' : 'Back');
}

export const BODY_CSS = `
.gym-body{display:block;width:100%;height:auto}
.gym-body .gb-skin{fill:var(--gb-skin,#d6d7d9)}
.gym-body .gb-line{fill:none;stroke:var(--gb-edge,#c3c4c7);stroke-width:1.2;stroke-linejoin:round}
.gym-body .gb-m{fill:var(--gb-skin,#d6d7d9);stroke:var(--gb-gap,#fff);stroke-width:2.2;stroke-linejoin:round}
.gym-body .gb-on{stroke-width:1;paint-order:normal}
.gym-body .gb-f{fill:none;stroke:var(--gb-gap,#fff);stroke-width:1;stroke-linecap:round;opacity:.8}
.gym-body .gb-fon{fill:none;stroke:${RED_DARK};stroke-width:.8;stroke-linecap:round}
.gym-body .gb-t{fill:var(--gb-gap,#fff);stroke:none;opacity:.92}
.gym-body .gb-g{fill:none;stroke:var(--gb-gap,#fff);stroke-width:2;stroke-linecap:round}
.gym-body .gb-soft{stroke-width:1.4;opacity:.85}
.gym-body .gb-f,.gym-body .gb-fon,.gym-body .gb-t,.gym-body .gb-g,.gym-body .gb-line{pointer-events:none}
`;
