/* The gym kept on the home screen: its page and the built files come from the cache when the
 * network is gone (a gym in a basement), the api never does. The page asks the network first,
 * so a new version shows as soon as it is reachable. */

const CACHE = 'kibbl-gym-v1';
const SHELL = ['/gym', '/manifest.webmanifest', '/img/icon-192.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((c) => c.addAll(SHELL))
            .catch(() => {}),
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/mcp') || url.pathname.startsWith('/socket.io')) return;

    // the gym's pages: the network, else the copy kept
    if (req.mode === 'navigate' && url.pathname.startsWith('/gym')) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    if (res.ok && !res.redirected) {
                        const copy = res.clone();
                        caches.open(CACHE).then((c) => c.put('/gym', copy));
                    }
                    return res;
                })
                .catch(() => caches.match('/gym').then((r) => r || Response.error())),
        );
        return;
    }

    // the built files carry their hash in the name: once fetched, they never change
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/img/')) {
        event.respondWith(
            caches.match(req).then(
                (hit) =>
                    hit ||
                    fetch(req).then((res) => {
                        if (res.ok) {
                            const copy = res.clone();
                            caches.open(CACHE).then((c) => c.put(req, copy));
                        }
                        return res;
                    }),
            ),
        );
    }
});
