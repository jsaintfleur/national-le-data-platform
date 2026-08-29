/**
 * State comparison.
 *
 * A table of states is the easiest place in this product to publish a false comparison. Two
 * states differ here for three unrelated reasons — how much law enforcement they have, how
 * much crime was reported, and how many of their agencies participated in the reporting
 * programme that year — and the third reason moves the first two. So participation and
 * population coverage sit in the table as columns of equal weight, not as a footnote, and
 * sorting never lets a missing value pass as a small one: nulls sink to the bottom in both
 * directions.
 *
 * The year lives in the URL because a state comparison is something people send to each
 * other, and a link that silently resolves to "whatever the latest release is" is a link
 * that will one day disagree with the message it was pasted into.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { DASH, fmt, fmtPct, fmtRate } from '../lib/format';
import { ErrorState, Loading, MetricTile, Notice, useAsync, Withheld } from '../components/primitives';

interface StateRow {
  state_abbr: string;
  data_year: number;
  agencies: number | null;
  agencies_participating: number | null;
  sworn_officers: number | null;
  civilian_personnel: number | null;
  violent_offenses_full_year: number | null;
  violent_crime_rate: number | null;
  population_coverage: number | null;
  full_year_reporters: number | null;
  partial_reporters: number | null;
  non_reporters: number | null;
}

interface StatesResponse {
  year: number;
  states: StateRow[];
}

type SortId = 'state_abbr' | 'agencies' | 'agencies_participating' | 'sworn_officers'
  | 'violent_crime_rate' | 'population_coverage' | 'full_year_reporters'
  | 'partial_reporters' | 'non_reporters';

const COLUMNS: { id: SortId; label: string; numeric: boolean; help?: string }[] = [
  { id: 'state_abbr', label: 'State', numeric: false },
  { id: 'agencies', label: 'Agencies', numeric: true, help: 'Agencies in the directory for this state-year' },
  { id: 'agencies_participating', label: 'Participating', numeric: true, help: 'Agencies carrying the source participation flag for this year — a different measure from the reporting counts, and not always larger' },
  { id: 'sworn_officers', label: 'Sworn officers', numeric: true },
  { id: 'violent_crime_rate', label: 'Violent crime rate', numeric: true, help: 'Per 100,000 residents covered by full-year reporters' },
  { id: 'population_coverage', label: 'Population coverage', numeric: true, help: 'Share of residents served by agencies that reported all twelve months' },
  { id: 'full_year_reporters', label: 'Full year', numeric: true },
  { id: 'partial_reporters', label: 'Partial', numeric: true },
  { id: 'non_reporters', label: 'None', numeric: true },
];

export default function States() {
  const [params, setParams] = useSearchParams();
  const yearParam = params.get('year');
  const year = yearParam ? Number(yearParam) : undefined;
  const sort = (params.get('sort') as SortId) || 'sworn_officers';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';

  const { data, loading, error, retry } = useAsync<StatesResponse>(
    () => api.states(year), [year],
  );
  // The selector needs the years the release actually contains; the states payload only
  // carries the one year it answered with. The overview response is cached by the client.
  const overview = useAsync(() => api.overview(), []);
  const years = overview.data?.trend.map((t) => t.data_year).slice().reverse() ?? [];

  const rows = useMemo<StateRow[]>(() => data?.states ?? [], [data]);

  // agencies_participating arrives as 0 for every state in years where the platform did not
  // compute participation. A state with 33 full-year reporters did not have zero agencies
  // participate, so 0 is read as "not established" rather than printed as a count.
  const participationKnown = rows.some((r) => (r.agencies_participating ?? 0) > 0);

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.id === sort);
    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (!col?.numeric) return a.state_abbr.localeCompare(b.state_abbr) * factor;
      const av = value(a, sort, participationKnown);
      const bv = value(b, sort, participationKnown);
      if (av == null && bv == null) return a.state_abbr.localeCompare(b.state_abbr);
      if (av == null) return 1;   // missing values sink in both directions
      if (bv == null) return -1;
      return (av - bv) * factor || a.state_abbr.localeCompare(b.state_abbr);
    });
  }, [rows, sort, dir, participationKnown]);

  const rollup = useMemo(() => summarise(rows), [rows]);

  const setSort = (id: SortId) => {
    const next = new URLSearchParams(params);
    if (id === sort) next.set('dir', dir === 'asc' ? 'desc' : 'asc');
    else { next.set('sort', id); next.set('dir', id === 'state_abbr' ? 'asc' : 'desc'); }
    setParams(next, { replace: true });
  };

  const setYear = (y: string) => {
    const next = new URLSearchParams(params);
    if (y) next.set('year', y); else next.delete('year');
    setParams(next);
  };

  const shownYear = data?.year ?? year ?? null;

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">States</div>
        <h1>Law enforcement by state</h1>
        <p className="question">How does law enforcement differ between states?</p>
        <p>
          Each row is a sum over the agencies in one state that appear in the release for the
          selected year. States differ in how many agencies they have, how those agencies are
          organised, and how completely they reported — the last of these is in the table
          rather than behind it.
        </p>
      </header>

      <div className="controls" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="year">Data year</label>
          <select id="year" value={shownYear ?? ''} onChange={(e) => setYear(e.target.value)}>
            {shownYear != null && !years.includes(shownYear) && <option value={shownYear}>{shownYear}</option>}
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {shownYear != null && <span className="chip chip-outline">{rows.length} states and territories</span>}
      </div>

      {loading && <div className="card"><Loading rows={6} label="Loading states" /></div>}
      {error && <div className="card"><ErrorState error={error} retry={retry} /></div>}

      {!loading && !error && rows.length === 0 && (
        <div className="card">
          <div className="state-block">
            <div className="title">No state figures for {shownYear ?? 'that year'}</div>
            <div>This release carries no state-level rows for the selected year. Choose another year.</div>
          </div>
        </div>
      )}

      {!loading && !error && rows.length > 0 && shownYear != null && (
        <>
          <div className="grid g4">
            <MetricTile
              label="States and territories"
              value={fmt(rows.length)}
              year={shownYear}
              note="Rows present in this release for the selected year. Territories appear only in the years they reported."
            />
            <MetricTile
              label="Agencies, summed across states"
              value={fmt(rollup.agencies)}
              year={shownYear}
              note="Sum of the per-state counts below, which cover agencies with an observation in this year. It is smaller than the national directory count on the Overview."
            />
            <MetricTile
              label="Sworn officers, summed across states"
              value={fmt(rollup.sworn)}
              year={shownYear}
              chips={rollup.swornMissing > 0
                ? <span className="chip chip-warn">{rollup.swornMissing} state{rollup.swornMissing > 1 ? 's' : ''} not included</span>
                : undefined}
              note={rollup.swornMissing > 0
                ? 'Sum across the states that published a staffing figure. States without one are omitted from the sum, not counted as zero.'
                : 'Sum across every state in the table.'}
            />
            <MetricTile
              label="Median population coverage"
              value={rollup.medianCoverage == null ? DASH : fmtPct(rollup.medianCoverage)}
              withheldReason={rollup.medianCoverage == null ? 'No state published a coverage figure for this year' : null}
              year={shownYear}
              chips={rollup.coverageMissing > 0
                ? <span className="chip chip-warn">{rollup.coverageMissing} state{rollup.coverageMissing > 1 ? 's' : ''} without a figure</span>
                : undefined}
              note="Median across states, not a national coverage rate. A national rate weights by population and is on the Overview."
            />
          </div>

          {!participationKnown && (
            <div style={{ marginTop: 16 }}>
              <Notice tone="warn" title={`Participation was not established for ${shownYear}`}>
                The release carries no agency-participation count for any state in this year, so the
                participating column is shown as unavailable rather than as zero. Full-year, partial
                and non-reporter counts are unaffected and are in the table.
              </Notice>
            </div>
          )}

          <section className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <div>
                <h2>All states, {shownYear}</h2>
                <div className="question">Sort any column. Missing values stay at the bottom in both directions.</div>
              </div>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div className="tablewrap">
                <table className="data">
                  <caption className="sr-only">
                    Law enforcement agencies, staffing, reported violent crime and reporting coverage by state for {shownYear}
                  </caption>
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.id}
                          scope="col"
                          className={`sortable${c.numeric ? ' n' : ''}`}
                          title={c.help}
                          aria-sort={sort === c.id ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        >
                          <button
                            className="th-sort"
                            onClick={() => setSort(c.id)}
                            aria-label={`Sort by ${c.label}`}
                          >
                            {c.label}
                            <span aria-hidden="true">{sort === c.id ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r) => (
                      <tr key={r.state_abbr}>
                        <td><Link to={`/states/${r.state_abbr}`}>{r.state_abbr}</Link></td>
                        <td className="n">{fmt(r.agencies)}</td>
                        <td className="n">
                          {participationKnown && (r.agencies_participating ?? 0) > 0
                            ? fmt(r.agencies_participating)
                            : <Withheld tone="neutral" reason="Not established" />}
                        </td>
                        <td className="n">
                          {r.sworn_officers == null
                            ? <Withheld tone="neutral" reason="Not reported" />
                            : fmt(r.sworn_officers)}
                        </td>
                        <td className="n">
                          {r.violent_crime_rate == null
                            ? <Withheld reason="Not published" />
                            : fmtRate(r.violent_crime_rate)}
                        </td>
                        <td className="n">
                          {r.population_coverage == null
                            ? <Withheld tone="neutral" reason="No denominator" />
                            : fmtPct(r.population_coverage)}
                        </td>
                        <td className="n">{fmt(r.full_year_reporters)}</td>
                        <td className="n">{fmt(r.partial_reporters)}</td>
                        <td className="n">{fmt(r.non_reporters)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card-foot">
              State totals are sums over the agencies that reported, so they move with
              participation and not only with crime or staffing. A state whose reporting
              improved between two years will show more offences and more officers on that
              account alone. A violent crime rate is published only where the state has
              full-year reporters and a population denominator for the same year; where it is
              not published the offence counts still exist and are on the state profile.
            </div>
          </section>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ helpers ---------- */

function value(r: StateRow, id: SortId, participationKnown: boolean): number | null {
  if (id === 'state_abbr') return null;
  if (id === 'agencies_participating') {
    const v = r.agencies_participating;
    return participationKnown && v != null && v > 0 ? v : null;
  }
  return r[id];
}

function summarise(rows: StateRow[]) {
  const swornRows = rows.filter((r) => r.sworn_officers != null);
  const coverage = rows.map((r) => r.population_coverage).filter((c): c is number => c != null).sort((a, b) => a - b);
  const mid = Math.floor(coverage.length / 2);
  return {
    agencies: rows.reduce((s, r) => s + (r.agencies ?? 0), 0),
    sworn: swornRows.reduce((s, r) => s + (r.sworn_officers ?? 0), 0),
    swornMissing: rows.length - swornRows.length,
    coverageMissing: rows.length - coverage.length,
    medianCoverage: coverage.length === 0 ? null
      : coverage.length % 2 ? coverage[mid] : (coverage[mid - 1] + coverage[mid]) / 2,
  };
}
