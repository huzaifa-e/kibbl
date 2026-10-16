import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancePaid, heatBudget } from '../../../shared/heat';

// the 2025 statement: 2.414,86 of which 619,15 heating (191,66 base, 0,098251 per unit)
const s = { advance: 200, previousAdvance: 150, advanceSince: '2026-05', otherCosts: 1795.71, baseCost: 191.66, perUnit: 0.098251 };

test('the advance of a year counts the months before the change at the previous one', () => {
    assert.equal(advancePaid(s, 2026), 4 * 150 + 8 * 200);
    assert.equal(advancePaid(s, 2027), 2400);
    assert.equal(advancePaid({ advance: 150 }, 2026), 1800);
    assert.equal(advancePaid({}, 2026), undefined);
});

test('what is left for use after the other costs and the base share, in units', () => {
    const b = heatBudget(s, 2027)!;
    assert.equal(Math.round(b.forUse * 100) / 100, 412.63);
    assert.equal(Math.round(b.units), 4200);
    assert.equal(heatBudget({ advance: 200 }, 2027), undefined);
});
