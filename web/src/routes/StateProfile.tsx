/**
 * State profile.
 *
 * A state is not an agency, and the difference matters more here than anywhere else in the
 * product. Every figure on this page is a sum over whichever agencies reported that year, so
 * the same state can appear to gain thousands of offences between two years because two
 * large departments started submitting. The trend chart is therefore never shown without the
 * coverage strip beneath it, and any year whose coverage is low is called out as not
 * comparable rather than plotted and left to speak for itself.
 *
 * The largest-agencies table is the bridge to the agency profiles. It carries each agency's
 * own coverage and its own withheld-rate reason, because a state-level average tells you
 * nothing about which departments inside it can be compared.
 */
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { CoverageStatus } from '../lib/api';
import {
  agencyTypeLabel, coverageChip, coverageLabel, DASH, fmt, fmtDecimal, fmtPct, fmtRate,
} from '../lib/format';
import { BarRows, ChartFrame, CoverageStrip, TimeSeries } from '../components/charts';
import type { Point } from '../components/charts';
import {
  EmptyState, ErrorState, Loading, MetricTile, Notice, useAsync, Withheld,
} from '../components/primitives';

interface StateSummary {
  state_abbr: string;
  data_year: number;
  agencies: number | null;
  agencies_participating: number | null;
  sworn_officers: number | null;
  civilian_personnel: number | null;
  violent_offenses_full_year: number | null;
  population_full_year_reporters: number | null;
  violent_crime_rate: number | null;
  population_coverage: number | null;
  full_year_reporters: number | null;
  partial_reporters: number | null;
  non_reporters: number | null;
  population_total: number | null;
  population_covered: number | null;
}

interface StateTrendRow {
  data_year: number;
  agencies: number | null;
  agencies_participating: number | null;
  sworn_officers: number | null;
  violent_offenses_full_year: number | null;
  violent_crime_rate: number | null;
  population_coverage: number | null;
}

interface LargestAgency {
  agency_id: string;
  agency_name: string;
  agency_type: string;
  geo_name: string | null;
  population: number | null;
  sworn_officers: number | null;
  officers_per_1k: number | null;
  violent_crime_rate: number | null;
  months_reported: number | null;
  coverage_status: CoverageStatus | null;
  rate_allowed: boolean;
  rate_withheld_reason: string | null;
}

interface StateProfileResponse {
  state: string;
  year: number;
  summary: StateSummary;
  trend: StateTrendRow[];
  composition: { agency_type: string; agencies: number | null; sworn: number | null }[];
  largest_agencies: LargestAgency[];
  quality: { agencies: number | null; accepted: number | null; needs_review: number | null; unmatched: number | null };
}

type TrendMetric = 'violent_crime_rate' | 'violent_offenses_full_year' | 'sworn_officers';

const TREND_OPTIONS: { id: TrendMetric; label: string; unit?: string; rate?: boolean }[] = [
  { id: 'violent_crime_rate', label: 'Violent crime rate', unit: 'per 100K', rate: true },
  { id: 'violent_offenses_full_year', label: 'Violent crime', unit: 'offenses' },
  { id: 'sworn_officers', label: 'Sworn officers', unit: 'officers' },
];

/** Below this share of residents, a state-year sum is not comparable with a well-covered one. */
const LOW_COVERAGE = 0.75;

export default function StateProfile() {
  const { code = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const yearParam = params.get('year');
  const year = yearParam ? Number(yearParam) : undefined;
  const metric = (params.get('metric') as TrendMetric) || 'violent_crime_rate';

  const { data, loading, error, retry } = useAsync<StateProfileResponse>(
    () => api.state(code, year), [code, year],
  );

  if (loading) return <div className="card"><Loading rows={5} label={`Loading ${code}`} /></div>;
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="card">
        <EmptyState
          title={`No state figures for ${code.toUpperCase()}`}
          detail={`${error.message}. Check the two-letter code, or return to the state list.`}
        />
        <div className="card-foot"><Link to="/states">All states</Link></div>
      </div>
    );
  }
  if (error) return <div className="card"><ErrorState error={error} retry={retry} /></div>;
  if (!data) return <div className="card"><EmptyState title={`No state figures for ${code.toUpperCase()}`} /></div>;

  const setParam = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(key, v);
    setParams(next, { replace: key === 'metric' });
  };

  return (
    <>
      <Header data={data} onYear={(y) => setParam('year', y)} />
      <Summary summary={data.summary} />

      <section style={{ marginTop: 18 }}>
        <Trend rows={data.trend} metric={metric} onMetric={(m) => setParam('metric', m)} state={data.state} />
      </section>

      <div className="grid g2" style={{ marginTop: 18, alignItems: 'start' }}>
        <Composition rows={data.composition} year={data.year} />
        <Quality quality={data.quality} state={data.state} />
      </div>

      <section style={{ marginTop: 18 }}>
        <LargestAgencies rows={data.largest_agencies} year={data.year} state={data.state} />
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ header ----------- */

function Header({ data, onYear }: { data: StateProfileResponse; onYear: (y: string) => void }) {
  const s = data.summary;
  const years = data.trend.map((t) => t.data_year).slice().reverse();
  const coverage = s.population_coverage;

  return (
    <header className="page-head">
      <div className="eyebrow">State profile</div>
      <h1>{data.state}</h1>
      <p className="question">What does law enforcement look like within this state?</p>
      <div className="controls" style={{ marginTop: 8, gap: 6 }}>
        <span className="chip chip-info">Data year {data.year}</span>
        <span className="chip chip-outline">{fmt(s.agencies)} agencies in the directory</span>
        {coverage != null && (
          <span className={`chip ${coverage >= 0.9 ? 'chip-ok' : coverage >= LOW_COVERAGE ? 'chip-info' : 'chip-warn'}`}>
            {fmtPct(coverage)} population covered
          </span>
        )}
        {coverage == null && <span className="chip chip-outline">Population coverage not established</span>}
        {(s.non_reporters ?? 0) > 0 && (
          <span className="chip chip-outline">
            {fmt(s.non_reporters)} {s.non_reporters === 1 ? 'agency' : 'agencies'} did not report
          </span>
        )}
      </div>
      <div className="controls" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="state-year">Data year</label>
          <select id="state-year" value={data.year} onChange={(e) => onYear(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <Link to="/states" className="btn" style={{ alignSelf: 'flex-end' }}>All states</Link>
      </div>
      <p>
        Every figure on this page is a sum over the agencies in {data.state} that appear in the
        release for {data.year}. It describes what was reported, not what occurred.
      </p>
    </header>
  );
}

/* ------------------------------------------------------------------ summary ---------- */

function Summary({ summary: s }: { summary: StateSummary }) {
  // 0 participating agencies alongside full-year reporters means participation was not
  // computed for this year, not that no agency took part. It is shown as unavailable.
  const participating = (s.agencies_participating ?? 0) > 0 ? s.agencies_participating : null;

  return (
    <div className="grid g3">
      <MetricTile
        label="Agencies" value={fmt(s.agencies)} year={s.data_year}
        withheldReason={s.agencies == null ? 'Not established for this year' : null}
        note="Agencies in the directory for this state, including those that did not report."
      />
      <MetricTile
        label="Agencies participating" value={fmt(participating)} year={s.data_year}
        withheldReason={participating == null ? 'Participation not established for this year' : null}
        chips={<span className="chip chip-outline">{fmt(s.full_year_reporters)} reported all twelve months</span>}
        note="Agencies carrying the source participation flag. It is a different field from the twelve-month reporting counts beside it and is sometimes lower, so the two are shown separately rather than reconciled."
      />
      <MetricTile
        label="Sworn officers" value={fmt(s.sworn_officers)} year={s.data_year}
        withheldReason={s.sworn_officers == null ? 'No staffing figure for this state-year' : null}
        note="Sum over agencies that reported staffing and whose identity resolved to one agency."
        methodology={{
          metric: 'Sworn officers, statewide',
          formula: 'sum of agency sworn officers over reporting agencies in the state',
          definition: 'Full-time sworn officers with general arrest powers, as reported to the FBI as of 31 October of the data year.',
          limitations: [
            'An agency that did not report staffing is absent from this sum, not counted as zero.',
            'The sum moves with how many agencies reported, so two years are only comparable when participation is similar.',
          ],
        }}
      />
      <MetricTile
        label="Civilian personnel" value={fmt(s.civilian_personnel)} year={s.data_year}
        withheldReason={s.civilian_personnel == null ? 'No staffing figure for this state-year' : null}
        note="Full-time non-sworn employees. Varies with what a state's agencies outsource more than with any policy choice."
      />
      <MetricTile
        label="Violent crime rate" value={fmtRate(s.violent_crime_rate)} unit="per 100K" year={s.data_year}
        withheldReason={s.violent_crime_rate == null
          ? 'No rate published for this state-year'
          : null}
        chips={s.population_covered != null
          ? <span className="chip chip-outline">Over {fmt(s.population_covered)} residents covered</span>
          : undefined}
        note="Offences reported by full-year reporters, over the population those agencies serve."
        methodology={{
          metric: 'Violent crime rate, statewide',
          formula: 'violent offences from full-year reporters ÷ population served by full-year reporters × 100,000',
          definition: 'The denominator is the covered population, not the state population, so the rate is not diluted by residents whose agency did not report.',
          limitations: [
            'A year in which few agencies reported produces a rate for a small, non-random slice of the state.',
            'Rates from years with very different coverage are not comparable with each other.',
          ],
        }}
      />
      <MetricTile
        label="Population coverage" value={fmtPct(s.population_coverage)} year={s.data_year}
        withheldReason={s.population_coverage == null ? 'No population denominator for this state-year' : null}
        chips={s.population_total != null
          ? <span className="chip chip-outline">of {fmt(s.population_total)} residents</span>
          : undefined}
        note="Share of residents served by agencies that reported all twelve months. A property of the data, not of any department."
      />
    </div>
  );
}

/* ------------------------------------------------------------------ trend ------------ */

function Trend({ rows, metric, onMetric, state }: {
  rows: StateTrendRow[]; metric: TrendMetric; onMetric: (m: TrendMetric) => void; state: string;
}) {
  const opt = TREND_OPTIONS.find((o) => o.id === metric) ?? TREND_OPTIONS[0];

  const points: Point[] = useMemo(() => rows.map((r) => {
    const v = r[metric] ?? null;
    const low = r.population_coverage != null && r.population_coverage < LOW_COVERAGE;
    return {
      x: r.data_year,
      y: v,
      partial: low && metric !== 'sworn_officers',
      count: metric === 'violent_crime_rate' ? r.violent_offenses_full_year : null,
      withheldReason: v == null
        ? (opt.rate ? 'No rate published for this year' : 'Not reported')
        : null,
    };
  }), [rows, metric, opt.rate]);

  const lowYears = rows.filter((r) => r.population_coverage != null && r.population_coverage < LOW_COVERAGE);
  const noCoverage = rows.filter((r) => r.population_coverage == null);

  return (
    <ChartFrame
      title={`${state} over time`}
      subtitle="Lines break where a year has no value. Years where fewer than three quarters of residents were covered are drawn as hollow points, because they summarise a different slice of the state."
      right={
        <div className="seg" role="tablist" aria-label="Trend metric">
          {TREND_OPTIONS.map((o) => (
            <button key={o.id} role="tab" aria-selected={o.id === metric}
                    className={o.id === metric ? 'on' : ''} onClick={() => onMetric(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      }
      footer={
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>Counts are sums over reporting agencies in {state}.</span>
          {noCoverage.length > 0 && <span>{noCoverage.length} year{noCoverage.length > 1 ? 's' : ''} without a population denominator</span>}
          <span className="legend" style={{ marginLeft: 'auto' }}>
            <span><i className="sw" style={{ background: 'var(--blue-600)' }} />Coverage at or above 75%</span>
            <span><i className="sw" style={{ background: 'var(--surface)', border: '2px solid var(--warn)' }} />Below 75% covered</span>
          </span>
        </div>
      }
    >
      <TimeSeries
        points={points}
        unit={opt.unit}
        valueLabel={opt.label}
        yZero={!opt.rate}
        format={(n) => fmt(Math.round(n))}
        ariaLabel={`${opt.label} in ${state}, by year`}
      />

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--rule-soft)' }}>
        <h3>Reporting coverage behind this line</h3>
        <div className="question">
          Population covered by full-year reporters in each year of the series.
        </div>
        <CoverageStrip years={rows} />
      </div>

      {lowYears.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn" title="Some years are not comparable with the rest of the series">
            In {lowYears.map((y) => y.data_year).join(', ')}, agencies covering less than three
            quarters of residents reported a full year — as low as{' '}
            <span className="num">{fmtPct(Math.min(...lowYears.map((y) => y.population_coverage as number)))}</span>.
            Counts for those years are sums over a smaller and non-random set of agencies. The
            platform publishes them as reported and does not scale them up to a full state.
          </Notice>
        </div>
      )}
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ composition ------ */

function Composition({ rows, year }: { rows: StateProfileResponse['composition']; year: number }) {
  const total = rows.reduce((s, r) => s + (r.agencies ?? 0), 0);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Agency composition</h2>
          <div className="question">Which kinds of agency make up this state's law enforcement?</div>
        </div>
      </div>
      <div className="card-body">
        {rows.length === 0 ? (
          <EmptyState title="No agency types recorded" detail="No agency in this state carries a classified agency type in this release." />
        ) : (
          <BarRows
            ariaLabel="Agencies by agency type in this state"
            rows={[...rows]
              .sort((a, b) => (b.agencies ?? 0) - (a.agencies ?? 0))
              .map((r) => ({
                label: agencyTypeLabel(r.agency_type),
                value: r.agencies,
                sub: r.sworn == null ? 'Sworn not reported' : `${fmt(r.sworn)} sworn`,
              }))}
          />
        )}
      </div>
      <div className="card-foot">
        {fmt(total)} agencies with a classified type, {year}. A sheriff's office, a university
        force and a state conservation police are counted in the same column here and should
        not be read as the same kind of organisation.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ quality ---------- */

function Quality({ quality: q, state }: { quality: StateProfileResponse['quality']; state: string }) {
  const total = q.agencies ?? null;
  const pct = (n: number | null) => (n == null || !total ? null : n / total);
  const rows: { label: string; value: number | null; detail: string }[] = [
    { label: 'Jurisdiction link accepted', value: q.accepted, detail: 'Matched to a place or county and reviewed. Per-resident rates are published for these agencies.' },
    { label: 'Needs review', value: q.needs_review, detail: 'Provisionally matched. No per-resident rate is published until a person confirms the link.' },
    { label: 'Unmatched', value: q.unmatched, detail: 'No municipality corresponds to the agency. Expected for university, transit, park and special-jurisdiction forces.' },
  ];

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Data quality in {state}</h2>
          <div className="question">How many agencies here can carry a per-resident rate?</div>
        </div>
        <span className="chip chip-outline">{fmt(total)} agencies</span>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr><th>Jurisdiction link</th><th className="n">Agencies</th><th className="n">Share</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="wide">
                    {r.label}
                    <div className="metric-note">{r.detail}</div>
                  </td>
                  <td className="n">{r.value == null ? DASH : fmt(r.value)}</td>
                  <td className="n">{pct(r.value) == null ? DASH : fmtPct(pct(r.value))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-foot">
        The federal government publishes no current crosswalk between an agency and the place it
        polices, so these links are built by this platform and carry a review status.{' '}
        <Link to="/quality">Data quality</Link>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ agencies --------- */

function LargestAgencies({ rows, year, state }: { rows: LargestAgency[]; year: number; state: string }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Largest agencies</h2>
          <div className="question">Ranked by sworn officers in {year}. A rate appears only where this agency's own data permits one.</div>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <EmptyState
            title={`No agency-level figures for ${state} in ${year}`}
            detail="No agency in this state has a staffing or crime observation in this release for the selected year."
          />
        ) : (
          <div className="tablewrap">
            <table className="data">
              <caption className="sr-only">Largest agencies in {state} by sworn officers, {year}</caption>
              <thead>
                <tr>
                  <th scope="col">Agency</th>
                  <th scope="col">Type</th>
                  <th scope="col">Jurisdiction</th>
                  <th scope="col" className="n">Population</th>
                  <th scope="col" className="n">Sworn</th>
                  <th scope="col" className="n">Officers per 1K</th>
                  <th scope="col" className="n">Violent rate</th>
                  <th scope="col">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.agency_id}>
                    <td className="wide"><Link to={`/agencies/${a.agency_id}`}>{a.agency_name}</Link></td>
                    <td>{agencyTypeLabel(a.agency_type)}</td>
                    <td className="wide">{a.geo_name ?? <span className="withheld neutral">No jurisdiction matched</span>}</td>
                    <td className="n">
                      {a.population == null
                        ? <Withheld tone="neutral" reason="No denominator" />
                        : fmt(a.population)}
                    </td>
                    <td className="n">{a.sworn_officers == null
                      ? <Withheld tone="neutral" reason="Not reported" />
                      : fmt(a.sworn_officers)}</td>
                    <td className="n">
                      {a.officers_per_1k == null
                        ? <Withheld tone="neutral" reason="No denominator" />
                        : fmtDecimal(a.officers_per_1k)}
                    </td>
                    <td className="n">
                      {a.rate_allowed && a.violent_crime_rate != null
                        ? fmtRate(a.violent_crime_rate)
                        : <Withheld reason={a.rate_withheld_reason ?? 'Not published'} />}
                    </td>
                    <td>
                      <span className={coverageChip(a.coverage_status)}>{coverageLabel(a.months_reported)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card-foot">
        Population is the population the agency serves, which for a sheriff's office or a state
        force is not the population of the place it is named after. Where the platform could not
        establish one, the rate is withheld rather than computed against a state total.
      </div>
    </section>
  );
}
