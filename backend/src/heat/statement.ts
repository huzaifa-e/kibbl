import type { HeatStatement, HeatStatementItem } from '../../../shared/heat';
import { germanNumber } from './report';

/*
 * The landlord's statement of the running costs (Betriebs-/Nebenkostenabrechnung) from the
 * OCR text of an upload: the table of costs between its header (Abrechnungsposten) and its sum
 * (Summe gesamt), a line per cost with the building's total first and the home's share last,
 * then the advance paid, the balance, and from the letter the advance from now on. Pure, for
 * the tests.
 */

const DATE = String.raw`(\d{2})\.(\d{2})\.(\d{4})`;
const NUM = String.raw`\d(?:[\d.,]*\d)?`;
const iso = (m: RegExpExecArray, i: number) => `${m[i + 2]}-${m[i + 1]}-${m[i]}`;

// how a cost is shared, from the key as printed (OCR reads m² as "m?" or "m*")
function keyOf(raw: string) {
    if (/anlage/i.test(raw)) return 'heating report';
    if (/fl\w?che/i.test(raw)) return 'area';
    if (/pers/i.test(raw)) return 'persons';
    if (/wohnein/i.test(raw)) return 'flats';
    if (/einheit/i.test(raw)) return 'units';
    if (/verbrauch/i.test(raw)) return 'use';
    return undefined;
}

export function parseStatement(text: string): HeatStatement | undefined {
    const start = /Abrechnungsposten[^\n]*\n/i.exec(text);
    const end = /^\s*Summe\s+gesamt([^\n]*)/im.exec(text);
    if (!start || !end || end.index < start.index) return undefined;

    const items: HeatStatementItem[] = [];
    const line = new RegExp(String.raw`^\s*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß./\- ]*?)\s+(${NUM})\s+(.*?)\s*(${NUM})\s*$`);
    for (const row of text.slice(start.index + start[0].length, end.index).split('\n')) {
        const m = line.exec(row);
        if (!m) continue;
        const name = m[1].trim();
        items.push({
            name,
            total: germanNumber(m[2]),
            key: keyOf(m[3]),
            share: germanNumber(m[4]),
            ...(/heiz/i.test(name) ? { heating: true } : {}),
        });
    }
    if (!items.length) return undefined;

    const s: HeatStatement = { items };
    const period = new RegExp(String.raw`Abrechnungsperiode\s+${DATE}\s+bis\s+${DATE}`, 'i').exec(text);
    if (period) s.period = { from: iso(period, 1), to: iso(period, 4) };
    const sums = [...end[1].matchAll(new RegExp(NUM, 'g'))];
    if (sums.length) s.total = germanNumber(sums[sums.length - 1][0]);
    const paid = new RegExp(String.raw`Vorauszahlung[^\n]*?(${NUM})\s*$`, 'im').exec(text);
    if (paid) s.advancePaid = germanNumber(paid[1]);
    const balance = new RegExp(String.raw`(Nachzahlung|Guthaben)\s+per[^\n]*?(${NUM})\s*-?\s*$`, 'im').exec(text);
    if (balance) s.balance = germanNumber(balance[2]) * (/guthaben/i.test(balance[1]) ? -1 : 1);

    // the letter: "Vorausz. BK/NK/Hzg. | 200,00 € | bisher 150,00 €", "Vorauszahlung … ab 01.05.2026"
    const advance = new RegExp(String.raw`Vorausz[^\n]*?(${NUM})\s*€[^\n]*?bisher\s+(${NUM})`, 'i').exec(text);
    if (advance) {
        s.advance = germanNumber(advance[1]);
        s.previousAdvance = germanNumber(advance[2]);
    }
    const from = new RegExp(String.raw`Vorauszahlung[\s\S]{0,120}?ab\s+${DATE}`, 'i').exec(text);
    if (from) s.advanceFrom = iso(from, 1);
    return s;
}

// what does not add up, for the person to check against the PDF
export function statementWarnings(s: HeatStatement) {
    const w: string[] = [];
    const sum = Math.round(s.items.reduce((a, i) => a + i.share, 0) * 100) / 100;
    if (s.total !== undefined && Math.abs(sum - s.total) > 0.01)
        w.push(`The costs of the statement add up to ${sum.toFixed(2)} EUR, it says ${s.total.toFixed(2)}.`);
    if (s.total !== undefined && s.advancePaid !== undefined && s.balance !== undefined && Math.abs(s.total - s.advancePaid - s.balance) > 0.01)
        w.push("The statement's total, advance and balance do not add up.");
    return w;
}
