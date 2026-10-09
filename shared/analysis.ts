/*
 * Everything the home's data says in one place (backend/src/analysis): the findings of each
 * part of kibbl. (the heat, the air of each room, the heating, the meters, the devices,
 * health), each with how much it matters and where to look.
 */

export type FindingLevel = 'alert' | 'warn' | 'info' | 'good';
export type FindingSource = 'heat' | 'air' | 'heating' | 'meters' | 'devices' | 'health';

export interface Finding {
    level: FindingLevel;
    icon: string; // tabler icon
    title: string;
    text: string;
    link?: string; // the page that shows it
    device?: string; // the device it is about, by name
}

export interface AnalysisSection {
    source: FindingSource;
    title: string;
    findings: Finding[];
    error?: string; // this part could not be analysed now
}

export interface AnalysisReport {
    at: number;
    counts: Record<FindingLevel, number>;
    sections: AnalysisSection[];
}

export const LEVEL_ORDER: FindingLevel[] = ['alert', 'warn', 'info', 'good'];
