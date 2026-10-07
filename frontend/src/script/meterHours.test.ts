import { describe, expect, it } from 'vitest';
import { hourlyConsumption } from './meterHours';

const at = (h: number, m: number) => new Date(2026, 9, 7, h, m).getTime();

describe('hourlyConsumption', () => {
    it('counts rises in the hours they happened', () => {
        const hours = hourlyConsumption(
            [
                { at: at(10, 0), value: 100 },
                { at: at(11, 0), value: 100.2 },
                { at: at(12, 0), value: 100.5 },
            ],
            3,
            at(12, 30),
        );
        expect(hours.map((h) => Math.round(h.consumption * 10) / 10)).toEqual([0.2, 0.3, 0]);
    });

    it('ignores a misread lower value and its return', () => {
        const hours = hourlyConsumption(
            [
                { at: at(10, 0), value: 56.7 },
                { at: at(11, 0), value: 54.8 },
                { at: at(12, 0), value: 56.7 },
                { at: at(13, 0), value: 57.0 },
            ],
            4,
            at(13, 10),
        );
        const sum = hours.reduce((s, h) => s + h.consumption, 0);
        expect(Math.round(sum * 10) / 10).toBe(0.3);
        expect(hours.every((h) => h.consumption >= 0)).toBe(true);
    });

    it('shares a step over the hours it spans', () => {
        const hours = hourlyConsumption(
            [
                { at: at(10, 30), value: 1 },
                { at: at(11, 30), value: 1.2 },
            ],
            2,
            at(11, 40),
        );
        expect(hours.map((h) => Math.round(h.consumption * 100) / 100)).toEqual([0.1, 0.1]);
    });
});
