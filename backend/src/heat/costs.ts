import type { HeatCostSettings, HeatCosts } from '../../../shared/heat';
import { HeatReportModel, User } from '../core/db';
import { hub } from '../core/hub';

/* The heating's costs (shared/heat.ts): the advance and other costs the person enters, the
 * price per unit and the base share from the latest imported report unless entered. */

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

export async function heatCosts(userID: string): Promise<HeatCosts> {
    const [user, report] = await Promise.all([User.findById(userID, { heatCosts: 1 }).lean(), latestReport(userID)]);
    const own = user?.heatCosts ?? {};
    return { settings: { baseCost: report?.baseCost, perUnit: report?.perUnit, ...own }, report };
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
