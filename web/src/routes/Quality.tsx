/**
 * The Data Quality Center.
 *
 * This screen exists because the platform's claim is that it respects uncertainty, and a
 * claim of that kind is only worth anything if the uncertainty is enumerated somewhere a
 * reader can reach. Everything here is a count of a known problem, not a score.
 *
 * The single rule that shapes the page: coverage is a property of the evidence, not of the
 * department. An agency that reported seven months is less measured, not worse. Nothing on
 * this page is ordered, coloured or worded so that "more data" reads as "better agency", and
 * the ramp on the heatmap is a coverage ramp with its number printed in every cell.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { agencyTypeLabel, coverageChip, DASH, fmt, fmtPct } from '../lib/format';
import { BarRows, ChartFrame, TimeSeries } from '../components/charts';
import type { Point } from '../components/charts';
import {
  EmptyState, ErrorState, Loading, MetricTile, Notice, useAsync, Withheld,
} from '../components/primitives';

/* ------------------------------------------------------------------ shapes ----------- */

interface GeoResolutionRow { status: string; match_method: string; n: number }
interface GeoTotals { agencies: number; accepted: number; needs_review: number; unmatched: number }
interface UnmatchedType { agency_type: string; n: number }
interface IdentifierResolution {
  agencies: number; from_legacy_ori: number; fallback: number; no_legacy_ori: number;
}
interface AmbiguousOri { ori7: string; agencies: number }
interface CoverageYear {
  data_year: number; full_year: number; partial: number; none_reported: number;
  agency_years: number; population_coverage: number | null;
}
interface HeatCell {
  state_abbr: string; data_year: number; full_year_reporters: number; partial_reporters: number;
  non_reporters: number; agency_years: number; population_coverage: number | null;
}
interface Check { check_id: string; severity: string; n: number; message: string }

interface QualityPayload {
  release: { release_id: string; built_at: string | null; git_commit: string | null };
  geography_resolution: GeoResolutionRow[];
  geography_totals: GeoTotals;
  unmatched_by_type: UnmatchedType[];
  identifier_resolution: IdentifierResolution;
  ambiguous_ori7: AmbiguousOri[];
  coverage_by_year: CoverageYear[];
  coverage_heatmap: HeatCell[];
  checks: Check[];
}

interface CoverageAgency {
  agency_id: string; agency_name: string; agency_type: string; state_abbr: string;
  months_reported: number | null; coverage_status: string | null;
  violent_crime_offenses: number | null; population: number | null;
  rate_allowed: boolean; rate_withheld_reason: string | null;
}
interface CoverageDetail {
  year: number; state: string | null; status: string | null; agencies: CoverageAgency[];
}

interface FlagRow {
  entity_id: string; data_year: number | null; observed: string | null; expected: string | null;
  severity: string; message: string; agency_name: string | null; state_abbr: string | null;
}

const DETAIL_LIMIT = 200;
const SEVERITIES: { id: string; label: string; tone: 'crit' | 'warn' | 'info' }[] = [
  { id: 'error', label: 'Error', tone: 'crit' },
  { id: 'warning', label: 'Warning', tone: 'warn' },
  { id: 'info', label: 'Information', tone: 'info' },
];

/* ------------------------------------------------------------------ page ------------- */

export default function Quality() {
  const { data, loading, error, retry } = useAsync<QualityPayload>(() => api.quality(), []);

  if (loading) return <div className="card"><Loading rows={6} label="Loading data quality" /></div>;
  if (error) return <div className="card"><ErrorState error={error} retry={retry} /></div>;
  if (!data) return <EmptyState title="No quality report in this release" />;

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Data quality</div>
        <h1>Data Quality Center</h1>
        <p className="question">How much confidence should I place in these numbers?</p>
        <p>
          Every count below is a known limitation of the evidence in release{' '}
          <code>{data.release.release_id}</code>, published rather than absorbed. Nothing here is
          a judgment about an agency.
        </p>
      </header>

      <Notice tone="info" title="Reporting coverage is not agency performance">
        An agency that reported fewer months is <strong>less measured</strong>, not worse. The
        FBI's collections are voluntary, submission is a records-management and IT question far
        more than a policing one, and this platform has no basis for reading a coverage figure as
        a statement about a department. Where coverage is short, the platform shows the counts the
        agency did report and withholds the annual rate, with the reason attached.
      </Notice>

      <GeographySection
        totals={data.geography_totals}
        resolution={data.geography_resolution}
        unmatched={data.unmatched_by_type}
      />

      <IdentifierSection
        resolution={data.identifier_resolution}
        ambiguous={data.ambiguous_ori7}
      />

      <ReportingCoverageSection years={data.coverage_by_year} />

      <HeatmapSection cells={data.coverage_heatmap} />

      <CheckRegisterSection checks={data.checks} />
    </>
  );
}

/* ------------------------------------------------------------------ geography -------- */

function GeographySection({ totals, resolution, unmatched }: {
  totals: GeoTotals; resolution: GeoResolutionRow[]; unmatched: UnmatchedType[];
}) {
  const byStatus = useMemo(() => {
    const groups = new Map<string, GeoResolutionRow[]>();
    for (const r of resolution) {
      const list = groups.get(r.status) ?? [];
      list.push(r);
      groups.set(r.status, list);
    }
    for (const list of groups.values()) list.sort((a, b) => b.n - a.n);
    // Preferred order first, then any status the resolver starts emitting later. A status this
    // component has not heard of must still appear; silently dropping one would understate the
    // universe on the page whose subject is exactly that.
    const preferred = ['accepted', 'needs_review', 'unmatched'];
    const order = [...preferred, ...[...groups.keys()].filter((s) => !preferred.includes(s))];
    return order
      .filter((s) => groups.has(s))
      .map((s) => [s, groups.get(s) as GeoResolutionRow[]] as const);
  }, [resolution]);

  const unmatchedTotal = unmatched.reduce((s, r) => s + r.n, 0);
  const structural = unmatched
    .filter((r) => r.agency_type !== 'municipal_police')
    .reduce((s, r) => s + r.n, 0);

  return (
    <section style={{ marginTop: 18 }}>
      <h2 style={{ marginBottom: 10 }}>Jurisdiction resolution</h2>
      <p className="question" style={{ marginBottom: 12 }}>
        No federal source publishes a crosswalk between a police agency and the place it polices,
        so this platform builds one and records how each link was made.
      </p>

      <div className="grid g4">
        <MetricTile label="Agencies in the universe" value={fmt(totals.agencies)} />
        <MetricTile
          label="Link accepted" value={fmt(totals.accepted)}
          note={`${fmtPct(totals.accepted / totals.agencies, 1)} of agencies. A per-resident rate is published only from an accepted link.`}
        />
        <MetricTile
          label="Needs human review" value={fmt(totals.needs_review)}
          chips={<span className="chip chip-warn">Rate withheld</span>}
          note="Matched provisionally, below the confidence the platform will publish a rate on."
        />
        <MetricTile
          label="Unmatched" value={fmt(totals.unmatched)}
          chips={<span className="chip chip-outline">Often the correct answer</span>}
          note="Shown at state level with counts and no per-resident rate."
        />
      </div>

      <div className="grid g2" style={{ marginTop: 14, alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>How each link was made</h2>
              <div className="question">The method and its review status travel with every agency.</div>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Match method</th>
                    <th className="n">Agencies</th>
                    <th className="n">Share of agencies</th>
                  </tr>
                </thead>
                {byStatus.map(([status, rows]) => {
                  const subtotal = rows.reduce((s, r) => s + r.n, 0);
                  return (
                    <tbody key={status}>
                      <tr>
                        <th scope="rowgroup" style={{ background: 'var(--panel)' }}>
                          <span className={
                            status === 'accepted' ? 'chip chip-ok'
                              : status === 'needs_review' ? 'chip chip-warn' : 'chip chip-outline'
                          }>
                            {status.replace(/_/g, ' ')}
                          </span>
                        </th>
                        <td className="n num" style={{ background: 'var(--panel)', fontWeight: 600 }}>
                          {fmt(subtotal)}
                        </td>
                        <td className="n num" style={{ background: 'var(--panel)', fontWeight: 600 }}>
                          {fmtPct(subtotal / totals.agencies, 0)}
                        </td>
                      </tr>
                      {rows.map((r) => (
                        <tr key={`${status}-${r.match_method}`}>
                          <td className="wide" style={{ paddingLeft: 26 }}>
                            <code style={{ fontSize: 12 }}>{r.match_method}</code>
                          </td>
                          <td className="n num">{fmt(r.n)}</td>
                          <td className="n num">{fmtPct(r.n / totals.agencies, 1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          </div>
          <div className="card-foot">
            Shares are of the whole agency universe. A fuzzy name match is only accepted when a
            second, independent signal — distance, or a unique name within the state —
            corroborates it.
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>What is unmatched, and why that is usually right</h2>
              <div className="question">Unmatched agencies by type.</div>
            </div>
          </div>
          <div className="card-body">
            <BarRows
              ariaLabel="Unmatched agencies by agency type"
              rows={unmatched
                .slice()
                .sort((a, b) => b.n - a.n)
                .map((r) => ({ label: agencyTypeLabel(r.agency_type), value: r.n }))}
            />
            <p className="question" style={{ marginTop: 14 }}>
              {fmt(structural)} of the {fmt(unmatchedTotal)} unmatched agencies are university,
              park and conservation, special-jurisdiction, marshal, tribal, port and transit
              agencies. None of these polices a municipality, so there is no municipality for the
              resolver to find: a campus, a highway network, a state park system and a
              constable's precinct are not Census places. For those agencies{' '}
              <strong>unmatched is the correct answer</strong>, not a resolution failure, and the
              platform reports their counts at state level rather than inventing a denominator.
            </p>
            <p className="question" style={{ marginTop: 8 }}>
              The genuine backlog is the{' '}
              {fmt(unmatched.find((r) => r.agency_type === 'municipal_police')?.n ?? 0)} municipal
              departments that should match a place and did not. Those are a work item.
            </p>
          </div>
        </section>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ identifiers ------ */

function IdentifierSection({ resolution, ambiguous }: {
  resolution: IdentifierResolution; ambiguous: AmbiguousOri[];
}) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Identifier resolution</h2>

      <div className="card">
        <div className="card-body prose">
          <p>
            An ORI is a <em>reporting</em> identifier, not an agency key. The nine-character NIBRS
            ORI identifies a submitting endpoint; the seven-character legacy ORI that the Police
            Employee master file is keyed on is shorter, older, and reused. One ORI7 can therefore
            stand for several distinct agencies — fourteen of them share <code>CA01999</code> — and
            a single agency can appear under more than one ORI across years and collections. Joining
            two federal files on an ORI and assuming one row means one department is the most common
            way to attribute one department's officers to another.
          </p>
          <p>
            The platform derives an ORI7 from the legacy ORI where one has been observed in any
            ingested year, and falls back to the NIBRS ORI otherwise. A fallback ORI7 is marked
            provisional on the agency's profile. Where an ORI7 is shared, staffing from the bulk
            file is <strong>refused rather than attributed</strong>, except where one agency is both
            the primary ORI for the block and an unambiguous name match. The refused records are
            counted in the staffing reconciliation ledger rather than quietly dropped.
          </p>
        </div>
      </div>

      <div className="grid g4" style={{ marginTop: 14 }}>
        <MetricTile label="Agencies with an identity" value={fmt(resolution.agencies)} />
        <MetricTile
          label="ORI7 from an observed legacy ORI" value={fmt(resolution.from_legacy_ori)}
          note={`${fmtPct(resolution.from_legacy_ori / resolution.agencies, 1)} of agencies.`}
          chips={<span className="chip chip-ok">Confirmed</span>}
        />
        <MetricTile
          label="ORI7 derived from the NIBRS ORI" value={fmt(resolution.fallback)}
          chips={<span className="chip chip-warn">Provisional</span>}
          note="No legacy ORI was observed in any ingested year, so the key is inferred."
        />
        <MetricTile
          label="ORI7 values shared by more than one agency" value={fmt(ambiguous.length)}
          note="Listed below. Bulk staffing keyed on these is refused, not guessed."
        />
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h2>Ambiguous ORI7 register</h2>
            <div className="question">
              Each of these seven-character identifiers maps to more than one agency.
            </div>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="tablewrap">
            <table className="data">
              <caption className="sr-only">ORI7 values shared by more than one agency</caption>
              <thead>
                <tr>
                  <th>ORI7</th>
                  <th className="n">Agencies sharing it</th>
                  <th>Consequence</th>
                  <th>Look up</th>
                </tr>
              </thead>
              <tbody>
                {ambiguous.map((a) => (
                  <tr key={a.ori7}>
                    <td><code>{a.ori7}</code></td>
                    <td className="n num">{fmt(a.agencies)}</td>
                    <td className="wide">
                      A Police Employee record keyed on this ORI7 cannot be attributed to one of
                      the {a.agencies} agencies, so none of them receives it.
                    </td>
                    <td><Link to={`/agencies?q=${encodeURIComponent(a.ori7)}`}>See the agencies</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-foot">
          Refusing an ambiguous record costs a real agency its staffing series for that year. The
          alternative — attributing it to whichever agency was read first — puts one department's
          officers inside another department's profile, which is worse and invisible.
        </div>
      </section>
    </section>
  );
}

/* ------------------------------------------------------------------ coverage --------- */

function ReportingCoverageSection({ years }: { years: CoverageYear[] }) {
  const points: Point[] = years.map((y) => ({
    x: y.data_year,
    y: y.population_coverage,
    withheldReason: y.population_coverage === null
      ? 'No population estimate series for this year'
      : null,
  }));

  const y2021 = years.find((y) => y.data_year === 2021);
  const latest = years[years.length - 1];

  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Reporting coverage</h2>

      <ChartFrame
        title="Share of the national population covered by a full-year reporter"
        subtitle="The denominator of every national figure. Where the line breaks, no population estimate series exists for that year, so the share cannot be computed and is not guessed."
        footer={
          <span>
            Reporting completeness is measured from the twelve monthly reported flags in the FBI's
            master files, not assumed from the presence of a record.
          </span>
        }
      >
        <TimeSeries
          points={points}
          ariaLabel="Population coverage by data year"
          valueLabel="Population coverage"
          format={(n) => `${Math.round(n * 100)}%`}
          yZero
        />
      </ChartFrame>

      {y2021 && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn" title={`2021: population coverage fell to ${fmtPct(y2021.population_coverage, 0)}`}>
            2021 is the year the FBI retired the Summary Reporting System and moved the national
            collection to NIBRS. Agencies that had not completed the transition — including several
            of the largest departments in the country — submitted nothing or part of a year. Full-year
            reporters fell from {fmt(years.find((y) => y.data_year === 2020)?.full_year)} in 2020 to{' '}
            {fmt(y2021.full_year)}, and non-reporters rose to {fmt(y2021.none_reported)}. National and
            state totals for 2021 are drawn from a materially smaller universe than the years on
            either side of them, and a 2021-to-2022 change is partly a change in who reported. The
            platform does not backfill the gap, and does not adjust 2021 to make the series look
            continuous.
          </Notice>
        </div>
      )}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h2>Reporting by year</h2>
            <div className="question">
              Agency-years by coverage status. An agency counted as not reporting is absent from the
              data, not observed at zero.
            </div>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="tablewrap">
            <table className="data">
              <caption className="sr-only">Reporting coverage by data year</caption>
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="n">Full-year reporters</th>
                  <th className="n">Partial reporters</th>
                  <th className="n">Not reporting</th>
                  <th className="n">Agency-years</th>
                  <th className="n">Population coverage</th>
                </tr>
              </thead>
              <tbody>
                {years.map((y) => (
                  <tr key={y.data_year}>
                    <td className="num">{y.data_year}</td>
                    <td className="n num">{fmt(y.full_year)}</td>
                    <td className="n num">{fmt(y.partial)}</td>
                    <td className="n num">{fmt(y.none_reported)}</td>
                    <td className="n num">{fmt(y.agency_years)}</td>
                    <td className="n">
                      {y.population_coverage === null
                        ? <Withheld tone="neutral" reason="No population series" />
                        : <span className="num">{fmtPct(y.population_coverage, 1)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-foot">
          {latest && (
            <>The {latest.data_year} row is the current release's most recent data year; agency-years
            below the earlier total reflect the collection still being open, not agencies leaving
            the universe.</>
          )}
        </div>
      </section>
    </section>
  );
}

/* ------------------------------------------------------------------ heatmap ---------- */

function rampClass(c: number | null): string {
  if (c === null) return 'hm-none';
  if (c < 0.60) return 'hm-1';
  if (c < 0.75) return 'hm-2';
  if (c < 0.85) return 'hm-3';
  if (c < 0.95) return 'hm-4';
  return 'hm-5';
}

function HeatmapSection({ cells }: { cells: HeatCell[] }) {
  const [sel, setSel] = useState<{ state: string; year: number } | null>(null);
  const [status, setStatus] = useState('');

  const { years, states, index } = useMemo(() => {
    const ys = Array.from(new Set(cells.map((c) => c.data_year))).sort((a, b) => a - b);
    const ss = Array.from(new Set(cells.map((c) => c.state_abbr))).sort();
    const ix = new Map<string, HeatCell>();
    for (const c of cells) ix.set(`${c.state_abbr}|${c.data_year}`, c);
    return { years: ys, states: ss, index: ix };
  }, [cells]);

  return (
    <section style={{ marginTop: 20 }}>
      <section className="card">
        <div className="card-head">
          <div>
            <h2>Coverage by state and year</h2>
            <div className="question">
              Share of each state's population covered by a full-year reporter. Select a cell to
              list the agencies behind it.
            </div>
          </div>
          <div className="hm-key" aria-hidden="true">
            <i className="hm-1" /><i className="hm-2" /><i className="hm-3" /><i className="hm-4" /><i className="hm-5" />
          </div>
        </div>
        <div className="card-body">
          <div className="legend" style={{ marginBottom: 10 }}>
            <span><i className="sw hm-1" />under 60%</span>
            <span><i className="sw hm-2" />60–75%</span>
            <span><i className="sw hm-3" />75–85%</span>
            <span><i className="sw hm-4" />85–95%</span>
            <span><i className="sw hm-5" />95% and above</span>
            <span><i className="sw hm-none" style={{ border: '1px solid var(--rule)' }} />no population series for that year</span>
          </div>

          <div className="heatmap-scroll">
            <table className="heatmap">
              <caption className="sr-only">
                Population coverage by state and data year, as a percentage. Cells reading “{DASH}”
                have no population estimate series for that year and are not zero.
              </caption>
              <thead>
                <tr>
                  <th className="corner" scope="col">State</th>
                  {years.map((y) => <th key={y} scope="col">{y}</th>)}
                </tr>
              </thead>
              <tbody>
                {states.map((s) => (
                  <tr key={s}>
                    <th scope="row">{s}</th>
                    {years.map((y) => {
                      const c = index.get(`${s}|${y}`);
                      const cov = c?.population_coverage ?? null;
                      const on = sel?.state === s && sel?.year === y;
                      const label = c
                        ? `${s} ${y}: ${cov === null ? 'population coverage not available' : `${Math.round(cov * 100)} percent population coverage`}, ${c.full_year_reporters} full-year reporters, ${c.partial_reporters} partial, ${c.non_reporters} not reporting`
                        : `${s} ${y}: no observation`;
                      return (
                        <td key={y}>
                          <button
                            type="button"
                            className={`hm-cell ${rampClass(cov)}`}
                            aria-pressed={on}
                            aria-label={label}
                            title={label}
                            onClick={() => { setSel({ state: s, year: y }); setStatus(''); }}
                          >
                            {cov === null ? DASH : Math.round(cov * 100)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-foot">
          Coverage varies with state reporting programmes, statutory mandates and records-system
          transitions. A low cell says the platform knows less about that state in that year. It
          does not say anything about policing there.
        </div>
      </section>

      {sel
        ? <CoverageDrilldown sel={sel} status={status} onStatus={setStatus} onClose={() => setSel(null)} />
        : (
          <div className="card" style={{ marginTop: 14 }}>
            <EmptyState
              title="No cell selected"
              detail="Select a state and year in the grid above to list the agencies behind that cell, with the months each one reported."
            />
          </div>
        )}
    </section>
  );
}

function CoverageDrilldown({ sel, status, onStatus, onClose }: {
  sel: { state: string; year: number };
  status: string;
  onStatus: (s: string) => void;
  onClose: () => void;
}) {
  const { data, loading, error, retry } = useAsync<CoverageDetail>(
    () => api.qualityCoverage(sel.year, { state: sel.state, status: status || undefined, limit: DETAIL_LIMIT }),
    [sel.state, sel.year, status],
  );

  const rows = data?.agencies ?? [];

  return (
    <section className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <div>
          <h2>{sel.state} · {sel.year}</h2>
          <div className="question">
            Agencies in this cell, largest population first. Months reported come from the source's
            monthly flags, not from an assumption.
          </div>
        </div>
        <div className="controls">
          <div className="field">
            <label htmlFor="cov-status">Coverage status</label>
            <select id="cov-status" value={status} onChange={(e) => onStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="COMPLETE">Complete — twelve months</option>
              <option value="PARTIAL">Partial — one to eleven months</option>
              <option value="NONE">None — zero months</option>
              <option value="UNKNOWN">Unknown — no submission record</option>
            </select>
          </div>
          <button className="btn" onClick={onClose}>Clear selection</button>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {loading && <Loading rows={4} label={`Loading ${sel.state} ${sel.year}`} />}
        {!!error && <ErrorState error={error} retry={retry} />}
        {!loading && !error && rows.length === 0 && (
          <EmptyState
            title="No agencies match this filter"
            detail={`No ${sel.state} agency in ${sel.year} has the selected coverage status in this release.`}
          />
        )}
        {!loading && !error && rows.length > 0 && (
          <div className="tablewrap">
            <table className="data">
              <caption className="sr-only">
                Agencies in {sel.state} for {sel.year} with reporting coverage
              </caption>
              <thead>
                <tr>
                  <th>Agency</th>
                  <th>Type</th>
                  <th className="n">Months reported</th>
                  <th>Coverage status</th>
                  <th className="n">Violent offenses</th>
                  <th className="n">Population</th>
                  <th>Annual rate</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.agency_id}>
                    <td className="wide">
                      <Link to={`/agencies/${encodeURIComponent(a.agency_id)}`}>{a.agency_name}</Link>
                    </td>
                    <td>{agencyTypeLabel(a.agency_type)}</td>
                    <td className="n num">{a.months_reported ?? DASH}</td>
                    <td>
                      <span className={coverageChip(a.coverage_status)}>{a.coverage_status ?? 'UNKNOWN'}</span>
                    </td>
                    <td className="n num">{fmt(a.violent_crime_offenses)}</td>
                    <td className="n num">{fmt(a.population)}</td>
                    <td>
                      {a.rate_allowed
                        ? <span className="chip chip-ok">Published</span>
                        : <Withheld tone="neutral" reason={a.rate_withheld_reason ?? 'Not available'} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card-foot">
        {rows.length >= DETAIL_LIMIT
          ? <>Showing the {DETAIL_LIMIT} largest agencies by population in this cell; there are more.
              Narrow by coverage status to see the rest.</>
          : <>{fmt(rows.length)} agenc{rows.length === 1 ? 'y' : 'ies'} in this cell.
              A blank months column means no submission record exists — it is not a zero.</>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ checks ----------- */

function CheckRegisterSection({ checks }: { checks: Check[] }) {
  const [open, setOpen] = useState<string | null>(null);

  const grouped = useMemo(() => SEVERITIES.map((s) => ({
    ...s,
    rows: checks.filter((c) => c.severity === s.id).sort((a, b) => b.n - a.n),
  })), [checks]);

  const total = checks.reduce((s, c) => s + c.n, 0);

  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Validation check register</h2>

      <Notice tone="plain" title="Validation records a problem. It never repairs one.">
        Every check below observed something and wrote a log entry. Not one of them deleted a row,
        replaced a value, capped an outlier or smoothed a series. An automatic correction to a
        published federal value would be a fabrication: the platform would be publishing a number
        no source ever released, under a source's name. Where a value is implausible the platform
        shows it with the flag attached and explains what would make it implausible, which leaves
        the reader able to disagree.
      </Notice>

      <div className="grid g4" style={{ marginTop: 14 }}>
        {grouped.map((g) => (
          <MetricTile
            key={g.id}
            label={`${g.label} checks`}
            value={fmt(g.rows.length)}
            unit={g.rows.length === 1 ? 'check' : 'checks'}
            chips={<span className={`chip chip-${g.tone}`}>{fmt(g.rows.reduce((s, c) => s + c.n, 0))} entries</span>}
            note={g.rows.length === 0 ? 'No check of this severity fired in this release.' : undefined}
          />
        ))}
        <MetricTile
          label="Log entries in this release" value={fmt(total)}
          note="Each entry names an entity, a year and what was observed."
        />
      </div>

      {grouped.map((g) => (
        <section className="card" key={g.id} style={{ marginTop: 14 }}>
          <div className="card-head">
            <div>
              <h2>{g.label}</h2>
              <div className="question">
                {g.id === 'error' && 'A value the platform will not publish at all.'}
                {g.id === 'warning' && 'A value that is published with the flag attached, because the platform cannot establish that it is wrong.'}
                {g.id === 'info' && 'A structural property of the source that a reader needs in order to read the value correctly.'}
              </div>
            </div>
            <span className={`chip chip-${g.tone}`}>{fmt(g.rows.length)}</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {g.rows.length === 0 ? (
              <EmptyState
                title={`No ${g.label.toLowerCase()}-severity checks fired`}
                detail="This is the state of the current release, not an unimplemented section."
              />
            ) : (
              <div className="tablewrap">
                <table className="data">
                  <caption className="sr-only">{g.label}-severity validation checks</caption>
                  <thead>
                    <tr>
                      <th>Check</th>
                      <th className="n">Entities flagged</th>
                      <th>What it observed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((c) => (
                      <CheckRow
                        key={c.check_id}
                        check={c}
                        open={open === c.check_id}
                        onToggle={() => setOpen(open === c.check_id ? null : c.check_id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      ))}
    </section>
  );
}

function CheckRow({ check, open, onToggle }: { check: Check; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td>
          <button className="rowtoggle" onClick={onToggle} aria-expanded={open}>
            <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
            <code style={{ fontSize: 12 }}>{check.check_id}</code>
          </button>
        </td>
        <td className="n num">{fmt(check.n)}</td>
        <td className="wide">{check.message}</td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={3}><FlaggedEntities checkId={check.check_id} /></td>
        </tr>
      )}
    </>
  );
}

function FlaggedEntities({ checkId }: { checkId: string }) {
  const { data, loading, error, retry } = useAsync<{ check_id: string; rows: FlagRow[] }>(
    () => api.qualityFlag(checkId), [checkId],
  );

  if (loading) return <Loading rows={3} label="Loading flagged entities" />;
  if (error) return <ErrorState error={error} retry={retry} />;
  const rows = data?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyState title="No entities listed" detail="The check reported a count but no rows in this release." />;
  }

  const expected = rows.find((r) => r.expected)?.expected ?? null;
  const isOri7 = checkId === 'ambiguous_ori7';

  return (
    <div>
      {expected && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--muted)' }}>
          Condition tested: <strong>{expected}</strong>.
        </p>
      )}
      <div className="tablewrap">
        <table className="data">
          <caption className="sr-only">Entities flagged by {checkId}</caption>
          <thead>
            <tr>
              <th>Entity</th>
              <th>State</th>
              <th className="n">Year</th>
              <th>Observed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.entity_id}-${r.data_year ?? 'na'}-${i}`}>
                <td className="wide">
                  {r.agency_name
                    ? <Link to={`/agencies/${encodeURIComponent(r.entity_id)}`}>{r.agency_name}</Link>
                    : isOri7
                      ? <Link to={`/agencies?q=${encodeURIComponent(r.entity_id)}`}><code>{r.entity_id}</code></Link>
                      : <code>{r.entity_id}</code>}
                </td>
                <td>{r.state_abbr ?? DASH}</td>
                <td className="n num">{r.data_year ?? DASH}</td>
                <td className="wide num">{r.observed ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--muted)' }}>
        {rows.length >= DETAIL_LIMIT
          ? `The ${DETAIL_LIMIT} most recent entries are listed. `
          : `${fmt(rows.length)} entries. `}
        An entity with no agency name is a government unit, an identifier or a source record that
        does not resolve to an agency in the directory, so there is nothing to link to.
      </p>
    </div>
  );
}
