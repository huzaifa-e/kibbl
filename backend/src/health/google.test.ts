import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { GoogleHealth } from './google';

/* Google answered by a stub: each call gets the url, the answer is a Response */
const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

function stub(answer: (url: URL, call: number) => Response | Promise<Response>) {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL) => {
        const url = new URL(String(input));
        urls.push(url);
        return answer(url, urls.length);
    }) as typeof fetch;
    return urls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

// a client with a valid access token, no database involved
function client() {
    const gh = new GoogleHealth('user');
    (gh as unknown as { tokens: unknown }).tokens = { access_token: 'token', refresh_token: 'r', expires_in: 3600, obtained_at: Math.floor(Date.now() / 1000) };
    return gh;
}

const hr = (h: number, m: number, s: number, bpm: number) => ({
    dataSource: { recordingMethod: 'PASSIVE', platform: 'FITBIT', device: { displayName: 'Charge 6' } },
    heartRate: { beatsPerMinute: bpm, sampleTime: { civilTime: { time: { hours: h, minutes: m, seconds: s } }, utcOffset: '7200s' } },
});

test('pages are asked for at the largest size and handed over one by one', async () => {
    const urls = stub((url) =>
        url.searchParams.get('pageToken') === 'p2' ? json({ dataPoints: [{ n: 3 }] }) : json({ dataPoints: [{ n: 1 }, { n: 2 }], nextPageToken: 'p2' }),
    );
    const pages: number[][] = [];
    const res = await client().dataPointsPages('steps', 'interval', '2026-10-01', '2026-10-02', (points) => void pages.push(points.map((p) => p.n)));
    assert.deepEqual(res, { status: 200, pages: 2, complete: true });
    assert.deepEqual(pages, [[1, 2], [3]]);
    assert.equal(urls[0].searchParams.get('pageSize'), '10000');
    assert.match(urls[0].searchParams.get('filter') ?? '', /steps\.interval\.civil_start_time >= "2026-10-01"/);
});

test('a day of heart rate becomes sorted rows, with a partial response', async () => {
    const urls = stub((url) =>
        url.searchParams.get('pageToken')
            ? json({ dataPoints: [hr(0, 0, 5, 60)] })
            : json({ dataPoints: [hr(12, 0, 0, 90), hr(0, 1, 0, 62)], nextPageToken: 'next' }),
    );
    const { status, rows, meta } = await client().heartRateDay('2026-10-05');
    assert.equal(status, 200);
    assert.deepEqual(rows, [
        [5, 60],
        [60, 62],
        [43200, 90],
    ]);
    assert.equal(meta.device, 'Charge 6');
    assert.equal(meta.utc_offset, 'UTC+2');
    assert.match(urls[0].searchParams.get('fields') ?? '', /heartRate\(beatsPerMinute/);
});

test('a refused partial response is asked for again without one, and not used again', async () => {
    const urls = stub((url) => (url.searchParams.get('fields') ? json({ error: { code: 400 } }, 400) : json({ dataPoints: [hr(1, 0, 0, 70)] })));
    const gh = client();
    assert.deepEqual((await gh.heartRateDay('2026-10-05')).rows, [[3600, 70]]);
    assert.deepEqual((await gh.heartRateDay('2026-10-06')).rows, [[3600, 70]]);
    assert.deepEqual(
        urls.map((u) => u.searchParams.has('fields')),
        [true, false, false],
    );
});

test('a rate limit waits as long as Google asks, then goes on', async () => {
    const started = Date.now();
    stub((_url, call) => (call === 1 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : json({ ok: true })));
    const res = await client().get('/users/me/profile');
    assert.deepEqual(res, { status: 200, body: { ok: true } });
    assert.ok(Date.now() - started >= 950);
});

test('a server error or a dropped connection is tried again', async () => {
    stub((_url, call) => {
        if (call === 1) throw new TypeError('fetch failed');
        return call === 2 ? new Response('', { status: 502 }) : json({ ok: true });
    });
    const res = await client().get('/users/me/profile');
    assert.deepEqual(res, { status: 200, body: { ok: true } });
});

test('a 404 is an answer, not something to try again', async () => {
    const urls = stub(() => json({ error: 'not found' }, 404));
    const res = await client().get('/users/me/dataTypes/nothing/dataPoints');
    assert.equal(res.status, 404);
    assert.equal(urls.length, 1);
});
