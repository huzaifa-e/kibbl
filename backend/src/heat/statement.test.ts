import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromStatement } from './costs';
import { parseStatement, statementWarnings } from './statement';

// what OCR read off a Betriebs-/Nebenkostenabrechnung (letter and statement, scan, 300 dpi)
const OCR = `Aufgrund der Héhe der Nachzahlung und des Anstiegs der Allgemeinkosten passen wir die monatliche
Vorauszahlung zu den Betriebs-/Nebenkosten ab 01.05.2026 wie folgt an und bitten Sie, den bestehenden
Dauerauftrag fristgerecht zu 4ndern:
| Miete 365,00 € |
| Vorausz. BK/NK/Hzg. | 200,00 € | bisher 150,00 €
|Miete p.M.: |__ 565,00 € |
Ihre Abrechnungsperiode 01.01.2025 bis 31.12.2025
Gesamtkosten zu verteilen Verteiler-Schlussel thr Anteil
Abrechnungsposten flr 365 Tage Gesamt Anteilig
Abwasser Gewerbe 28,56 28,56 8,0000 0,0000 =m? Verbrauch 0,00
Abwasser Wohnungen 671,16 671,16 2190,0000 365,0000 Pers./Tg. Whg. 111,86
Allgemeinstrom 314,74 314,74 258,6500 46,2000 m*Flache gesamt 56,22
Gebaudeversicherung 2.842,44 2.842,44 258,6500 46,2000 m?Flache gesamt 507,72
Grundsteuer 2.810,72 2.810,72 258,6500 46,2000 m?Flache gesamt 502,05
Haftpflichtversicherung 56,41 56,41 4,0000 1,0000 — Einheiten 14,10
Hausflurreinigung 1.668,00 1.668,00 4,0000 1,0000 —_Ejiinheiten 417,00
Heizungskosten 3.576,63 3.576,63 siehe Anlage 619,15
Millabfuhr 277,00 277,00 1095,0000 0,0000 =Pers./Tg. Objekt 0,00
Niederschlagswasser 54,74 54,74 258,6500 46,2000 m?Flache gesamt 9,78
StraRenreinigung 138,00 138,00 258,6500 46,2000 m?Flache gesamt 24,65
Trinkwasser Gewerbe 22,40 22,40 8,0000 0,0000 =m? Verbrauch 0,00
Trinkwasser Wohnungen 646,81 646,81 2190,0000 365,0000 Pers./Tg. Whg. 107,80
Wartung Rauchwarnmelder 129,71 129,71 3,0000 1,0000 Wohneinheiten 43,24
Winterwartung Stadt Wesel 7,20 7,20 258,6500 46,2000 m?Flache gesamt 1,29
i
Summe gesamt 13.244,52 2.414,86
Ihr Anteil
Summe anteilige Betrage 1.576,05-
Summe Festbetrage 838,81-
Gesamtkosten 2.414,86-
Gesamt-Vorauszahlung aus 1.800,00 1.800,00
bezahlten Werten
614,86-
thre Nachzahlung per 31.12.2025 614,86 614,86
ee`;

test('the costs of a statement, its sums and the new advance', () => {
    const s = parseStatement(OCR)!;
    assert.equal(s.items.length, 15);
    assert.deepEqual(s.items[1], { name: 'Abwasser Wohnungen', total: 671.16, key: 'persons', share: 111.86 });
    assert.deepEqual(s.items[3], { name: 'Gebaudeversicherung', total: 2842.44, key: 'area', share: 507.72 });
    assert.deepEqual(s.items[7], { name: 'Heizungskosten', total: 3576.63, key: 'heating report', share: 619.15, heating: true });
    assert.equal(s.items[5].key, 'units');
    assert.equal(s.items[13].key, 'flats');
    assert.deepEqual(s.period, { from: '2025-01-01', to: '2025-12-31' });
    assert.equal(s.total, 2414.86);
    assert.equal(s.advancePaid, 1800);
    assert.equal(s.balance, 614.86);
    assert.equal(s.advance, 200);
    assert.equal(s.previousAdvance, 150);
    assert.equal(s.advanceFrom, '2026-05-01');
    assert.deepEqual(statementWarnings(s), []);
    assert.deepEqual(fromStatement(s), { otherCosts: 1795.71, advance: 200, previousAdvance: 150, advanceSince: '2026-05' });
});

test('no statement in a Techem report alone', () => {
    assert.equal(parseStatement('Heizkostenabrechnung 2025\nVerbrauch (Einheiten) 4.351,000'), undefined);
});
