import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redirectAllowed } from './oauth';
import { escapeHtml } from './signin';

test('only configured redirect urls and loopback ones may register', () => {
    const configured = 'https://assistant.example/api/callback, https://other.example/cb';
    assert.equal(redirectAllowed('https://assistant.example/api/callback', configured), true);
    assert.equal(redirectAllowed('https://other.example/cb', configured), true);
    assert.equal(redirectAllowed('https://assistant.example/api/callback?x=1', configured), false);
    assert.equal(redirectAllowed('https://evil.example/cb', configured), false);
    assert.equal(redirectAllowed('http://localhost:53682/callback', ''), true);
    assert.equal(redirectAllowed('http://127.0.0.1:9/cb', ''), true);
    assert.equal(redirectAllowed('https://localhost.evil.example/cb', ''), false);
    assert.equal(redirectAllowed('not a url', ''), false);
});

test('the sign-in page escapes what a client sends', () => {
    assert.equal(escapeHtml('<b x="1">\'&'), '&lt;b x=&quot;1&quot;&gt;&#39;&amp;');
});
