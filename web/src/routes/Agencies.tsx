/**
 * Agency Explorer — the screen an analyst sends to a colleague.
 *
 * Two decisions shape everything here.
 *
 * The first is that the URL is the only state. Every filter, the sort, the page size and the
 * page number are read from and written to the query string, so a filtered view can be
 * pasted into an email, bookmarked, or reloaded, and it comes back identical. A local
 * `useState` filter would make this screen unciteable, and an unciteable view of public data
 * is worth very little.
 *
 * The second is that the export carries its own context. A CSV that leaves this application
 * is going to be opened months later by someone who was not here, so the file begins with a
 * metadata block naming the release, the observation year, the active filters, the metric
 * definitions and the meaning of a blank cell. A blank cell in these files is a value that
 * does not exist or was withheld. It is never a zero, and the header says so in writing.
 *
 * Sorting and paging are server-side. The table shows the page the server returned; the
 * count above it is the size of the whole matching set, which is a different number and is
 * labelled as one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Confidence, CoverageStatus, GeoStatus } from '../lib/api';
import {
  agencyTypeLabel, confidenceChip, confidenceLabel, coverageChip, coverageLabel,
  DASH, denominatorLabel, fmt, fmtDecimal, fmtRate,
} from '../lib/format';
import { EmptyState, ErrorState, Loading, Notice, useAsync, Withheld } from '../components/primitives';

/* ------------------------------------------------------------------ shapes ----------- */

interface AgencyRow {
  agency_id: string;
  agency_name: string;
  agency_type: string | null;
  state_abbr: string | null;
  geo_name: string | null;
  geo_level: string | null;
  geo_review_status: GeoStatus | null;
  data_year: number;
  population: number | null;
  denominator_type: string | null;
  denominator_confidence: Confidence | null;
  sworn_officers: number | null;
  civilian_personnel: number | null;
  officers_per_1k: number | null;
  violent_crime_offenses: number | null;
  violent_crime_rate: number | null;
  property_crime_rate: number | null;
  months_reported: number | null;
  coverage_status: CoverageStatus | null;
  rate_allowed: boolean;
  rate_withheld_reason: string | null;
  methodology_warning: string | null;
  population_band: string | null;
  urbanicity_band: string | null;
}

interface AgenciesPage {
  year: number;
  total: number;
  page: number;
  page_size: number;
  pages: number;
  results: AgencyRow[];
}

interface Facets {
  agency_types: { agency_type: string; n: number }[];
  states: { state_abbr: string; n: number }[];
  coverage: { coverage_status: string; n: number }[];
  geo_status: { geo_review_status: string; n: number }[];
  population_bands: { population_band: string; n: number }[];
}

/* ------------------------------------------------------------------ constants -------- */

type SortKey =
  | 'agency_name' | 'state_abbr' | 'population' | 'sworn_officers'
  | 'officers_per_1k' | 'violent_crime_rate' | 'months_reported';

interface Column {
  key: string;
  label: string;
  sort?: SortKey;
  numeric?: boolean;
  /** The direction a first click applies. Text reads best ascending, magnitude descending. */
  firstDir?: 'asc' | 'desc';
}

const COLUMNS: Column[] = [
  { key: 'agency', label: 'Agency', sort: 'agency_name', firstDir: 'asc' },
  { key: 'location', label: 'Location', sort: 'state_abbr', firstDir: 'asc' },
  { key: 'type', label: 'Type' },
  { key: 'population', label: 'Population', sort: 'population', numeric: true, firstDir: 'desc' },
  { key: 'sworn', label: 'Sworn', sort: 'sworn_officers', numeric: true, firstDir: 'desc' },
  { key: 'per1k', label: 'Officers per 1K', sort: 'officers_per_1k', numeric: true, firstDir: 'desc' },
  { key: 'violent', label: 'Violent crime rate', sort: 'violent_crime_rate', numeric: true, firstDir: 'desc' },
  { key: 'coverage', label: 'Coverage', sort: 'months_reported', firstDir: 'desc' },
  { key: 'year', label: 'Observation year', numeric: true },
];

const COVERAGE_OPTIONS: CoverageStatus[] = ['COMPLETE', 'PARTIAL', 'NONE', 'UNKNOWN'];
const GEO_OPTIONS: { id: GeoStatus; label: string }[] = [
  { id: 'accepted', label: 'Accepted' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'unmatched', label: 'Unmatched' },
];
const PAGE_SIZES = [25, 50, 100, 200];

/** The earliest year the warehouse carries analytical rows for. The API exposes no year list. */
const FIRST_YEAR = 2016;
const FALLBACK_YEAR = 2025;

/** Every filter that narrows the result set, in the order the CSV header echoes them. */
const FILTER_KEYS = [
  'q', 'state', 'agency_type', 'coverage', 'geo_status',
  'min_population', 'max_population', 'min_sworn', 'max_sworn',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const FILTER_LABEL: Record<FilterKey, string> = {
  q: 'Name or ORI contains',
  state: 'State',
  agency_type: 'Agency type',
  coverage: 'Reporting coverage',
  geo_status: 'Jurisdiction link',
  min_population: 'Population at least',
  max_population: 'Population at most',
  min_sworn: 'Sworn officers at least',
  max_sworn: 'Sworn officers at most',
};

/* ------------------------------------------------------------------ screen ----------- */

export default function Agencies() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const release = useAsync(() => api.release(), []);

  const year = Number(params.get('year')) || FALLBACK_YEAR;
  const sort = (params.get('sort') as SortKey) || 'sworn_officers';
  const direction = params.get('direction') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get('page_size')))
    ? Number(params.get('page_size'))
    : 50;

  const filters = useMemo(() => {
    const out: Partial<Record<FilterKey, string>> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [params]);

  /** Writes a set of keys into the URL. A null value removes the key. */
  const patch = useCallback((next: Record<string, string | number | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') p.delete(k);
      else p.set(k, String(v));
    }
    setParams(p, { replace: false });
  }, [params, setParams]);

  /** Any change to what is being filtered returns the reader to the first page. */
  const setFilter = useCallback((key: string, value: string | null) => {
    patch({ [key]: value, page: null });
  }, [patch]);

  const query = useMemo(() => ({
    ...filters, year, sort, direction, page, page_size: pageSize,
  }), [filters, year, sort, direction, page, pageSize]);
  const queryKey = JSON.stringify(query);

  const list = useAsync<AgenciesPage>(() => api.agencies(query), [queryKey]);
  const facets = useAsync<Facets>(() => api.agencyFacets(year), [year]);

  const rows = list.data?.results ?? [];
  const total = list.data?.total ?? 0;
  const pages = list.data?.pages ?? 1;
  const activeFilters = Object.entries(filters) as [FilterKey, string][];

  const onSort = (key: SortKey, firstDir: 'asc' | 'desc') => {
    const nextDir = sort === key ? (direction === 'asc' ? 'desc' : 'asc') : firstDir;
    patch({ sort: key, direction: nextDir, page: null });
  };

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Agency explorer</div>
        <h1>Law enforcement agencies</h1>
        <div className="question">
          Which agencies match what I am looking for? Every filter below is held in the address
          bar, so this view can be shared exactly as you left it.
        </div>
      </header>

      <FilterBar
        filters={filters}
        year={year}
        facets={facets.data}
        latestYear={release.data?.latest_years?.crime ?? FALLBACK_YEAR}
        onFilter={setFilter}
        onYear={(y) => patch({ year: y, page: null })}
        onReset={() => setParams(new URLSearchParams(), { replace: false })}
      />

      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="num num-lg">{list.loading ? DASH : fmt(total)}</span>
              <span>{total === 1 ? 'agency matches' : 'agencies match'}</span>
            </h2>
            <div className="question">
              Observed in {year}. Agencies with no row for {year} are absent from this count,
              not counted as zero.
            </div>
          </div>
          <ExportControls
            query={query}
            year={year}
            total={total}
            rows={rows}
            page={page}
            pageSize={pageSize}
            filters={filters}
            sort={sort}
            direction={direction}
            releaseId={release.data?.release_id ?? null}
            builtAt={release.data?.built_at ?? null}
          />
        </div>

        <div className="card-body" style={{ padding: 0 }}>
          {list.loading && <Loading rows={6} label="Loading agencies" />}
          {list.error ? <ErrorState error={list.error} retry={list.retry} /> : null}

          {!list.loading && !list.error && rows.length === 0 && (
            <div style={{ padding: 16 }}>
              <EmptyState
                title="No agency matches these filters"
                detail={`No agency in the ${year} release satisfies every condition below at once. Widen or remove one of them.`}
              />
              <div className="controls" style={{ justifyContent: 'center', marginTop: 4 }}>
                <span className="chip chip-outline">Observation year {year}</span>
                {activeFilters.map(([k, v]) => (
                  <span key={k} className="chip chip-info">
                    {FILTER_LABEL[k]}: {filterValueLabel(k, v)}
                  </span>
                ))}
                {activeFilters.length === 0 && (
                  <span className="chip chip-outline">No filters beyond the year</span>
                )}
              </div>
            </div>
          )}

          {!list.loading && !list.error && rows.length > 0 && (
            <div className="tablewrap">
              <table className="data">
                <caption className="sr-only">
                  Agencies matching the active filters, observed in {year}, sorted by {sort} {direction === 'asc' ? 'ascending' : 'descending'}.
                </caption>
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className={[c.sort ? 'sortable' : '', c.numeric ? 'n' : ''].filter(Boolean).join(' ') || undefined}
                        aria-sort={
                          !c.sort ? undefined
                            : sort === c.sort ? (direction === 'asc' ? 'ascending' : 'descending')
                            : 'none'
                        }
                        scope="col"
                      >
                        {c.sort ? (
                          <button
                            type="button"
                            className="th-sort"
                            onClick={() => onSort(c.sort as SortKey, c.firstDir ?? 'desc')}
                          >
                            {c.label}
                            <span aria-hidden="true">
                              {sort === c.sort ? (direction === 'asc' ? '▲' : '▼') : '↕'}
                            </span>
                          </button>
                        ) : c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row key={r.agency_id} row={r} onOpen={() => navigate(`/agencies/${r.agency_id}`)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card-foot">
          <div className="pager" style={{ flexWrap: 'wrap' }}>
            <span>
              Showing <span className="num">{rows.length === 0 ? 0 : (page - 1) * pageSize + 1}</span>
              –<span className="num">{(page - 1) * pageSize + rows.length}</span> of{' '}
              <span className="num">{fmt(total)}</span>
            </span>
            <button className="btn" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}>
              Previous
            </button>
            <span>
              Page <span className="num">{fmt(page)}</span> of <span className="num">{fmt(pages)}</span>
            </span>
            <button className="btn" disabled={page >= pages} onClick={() => patch({ page: page + 1 })}>
              Next
            </button>
            <label className="controls" style={{ gap: 6, marginLeft: 'auto' }}>
              <span>Rows per page</span>
              <select
                value={pageSize}
                onChange={(e) => patch({ page_size: e.target.value, page: null })}
                aria-label="Rows per page"
              >
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </div>
      </section>

      <div style={{ marginTop: 14 }}>
        <Notice tone="info" title="How to read this table">
          Coverage describes the evidence, not the department: an agency that reported eight of
          twelve months produces counts but no annual rate, because the platform does not
          annualise a partial year. Officers per 1,000 residents is published only where a
          population denominator exists for the same year and the jurisdiction link was
          accepted, which is why several rows carry a count but no rate.
        </Notice>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ row -------------- */

function Row({ row, onOpen }: { row: AgencyRow; onOpen: () => void }) {
  const per1kReason = perThousandReason(row);
  return (
    <tr
      className="clickable"
      onClick={(e) => {
        // A click on the name link navigates on its own; do not double-handle it.
        if ((e.target as HTMLElement).closest('a')) return;
        onOpen();
      }}
    >
      <td className="wide">
        <Link to={`/agencies/${row.agency_id}`}>{row.agency_name}</Link>
        <div className="num" style={{ fontSize: 10.5, color: 'var(--faint)' }}>{row.agency_id}</div>
      </td>
      <td>
        {row.state_abbr ?? DASH}
        {/* An unmatched agency carries the state itself as its geography; do not print it twice. */}
        {row.geo_name && row.geo_name !== row.state_abbr && (
          <span style={{ color: 'var(--muted)' }}> · {row.geo_name}</span>
        )}
        {row.geo_review_status && row.geo_review_status !== 'accepted' && (
          <span className="chip chip-warn" style={{ marginLeft: 6 }}>
            {row.geo_review_status === 'needs_review' ? 'Link needs review' : 'Unmatched'}
          </span>
        )}
      </td>
      <td>{agencyTypeLabel(row.agency_type)}</td>
      <td className="n">
        {row.population == null
          ? <Withheld tone="neutral" reason="No population estimate" />
          : fmt(row.population)}
      </td>
      <td className="n">
        {row.sworn_officers == null
          ? <Withheld tone="neutral" reason="Staffing not reported" />
          : fmt(row.sworn_officers)}
      </td>
      <td className="n">
        {per1kReason ? <Withheld tone="neutral" reason={per1kReason} /> : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
            <span>{fmtDecimal(row.officers_per_1k)}</span>
            <span className={confidenceChip(row.denominator_confidence)}
                  title={`Denominator: ${denominatorLabel(row.denominator_type)}`}>
              {confidenceLabel(row.denominator_confidence)}
            </span>
            {row.methodology_warning && (
              <span className="chip chip-warn" title={row.methodology_warning}>Methodology</span>
            )}
          </span>
        )}
      </td>
      <td className="n">
        {row.rate_allowed && row.violent_crime_rate != null
          ? fmtRate(row.violent_crime_rate)
          : <Withheld reason={row.rate_withheld_reason ?? 'Not published for this year'} />}
      </td>
      <td>
        <span className={coverageChip(row.coverage_status)}>{row.coverage_status ?? 'UNKNOWN'}</span>
        <span style={{ marginLeft: 6, color: 'var(--muted)', fontSize: 11.5 }}>
          {coverageLabel(row.months_reported)}
        </span>
      </td>
      <td className="n">{row.data_year}</td>
    </tr>
  );
}

/** Why this row has no officers-per-1,000 value. The server supplies no reason for this field. */
function perThousandReason(row: AgencyRow): string | null {
  if (row.officers_per_1k != null) return null;
  if (row.denominator_confidence === 'NOT_COMPARABLE') return 'Not comparable';
  if (row.sworn_officers == null) return 'Staffing not reported';
  if (row.population == null) return 'No population estimate';
  return 'Not available';
}

/* ------------------------------------------------------------------ filters ---------- */

function FilterBar({ filters, year, facets, latestYear, onFilter, onYear, onReset }: {
  filters: Partial<Record<FilterKey, string>>;
  year: number;
  facets: Facets | null;
  latestYear: number;
  onFilter: (key: string, value: string | null) => void;
  onYear: (y: number) => void;
  onReset: () => void;
}) {
  const years = useMemo(() => {
    const top = Math.max(latestYear, FIRST_YEAR);
    return Array.from({ length: top - FIRST_YEAR + 1 }, (_, i) => top - i);
  }, [latestYear]);

  const coverageCount = (s: string) =>
    facets?.coverage.find((c) => c.coverage_status === s)?.n ?? null;
  const geoCount = (s: string) =>
    facets?.geo_status.find((g) => g.geo_review_status === s)?.n ?? null;

  const active = Object.keys(filters).length;

  return (
    <section className="card">
      <div className="card-head" style={{ alignItems: 'center' }}>
        <div>
          <h2>Filters</h2>
          <div className="question">
            Counts beside each option are agencies with a {year} row, not agencies that exist.
          </div>
        </div>
        <button className="btn" onClick={onReset} disabled={active === 0 && year === latestYear}>
          Reset all filters
        </button>
      </div>
      <div className="card-body">
        <div className="controls" style={{ gap: 12, alignItems: 'flex-end' }}>
          <DebouncedField
            label="Name or ORI"
            value={filters.q ?? ''}
            placeholder="e.g. Baltimore or MDBPD0000"
            width={230}
            onCommit={(v) => onFilter('q', v || null)}
          />

          <div className="field">
            <label htmlFor="f-state">State</label>
            <select id="f-state" value={filters.state ?? ''}
                    onChange={(e) => onFilter('state', e.target.value || null)}>
              <option value="">All states</option>
              {(facets?.states ?? []).map((s) => (
                <option key={s.state_abbr} value={s.state_abbr}>
                  {s.state_abbr} ({fmt(s.n)})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="f-type">Agency type</label>
            <select id="f-type" value={filters.agency_type ?? ''}
                    onChange={(e) => onFilter('agency_type', e.target.value || null)}>
              <option value="">All types</option>
              {(facets?.agency_types ?? []).map((t) => (
                <option key={t.agency_type} value={t.agency_type}>
                  {agencyTypeLabel(t.agency_type)} ({fmt(t.n)})
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="f-coverage">Reporting coverage</label>
            <select id="f-coverage" value={filters.coverage ?? ''}
                    onChange={(e) => onFilter('coverage', e.target.value || null)}>
              <option value="">Any coverage</option>
              {COVERAGE_OPTIONS.map((c) => {
                const n = coverageCount(c);
                return (
                  <option key={c} value={c}>
                    {c}{n === null ? ' (0)' : ` (${fmt(n)})`}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="field">
            <label htmlFor="f-geo">Jurisdiction link</label>
            <select id="f-geo" value={filters.geo_status ?? ''}
                    onChange={(e) => onFilter('geo_status', e.target.value || null)}>
              <option value="">Any status</option>
              {GEO_OPTIONS.map((g) => {
                const n = geoCount(g.id);
                return (
                  <option key={g.id} value={g.id}>
                    {g.label}{n === null ? '' : ` (${fmt(n)})`}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="field">
            <label htmlFor="f-year">Observation year</label>
            <select id="f-year" value={year} onChange={(e) => onYear(Number(e.target.value))}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="sr-only">Population range</legend>
            <div className="controls" style={{ gap: 8, alignItems: 'flex-end' }}>
              <DebouncedField
                label="Population from" type="number" width={110}
                value={filters.min_population ?? ''}
                onCommit={(v) => onFilter('min_population', v || null)}
              />
              <DebouncedField
                label="Population to" type="number" width={110}
                value={filters.max_population ?? ''}
                onCommit={(v) => onFilter('max_population', v || null)}
              />
            </div>
          </fieldset>

          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="sr-only">Sworn officer range</legend>
            <div className="controls" style={{ gap: 8, alignItems: 'flex-end' }}>
              <DebouncedField
                label="Sworn from" type="number" width={100}
                value={filters.min_sworn ?? ''}
                onCommit={(v) => onFilter('min_sworn', v || null)}
              />
              <DebouncedField
                label="Sworn to" type="number" width={100}
                value={filters.max_sworn ?? ''}
                onCommit={(v) => onFilter('max_sworn', v || null)}
              />
            </div>
          </fieldset>
        </div>

        {active > 0 && (
          <div className="controls" style={{ marginTop: 12, gap: 6 }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Active:</span>
            {(Object.entries(filters) as [FilterKey, string][]).map(([k, v]) => (
              <span key={k} className="chip chip-info">
                {FILTER_LABEL[k]}: {filterValueLabel(k, v)}
                <button className="iconbtn" aria-label={`Remove filter ${FILTER_LABEL[k]}`}
                        onClick={() => onFilter(k, null)}>×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function filterValueLabel(key: FilterKey, value: string): string {
  if (key === 'agency_type') return agencyTypeLabel(value);
  if (key === 'geo_status') return GEO_OPTIONS.find((g) => g.id === value)?.label ?? value;
  if (key.startsWith('min_') || key.startsWith('max_')) return fmt(Number(value));
  return value;
}

/**
 * A text or number filter that writes to the URL after the reader stops typing.
 * The URL stays authoritative: if it changes underneath (back button, reset), the draft
 * follows it.
 */
function DebouncedField({ label, value, onCommit, type = 'text', placeholder, width }: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  type?: 'text' | 'number';
  placeholder?: string;
  width?: number;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(value);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  useEffect(() => {
    if (value !== settled.current) { settled.current = value; setDraft(value); }
  }, [value]);

  useEffect(() => {
    if (draft === settled.current) return;
    const t = setTimeout(() => { settled.current = draft; commit.current(draft); }, 320);
    return () => clearTimeout(t);
  }, [draft]);

  const id = `f-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        value={draft}
        placeholder={placeholder}
        style={width ? { width } : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { settled.current = draft; commit.current(draft); }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ export ----------- */

const CSV_COLUMNS: { key: string; header: string }[] = [
  { key: 'agency_id', header: 'agency_id' },
  { key: 'agency_name', header: 'agency_name' },
  { key: 'agency_type', header: 'agency_type' },
  { key: 'state_abbr', header: 'state_abbr' },
  { key: 'geo_name', header: 'jurisdiction' },
  { key: 'geo_level', header: 'jurisdiction_level' },
  { key: 'geo_review_status', header: 'jurisdiction_link_status' },
  { key: 'data_year', header: 'observation_year' },
  { key: 'population', header: 'population' },
  { key: 'population_band', header: 'population_band' },
  { key: 'urbanicity_band', header: 'urbanicity_band' },
  { key: 'denominator_type', header: 'denominator_type' },
  { key: 'denominator_confidence', header: 'denominator_confidence' },
  { key: 'sworn_officers', header: 'sworn_officers' },
  { key: 'civilian_personnel', header: 'civilian_personnel' },
  { key: 'officers_per_1k', header: 'officers_per_1k' },
  { key: 'officers_per_1k_absent_reason', header: 'officers_per_1k_absent_reason' },
  { key: 'violent_crime_offenses', header: 'violent_crime_offenses' },
  { key: 'violent_crime_rate', header: 'violent_crime_rate' },
  { key: 'property_crime_rate', header: 'property_crime_rate' },
  { key: 'rate_withheld_reason', header: 'rate_withheld_reason' },
  { key: 'months_reported', header: 'months_reported' },
  { key: 'coverage_status', header: 'coverage_status' },
  { key: 'methodology_warning', header: 'methodology_warning' },
];

const METRIC_DEFINITIONS = [
  'population — Resident population of the geography used as the rate denominator, for the observation year. Blank where no estimate exists for that agency and year.',
  'denominator_type / denominator_confidence — Which population was used and how well it fits the agency. A sheriff denominated on an unincorporated balance is not measuring the same public as a city police department.',
  'sworn_officers — Full-time sworn officers with general arrest powers, as reported to the FBI as of 31 October of the observation year. An agency that did not report is blank, not zero.',
  'officers_per_1k — sworn_officers / population x 1,000. Blank where either input is absent or the denominator is not comparable; the reason is in officers_per_1k_absent_reason.',
  'violent_crime_offenses — Murder and nonnegligent manslaughter, rape, robbery and aggravated assault, as reported by the agency for the months it reported.',
  'violent_crime_rate — violent_crime_offenses / population x 100,000. Published only where the agency reported all twelve months, a same-year population estimate exists, and the jurisdiction link was accepted. Blank otherwise, with the reason in rate_withheld_reason.',
  'months_reported / coverage_status — Months of the observation year the agency submitted, counted from the source response. Coverage is a property of the data, not of the department, and is never blended into a metric.',
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportRow(r: AgencyRow): Record<string, unknown> {
  const rateOk = r.rate_allowed;
  return {
    ...r,
    // A withheld rate never leaves this application, in any format.
    violent_crime_rate: rateOk ? r.violent_crime_rate : null,
    property_crime_rate: rateOk ? r.property_crime_rate : null,
    rate_withheld_reason: rateOk ? null : (r.rate_withheld_reason ?? 'Not published for this year'),
    officers_per_1k_absent_reason: perThousandReason(r),
  };
}

function buildCsv(opts: {
  rows: AgencyRow[];
  year: number;
  scope: string;
  filters: Partial<Record<FilterKey, string>>;
  sort: string;
  direction: string;
  releaseId: string | null;
  builtAt: string | null;
}): string {
  const activeFilters = (Object.entries(opts.filters) as [FilterKey, string][])
    .map(([k, v]) => `${FILTER_LABEL[k]} = ${filterValueLabel(k, v)}`);

  const head = [
    'National Law Enforcement Data & Intelligence Platform — agency export',
    `Generated: ${new Date().toISOString()}`,
    `Data release: ${opts.releaseId ?? 'unknown'}${opts.builtAt ? ` (built ${opts.builtAt})` : ''}`,
    `Observation year: ${opts.year} — every value in this file was observed in this year`,
    `Rows: ${opts.scope}`,
    `Sort: ${opts.sort} ${opts.direction === 'asc' ? 'ascending' : 'descending'}`,
    `Active filters: ${activeFilters.length ? activeFilters.join('; ') : 'none beyond the observation year'}`,
    '',
    'Metric definitions',
    ...METRIC_DEFINITIONS,
    '',
    'Source: FBI Crime Data Explorer (NIBRS and legacy SRS submissions) and FBI Police Employee data; population denominators from U.S. Census Bureau Population Estimates.',
    'Coverage note: a blank cell is a value that does not exist for that agency and year, or a value the platform withheld. It is never a zero, and it must not be replaced with one.',
    'Comparability note: coverage, denominator confidence and the metric are three separate columns. Do not combine them into a single score.',
  ].map((l) => (l ? `# ${l}` : '#')).join('\n');

  const header = CSV_COLUMNS.map((c) => c.header).join(',');
  const body = opts.rows
    .map(exportRow)
    .map((r) => CSV_COLUMNS.map((c) => csvCell(r[c.key])).join(','))
    .join('\n');

  return `${head}\n\n${header}\n${body}\n`;
}

function download(name: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ExportControls(props: {
  query: Record<string, unknown>;
  year: number;
  total: number;
  rows: AgencyRow[];
  page: number;
  pageSize: number;
  filters: Partial<Record<FilterKey, string>>;
  sort: string;
  direction: string;
  releaseId: string | null;
  builtAt: string | null;
}) {
  const { query, year, total, rows, page, pageSize, filters, sort, direction, releaseId, builtAt } = props;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const cancelled = useRef(false);

  const stamp = new Date().toISOString().slice(0, 10);

  const exportPage = () => {
    const first = (page - 1) * pageSize + 1;
    download(
      `agencies-${year}-page-${page}-${stamp}.csv`,
      buildCsv({
        rows, year, filters, sort, direction, releaseId, builtAt,
        scope: `this page only — ${first} to ${first + rows.length - 1} of ${total} matching agencies`,
      }),
    );
  };

  const exportAll = async () => {
    setFailed(null);
    cancelled.current = false;
    const size = 200;
    const pages = Math.max(1, Math.ceil(total / size));
    const collected: AgencyRow[] = [];
    setProgress({ done: 0, total });
    try {
      for (let p = 1; p <= pages; p++) {
        if (cancelled.current) { setProgress(null); return; }
        const chunk: AgenciesPage = await api.agencies({ ...query, page: p, page_size: size });
        collected.push(...chunk.results);
        setProgress({ done: collected.length, total });
      }
      download(
        `agencies-${year}-all-matching-${stamp}.csv`,
        buildCsv({
          rows: collected, year, filters, sort, direction, releaseId, builtAt,
          scope: `every agency matching the filters — ${collected.length} of ${total} reported by the server`,
        }),
      );
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The export could not be completed.');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
      <div className="controls">
        <button className="btn" onClick={exportPage} disabled={rows.length === 0 || !!progress}>
          Export this page (CSV)
        </button>
        <button className="btn btn-primary" onClick={exportAll} disabled={total === 0 || !!progress}>
          Export all {fmt(total)} matching (CSV)
        </button>
        {progress && (
          <button className="btn" onClick={() => { cancelled.current = true; }}>Cancel</button>
        )}
      </div>
      {progress && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }} role="status" aria-live="polite">
          Paging through the API: <span className="num">{fmt(progress.done)}</span> of{' '}
          <span className="num">{fmt(progress.total)}</span> rows collected
        </div>
      )}
      {failed && (
        <div style={{ fontSize: 11.5, color: 'var(--crit)' }} role="alert">{failed}</div>
      )}
      <div style={{ fontSize: 11, color: 'var(--faint)', maxWidth: 340, textAlign: 'right' }}>
        Both files begin with a metadata block naming the release, the year, the filters and
        what a blank cell means.
      </div>
    </div>
  );
}
