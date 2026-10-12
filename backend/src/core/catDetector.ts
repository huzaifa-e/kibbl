import path from 'node:path';
import fs from 'node:fs';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { logger } from './logger';

/*
 * Is a cat in the picture: YOLOX-S (Megvii, Apache-2.0), an object detector trained on COCO,
 * whose class 15 is "cat", run on the server's CPU with ONNX Runtime (~100 ms a frame). Nothing
 * leaves the server. The model (yolox_s.onnx, 36 MB, release 0.1.1rc0) is downloaded by the
 * Dockerfile; CAT_MODEL_PATH points elsewhere. Without it detection is off and callers fall
 * back to plain motion.
 *
 * YOLOX as its ONNX demo runs it: the picture fitted into 640 x 640 at the top left, the rest
 * grey (114), BGR, 0-255, channels first. The output is one row per anchor of the strides 8,
 * 16 and 32 (x, y, w, h relative to the anchor's cell, objectness, 80 class scores, both
 * already through a sigmoid).
 */

const log = logger('detect');

const SIZE = 640;
const STRIDES = [8, 16, 32];
const CLASSES = 80;
const CAT = 15;
export const CAT_MIN_SCORE = 0.4;

export interface Detection {
    score: number; // objectness x the cat class, 0-1
    box: { x: number; y: number; w: number; h: number }; // in the picture's pixels
}

let session: Promise<ort.InferenceSession | undefined> | undefined;
let busy: Promise<unknown> = Promise.resolve(); // one inference at a time: the CPU is shared with everything else

function modelPath() {
    return process.env.CAT_MODEL_PATH || path.join(process.cwd(), 'models', 'yolox_s.onnx');
}

function load() {
    session ??= (async () => {
        const file = modelPath();
        if (!fs.existsSync(file)) {
            log.warn('no detection model: visits are any movement', { path: file });
            return undefined;
        }
        const s = await ort.InferenceSession.create(file, { intraOpNumThreads: 2, graphOptimizationLevel: 'all' });
        log.info('detection model loaded', { path: file });
        return s;
    })().catch((err) => {
        log.error('detection model not loaded', {}, err);
        return undefined;
    });
    return session;
}

export async function detectionAvailable() {
    return (await load()) !== undefined;
}

// the most likely cat in a jpeg, undefined when the model is missing
export async function findCat(jpeg: Buffer): Promise<Detection | null | undefined> {
    const s = await load();
    if (!s) return undefined;
    const run = busy.then(() => detect(s, jpeg));
    busy = run.catch(() => undefined);
    return run;
}

async function detect(s: ort.InferenceSession, jpeg: Buffer): Promise<Detection | null> {
    const meta = await sharp(jpeg).metadata();
    const w0 = meta.width ?? SIZE;
    const h0 = meta.height ?? SIZE;
    const r = Math.min(SIZE / w0, SIZE / h0);
    const w = Math.round(w0 * r);
    const h = Math.round(h0 * r);
    const rgb = await sharp(jpeg)
        .resize(w, h, { fit: 'fill' })
        .removeAlpha()
        .toColourspace('srgb')
        .extend({ right: SIZE - w, bottom: SIZE - h, background: { r: 114, g: 114, b: 114 } })
        .raw()
        .toBuffer();

    // HWC RGB -> CHW BGR
    const plane = SIZE * SIZE;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        input[i] = rgb[i * 3 + 2];
        input[plane + i] = rgb[i * 3 + 1];
        input[2 * plane + i] = rgb[i * 3];
    }
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    const data = out[s.outputNames[0]].data as Float32Array;
    const row = 5 + CLASSES;

    let best: Detection | null = null;
    let anchor = 0;
    for (const stride of STRIDES) {
        const cells = SIZE / stride;
        for (let gy = 0; gy < cells; gy++) {
            for (let gx = 0; gx < cells; gx++, anchor++) {
                const o = anchor * row;
                const score = data[o + 4] * data[o + 5 + CAT];
                if (score < CAT_MIN_SCORE / 2 || (best && score <= best.score)) continue;
                const cx = (data[o] + gx) * stride;
                const cy = (data[o + 1] + gy) * stride;
                const bw = Math.exp(data[o + 2]) * stride;
                const bh = Math.exp(data[o + 3]) * stride;
                best = { score, box: { x: (cx - bw / 2) / r, y: (cy - bh / 2) / r, w: bw / r, h: bh / r } };
            }
        }
    }
    return best;
}

// the picture with the cat's box drawn on it, for the e-mail
export async function markCat(jpeg: Buffer, cat: Detection): Promise<Buffer> {
    const meta = await sharp(jpeg).metadata();
    const W = meta.width ?? SIZE;
    const H = meta.height ?? SIZE;
    const x = Math.max(0, Math.round(cat.box.x));
    const y = Math.max(0, Math.round(cat.box.y));
    const w = Math.min(W - x, Math.round(cat.box.w));
    const h = Math.min(H - y, Math.round(cat.box.h));
    const label = `cat ${Math.round(cat.score * 100)} %`;
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#e0a526" stroke-width="4" rx="6"/>
        <rect x="${x}" y="${Math.max(0, y - 26)}" width="${label.length * 11 + 12}" height="26" fill="#e0a526" rx="4"/>
        <text x="${x + 6}" y="${Math.max(0, y - 26) + 19}" font-family="sans-serif" font-size="17" font-weight="bold" fill="#2a1a12">${label}</text>
    </svg>`;
    return sharp(jpeg)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 85 })
        .toBuffer();
}
