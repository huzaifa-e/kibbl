import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { findCat } from './catDetector';

const model = path.join(process.cwd(), 'models', 'yolox_s.onnx');

// the model is downloaded (Dockerfile, or by hand into backend/models): without it there is nothing to test
test('a plain picture has no cat', { skip: !fs.existsSync(model) && 'no detection model in backend/models' }, async () => {
    process.env.CAT_MODEL_PATH = model;
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 110, b: 100 } } })
        .jpeg()
        .toBuffer();
    assert.equal(await findCat(jpeg), null);
});
