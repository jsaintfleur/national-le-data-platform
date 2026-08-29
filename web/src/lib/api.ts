/**
 * Typed client for the analytical API.
 *
 * The frontend never computes a headline metric and never decides whether a rate may be
 * shown. Those answers arrive from the server already made, on fields like `rate_allowed`
 * and `rate_withheld_reason`, because the policy engine that produces them is tested and a
 * component is not.
 */

const BASE = (import.meta as any).env?.VITE_API_BASE ?? '';

/** A self-contained build has no server; every call resolves from an embedded dataset. */
export const IS_STATIC = (import.meta as any).env?.VITE_STATIC === '1';

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

const cache = new Map<string, Promise<unknown>>();

export async function get<T>(path: string, opts: { fresh?: boolean } = {}): Promise<T> {
  const url = `${BASE}${path}`;
  if (!opts.fresh && cache.has(url)) return cache.get(url) as Promise<T>;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? body.error ?? detail;
      } catch {
        /* response was not JSON; the status text stands */
      }
      throw new ApiError(String(detail), res.status, url);
    }
    return res.json();
  })();
  if (!opts.fresh) cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p as Promise<T>;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

/* ---------------------------------------------------------------- shared shapes ------ */

export type CoverageStatus = 'COMPLETE' | 'PARTIAL' | 'NONE' | 'UNKNOWN';
export type Confidence = 'HIGH' | 'MODERATE' | 'LIMITED' | 'NOT_COMPARABLE';
export type GeoStatus = 'accepted' | 'needs_review' | 'unmatched';

export interface AgencyYear {
  agency_id: string;
  agency_name: string;
  agency_type: string;
  state_abbr: string | null;
  geo_id: string | null;
  geo_name: string | null;
  geo_level: string | null;
  geo_review_status: GeoStatus | null;
  urbanicity_band: string | null;
  data_year: number;
  population: number | null;
  population_geography_total: number | null;
  denominator_type: string | null;
  denominator_value: number | null;
  denominator_year: number | null;
  denominator_source: string | null;
  denominator_confidence: Confidence | null;
  denominator_notes: string | null;
  denominator_basis: string | null;
  sworn_officers: number | null;
  civilian_personnel: number | null;
  total_personnel: number | null;
  civilian_share: number | null;
  officers_per_1k: number | null;
  violent_crime_offenses: number | null;
  violent_crime_clearances: number | null;
  violent_crime_rate: number | null;
  property_crime_offenses: number | null;
  property_crime_rate: number | null;
  months_reported: number | null;
  coverage_status: CoverageStatus | null;
  rate_allowed: boolean;
  rate_withheld_reason: string | null;
  methodology_warning: string | null;
  implausible_rate_flag?: boolean;
  population_band: string | null;
  participated?: boolean | null;
  pe_reported?: boolean | null;
}

export interface Release {
  release_id: string;
  built_at: string | null;
  git_commit: string | null;
  latest_years: Record<string, number | null>;
  crime_completeness_cutoff: number;
  vintages: Record<string, string | number>;
}

export interface SearchResult {
  type: 'agency' | 'state' | 'county' | 'place';
  agency_id?: string;
  agency_name?: string;
  agency_type?: string;
  state_abbr?: string;
  county_name?: string;
  ori7?: string;
  code?: string;
  name?: string;
  geo_id?: string;
  geoid?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  ambiguous_identifier: {
    identifier: string;
    kind: string;
    match_count: number;
    message: string;
  } | null;
  agencies_sharing_identifier: SearchResult[];
}

export interface HeadlineMetric {
  value: number | null;
  label: string;
  note: string;
  year?: number;
}

export interface Overview {
  release: { release_id: string; built_at: string; git_commit: string };
  years: { crime: number; staffing: number; completeness_cutoff: number };
  headline: Record<string, HeadlineMetric>;
  coverage: Record<string, number | null>;
  composition: { agency_type: string; agencies: number; sworn: number | null; civilian: number | null; share: number }[];
  trend: {
    data_year: number;
    full_year_reporters: number | null;
    partial_reporters: number | null;
    non_reporters: number | null;
    population_coverage: number | null;
    violent_offenses: number | null;
    sworn_officers: number | null;
    violent_crime_rate: number | null;
  }[];
  reconciliation: {
    available: boolean;
    year?: number;
    platform_total?: number;
    fbi_published?: number;
    source_file_total?: number;
    excluded?: Record<string, number>;
    headline_note: string;
    document?: string;
  };
}

export interface PeerResponse {
  agency_id: string;
  year: number;
  metric: string;
  subject: AgencyYear;
  cohort: {
    definition: string;
    agency_type: string;
    population_band: string | null;
    urbanicity_band: string | null;
    size: number;
    minimum_size: number;
    sufficient: boolean;
  };
  percentile: number | null;
  percentile_allowed: boolean;
  percentile_note: string;
  peer_median: number | null;
  peer_p25: number | null;
  peer_p75: number | null;
  state_median: number | null;
  national_median: number | null;
  peers: { agency_id: string; agency_name: string; state_abbr: string; population: number | null; value: number | null }[];
}

export interface MapResponse {
  metric: string;
  year: number;
  layer: 'agency' | 'state' | 'county';
  unit: string;
  legend: {
    min: number | null; max: number | null;
    p10: number | null; p25: number | null; p50: number | null; p75: number | null; p90: number | null;
    with_value: number; without_value: number;
  };
  features: any[];
  agencies_without_coordinates: number;
  no_data_note: string;
}

/* ---------------------------------------------------------------- endpoints ---------- */

const liveApi = {
  release: () => get<Release>('/api/release'),
  overview: (year?: number) => get<Overview>(`/api/overview${qs({ year })}`),
  metrics: () => get<any>('/api/metrics'),
  sources: () => get<any>('/api/sources'),
  search: (q: string) => get<SearchResponse>(`/api/search${qs({ q })}`, { fresh: false }),
  agencies: (params: Record<string, any>) => get<any>(`/api/agencies${qs(params)}`),
  agencyFacets: (year?: number) => get<any>(`/api/agencies/facets${qs({ year })}`),
  agency: (id: string) => get<any>(`/api/agencies/${encodeURIComponent(id)}`),
  agencyMetrics: (id: string) => get<{ agency_id: string; series: AgencyYear[]; provenance: any }>(
    `/api/agencies/${encodeURIComponent(id)}/metrics`),
  agencyCoverage: (id: string) => get<any>(`/api/agencies/${encodeURIComponent(id)}/coverage`),
  agencyPeers: (id: string, year: number, metric: string) =>
    get<PeerResponse>(`/api/agencies/${encodeURIComponent(id)}/peers${qs({ year, metric })}`),
  states: (year?: number) => get<any>(`/api/states${qs({ year })}`),
  state: (code: string, year?: number) => get<any>(`/api/states/${encodeURIComponent(code)}${qs({ year })}`),
  compare: (ids: string[], year?: number) => get<any>(`/api/compare${qs({ agencies: ids.join(','), year })}`),
  map: (params: Record<string, any>) => get<MapResponse>(`/api/map${qs(params)}`),
  quality: (year?: number) => get<any>(`/api/quality${qs({ year })}`),
  qualityCoverage: (year: number, params: Record<string, any> = {}) =>
    get<any>(`/api/quality/coverage/${year}${qs(params)}`),
  qualityFlag: (checkId: string) => get<any>(`/api/quality/flags/${encodeURIComponent(checkId)}`),
};


// In a static build every method is replaced by the adapter in api.static.ts. The interface
// is identical, so no route knows the difference.
export const api: typeof liveApi = IS_STATIC
  ? (await import('./api.static')).staticApi as unknown as typeof liveApi
  : liveApi;
