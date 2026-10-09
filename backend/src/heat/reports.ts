import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HeatReportData, HeatReportSummary } from '../../../shared/heat';
import { HeatMeterModel, HeatReportModel } from '../core/db';
import { hub } from '../core/hub';
import { logger } from '../core/logger';
import { reportRoot, resolveInside } from '../core/storage';
import { reportText } from './ocr';
import { parseReport } from './report';
import { addMeter, addReadings, today, updateMeter } from './service';

/*
 * Heating cost reports uploaded in the app: the PDF is kept, read on this server (ocr.ts,
 * report.ts) and shown to the person, who corrects what OCR got wrong and imports it: a
 * heat meter for each heat cost allocator (found again by its number), its reading at the
 * start and the end of the period, and the building's kWh per unit for the energy.
 */

const log = logger('heat');
const DAY_MS = 24 * 3600_000;

const summary = (r: HeatReportDoc): HeatReportSummary => ({
    _id: r._id,
    fileName: r.fileName,
    uploadedAt: r.uploadedAt,
    appliedAt: r.appliedAt,
    data: r.data,
    warnings: r.warnings ?? [],
});

export async function uploadReport(userID: string, fileName: string, pdf: Buffer) {
    const text = await reportText(pdf);
    const { data, warnings } = parseReport(text);
    const _id = randomUUID();
    const file = path.join(userID, `${_id}.pdf`);
    const full = resolveInside(reportRoot(), file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, pdf);
    const doc: HeatReportDoc = { _id, ownerID: userID, fileName: fileName.slice(0, 120), file, size: pdf.length, uploadedAt: Date.now(), data, warnings };
    await HeatReportModel.create(doc);
    log.info('report uploaded', { user: userID, company: data.company, devices: data.devices.length, warnings: warnings.length });
    return summary(doc);
}

export async function listReports(userID: string) {
    return (await HeatReportModel.find({ ownerID: userID }).sort({ uploadedAt: -1 }).lean()).map(summary);
}

export async function reportFile(userID: string, id: string) {
    const r = await HeatReportModel.findOne({ _id: id, ownerID: userID }, { file: 1, fileName: 1 }).lean();
    return r ? { path: resolveInside(reportRoot(), r.file), fileName: r.fileName } : undefined;
}

// the report and its PDF; the readings imported from it stay with their meters
export async function removeReport(userID: string, id: string) {
    const r = await HeatReportModel.findOneAndDelete({ _id: id, ownerID: userID }).lean();
    if (!r) return false;
    await rm(resolveInside(reportRoot(), r.file), { force: true });
    hub.emit('heatUpdate', userID);
    return true;
}

export interface ApplyDevice {
    serial: string;
    name: string;
    roomId: string | null;
    room?: string;
    date: string;
    old: number;
    new: number;
    use: number;
}

export class ReportError extends Error {}

/* Imports the checked values: each allocator becomes a heat meter (or is found by its number),
 * with its reading on the day before the period and on the day it was read. What one shown
 * unit counts for is the report's use over the readings' difference. */
export async function applyReport(userID: string, id: string, input: { from: string; devices: ApplyDevice[]; buildingKWh?: number; buildingUnits?: number }) {
    const report = await HeatReportModel.findOne({ _id: id, ownerID: userID }).lean();
    if (!report) return false;
    if (input.from > today()) throw new ReportError('The period starts in the future.');
    const start = new Date(Date.parse(`${input.from}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    const meters = await HeatMeterModel.find({ ownerID: userID }, { _id: 1, serial: 1 }).lean();

    const opening: { meterId: string; value: number }[] = [];
    const closing = new Map<string, { meterId: string; value: number }[]>();
    for (const d of input.devices) {
        const factor = d.new > d.old && d.use > 0 ? Math.round((d.use / (d.new - d.old)) * 1000) / 1000 : 1;
        let meterId = meters.find((m) => m.serial === d.serial)?._id;
        if (meterId) await updateMeter(userID, meterId, { factor, ...(d.roomId ? { roomId: d.roomId } : {}) });
        else meterId = await addMeter(userID, { name: d.name, kind: 'radiator', factor, roomId: d.roomId ?? undefined, serial: d.serial });
        opening.push({ meterId, value: d.old });
        if (!closing.has(d.date)) closing.set(d.date, []);
        closing.get(d.date)!.push({ meterId, value: d.new });
    }
    await addReadings(userID, start, opening, 'report');
    for (const [date, values] of closing) await addReadings(userID, date, values, 'report');

    const data: HeatReportData = {
        ...report.data,
        period: { from: input.from, to: [...closing.keys()].sort().pop() ?? report.data.period?.to ?? input.from },
        devices: input.devices.map(({ serial, room, date, old, new: n, use }) => ({ serial, room, date, old, new: n, use })),
        buildingKWh: input.buildingKWh,
        buildingUnits: input.buildingUnits,
    };
    await HeatReportModel.updateOne({ _id: id }, { $set: { data, appliedAt: Date.now() } });
    log.info('report imported', { user: userID, report: id, devices: input.devices.length });
    hub.emit('heatUpdate', userID);
    return true;
}
