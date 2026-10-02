import { describe, expect, test } from 'vitest';
import { escapeHtml, formatDuration, signalQuality, timeAgo } from './utils';

describe('escapeHtml', () => {
    test('a device name cannot inject markup', () => {
        expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    });
    test('undefined is empty', () => {
        expect(escapeHtml(undefined)).toBe('');
    });
});

describe('timeAgo', () => {
    test('rounds to what a person says', () => {
        const now = Date.now();
        expect(timeAgo(now - 10_000)).toBe('just now');
        expect(timeAgo(now - 5 * 60_000)).toBe('5 min ago');
        expect(timeAgo(now - 3 * 3600_000)).toBe('3 h ago');
        expect(timeAgo(now - 26 * 3600_000)).toBe('yesterday');
    });
});

describe('formatDuration', () => {
    test('seconds, minutes, hours', () => {
        expect(formatDuration(0.2)).toBe('1 s');
        expect(formatDuration(75)).toBe('1 min 15 s');
        expect(formatDuration(3 * 3600 + 120)).toBe('3 h 2 min');
    });
});

describe('signalQuality', () => {
    test('rssi bands', () => {
        expect(signalQuality(-50).label).toBe('excellent');
        expect(signalQuality(-75).label).toBe('weak');
        expect(signalQuality(-90).label).toBe('poor');
        expect(signalQuality(undefined).label).toBe('unknown');
    });
});
