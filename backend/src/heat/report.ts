import { REPORT_ROOMS, type HeatReportData, type HeatReportDevice } from '../../../shared/heat';

/*
 * The values of a heating cost report (Techem's Heizkostenabrechnung and Verbrauchsanalyse)
 * from the text OCR read off its scan (ocr.ts). Pure, for the tests. OCR mixes up some
 * letters and separators ("Zz" for Z, "30,628,000"), so numbers and codes are read leniently,
 * and what does not add up is named in the warnings; the person checks it all before import.
 */

const DATE = String.raw`(\d{2})\.(\d{2})\.(\d{4})`;
const NUM = String.raw`\d(?:[\d.,]*\d)?`; // digits with separators; germanNumber reads them

const isoDate = (d: string, m: string, y: string) => `${y}-${m}-${d}`;

/* A German number as printed: the last separator is the decimal one unless it is a dot
 * before 3 digits, any other is for thousands ("1.147,000", OCR's "30,628,000"). */
export function germanNumber(s: string): number {
    const t = s.trim().replace(/\s/g, '');
    // a dot before exactly 3 digits is for thousands in German ("6.694 kWh")
    const m = /^(.*)[.,](\d+)$/.exec(t);
    if (m && t[m[1].length] === '.' && m[2].length === 3) return Number(t.replace(/[.,]/g, ''));
    const whole = (m ? m[1] : t).replace(/[.,]/g, '');
    return Number(m ? `${whole}.${m[2]}` : whole);
}

// a room code as printed, OCR's "Zz" or "Ww" for Z and W
function roomCode(raw: string | undefined) {
    if (!raw) return undefined;
    const up = raw.toUpperCase();
    if (REPORT_ROOMS[up]) return up;
    return REPORT_ROOMS[up[0]] ? up[0] : undefined;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function parseReport(text: string): { data: HeatReportData; warnings: string[] } {
    const warnings: string[] = [];
    const data: HeatReportData = { company: /techem/i.test(text) ? 'techem' : 'unknown', devices: [] };

    const period = new RegExp(String.raw`(?:Abrechnungszeitraum|Nutzungszeitraum)[\s\S]{0,120}?${DATE}\s*[-–]\s*${DATE}`, 'i').exec(text);
    if (period) data.period = { from: isoDate(period[1], period[2], period[3]), to: isoDate(period[4], period[5], period[6]) };

    const userNo = /Nutzer-?Nr\.?[\s\S]{0,60}?(\d{4}\/\d{4,6}\s*\d{4}\/\d-\d{1,3})/i.exec(text);
    if (userNo) data.userNo = userNo[1].replace(/\s+/g, ' ');

    // the readings: number, room code, date, reading old, reading new, use
    const line = new RegExp(String.raw`^\s*(\d{7,9})\s+([A-Za-z]{1,3}\b)?\s*${DATE}\s+(${NUM})\s+(${NUM})\s+[_—\-\s]*(${NUM})\s*$`, 'gm');
    const seen = new Set<string>();
    for (const m of text.matchAll(line)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const device: HeatReportDevice = {
            serial: m[1],
            room: roomCode(m[2]),
            date: isoDate(m[3], m[4], m[5]),
            old: germanNumber(m[6]),
            new: germanNumber(m[7]),
            use: germanNumber(m[8]),
        };
        if (device.new < device.old) warnings.push(`${device.serial}: the new reading is below the old one.`);
        data.devices.push(device);
    }

    const units = /Verbrauch\s*\(Einheiten\)\s*(\S+)/i.exec(text);
    if (units) data.units = germanNumber(units[1]);
    const sum = round3(data.devices.reduce((s, d) => s + d.use, 0));
    if (data.units !== undefined && data.devices.length && Math.abs(sum - data.units) > 0.01) {
        warnings.push(`The readings add up to ${sum} units, the report says ${data.units}.`);
    }

    // 70% Verbrauchskosten 2.503,64 : 25.482,000 Einheiten = 0,098251 x 4.351,000 = 427,49
    const usage = /Verbrauchskosten([^\n]*)/i.exec(text);
    if (usage) {
        const nums = [...usage[1].matchAll(new RegExp(NUM, 'g'))].map((n) => ({ raw: n[0], v: germanNumber(n[0]) }));
        const perUnit = nums.find((n) => /[.,]\d{5,6}$/.test(n.raw));
        if (perUnit) data.costPerUnit = perUnit.v;
        const building = nums.find((n) => /[.,]\d{3}$/.test(n.raw) && n.v > (data.units ?? 0) * 1.5);
        if (building) data.buildingUnits = building.v;
    }

    // the building's energy: the line "Verbrauch 30.628,000 2.748,74" under Brennstoff
    const energy = new RegExp(String.raw`^\s*Verbrauch\s+(${NUM})\s`, 'im').exec(text);
    if (energy) data.buildingKWh = germanNumber(energy[1]);

    const costs = new RegExp(String.raw`Ihre\s+Heizkosten\s+(${NUM})\s*(?:EUR|$)`, 'im').exec(text);
    if (costs) data.costs = germanNumber(costs[1]);

    const analysis = new RegExp(String.raw`^\s*Heizung\s+(${NUM})\s*kWh`, 'im').exec(text);
    if (analysis) data.analysisKWh = germanNumber(analysis[1]);
    // "Klimafaktor 1,28", or the sentence "… lag dieser bei 1,28" where OCR garbles the word
    const climate = /(?:Klima\w*\s+|lag\s+dieser\s+bei\s+)(\d[.,]\d{1,3})\b/i.exec(text);
    if (climate) data.climateFactor = germanNumber(climate[1]);

    if (!data.devices.length) warnings.push('No readings of heat cost allocators were found.');
    if (!data.period) warnings.push('The period of the report was not found.');
    if (!data.buildingKWh || !data.buildingUnits) warnings.push("The building's energy or units were not found: kWh per unit is unknown.");
    return { data, warnings };
}
