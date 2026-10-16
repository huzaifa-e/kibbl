import type { HeatCostSettings, HeatCosts, HeatStatement } from '../../../shared/heat';
import { HeatReportModel, User } from '../core/db';
import { hub } from '../core/hub';

/* The heating's costs (shared/heat.ts): what the person enters, else the advance and the other
 * costs from the latest uploaded statement, the price per unit and the base share from the
 * latest imported report. */

const round2 = (v: number) => Math.round(v * 100) / 100;

async function latestReport(userID: string): Promise<HeatCosts['report']> {
    const r = await HeatReportModel.findOne({ ownerID: userID, appliedAt: { $exists: true }, 'data.costs': { $exists: true } }, { data: 1 })
        .sort({ 'data.period.to': -1 })
        .lean();
    if (!r) return undefined;
    const d = r.data;
    const baseCost = d.costs !== undefined && d.costPerUnit && d.units !== undefined ? round2(d.costs - d.costPerUnit * d.units) : undefined;
    return { from: d.period?.from, to: d.period?.to, units: d.units, costs: d.costs, baseCost, perUnit: d.costPerUnit };
}

async function latestStatement(userID: string): Promise<HeatCosts['statement']> {
    const r = await HeatReportModel.findOne({ ownerID: userID, 'data.statement': { $exists: true } }, { 'data.statement': 1, fileName: 1 })
        .sort({ 'data.statement.period.to': -1, uploadedAt: -1 })
        .lean();
    return r?.data.statement ? { ...r.data.statement, reportId: r._id, fileName: r.fileName } : undefined;
}

// the settings a statement gives: its advance (and the one before it, from the month it changed) and its costs other than heating
export function fromStatement(s: HeatStatement): HeatCostSettings {
    const heating = s.items.filter((i) => i.heating).reduce((a, i) => a + i.share, 0);
    const out: HeatCostSettings = {};
    if (s.total !== undefined) out.otherCosts = round2(s.total - heating);
    if (s.advance !== undefined) out.advance = s.advance;
    else if (s.advancePaid !== undefined) out.advance = round2(s.advancePaid / 12);
    if (s.advance !== undefined && s.previousAdvance !== undefined && s.advanceFrom) {
        out.previousAdvance = s.previousAdvance;
        out.advanceSince = s.advanceFrom.slice(0, 7);
    }
    return out;
}

export async function heatCosts(userID: string): Promise<HeatCosts> {
    const [user, report, statement] = await Promise.all([User.findById(userID, { heatCosts: 1 }).lean(), latestReport(userID), latestStatement(userID)]);
    const own = user?.heatCosts ?? {};
    const defaults = { baseCost: report?.baseCost, perUnit: report?.perUnit, ...(statement ? fromStatement(statement) : {}) };
    return { settings: { ...defaults, ...own }, report, statement };
}

// a field null drops it (back to the report's)
export async function setHeatCosts(userID: string, fields: Partial<Record<keyof HeatCostSettings, number | string | null>>) {
    const $set: Record<string, unknown> = {};
    const $unset: Record<string, 1> = {};
    for (const [k, v] of Object.entries(fields)) {
        if (v === null) $unset[`heatCosts.${k}`] = 1;
        else $set[`heatCosts.${k}`] = v;
    }
    await User.updateOne({ _id: userID }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) });
    hub.emit('heatUpdate', userID);
    return heatCosts(userID);
}
