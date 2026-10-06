import assert from 'node:assert/strict';
import { test } from 'node:test';
import chalk from 'chalk';
import { clean, formatFields, formatLine, formatTime } from './logger';

const plain = new chalk.Instance({ level: 0 });
const at = new Date(2026, 9, 6, 10, 42, 53, 39); // local time, as the server writes it

test('columns: time, level, scope, message, fields', () => {
    const line = formatLine('warn', 'device', 'silent, closing', { device: 'C82E1824CFA8', after: '35s' }, at, plain);
    assert.equal(line, '2026-10-06 10:42:53.039  WARN   device   silent, closing                          device=C82E1824CFA8 after=35s');
});

test('a message without fields has no padding at the end', () => {
    assert.equal(formatLine('info', 'db', 'connected to MongoDB', undefined, at, plain), '2026-10-06 10:42:53.039  INFO   db       connected to MongoDB');
});

test('levels and scopes line up whatever their length', () => {
    const a = formatLine('error', 'app', 'x', undefined, at, plain);
    const b = formatLine('info', 'motion', 'x', undefined, at, plain);
    assert.equal(a.indexOf(' x'), b.indexOf(' x'));
});

test('values with spaces, quotes or = are quoted, empty ones too', () => {
    assert.equal(formatFields({ name: 'Camera CFA8', q: 'a"b', eq: 'a=b', e: '', n: 3, ok: true }), 'name="Camera CFA8" q="a\\"b" eq="a=b" e="" n=3 ok=true');
});

test('undefined and null fields are left out', () => {
    assert.equal(formatFields({ a: undefined, b: null, c: 1 }), 'c=1');
});

test('a device cannot start a fake log line', () => {
    const line = formatLine('info', 'device', 'hello', { fw: 'X\n2026-10-06 00:00:00.000  INFO   auth     logged in' }, at, plain);
    assert.equal(line.split('\n').length, 1);
    assert.equal(clean('a\r\nb\u0007c'), 'a b c');
});

test('time is local, with milliseconds', () => {
    assert.equal(formatTime(new Date(2026, 0, 2, 3, 4, 5, 6)), '2026-01-02 03:04:05.006');
});
