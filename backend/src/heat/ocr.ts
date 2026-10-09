import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../core/logger';

/*
 * The text of a scanned report, on this server: poppler's pdftoppm draws each page at 300 dpi,
 * Tesseract reads it (German where its language data is installed, see the Dockerfile).
 * Nothing leaves the server. One report at a time and Tesseract on one thread, so a long
 * scan does not starve the rest of the server.
 */

const log = logger('heat');
const run = promisify(execFile);

const MAX_PAGES = 30;
const PAGE_TIMEOUT_MS = 90_000;
const ENV = { ...process.env, OMP_THREAD_LIMIT: '1' };

export class OcrError extends Error {}

let languages: Promise<string> | undefined;
function language() {
    languages ??= run('tesseract', ['--list-langs'], { env: ENV })
        .then(({ stdout, stderr }) => {
            const have = new Set(`${stdout}\n${stderr}`.split('\n').map((l) => l.trim()));
            return ['deu', 'eng'].filter((l) => have.has(l)).join('+') || 'eng';
        })
        .catch(() => 'eng');
    return languages;
}

let queue: Promise<unknown> = Promise.resolve();

async function readIn(dir: string, pdf: Buffer) {
    await writeFile(path.join(dir, 'report.pdf'), pdf);
    try {
        await run('pdftoppm', ['-r', '300', '-gray', '-png', '-l', String(MAX_PAGES), 'report.pdf', 'page'], { cwd: dir, timeout: 120_000 });
    } catch (err) {
        throw new OcrError((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'pdftoppm is not installed on the server.' : 'The PDF could not be opened.');
    }
    const pages = (await readdir(dir)).filter((f) => /^page-\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)));
    const lang = await language();
    const started = Date.now();
    const texts: string[] = [];
    for (const page of pages) {
        try {
            const { stdout } = await run('tesseract', [page, '-', '--psm', '6', '-l', lang], {
                cwd: dir,
                env: ENV,
                timeout: PAGE_TIMEOUT_MS,
                maxBuffer: 4 * 1024 * 1024,
            });
            texts.push(stdout);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new OcrError('Tesseract is not installed on the server.');
            log.warn('page not read', { page }, err);
        }
    }
    log.info('report read', { pages: pages.length, lang, ms: Date.now() - started });
    return texts.join('\n\f\n');
}

// the pages are drawn in a folder of their own, removed after
async function read(pdf: Buffer) {
    const dir = await mkdtemp(path.join(tmpdir(), 'kibbl-report-'));
    return readIn(dir, pdf).finally(() => rm(dir, { recursive: true, force: true }));
}

// the text of all pages, one report after the other
export function reportText(pdf: Buffer): Promise<string> {
    const next = queue.then(() => read(pdf));
    queue = next.catch(() => undefined);
    return next;
}
