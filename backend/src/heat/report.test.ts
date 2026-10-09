import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kWhPerUnit } from '../../../shared/heat';
import { germanNumber, parseReport } from './report';

// what OCR read off a Techem Heizkostenabrechnung and Verbrauchsanalyse (scan, 300 dpi), with its slips
const OCR = `Auftraggeber
teche m
Techem Nutzer-Nr. Lage
0104/01640 0004/0-17 3G
Abrechnungszeitraum ihre Heizkosten __ 619,15 EUR
01.01.2025 - 31.12.2025 ihr Anteil an den Gesamtkosten 619,15 EUR
Heizkosten 3.576,63
30% Grundkosten 1.072,99 : 258,650 v1? Nutzflacho -  4,148425 x 46,200 7 191,66
70% Verbrauchskosten 2.503,64: — 25.482,000 Finrciten = 0,098251 x  4.351,000 = 427 49
Ihre Heizkosten 619,15
Heizkostenverteiler
11275548 S 31.12.2025 0,000 1.147,000 1.147,000
11275550 Zz 31.12.2025 0,000 919,000 919,000
11275576 Z 31.12.2025 0,000 221,000 221,000
11272307 B 31.12.2025 0,000 427,000 427,000
11275588 Ww 31.12.2025 0,000 480,000 480,000
11275590 Z 31.12.2025 0,000 787,000 787,000
11275592 Z 31.12.2025 0,000 370,000 ____ 370,000
Verbrauch (Einheiten) 4.351,000
Brennstoff
Anlieferung Brennstoff 30,628,000 22.01.2026 2,930,55
Verbrauch 30.628,000 2.748,74
Heizung 6.694 kWh _* —* 8% weniger
boriicksichtigt. Flr die Abrechrurgsperiode 2025 lag dieser bei 1,28.`;

test('German numbers, also with the separators OCR mixes up', () => {
    assert.equal(germanNumber('1.147,000'), 1147);
    assert.equal(germanNumber('30,628,000'), 30628);
    assert.equal(germanNumber('0,098251'), 0.098251);
    assert.equal(germanNumber('619,15'), 619.15);
    assert.equal(germanNumber('6.694'), 6694);
});

test('a Techem report: the readings, the period and what a unit is worth', () => {
    const { data, warnings } = parseReport(OCR);
    assert.deepEqual(warnings, []);
    assert.equal(data.company, 'techem');
    assert.deepEqual(data.period, { from: '2025-01-01', to: '2025-12-31' });
    assert.equal(data.userNo, '0104/01640 0004/0-17');
    assert.equal(data.devices.length, 7);
    assert.deepEqual(data.devices[0], { serial: '11275548', room: 'S', date: '2025-12-31', old: 0, new: 1147, use: 1147 });
    assert.deepEqual(
        data.devices.map((d) => d.room),
        ['S', 'Z', 'Z', 'B', 'W', 'Z', 'Z'],
    );
    assert.equal(data.units, 4351);
    assert.equal(data.buildingUnits, 25482);
    assert.equal(data.buildingKWh, 30628);
    assert.equal(data.costs, 619.15);
    assert.equal(data.costPerUnit, 0.098251);
    assert.equal(data.analysisKWh, 6694);
    assert.equal(data.climateFactor, 1.28);
    assert.equal(Math.round(kWhPerUnit(data)! * 1000) / 1000, 1.202);
});

test('readings that do not add up are named', () => {
    const { warnings } = parseReport(OCR.replace('Verbrauch (Einheiten) 4.351,000', 'Verbrauch (Einheiten) 4.352,000'));
    assert.match(warnings[0], /add up to 4351 units, the report says 4352/);
});

test('a page without a report says so', () => {
    const { data, warnings } = parseReport('Kontoauszug 01.01.2025 bis 31.12.2025');
    assert.equal(data.devices.length, 0);
    assert.ok(warnings.some((w) => /No readings/.test(w)));
});
