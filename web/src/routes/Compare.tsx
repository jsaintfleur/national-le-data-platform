/**
 * Compare — how one agency differs from agencies it can honestly be set beside.
 *
 * A comparison screen is the easiest place in a data product to tell a lie, because putting
 * two numbers next to each other is itself an assertion that they measure the same thing.
 * Three rules keep this screen honest.
 *
 * The comparability panel sits above the analysis and never blocks it. The server returns the
 * reasons these agencies are awkward to compare — different denominators, different agency
 * types, uneven reporting coverage — and every one of them is printed in full before the
 * first number. Readers are trusted with the caveat and then given the data; a modal that
 * refuses to show the comparison would just send them to a worse source.
 *
 * Agencies that could not be resolved for the selected year are listed by name with the
 * reason and the latest year they do have. Dropping them silently would turn "no data" into
 * "not selected", which is the same failure as printing a missing value as zero.
 *
 * The four modes answer four different questions, and the indexed mode exists because raw
 * levels cannot compare a department of 2,000 officers with one of 200. Rebasing to a common
 * year is the only view in this application where several series share one pair of axes, and
 * it is allowed there precisely because the rebasing has made the scale shared.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchResponse, SearchResult } from '../lib/api';
import {
  agencyTypeLabel, confidenceChip, confidenceLabel, coverageChip, coverageLabel,
  DASH, denominatorLabel, deltaClass, fmt, fmtDecimal, fmtDelta, fmtRate, pctChange,
} from '../lib/format';
import { ChartFrame, MultiSeries, TimeSeries } from '../components/charts';
import type { Point, SeriesSpec } from '../components/charts';
import {
  EmptyState, ErrorState, Icon, Loading, Notice, useAsync, Withheld,
} from '../components/primitives';

/* ------------------------------------------------------------------ shapes ----------- */

interface SnapshotRow {
  agency_id: string;
  agency_name: string;
  agency_type: string | null;
  state_abbr: string | null;
  geo_name: string | null;
  geo_review_status: string | null;
  data_year: number;
  population: number | null;
  denominator_type: string | null;
  denominator_value: number | null;
  denominator_year: number | null;
  denominator_confidence: string | null;
  denominator_notes: string | null;
  sworn_officers: number | null;
  civilian_personnel: number | null;
  officers_per_1k: number | null;
  violent_crime_offenses: number | null;
  violent_crime_rate: number | null;
  property_crime_offenses: number | null;
  property_crime_rate: number | null;
  months_reported: number | null;
  coverage_status: string | null;
  rate_allowed: boolean;
  rate_withheld_reason: string | null;
  methodology_warning: string | null;
  implausible_rate_flag?: boolean;
}

interface TrendRow {
  agency_id: string;
  agency_name: string;
  data_year: number;
  population: number | null;
  sworn_officers: number | null;
  officers_per_1k: number | null;
  violent_crime_offenses: number | null;
  violent_crime_rate: number | null;
  property_crime_offenses: number | null;
  property_crime_rate: number | null;
  months_reported: number | null;
  coverage_status: string | null;
  rate_allowed: boolean;
  rate_withheld_reason: string | null;
}

interface Issue { severity: string; code: string; message: string }

interface MissingEntry {
  agency_id: string;
  agency_name: string | null;
  reason: string | null;
  latest_year_available: number | null;
}

interface CompareResponse {
  year: number;
  agency_ids: string[];
  missing: (string | MissingEntry)[];
  snapshot: SnapshotRow[];
  trends: TrendRow[];
  comparability: Issue[];
}

/* ------------------------------------------------------------------ metrics ---------- */

type Mode = 'snapshot' | 'trend' | 'indexed' | 'change';
const MODES: { id: Mode; label: string }[] = [
  { id: 'snapshot', label: 'Snapshot' },
  { id: 'trend', label: 'Trend' },
  { id: 'indexed', label: 'Indexed' },
  { id: 'change', label: 'Change' },
];

interface MetricDef {
  id: keyof TrendRow;
  label: string;
  unit: string;
  /** A crime rate the policy engine may withhold; `rate_allowed` governs it. */
  crimeRate?: boolean;
  decimals?: number;
}

const METRICS: MetricDef[] = [
  { id: 'violent_crime_offenses', label: 'Violent crime', unit: 'offenses' },
  { id: 'violent_crime_rate', label: 'Violent crime rate', unit: 'per 100K', crimeRate: true },
  { id: 'property_crime_offenses', label: 'Property crime', unit: 'offenses' },
  { id: 'property_crime_rate', label: 'Property crime rate', unit: 'per 100K', crimeRate: true },
  { id: 'sworn_officers', label: 'Sworn officers', unit: 'officers' },
  { id: 'officers_per_1k', label: 'Officers per 1,000', unit: 'per 1K', decimals: 2 },
  { id: 'population', label: 'Population served', unit: 'residents' },
];

const OFFICERS_PER_1K = METRICS.find((m) => m.id === 'officers_per_1k') as MetricDef;

const FALLBACK_YEAR = 2025;
const FIRST_YEAR = 2016;
const MAX_AGENCIES = 5;

/**
 * The value of one metric for one year, with the reason it is absent when it is.
 *
 * Only the crime rates are gated on `rate_allowed`: that flag records a decision about
 * annualising crime counts, and applying it to a staffing ratio would suppress a figure the
 * warehouse computed perfectly well.
 */
function readMetric(row: TrendRow | undefined, m: MetricDef): { value: number | null; reason: string | null } {
  if (!row) return { value: null, reason: 'No observation for this year' };
  if (m.crimeRate && !row.rate_allowed) {
    return { value: null, reason: row.rate_withheld_reason ?? 'Rate not published for this year' };
  }
  const raw = row[m.id] as number | null;
  if (raw === null || raw === undefined) {
    if (m.id === 'officers_per_1k') {
      if (row.sworn_officers == null) return { value: null, reason: 'Staffing not reported' };
      if (row.population == null) return { value: null, reason: 'No population estimate' };
      return { value: null, reason: 'Not comparable using a standard resident denominator' };
    }
    return { value: null, reason: 'Not reported' };
  }
  return { value: raw, reason: null };
}

function formatMetric(m: MetricDef, n: number | null): string {
  if (n === null) return DASH;
  if (m.decimals) return fmtDecimal(n, m.decimals);
  if (m.crimeRate) return fmtRate(n);
  return fmt(Math.round(n));
}

/* ------------------------------------------------------------------ screen ----------- */

export default function Compare() {
  const [params, setParams] = useSearchParams();
  const release = useAsync(() => api.release(), []);

  const ids = useMemo(
    () => (params.get('agencies') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    [params],
  );
  const year = Number(params.get('year')) || FALLBACK_YEAR;
  const mode = (MODES.find((m) => m.id === params.get('mode'))?.id ?? 'snapshot') as Mode;
  const metric = METRICS.find((m) => m.id === params.get('metric')) ?? METRICS[1];

  const [nameHints, setNameHints] = useState<Record<string, string>>({});

  const patch = (next: Record<string, string | number | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') p.delete(k);
      else p.set(k, String(v));
    }
    setParams(p, { replace: false });
  };

  const setIds = (next: string[]) => patch({ agencies: next.join(',') || null });

  const enough = ids.length >= 2;
  const cmp = useAsync<CompareResponse | null>(
    () => (enough ? api.compare(ids, year) : Promise.resolve(null)),
    [ids.join(','), year, enough],
  );

  const data = cmp.data;
  // The server returns snapshot rows in warehouse order; the reader chose an order, so the
  // columns follow the order the ids appear in the URL.
  const snapshot = [...(data?.snapshot ?? [])].sort(
    (a, b) => ids.indexOf(a.agency_id) - ids.indexOf(b.agency_id));
  const trends = data?.trends ?? [];
  // Names come from whichever source knows them: the snapshot, the trend rows, the missing
  // list, or the search result the reader clicked. An id is shown only when nothing knows a
  // name — an agency with no row for the selected year usually still has one in its trend.
  const names: Record<string, string> = { ...nameHints };
  for (const s of snapshot) names[s.agency_id] = s.agency_name;
  for (const t of trends) names[t.agency_id] = t.agency_name;
  const missing = normalizeMissing(data?.missing ?? [], names);
  for (const m of missing) if (m.agency_name) names[m.agency_id] = m.agency_name;

  const years = useMemo(() => {
    const set = new Set<number>(trends.map((t) => t.data_year));
    if (set.size === 0) return [year];
    return [...set].sort((a, b) => a - b);
  }, [trends, year]);

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Comparison</div>
        <h1>Compare agencies</h1>
        <div className="question">
          How does this agency differ from appropriate peers? Two to five agencies, held in the
          address bar, so a comparison can be cited exactly as it was read.
        </div>
      </header>

      <Picker
        ids={ids}
        names={names}
        onAdd={(r) => {
          if (!r.agency_id || ids.includes(r.agency_id) || ids.length >= MAX_AGENCIES) return;
          setNameHints((h) => ({ ...h, [r.agency_id as string]: r.agency_name ?? r.agency_id as string }));
          setIds([...ids, r.agency_id]);
        }}
        onRemove={(id) => setIds(ids.filter((i) => i !== id))}
        year={year}
        latestYear={release.data?.latest_years?.crime ?? FALLBACK_YEAR}
        onYear={(y) => patch({ year: y })}
      />

      {!enough && (
        <div className="card" style={{ marginTop: 14 }}>
          <EmptyState
            title="Select at least two agencies"
            detail="A comparison needs two agencies and takes at most five. Use the search box above, or arrive here from an agency profile."
          />
        </div>
      )}

      {enough && cmp.loading && <div className="card" style={{ marginTop: 14 }}><Loading rows={6} label="Loading comparison" /></div>}
      {enough && cmp.error && <div className="card" style={{ marginTop: 14 }}><ErrorState error={cmp.error} retry={cmp.retry} /></div>}

      {enough && data && (
        <>
          {missing.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <Notice tone="warn" title={`${missing.length} selected ${missing.length === 1 ? 'agency has' : 'agencies have'} no row for ${year}`}>
                <ul style={{ margin: '6px 0 0', paddingLeft: '1.1em' }}>
                  {missing.map((m) => (
                    <li key={m.agency_id} style={{ marginBottom: 3 }}>
                      <strong>{m.agency_name ?? m.agency_id}</strong>{' '}
                      {m.agency_name && m.agency_name !== m.agency_id && (
                        <span className="num" style={{ fontSize: 11 }}>({m.agency_id})</span>
                      )} —{' '}
                      {m.reason ?? 'No observation for this year'}
                      {m.latest_year_available != null && (
                        <> Latest year available: <span className="num">{m.latest_year_available}</span>.</>
                      )}
                    </li>
                  ))}
                </ul>
                They remain selected and are shown wherever they do have data. They are not
                counted as zero anywhere on this screen.
              </Notice>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <ComparabilityPanel issues={data.comparability} year={year} count={snapshot.length} />
          </div>

          <section className="card" style={{ marginTop: 14 }}>
            <div className="card-head" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <h2>{MODES.find((m) => m.id === mode)?.label}</h2>
                <div className="question">{MODE_QUESTION[mode]}</div>
              </div>
              <div className="controls">
                {mode !== 'snapshot' && (
                  <label className="controls" style={{ gap: 6 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>Metric</span>
                    <select value={metric.id as string} onChange={(e) => patch({ metric: e.target.value })}
                            aria-label="Metric">
                      {METRICS.map((m) => <option key={m.id as string} value={m.id as string}>{m.label}</option>)}
                    </select>
                  </label>
                )}
                <div className="seg" role="tablist" aria-label="Comparison mode">
                  {MODES.map((m) => (
                    <button key={m.id} role="tab" aria-selected={m.id === mode}
                            className={m.id === mode ? 'on' : ''}
                            onClick={() => patch({ mode: m.id })}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card-body" style={{ padding: mode === 'snapshot' ? 0 : 16 }}>
              {mode === 'snapshot' && <SnapshotPanel rows={snapshot} year={year} />}
              {mode === 'trend' && <TrendPanel trends={trends} ids={ids} names={names} metric={metric} />}
              {mode === 'indexed' && <IndexedPanel trends={trends} ids={ids} names={names} metric={metric} />}
              {mode === 'change' && (
                <ChangePanel
                  trends={trends} ids={ids} names={names} metric={metric} years={years}
                  from={Number(params.get('from')) || years[0]}
                  to={Number(params.get('to')) || years[years.length - 1]}
                  onYears={(f, t) => patch({ from: f, to: t })}
                />
              )}
            </div>

            <div className="card-foot">
              Coverage, denominator confidence and the metric itself stay separate throughout.
              None of them is combined into a single score, and no agency on this screen is
              ranked as better or worse than another.
            </div>
          </section>
        </>
      )}
    </>
  );
}

const MODE_QUESTION: Record<Mode, string> = {
  snapshot: 'What did each agency report in the selected year, and what is missing?',
  trend: 'How has each agency moved over time, on its own scale?',
  indexed: 'Rebased to a shared starting point, which agency moved further?',
  change: 'Between two chosen years, how much did each agency change?',
};

function normalizeMissing(raw: (string | MissingEntry)[], hints: Record<string, string>): MissingEntry[] {
  // The endpoint has returned both a list of ids and a list of objects across builds; accept
  // either, because losing a missing agency is exactly the failure this list exists to prevent.
  return raw.map((m) => typeof m === 'string'
    ? { agency_id: m, agency_name: hints[m] ?? null, reason: null, latest_year_available: null }
    : m);
}

/* ------------------------------------------------------------------ picker ----------- */

function Picker({ ids, names, onAdd, onRemove, year, latestYear, onYear }: {
  ids: string[];
  names: Record<string, string>;
  onAdd: (r: SearchResult) => void;
  onRemove: (id: string) => void;
  year: number;
  latestYear: number;
  onYear: (y: number) => void;
}) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.search(q.trim()).then((d) => { if (live) { setRes(d); setCursor(0); } }, () => {});
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const hits = (res?.results ?? []).filter((r) => r.type === 'agency' && r.agency_id && !ids.includes(r.agency_id));
  const full = ids.length >= MAX_AGENCIES;

  const years = useMemo(() => {
    const top = Math.max(latestYear, FIRST_YEAR);
    return Array.from({ length: top - FIRST_YEAR + 1 }, (_, i) => top - i);
  }, [latestYear]);

  const add = (r: SearchResult) => { onAdd(r); setQ(''); setRes(null); setOpen(false); };

  return (
    <section className="card">
      <div className="card-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <h2>Selected agencies</h2>
          <div className="question">
            <span className="num">{ids.length}</span> of {MAX_AGENCIES} selected. Two are required.
          </div>
        </div>
        <div className="field">
          <label htmlFor="cmp-year">Comparison year</label>
          <select id="cmp-year" value={year} onChange={(e) => onYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <div className="card-body">
        <div className="controls" style={{ gap: 6, marginBottom: ids.length ? 12 : 0 }}>
          {ids.map((id) => (
            <span key={id} className="chip chip-info" style={{ paddingRight: 3 }}>
              {names[id] ?? id}
              {names[id] && names[id] !== id && (
                <span className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>{id}</span>
              )}
              <button className="iconbtn" onClick={() => onRemove(id)}
                      aria-label={`Remove ${names[id] ?? id} from the comparison`}>
                <Icon.close />
              </button>
            </span>
          ))}
        </div>

        <div className="cmd" ref={box} style={{ maxWidth: 460 }}>
          <span className="cmd-icon"><Icon.search /></span>
          <input
            className="cmd-input"
            placeholder={full ? 'Five agencies is the maximum' : 'Add an agency by name or ORI…'}
            value={q}
            disabled={full}
            role="combobox"
            aria-expanded={open && hits.length > 0}
            aria-controls="cmp-results"
            aria-label="Add an agency to the comparison"
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 160)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (e.key === 'Enter' && hits[cursor]) { e.preventDefault(); add(hits[cursor]); }
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          {open && q.trim().length > 1 && (
            <div className="cmd-results" id="cmp-results" role="listbox">
              {res?.ambiguous_identifier && (
                <div className="notice warn" style={{ margin: 10, borderRadius: 6 }}>
                  <span className="t">Ambiguous identifier</span>
                  {res.ambiguous_identifier.message}
                </div>
              )}
              {hits.length === 0 && <div className="cmd-empty">No agency to add for “{q}”.</div>}
              {hits.map((r, i) => (
                <button key={r.agency_id} className="cmd-item" role="option" aria-selected={i === cursor}
                        onMouseDown={(e) => e.preventDefault()} onClick={() => add(r)}>
                  <span className="chip mono chip-outline" style={{ justifySelf: 'start' }}>{r.state_abbr ?? '—'}</span>
                  <span className="name">{r.agency_name}</span>
                  <span className="meta">{agencyTypeLabel(r.agency_type)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ comparability ---- */

function ComparabilityPanel({ issues, year, count }: { issues: Issue[]; year: number; count: number }) {
  // With fewer than two agencies observed in the selected year there is nothing to hold up
  // against anything, and an empty issue list would otherwise read as a clean bill of health.
  const checked = count >= 2;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Comparability</h2>
          <div className="question">
            What has to be understood before these agencies are read side by side?
          </div>
        </div>
        <span className={!checked ? 'chip chip-outline' : issues.length ? 'chip chip-warn' : 'chip chip-ok'}>
          {!checked ? 'Not applicable'
            : issues.length === 0 ? 'No issues raised'
            : `${issues.length} issue${issues.length > 1 ? 's' : ''}`}
        </span>
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 8 }}>
        {!checked ? (
          <Notice tone="warn" title="No comparison was checked">
            {count === 1
              ? `Only one selected agency has a ${year} observation, so there is no second series to check it against.`
              : `No selected agency has a ${year} observation, so there is nothing to check.`}
            {' '}The comparability checks run again as soon as two agencies share a year.
          </Notice>
        ) : issues.length === 0 ? (
          <Notice tone="info" title="Comparable on the checks this platform runs">
            These agencies share an agency type, denominator basis and reporting coverage for
            {' '}{year}. That makes the figures below directly comparable on those three axes. It
            does not make the agencies alike in every respect that matters.
          </Notice>
        ) : (
          issues.map((i, k) => (
            <Notice key={k} tone="warn" title={issueTitle(i.code)}>
              {i.message}
            </Notice>
          ))
        )}
        {checked && (
          <p className="question" style={{ margin: 0 }}>
            These warnings explain the comparison; they do not withhold it. Everything below is
            still shown, with the caveat attached.
          </p>
        )}
      </div>
    </section>
  );
}

function issueTitle(code: string): string {
  return code
    ? code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    : 'Comparability warning';
}

/* ------------------------------------------------------------------ snapshot --------- */

function SnapshotPanel({ rows, year }: { rows: SnapshotRow[]; year: number }) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        <EmptyState
          title={`No selected agency has a ${year} observation`}
          detail="Change the snapshot year, or select agencies that reported in this year."
        />
      </div>
    );
  }

  const cell = (r: SnapshotRow, render: (r: SnapshotRow) => React.ReactNode) => (
    <td key={r.agency_id} className="n">{render(r)}</td>
  );

  return (
    <div className="tablewrap">
      <table className="data">
        <caption className="sr-only">
          Reported measures for the selected agencies, observation year {year}.
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            {rows.map((r) => (
              <th key={r.agency_id} className="n" scope="col">
                <Link to={`/agencies/${r.agency_id}`}>{r.agency_name}</Link>
                <div style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--sans)' }}>
                  {agencyTypeLabel(r.agency_type)}{r.state_abbr ? ` · ${r.state_abbr}` : ''}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Observation year</th>
            {rows.map((r) => cell(r, (x) => <span className="num">{x.data_year}</span>))}
          </tr>
          <tr>
            <th scope="row">Population served</th>
            {rows.map((r) => cell(r, (x) => x.denominator_value == null && x.population == null
              ? <Withheld tone="neutral" reason="No population estimate for this year" />
              : <>
                  {fmt(x.denominator_value ?? x.population)}
                  {x.denominator_year != null && x.denominator_year !== x.data_year && (
                    <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>estimate year {x.denominator_year}</div>
                  )}
                </>))}
          </tr>
          <tr>
            <th scope="row">Denominator basis</th>
            {rows.map((r) => (
              <td key={r.agency_id} className="n">
                <div>{denominatorLabel(r.denominator_type)}</div>
                <span className={confidenceChip(r.denominator_confidence)}>
                  {confidenceLabel(r.denominator_confidence)} confidence
                </span>
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">Sworn officers</th>
            {rows.map((r) => cell(r, (x) => x.sworn_officers == null
              ? <Withheld tone="neutral" reason="Staffing not reported" />
              : fmt(x.sworn_officers)))}
          </tr>
          <tr>
            <th scope="row">Civilian personnel</th>
            {rows.map((r) => cell(r, (x) => x.civilian_personnel == null
              ? <Withheld tone="neutral" reason="Not reported" />
              : fmt(x.civilian_personnel)))}
          </tr>
          <tr>
            <th scope="row">Officers per 1,000 residents</th>
            {rows.map((r) => cell(r, (x) => {
              const v = readMetric(x as unknown as TrendRow, OFFICERS_PER_1K);
              return v.value === null
                ? <Withheld tone="neutral" reason={v.reason ?? 'Not available'} />
                : fmtDecimal(v.value);
            }))}
          </tr>
          <tr>
            <th scope="row">Violent crime offenses</th>
            {rows.map((r) => cell(r, (x) => x.violent_crime_offenses == null
              ? <Withheld tone="neutral" reason="Not reported" />
              : fmt(x.violent_crime_offenses)))}
          </tr>
          <tr>
            <th scope="row">Violent crime rate <span style={{ fontWeight: 400 }}>per 100K</span></th>
            {rows.map((r) => cell(r, (x) => x.rate_allowed && x.violent_crime_rate != null
              ? <>
                  {fmtRate(x.violent_crime_rate)}
                  {x.implausible_rate_flag && (
                    <div><span className="chip chip-warn">Implausible value flagged</span></div>
                  )}
                </>
              : <Withheld reason={x.rate_withheld_reason ?? 'Not published for this year'} />))}
          </tr>
          <tr>
            <th scope="row">Property crime offenses</th>
            {rows.map((r) => cell(r, (x) => x.property_crime_offenses == null
              ? <Withheld tone="neutral" reason="Not reported" />
              : fmt(x.property_crime_offenses)))}
          </tr>
          <tr>
            <th scope="row">Property crime rate <span style={{ fontWeight: 400 }}>per 100K</span></th>
            {rows.map((r) => cell(r, (x) => x.rate_allowed && x.property_crime_rate != null
              ? fmtRate(x.property_crime_rate)
              : <Withheld reason={x.rate_withheld_reason ?? 'Not published for this year'} />))}
          </tr>
          <tr>
            <th scope="row">Months reported</th>
            {rows.map((r) => cell(r, (x) => coverageLabel(x.months_reported)))}
          </tr>
          <tr>
            <th scope="row">Reporting coverage</th>
            {rows.map((r) => (
              <td key={r.agency_id} className="n">
                <span className={coverageChip(r.coverage_status)}>{r.coverage_status ?? 'UNKNOWN'}</span>
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">Jurisdiction link</th>
            {rows.map((r) => (
              <td key={r.agency_id} className="n">
                {r.geo_name ?? DASH}
                {r.geo_review_status && r.geo_review_status !== 'accepted' && (
                  <div><span className="chip chip-warn">
                    {r.geo_review_status === 'needs_review' ? 'Needs review' : 'Unmatched'}
                  </span></div>
                )}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">Methodology warning</th>
            {rows.map((r) => (
              <td key={r.agency_id} className="wide" style={{ whiteSpace: 'normal', fontSize: 11.5, color: 'var(--muted)' }}>
                {r.methodology_warning ?? 'None recorded'}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ trend ------------ */

function seriesFor(trends: TrendRow[], id: string, metric: MetricDef): Point[] {
  return trends
    .filter((t) => t.agency_id === id)
    .sort((a, b) => a.data_year - b.data_year)
    .map((t) => {
      const v = readMetric(t, metric);
      return {
        x: t.data_year,
        y: v.value,
        partial: t.coverage_status === 'PARTIAL',
        withheldReason: v.reason,
        count: metric.crimeRate ? t.violent_crime_offenses : null,
      } as Point;
    });
}

/**
 * One chart per agency rather than one chart with several lines. A 2,000-officer department
 * and a 200-officer department share no useful y-axis, and overlaying them makes the smaller
 * one look like a flat line at zero, which is a visual claim that is not true.
 */
function TrendPanel({ trends, ids, names, metric }: {
  trends: TrendRow[]; ids: string[]; names: Record<string, string>; metric: MetricDef;
}) {
  const present = ids.filter((id) => trends.some((t) => t.agency_id === id));
  const absent = ids.filter((id) => !present.includes(id));

  return (
    <>
      <Notice tone="info" title="Read each panel on its own axis">
        Each agency has its own vertical scale, so heights are not comparable across panels —
        shapes are. Use the indexed mode to put the agencies on one axis. Lines break where a
        year is missing and nothing is drawn across the gap.
      </Notice>

      {absent.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn" title="No series available">
            {absent.map((id) => names[id] ?? id).join(', ')} has no observation in any year of
            this release, so no panel is drawn.
          </Notice>
        </div>
      )}

      <div className="grid g2" style={{ marginTop: 12, alignItems: 'start' }}>
        {present.map((id) => {
          const points = seriesFor(trends, id, metric);
          const partials = points.filter((p) => p.partial).length;
          const gaps = points.filter((p) => p.y === null).length;
          return (
            <ChartFrame
              key={id}
              title={names[id] ?? id}
              subtitle={`${metric.label} · ${metric.unit}`}
              footer={
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  {gaps > 0 && <span>{gaps} year{gaps > 1 ? 's' : ''} without a published value</span>}
                  {partials > 0 && <span>{partials} partial-reporting year{partials > 1 ? 's' : ''}</span>}
                  {gaps === 0 && partials === 0 && <span>Complete series across the release</span>}
                </div>
              }
            >
              <TimeSeries
                points={points}
                height={180}
                unit={metric.unit}
                valueLabel={metric.label}
                yZero={!metric.crimeRate && metric.id !== 'officers_per_1k'}
                format={(n) => formatMetric(metric, n)}
                ariaLabel={`${metric.label} by year for ${names[id] ?? id}`}
              />
            </ChartFrame>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ indexed ---------- */

function IndexedPanel({ trends, ids, names, metric }: {
  trends: TrendRow[]; ids: string[]; names: Record<string, string>; metric: MetricDef;
}) {
  const raw = useMemo(
    () => ids.map((id) => ({ id, label: names[id] ?? id, points: seriesFor(trends, id, metric) }))
             .filter((s) => s.points.length > 0),
    [trends, ids, names, metric],
  );

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const s of raw) for (const p of s.points) set.add(p.x);
    return [...set].sort((a, b) => a - b);
  }, [raw]);

  // The base is the earliest year in which every selected agency has a published value. Only
  // then does an index of 100 mean the same thing on every line.
  const commonBase = years.find((y) => raw.length > 0 && raw.every(
    (s) => s.points.some((p) => p.x === y && p.y !== null)));

  const series: SeriesSpec[] = raw.map((s) => {
    const baseYear = commonBase ?? s.points.find((p) => p.y !== null)?.x ?? null;
    const base = baseYear == null ? null : s.points.find((p) => p.x === baseYear)?.y ?? null;
    return {
      id: s.id,
      label: s.label,
      note: base == null || base === 0 ? 'no usable base year' : `${baseYear} = 100`,
      points: s.points.map((p) => ({
        ...p,
        y: base == null || base === 0 || p.y === null ? null : (p.y / base) * 100,
        withheldReason: base == null || base === 0
          ? 'No base year with a usable published value'
          : p.withheldReason,
      })),
    };
  });

  if (raw.length === 0) {
    return <EmptyState title="Nothing to index" detail="No selected agency has a published value for this metric in any year." />;
  }

  return (
    <>
      {commonBase ? (
        <Notice tone="info" title={`Rebased to ${commonBase} = 100`}>
          {commonBase} is the earliest year in which every selected agency has a published
          value for {metric.label.toLowerCase()}. A line at 120 stands twenty percent above
          where that agency was in {commonBase}. Levels are removed by construction: this view
          shows movement, not size.
        </Notice>
      ) : (
        <Notice tone="warn" title="No year is shared by every selected agency">
          There is no year in which all of these agencies have a published value for
          {' '}{metric.label.toLowerCase()}, so a single common base does not exist. Each line is
          instead rebased to its own first available year, named in the legend. Movements are
          therefore measured from different starting points and are not directly comparable.
        </Notice>
      )}

      <div style={{ marginTop: 14 }}>
        <MultiSeries
          series={series}
          unit="index"
          valueLabel={`${metric.label}, indexed`}
          yZero={false}
          format={(n) => fmtDecimal(n, 0)}
          reference={{ value: 100, label: 'base = 100' }}
          ariaLabel={`${metric.label} indexed to ${commonBase ?? 'each agency’s first available year'} for ${series.map((s) => s.label).join(', ')}`}
        />
      </div>

      <p className="question" style={{ marginTop: 10 }}>
        A gap in a line is a year the agency did not report or the platform withheld; the index
        is not carried across it.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ change ----------- */

function ChangePanel({ trends, ids, names, metric, years, from, to, onYears }: {
  trends: TrendRow[];
  ids: string[];
  names: Record<string, string>;
  metric: MetricDef;
  years: number[];
  from: number;
  to: number;
  onYears: (from: number, to: number) => void;
}) {
  const rowsFor = (id: string, y: number) => trends.find((t) => t.agency_id === id && t.data_year === y);

  return (
    <>
      <div className="controls" style={{ marginBottom: 12 }}>
        <div className="field">
          <label htmlFor="chg-from">From year</label>
          <select id="chg-from" value={from} onChange={(e) => onYears(Number(e.target.value), to)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="chg-to">To year</label>
          <select id="chg-to" value={to} onChange={(e) => onYears(from, Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <span className="chip chip-outline">{metric.label} · {metric.unit}</span>
      </div>

      {from === to && (
        <Notice tone="warn" title="Both endpoints are the same year">
          Choose two different years to measure a change.
        </Notice>
      )}

      <div className="tablewrap">
        <table className="data">
          <caption className="sr-only">
            Change in {metric.label} between {from} and {to} for each selected agency.
          </caption>
          <thead>
            <tr>
              <th scope="col">Agency</th>
              <th className="n" scope="col">{from}</th>
              <th className="n" scope="col">{to}</th>
              <th className="n" scope="col">Absolute change</th>
              <th className="n" scope="col">Percent change</th>
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => {
              const a = readMetric(rowsFor(id, from), metric);
              const b = readMetric(rowsFor(id, to), metric);
              const suppressed = a.value === null || b.value === null;
              const abs = suppressed ? null : (b.value as number) - (a.value as number);
              const pct = suppressed ? null : pctChange(a.value, b.value);
              const reason = a.value === null
                ? `${from}: ${a.reason ?? 'no value'}`
                : `${to}: ${b.reason ?? 'no value'}`;
              return (
                <tr key={id}>
                  <td className="wide">
                    <Link to={`/agencies/${id}`}>{names[id] ?? id}</Link>
                  </td>
                  <td className="n">
                    {a.value === null
                      ? <Withheld tone="neutral" reason={a.reason ?? 'Not available'} />
                      : formatMetric(metric, a.value)}
                  </td>
                  <td className="n">
                    {b.value === null
                      ? <Withheld tone="neutral" reason={b.reason ?? 'Not available'} />
                      : formatMetric(metric, b.value)}
                  </td>
                  <td className="n" colSpan={suppressed ? 2 : 1}>
                    {suppressed
                      ? <Withheld reason={`Change not computed — ${reason}`} />
                      : <span className={`num ${deltaClass(pct)}`}>
                          <span aria-hidden="true">{(abs as number) > 0 ? '▲ ' : (abs as number) < 0 ? '▼ ' : ''}</span>
                          {(abs as number) > 0 ? '+' : ''}{formatMetric(metric, abs)}
                        </span>}
                  </td>
                  {!suppressed && (
                    <td className="n">
                      <span className={`num ${deltaClass(pct)}`}>{fmtDelta(pct)}</span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="question" style={{ marginTop: 10 }}>
        A change is computed only where both endpoints are published values. Where either end
        is missing or withheld, the cell states which year failed and why rather than showing a
        change of zero. The arrow and colour mark direction only; an increase is not a
        judgment, and a change measured across a year of partial reporting reflects reporting
        as much as it reflects incidence.
      </p>
    </>
  );
}
