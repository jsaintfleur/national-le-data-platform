/**
 * Static data adapter — the same `api` interface, served from an embedded bundle.
 *
 * This exists so the platform can ship as one self-contained page with no server. The
 * constraint that shaped it is the architecture's central rule: the policy engine decides
 * what may be published, and no client reconstructs a value it withheld.
 *
 * So this file adjudicates nothing. Every response with a bounded shape — the overview, the
 * quality register, all 51 state profiles, the registries, peer cohorts and percentiles —
 * was computed by the real API in `scripts/export_static_bundle.py` and is returned here
 * verbatim. Everything else is assembled from rows whose policy columns are already decided:
 * `rate_allowed`, `rate_withheld_reason`, `denominator_confidence` and `methodology_warning`
 * travel with each row, and this code's job is lookup, filtering, sorting and layout.
 *
 * The one exception is documented at `comparability()` below.
 *
 * The bundle is 30 MB of JSON, embedded gzipped and base64-encoded and inflated by the
 * browser's native DecompressionStream. That is what makes the whole national dataset fit in
 * a page rather than a sample of it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ColumnarColumn { n: string; d?: string[]; v: (number | string | boolean | null)[] }
interface ColumnarTable { count: number; columns: ColumnarColumn[] }

let BUNDLE: any = null;
const tableCache = new Map<string, any[]>();
const indexCache = new Map<string, Map<string, any[]>>();

/** Inflate and parse the embedded payload. Called once, before the app renders. */
export async function loadBundle(): Promise<void> {
  if (BUNDLE) return;
  const el = document.getElementById('nledp-data');
  if (!el?.textContent) throw new Error('Embedded dataset is missing from this page.');

  const b64 = el.textContent.trim();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  let json: string;
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new (window as any).DecompressionStream('gzip'));
    json = await new Response(stream).text();
  } else {
    throw new Error(
      'This browser cannot decompress the embedded dataset. It needs DecompressionStream — '
      + 'Chrome 80+, Edge 80+, Safari 16.4+ or Firefox 113+.',
    );
  }
  BUNDLE = JSON.parse(json);
  el.textContent = '';   // release the base64 string; the parsed bundle is what we keep
}

function table(name: string): any[] {
  const cached = tableCache.get(name);
  if (cached) return cached;
  const t: ColumnarTable = BUNDLE[name];
  if (!t) throw new Error(`missing table ${name} in bundle`);
  const rows: any[] = new Array(t.count);
  for (let i = 0; i < t.count; i++) rows[i] = {};
  for (const col of t.columns) {
    const { n, d, v } = col;
    if (d) {
      for (let i = 0; i < t.count; i++) {
        const idx = v[i] as number | null;
        rows[i][n] = idx === null || idx === undefined ? null : d[idx];
      }
    } else {
      for (let i = 0; i < t.count; i++) rows[i][n] = v[i];
    }
  }
  tableCache.set(name, rows);
  return rows;
}

function groupBy(name: string, key: string): Map<string, any[]> {
  const cacheKey = `${name}:${key}`;
  const cached = indexCache.get(cacheKey);
  if (cached) return cached;
  const map = new Map<string, any[]>();
  for (const row of table(name)) {
    const k = String(row[key]);
    const list = map.get(k);
    if (list) list.push(row); else map.set(k, [row]);
  }
  indexCache.set(cacheKey, map);
  return map;
}

const CRIME_YEAR = 2025;

/* ------------------------------------------------------------------ derivations ------ */
/* Arithmetic the exporter omitted to save space. Deriving a sum is not adjudicating a
   policy: none of these can turn a withheld value into a published one. */

function enrich(row: any): any {
  const sworn = row.sworn_officers;
  const civ = row.civilian_personnel;
  const total = sworn == null && civ == null ? null : (sworn ?? 0) + (civ ?? 0);
  return {
    ...row,
    total_personnel: total,
    civilian_share: total ? (civ ?? 0) / total : null,
    denominator_year: row.denominator_value == null ? null : row.data_year,
    denominator_source: row.denominator_type
      ? BUNDLE.denominator_sources?.[row.denominator_type] ?? null : null,
    denominator_notes: row.denominator_type
      ? BUNDLE.denominator_notes?.[row.denominator_type] ?? null : null,
  };
}

function agencyMeta(id: string) {
  return groupBy('agencies', 'agency_id').get(id)?.[0] ?? null;
}
function geoFor(id: string) {
  return groupBy('geography', 'agency_id').get(id)?.[0] ?? null;
}

/** An agency-year row joined to its geography, matching the API's analytics_agency_year. */
function yearRow(row: any): any {
  const meta = agencyMeta(row.agency_id);
  const geo = geoFor(row.agency_id);
  return enrich({
    ...row,
    agency_name: meta?.agency_name ?? null,
    agency_type: meta?.agency_type ?? null,
    state_abbr: meta?.state_abbr ?? null,
    geo_id: geo?.geo_id ?? null,
    geo_name: geo?.geo_name ?? null,
    geo_level: geo?.geo_level ?? null,
    geo_review_status: geo?.geo_review_status ?? null,
    urbanicity_band: geo?.urbanicity_band ?? null,
    rate_denominator_eligible: meta?.rate_denominator_eligible ?? null,
  });
}

function seriesFor(id: string): any[] {
  return (groupBy('series', 'agency_id').get(id) ?? [])
    .slice()
    .sort((a, b) => a.data_year - b.data_year)
    .map(yearRow);
}

function yearSlice(year: number): any[] {
  const key = `__year_${year}`;
  const cached = tableCache.get(key);
  if (cached) return cached;
  const rows = table('series').filter((r) => r.data_year === year).map(yearRow);
  tableCache.set(key, rows);
  return rows;
}

/* ------------------------------------------------------------------ comparability ---- */

/**
 * The one rule this file evaluates rather than looks up.
 *
 * A comparison is an arbitrary set of agencies, so its warnings cannot be precomputed. The
 * five predicates below are set comparisons over fields the policy engine already decided,
 * and every threshold and every sentence of message text comes from `BUNDLE.policy`, exported
 * from `nledp.policy`. Nothing here decides whether a value may be shown — only whether the
 * user is told that two shown values are not on a common basis.
 *
 * Failing to warn is a real harm in this product, so the alternative — dropping the engine in
 * the static build — was worse than porting five set comparisons.
 */
function comparability(agencies: any[], year: number) {
  const p = BUNDLE.policy;
  const msg = p.comparability_messages;
  const issues: { severity: string; code: string; message: string }[] = [];
  if (agencies.length < 2) return issues;

  const types = new Set(agencies.map((a) => a.agency_type).filter(Boolean));
  const dtypes = new Set(agencies.map((a) => a.denominator_type).filter(Boolean));
  const confidences = new Set(agencies.map((a) => a.denominator_confidence));
  const statewide = new Set<string>(p.overlapping_jurisdiction_types);
  const hasStatewide = [...types].some((t) => statewide.has(t));
  const hasLocal = [...types].some((t) => !statewide.has(t));
  const pretty = (s: string) => s.replace(/_/g, ' ');

  if (hasStatewide && hasLocal) {
    issues.push({ severity: 'warning', code: 'statewide_vs_local', message: msg.statewide_vs_local });
  }
  if (dtypes.size > 1) {
    issues.push({
      severity: 'warning', code: 'mixed_denominators',
      message: msg.mixed_denominators.replace('{types}', [...dtypes].map(pretty).sort().join(', ')),
    });
  }
  if (confidences.has('NOT_COMPARABLE')) {
    issues.push({ severity: 'warning', code: 'not_comparable_member', message: msg.not_comparable_member });
  }
  if (types.size > 1 && !hasStatewide) {
    issues.push({
      severity: 'warning', code: 'mixed_agency_types',
      message: msg.mixed_agency_types.replace('{types}', [...types].map(pretty).sort().join(', ')),
    });
  }
  const months = agencies.map((a) => a.months_reported).filter((m) => m != null) as number[];
  if (months.length && Math.min(...months) < p.required_months_for_rate) {
    issues.push({
      severity: 'warning', code: 'incomplete_coverage',
      message: msg.incomplete_coverage
        .replace('{months}', String(p.required_months_for_rate))
        .replace('{year}', String(year)),
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ endpoints -------- */

const SORTABLE: Record<string, string> = {
  agency_name: 'agency_name', state_abbr: 'state_abbr', population: 'population',
  sworn_officers: 'sworn_officers', officers_per_1k: 'officers_per_1k',
  violent_crime_rate: 'violent_crime_rate', months_reported: 'months_reported',
};

export const staticApi = {
  release: async () => BUNDLE.release,
  metrics: async () => BUNDLE.metrics,
  sources: async () => BUNDLE.sources,
  overview: async () => BUNDLE.overview,
  quality: async () => BUNDLE.quality,
  states: async () => BUNDLE.states_list,

  state: async (code: string) => {
    const s = BUNDLE.states[code.toUpperCase()];
    if (!s) throw new Error(`No data for state ${code.toUpperCase()}`);
    return s;
  },

  agencyFacets: async () => BUNDLE.facets,

  search: async (q: string) => {
    const term = q.trim();
    const upper = term.toUpperCase();
    const lower = term.toLowerCase();
    const all = table('agencies');

    const sharing = all.filter((a) => a.ori7 === upper);
    const ambiguous = sharing.length > 1 ? {
      identifier: upper, kind: 'ORI7', match_count: sharing.length,
      message: `${sharing.length} agencies share the ORI7 ${upper}. This identifier does not `
        + 'uniquely name an agency, so the platform will not choose one for you.',
    } : null;

    const hits = all
      .filter((a) => a.agency_name?.toLowerCase().includes(lower)
        || a.agency_id === upper || a.ori7 === upper)
      .sort((a, b) => {
        const rank = (x: any) => (x.agency_id === upper ? 0
          : x.agency_name?.toLowerCase() === lower ? 1 : 2);
        return rank(a) - rank(b) || (a.agency_name?.length ?? 0) - (b.agency_name?.length ?? 0);
      })
      .slice(0, 12)
      .map((a) => ({ type: 'agency', ...a }));

    const states = [...new Set(all.map((a) => a.state_abbr))]
      .filter((s) => s && s === upper)
      .map((s) => ({ type: 'state', code: s, name: s }));

    return {
      query: term,
      results: [...hits, ...states].slice(0, 12),
      ambiguous_identifier: ambiguous,
      agencies_sharing_identifier: ambiguous ? sharing : [],
    };
  },

  agencies: async (params: Record<string, any>) => {
    const year = Number(params.year ?? CRIME_YEAR);
    let rows = yearSlice(year);
    const q = params.q?.toLowerCase();
    if (q) rows = rows.filter((r) => r.agency_name?.toLowerCase().includes(q)
      || r.agency_id === String(params.q).toUpperCase());
    if (params.state) rows = rows.filter((r) => r.state_abbr === params.state);
    if (params.agency_type) rows = rows.filter((r) => r.agency_type === params.agency_type);
    if (params.coverage) rows = rows.filter((r) => r.coverage_status === params.coverage);
    if (params.geo_status) rows = rows.filter((r) => r.geo_review_status === params.geo_status);
    if (params.min_population != null) rows = rows.filter((r) => (r.population ?? -1) >= params.min_population);
    if (params.max_population != null) rows = rows.filter((r) => (r.population ?? Infinity) <= params.max_population);
    if (params.min_sworn != null) rows = rows.filter((r) => (r.sworn_officers ?? -1) >= params.min_sworn);
    if (params.max_sworn != null) rows = rows.filter((r) => (r.sworn_officers ?? Infinity) <= params.max_sworn);

    const key = SORTABLE[params.sort] ?? 'sworn_officers';
    const dir = params.direction === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = a[key]; const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;                    // nulls last, in both directions
      if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(String(bv));
      return dir * (av - bv);
    });

    const pageSize = Number(params.page_size ?? 50);
    const page = Number(params.page ?? 1);
    const start = (page - 1) * pageSize;
    return {
      year, total: rows.length, page, page_size: pageSize,
      pages: Math.max(1, Math.ceil(rows.length / pageSize)),
      results: rows.slice(start, start + pageSize),
    };
  },

  agency: async (id: string) => {
    const key = id.toUpperCase();
    const meta = agencyMeta(key);
    if (!meta) throw new Error(`No agency with id ${id}`);
    const geo = geoFor(key);
    const series = seriesFor(key);
    const latest = [...series].reverse()
      .find((r) => r.sworn_officers != null || r.violent_crime_offenses != null) ?? null;
    return {
      agency: { ...meta, jurisdiction_type: null, agency_status: null, source_id: null },
      geography_link: geo ? {
        geo_id: geo.geo_id, geo_name: geo.geo_name, target_id: geo.geo_id,
        target_name: geo.geo_name, match_method: geo.match_method,
        match_score: geo.match_score, review_status: geo.geo_review_status, notes: null,
      } : null,
      latest,
      history: (groupBy('agency_history', 'agency_id').get(key) ?? []),
      release: BUNDLE.release,
    };
  },

  agencyMetrics: async (id: string) => {
    const key = id.toUpperCase();
    const series = seriesFor(key);
    if (!series.length) throw new Error(`No observations for ${id}`);
    const prov = groupBy('provenance', 'agency_id').get(key) ?? [];
    const shape = (measure: string) => prov
      .filter((p) => p.measure === measure)
      .map((p) => ({ ...p, ...(BUNDLE.source_meta[p.source_id] ?? {}), data_year: p.last_year }));
    return {
      agency_id: key,
      series,
      provenance: { staffing: shape('staffing'), crime: shape('crime') },
    };
  },

  agencyCoverage: async (id: string) => {
    const key = id.toUpperCase();
    return {
      agency_id: key,
      years: seriesFor(key).map((r) => ({
        data_year: r.data_year, months_reported: r.months_reported,
        coverage_status: r.coverage_status, rate_allowed: r.rate_allowed,
        rate_withheld_reason: r.rate_withheld_reason, participated: r.participated,
        nibrs_participated: null, pe_reported: r.pe_reported,
        violent_crime_offenses: r.violent_crime_offenses, sworn_officers: r.sworn_officers,
      })),
      quality_flags: (groupBy('agency_flags', 'entity_id').get(key) ?? []),
    };
  },

  agencyPeers: async (id: string, year: number, metric: string) => {
    const key = id.toUpperCase();
    const subject = seriesFor(key).find((r) => r.data_year === year);
    if (!subject) throw new Error(`No ${year} observation for ${id}`);

    const member = table('peer_members').find(
      (m) => m.agency_id === key && m.data_year === year && m.metric === metric);
    const cohortKey = member?.cohort_key ?? null;
    const [ctype, band, urb] = (cohortKey ?? '||').split('|');
    const cohort = table('peer_cohorts').find(
      (c) => c.metric === metric && c.data_year === year && c.agency_type === ctype
        && c.population_band === band && (c.urbanicity_band ?? '') === urb);

    const stateMed = table('median_state').find(
      (m) => m.metric === metric && m.data_year === year && m.state_abbr === subject.state_abbr);
    const natMed = table('median_national').find(
      (m) => m.metric === metric && m.data_year === year);

    const size = cohort?.cohort_size ?? 0;
    const sufficient = size >= BUNDLE.policy.minimum_cohort_size;
    const parts = [
      subject.agency_type ? `${subject.agency_type.replace(/_/g, ' ')} agencies` : null,
      band ? `population served ${band}` : null,
      urb ? urb.toLowerCase() : null,
      `complete reporting in ${year}`,
    ].filter(Boolean);

    return {
      agency_id: key, year, metric, subject,
      cohort: {
        definition: parts.join('; '),
        agency_type: subject.agency_type, population_band: band || null,
        urbanicity_band: urb || null, size,
        minimum_size: BUNDLE.policy.minimum_cohort_size, sufficient,
      },
      percentile: sufficient ? member?.percentile ?? null : null,
      percentile_allowed: Boolean(sufficient && member
        && subject.denominator_confidence !== 'NOT_COMPARABLE'),
      percentile_note: 'A percentile is a position in a distribution, not a grade. It says '
        + 'where this agency sits among its peers, not whether that position is good.',
      peer_median: cohort?.peer_median ?? null,
      peer_p25: cohort?.peer_p25 ?? null,
      peer_p75: cohort?.peer_p75 ?? null,
      state_median: stateMed?.median ?? null,
      national_median: natMed?.median ?? null,
      peers: [],
    };
  },

  compare: async (ids: string[], year = CRIME_YEAR) => {
    const upper = ids.map((i) => i.toUpperCase());
    const snapshot = upper.map((i) => seriesFor(i).find((r) => r.data_year === year))
      .filter(Boolean) as any[];
    const present = new Set(snapshot.map((s) => s.agency_id));
    const missing = upper.filter((i) => !present.has(i)).map((i) => {
      const meta = agencyMeta(i);
      const series = seriesFor(i);
      return {
        agency_id: i, agency_name: meta?.agency_name ?? null,
        reason: meta ? 'No observation for this year' : 'No agency with this id',
        latest_year_available: series.length ? series[series.length - 1].data_year : null,
      };
    });
    return {
      year, agency_ids: upper, missing, snapshot,
      trends: upper.flatMap((i) => seriesFor(i)),
      comparability: comparability(snapshot, year),
    };
  },

  map: async (params: Record<string, any>) => {
    const year = Number(params.year ?? CRIME_YEAR);
    const metric = params.metric ?? 'violent_crime_rate';
    const layer = params.layer ?? 'state';
    let rows = yearSlice(year);
    if (params.state) rows = rows.filter((r) => r.state_abbr === params.state);
    if (params.agency_type) rows = rows.filter((r) => r.agency_type === params.agency_type);

    let features: any[];
    let withoutCoords = 0;
    if (layer === 'agency') {
      const withCoords = rows.filter((r) => {
        const m = agencyMeta(r.agency_id);
        return m?.latitude != null && m?.longitude != null;
      });
      withoutCoords = rows.length - withCoords.length;
      features = withCoords.map((r) => {
        const m = agencyMeta(r.agency_id);
        return { ...r, latitude: m.latitude, longitude: m.longitude, value: r[metric] ?? null };
      }).sort((a, b) => (b.sworn_officers ?? 0) - (a.sworn_officers ?? 0));
    } else if (layer === 'state') {
      const byState = new Map<string, any[]>();
      for (const r of rows) {
        if (!r.state_abbr) continue;
        const list = byState.get(r.state_abbr);
        if (list) list.push(r); else byState.set(r.state_abbr, [r]);
      }
      features = [...byState.entries()].map(([state_abbr, list]) => {
        const vals = list.map((r) => r[metric]).filter((v) => v != null).sort((a, b) => a - b);
        return {
          state_abbr, agencies: list.length,
          sworn_officers: list.reduce((a, r) => a + (r.sworn_officers ?? 0), 0),
          population: list.reduce((a, r) => a + (r.population ?? 0), 0),
          reporting_agencies: list.filter((r) => r.rate_allowed).length,
          value: vals.length ? vals[Math.floor((vals.length - 1) / 2)] : null,
        };
      }).sort((a, b) => a.state_abbr.localeCompare(b.state_abbr));
    } else {
      features = [];   // the county layer needs boundary geometry this build does not carry
    }

    const values = features.map((f) => f.value).filter((v) => v != null).sort((a, b) => a - b);
    const pct = (p: number) => values.length
      ? values[Math.min(values.length - 1, Math.round(p * (values.length - 1)))] : null;

    return {
      metric, year, layer,
      unit: {
        violent_crime_rate: 'Incidents per 100,000 residents',
        property_crime_rate: 'Incidents per 100,000 residents',
        officers_per_1k: 'Sworn officers per 1,000 residents',
        sworn_officers: 'Sworn officers',
        population: 'Residents',
        months_reported: 'Months reported of 12',
      }[metric as string] ?? '',
      legend: {
        min: values[0] ?? null, max: values[values.length - 1] ?? null,
        p10: pct(0.10), p25: pct(0.25), p50: pct(0.50), p75: pct(0.75), p90: pct(0.90),
        with_value: values.length, without_value: features.length - values.length,
      },
      features,
      agencies_without_coordinates: withoutCoords,
      no_data_note: 'Features without a value are drawn in the no-data pattern. No data is '
        + 'never rendered as zero, and no coordinate is ever fabricated for an agency that '
        + 'lacks one.',
    };
  },

  qualityCoverage: async (year: number, params: Record<string, any> = {}) => {
    let rows = yearSlice(year);
    if (params.state) rows = rows.filter((r) => r.state_abbr === params.state);
    if (params.status) rows = rows.filter((r) => r.coverage_status === params.status);
    return {
      year, state: params.state ?? null, status: params.status ?? null,
      agencies: rows.slice()
        .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
        .slice(0, params.limit ?? 200),
    };
  },

  qualityFlag: async (checkId: string) => ({
    check_id: checkId,
    rows: table('quality_log')
      .filter((r) => r.check_id === checkId)
      .map((r) => {
        const meta = agencyMeta(String(r.entity_id));
        return { ...r, agency_name: meta?.agency_name ?? null, state_abbr: meta?.state_abbr ?? null };
      }),
  }),
};
