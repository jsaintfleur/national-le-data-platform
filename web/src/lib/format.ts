/**
 * Number and label formatting.
 *
 * One rule governs everything here: a value that does not exist never renders as a number.
 * `fmt(null)` returns a dash, never "0", and the components that display it show a reason
 * beside the dash rather than leaving the reader to guess.
 */

export const AGENCY_TYPE_LABEL: Record<string, string> = {
  municipal_police: 'Municipal police',
  county_sheriff: "Sheriff's office",
  county_police: 'County police',
  state_police: 'State police',
  state_special_jurisdiction: 'State special jurisdiction',
  university_police: 'University police',
  tribal_police: 'Tribal police',
  transit_police: 'Transit police',
  port_or_airport_police: 'Port or airport police',
  park_or_conservation_police: 'Park or conservation police',
  marshal_or_constable: 'Marshal or constable',
  special_jurisdiction: 'Special jurisdiction',
  federal: 'Federal',
};

export const DENOMINATOR_LABEL: Record<string, string> = {
  municipal_population: 'Municipal population',
  county_population: 'County population',
  unincorporated_population: 'Unincorporated / primary jurisdiction estimate',
  contract_service_population: 'Contract service population',
  campus_population: 'Campus population',
  transit_population: 'Transit network',
  statewide_population: 'Statewide population',
  unknown: 'Not established',
  not_applicable: 'Not applicable',
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  HIGH: 'High',
  MODERATE: 'Moderate',
  LIMITED: 'Limited',
  NOT_COMPARABLE: 'Not comparable',
};

export const DASH = '—';

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1000)}K`;
  return fmt(n);
}

export function fmtRate(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  return fmt(Math.round(n));
}

export function fmtDecimal(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  return n.toFixed(digits);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtDelta(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function deltaClass(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'delta-flat';
  if (Math.abs(n) < 0.05) return 'delta-flat';
  return n > 0 ? 'delta-up' : 'delta-down';
}

export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function coverageLabel(months: number | null | undefined): string {
  if (months === null || months === undefined) return 'Not reported';
  return `${months} / 12 months`;
}

export function agencyTypeLabel(t: string | null | undefined): string {
  if (!t) return 'Unclassified';
  return AGENCY_TYPE_LABEL[t] ?? t.replace(/_/g, ' ');
}

export function denominatorLabel(t: string | null | undefined): string {
  if (!t) return 'Not established';
  return DENOMINATOR_LABEL[t] ?? t.replace(/_/g, ' ');
}

export function confidenceLabel(c: string | null | undefined): string {
  if (!c) return DASH;
  return CONFIDENCE_LABEL[c] ?? c;
}

export function confidenceChip(c: string | null | undefined): string {
  switch (c) {
    case 'HIGH': return 'chip chip-ok';
    case 'MODERATE': return 'chip chip-info';
    case 'LIMITED': return 'chip chip-warn';
    case 'NOT_COMPARABLE': return 'chip chip-outline';
    default: return 'chip';
  }
}

export function coverageChip(status: string | null | undefined): string {
  switch (status) {
    case 'COMPLETE': return 'chip chip-ok';
    case 'PARTIAL': return 'chip chip-warn';
    case 'NONE': return 'chip chip-crit';
    default: return 'chip chip-outline';
  }
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function freshness(latestYear: number | null | undefined, currentYear = new Date().getFullYear()) {
  if (!latestYear) return { label: 'Unknown', cls: 'chip chip-outline' };
  const age = currentYear - latestYear;
  if (age <= 1) return { label: 'Current', cls: 'chip chip-ok' };
  if (age === 2) return { label: '1 year old', cls: 'chip chip-info' };
  return { label: `${age - 1}+ years old`, cls: 'chip chip-warn' };
}
