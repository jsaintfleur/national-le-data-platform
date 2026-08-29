/**
 * National overview.
 *
 * The hard problem on this screen is not the arithmetic, it is the fact that the platform's
 * national sworn-officer figure is roughly 36,000 lower than the FBI's own published one.
 * A homepage that shows a federal-looking number without that ledger is asking the reader to
 * trust it; a homepage that shows the ledger is showing its work. So the reconciliation is a
 * card in the reading order, directly under the headline it explains, rather than a footnote
 * or a methodology page nobody opens.
 *
 * The second thing this page has to resist is reading the national crime series as a series
 * about crime. Between 2020 and 2022 the line moves mostly because the reporting programme
 * changed, so the reporting context is rendered beneath the chart as first-class content and
 * the 2021 transition is annotated rather than smoothed.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Overview as OverviewData } from '../lib/api';
import { agencyTypeLabel, DASH, fmt, fmtPct } from '../lib/format';
import { BarRows, ChartFrame, CoverageStrip, TimeSeries } from '../components/charts';
import type { Point } from '../components/charts';
import { ErrorState, Loading, MetricTile, Notice, useAsync } from '../components/primitives';

/** Rendered in this order regardless of key order in the payload. */
const HEADLINE_ORDER = ['agencies', 'sworn_officers', 'agencies_geolocated', 'population_coverage'];

type TrendMetric = 'violent_offenses' | 'violent_crime_rate' | 'sworn_officers' | 'population_coverage';

const TREND_OPTIONS: { id: TrendMetric; label: string; unit?: string; rate?: boolean; pct?: boolean }[] = [
  { id: 'violent_offenses', label: 'Violent crime', unit: 'offenses' },
  { id: 'violent_crime_rate', label: 'Violent crime rate', unit: 'per 100K', rate: true },
  { id: 'sworn_officers', label: 'Sworn officers', unit: 'officers' },
  { id: 'population_coverage', label: 'Population coverage', pct: true },
];

export default function Overview() {
  const { data, loading, error, retry } = useAsync(() => api.overview(), []);

  if (loading) return <div className="card"><Loading rows={5} label="Loading the national overview" /></div>;
  if (error) return <div className="card"><ErrorState error={error} retry={retry} /></div>;
  if (!data) return <div className="card"><ErrorState error="No overview payload in this release" /></div>;

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">National overview</div>
        <h1>American law enforcement</h1>
        <p className="question">What does American law enforcement look like nationally?</p>
        <p>
          Every figure below is a count of what agencies reported to the federal government,
          carried at the year it was observed. Where a number could not be established it is
          shown as missing rather than as zero, and where the platform's universe differs from
          the FBI's the difference is itemised rather than reconciled away.
        </p>
      </header>

      <Headline data={data} />

      <section style={{ marginTop: 18 }}>
        <Reconciliation r={data.reconciliation} />
      </section>

      <section style={{ marginTop: 18 }}>
        <Composition data={data} />
      </section>

      <section style={{ marginTop: 18 }}>
        <Trend data={data} />
      </section>

      <p className="question" style={{ marginTop: 18 }}>
        Active data release <span className="num">{data.release.release_id}</span>
        {data.release.built_at && <> · built {data.release.built_at.slice(0, 10)}</>}
        {data.release.git_commit && <> · commit <span className="num">{data.release.git_commit.slice(0, 10)}</span></>}
        {' '}· crime through {data.years.crime}, staffing through {data.years.staffing}.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ headline --------- */

function Headline({ data }: { data: OverviewData }) {
  const r = data.reconciliation;
  return (
    <div className="grid g4">
      {HEADLINE_ORDER.map((key) => {
        const m = data.headline[key];
        if (!m) return null;
        const isShare = key === 'population_coverage';
        return (
          <MetricTile
            key={key}
            featured={key === 'agencies'}
            label={m.label}
            value={m.value == null ? DASH : isShare ? fmtPct(m.value) : fmt(m.value)}
            withheldReason={m.value == null ? 'Not established in this release' : null}
            year={m.year ?? null}
            /* A directory count has no observation year — its basis is the active release,
               and saying so is better than borrowing a crime year it does not come from. */
            chips={m.year == null ? <span className="chip">Current directory</span> : undefined}
            note={m.note}
            methodology={
              key === 'sworn_officers'
                ? {
                    metric: 'Sworn officers, national',
                    definition:
                      'Full-time sworn officers with general arrest powers at state, local, tribal and territorial agencies whose identity the platform could resolve to a single agency.',
                    formula: 'sum of agency sworn officers over agencies with a resolved identity',
                    limitations: [
                      'Federal agencies are outside this universe. The FBI includes them in its national figure.',
                      'Records keyed on an identifier shared by several agencies are refused rather than attributed to one of them.',
                      'Reported as of 31 October of the data year, not an annual average.',
                    ],
                    source: r.document ? { name: 'Reconciliation ledger', dataset: r.document } : undefined,
                  }
                : key === 'population_coverage'
                ? {
                    metric: 'Population covered by full-year reporters',
                    formula: 'population served by agencies reporting twelve months ÷ total population',
                    definition:
                      'A property of the data, not of any department. It says how much of the country is inside the crime counts on this page.',
                    limitations: [
                      'An agency that reported fewer than twelve months contributes counts but no population coverage.',
                      'Coverage moves with participation in the reporting programme, which changed materially in 2021.',
                    ],
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ reconciliation --- */

function Reconciliation({ r }: { r: OverviewData['reconciliation'] }) {
  if (!r.available) {
    return (
      <Notice tone="warn" title="Staffing reconciliation not built for this release">
        The national sworn-officer figure on this page has not been reconciled to the FBI's
        published national figure in this release, so the two should not be compared.
      </Notice>
    );
  }

  const excluded = r.excluded ?? {};
  const source = r.source_file_total ?? null;
  const platform = r.platform_total ?? null;
  const published = r.fbi_published ?? null;

  const deductions = [
    {
      key: 'federal_agencies',
      label: 'Federal agencies',
      detail: "Outside this platform's universe of state, local, tribal and territorial agencies. The FBI's national figure includes them.",
    },
    {
      key: 'ambiguous_identifier',
      label: 'Ambiguous identifier',
      detail: 'One reporting identifier shared by several agencies. These records are refused rather than attributed to whichever agency was read first.',
    },
    {
      key: 'unresolved_identifier',
      label: 'Identifier with no agency in the directory',
      detail: 'Dormant, reorganised and sub-unit identifiers carried by the employment file but absent from the live agency directory.',
    },
  ]
    .map((d) => ({ ...d, value: excluded[d.key] ?? null }))
    .filter((d) => d.value != null);

  // Whatever the three named exclusions do not account for. In the current release this is
  // duplicate agency-years collapsed on load; it is shown as a residual rather than named,
  // because the payload names the exclusions and not this remainder.
  const residual =
    source != null && platform != null
      ? source - deductions.reduce((s, d) => s + (d.value ?? 0), 0) - platform
      : null;
  const apiVsFile = source != null && published != null ? source - published : null;

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Why this differs from the FBI's national figure</h2>
          <div className="question">
            The platform reports {fmt(platform)} sworn officers for {r.year}. The FBI publishes {fmt(published)}.
            Where do the other {fmt(published != null && platform != null ? published - platform : null)} officers sit?
          </div>
        </div>
        <span className="chip chip-outline">{r.year}</span>
      </div>

      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <caption className="sr-only">
              Ledger from the FBI published national sworn figure to the platform national total for {r.year}
            </caption>
            <thead>
              <tr><th>Step</th><th className="n">Sworn officers</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="wide">FBI published national figure</td>
                <td className="n">{fmt(published)}</td>
              </tr>
              <tr>
                <td className="wide">
                  FBI Police Employee master file
                  {apiVsFile != null && apiVsFile !== 0 && (
                    <div className="metric-note">
                      {fmt(Math.abs(apiVsFile))} {apiVsFile > 0 ? 'more' : 'fewer'} than the published figure.
                      Both are the FBI's own numbers; the bulk file and the API are refreshed on
                      different schedules, so a late agency revision appears in one before the other.
                    </div>
                  )}
                </td>
                <td className="n">{fmt(source)}</td>
              </tr>
              {deductions.map((d) => (
                <tr key={d.key}>
                  <td className="wide">
                    {d.label}
                    <div className="metric-note">{d.detail}</div>
                  </td>
                  <td className="n deduct">−{fmt(d.value)}</td>
                </tr>
              ))}
              {residual != null && residual !== 0 && (
                <tr>
                  <td className="wide">
                    Residual
                    <div className="metric-note">
                      What the three exclusions above do not account for: duplicate agency-years
                      collapsed when the file was loaded.
                    </div>
                  </td>
                  <td className="n deduct">−{fmt(residual)}</td>
                </tr>
              )}
              <tr className="ledger-total">
                <td className="wide">Platform national total, {r.year}</td>
                <td className="n">{fmt(platform)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid var(--rule-soft)' }}>
          <Notice title="These two figures describe different universes">
            Nothing was adjusted to make them agree. The platform counts state, local, tribal and
            territorial agencies whose identity resolves to exactly one agency; the FBI's national
            figure additionally includes federal agencies and does not have to resolve identity to
            publish a national sum. A reader who wants the federal-inclusive number can add the
            excluded lines back from this table.
          </Notice>
          <p className="question" style={{ marginTop: 10 }}>
            {r.headline_note}
          </p>
        </div>
      </div>

      <div className="card-foot">
        {excluded.records != null && <>{fmt(excluded.records)} source records sit outside the platform total. </>}
        The full ledger, including the largest excluded agencies by name, is in{' '}
        <Link to="/methodology">Methodology</Link>
        {r.document && <> and in <span className="num">{r.document}</span></>}.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ composition ------ */

function Composition({ data }: { data: OverviewData }) {
  const [rank, setRank] = useState<'agencies' | 'sworn'>('agencies');
  const rows = data.composition;

  const totals = useMemo(() => ({
    agencies: rows.reduce((s, r) => s + (r.agencies ?? 0), 0),
    sworn: rows.reduce((s, r) => s + (r.sworn ?? 0), 0),
    civilian: rows.reduce((s, r) => s + (r.civilian ?? 0), 0),
  }), [rows]);

  const directoryTotal = data.headline.agencies?.value ?? null;
  const unclassified = directoryTotal != null ? directoryTotal - totals.agencies : null;

  const bars = useMemo(
    () => [...rows]
      .sort((a, b) => (rank === 'agencies' ? (b.agencies ?? 0) - (a.agencies ?? 0) : (b.sworn ?? 0) - (a.sworn ?? 0)))
      .map((r) => ({
        label: agencyTypeLabel(r.agency_type),
        value: rank === 'agencies' ? r.agencies : r.sworn,
        sub: rank === 'agencies'
          ? (r.sworn == null ? 'Sworn not reported' : `${fmt(r.sworn)} sworn`)
          : `${fmt(r.agencies)} agencies`,
      })),
    [rows, rank],
  );

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>The national agency landscape</h2>
          <div className="question">What kinds of organisation is “the police” made of?</div>
        </div>
        <div className="seg" role="tablist" aria-label="Rank agency types by">
          <button role="tab" aria-selected={rank === 'agencies'} className={rank === 'agencies' ? 'on' : ''}
                  onClick={() => setRank('agencies')}>By agencies</button>
          <button role="tab" aria-selected={rank === 'sworn'} className={rank === 'sworn' ? 'on' : ''}
                  onClick={() => setRank('sworn')}>By sworn officers</button>
        </div>
      </div>

      <div className="card-body">
        <p style={{ marginTop: 0 }}>
          “Police agency” is not one kind of entity. A municipal department, a sheriff's office
          that also runs a jail and serves civil process, a university force, a transit police
          department and a state conservation police answer to different authorities, police
          different populations and are funded differently. Counting them in one row is what
          makes a national total possible; comparing them to each other in one league table is
          what makes it misleading.
        </p>

        <BarRows
          rows={bars}
          ariaLabel={rank === 'agencies' ? 'Agencies by agency type' : 'Sworn officers by agency type'}
        />

        <div className="tablewrap" style={{ marginTop: 16 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Agency type</th>
                <th className="n">Agencies</th>
                <th className="n">Share of agencies</th>
                <th className="n">Sworn officers</th>
                <th className="n">Civilian personnel</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].sort((a, b) => (b.agencies ?? 0) - (a.agencies ?? 0)).map((r) => (
                <tr key={r.agency_type}>
                  <td className="wide">{agencyTypeLabel(r.agency_type)}</td>
                  <td className="n">{fmt(r.agencies)}</td>
                  <td className="n">{fmtPct(r.share)}</td>
                  <td className="n">{fmt(r.sworn)}</td>
                  <td className="n">{fmt(r.civilian)}</td>
                </tr>
              ))}
              <tr className="ledger-total">
                <td>Classified agencies</td>
                <td className="n">{fmt(totals.agencies)}</td>
                <td className="n">{fmtPct(1)}</td>
                <td className="n">{fmt(totals.sworn)}</td>
                <td className="n">{fmt(totals.civilian)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card-foot">
        Shares are of the {fmt(totals.agencies)} agencies carrying an agency type.
        {unclassified != null && unclassified > 0 && (
          <> The other {fmt(unclassified)} of the {fmt(directoryTotal)} identifiers in the directory
            are absent from this table rather than folded into another row.</>
        )}
        {' '}Staffing is for {data.years.staffing}; the agency counts are from the current directory.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ trend ------------ */

function Trend({ data }: { data: OverviewData }) {
  const [metric, setMetric] = useState<TrendMetric>('violent_offenses');
  const opt = TREND_OPTIONS.find((o) => o.id === metric) ?? TREND_OPTIONS[0];
  const rows = data.trend;

  const points: Point[] = useMemo(() => rows.map((r) => {
    const value = r[metric] ?? null;
    return {
      x: r.data_year,
      y: value,
      count: metric === 'violent_crime_rate' ? r.violent_offenses : null,
      withheldReason: value == null
        ? (opt.rate || opt.pct ? 'No population denominator for this year' : 'Not reported')
        : null,
    };
  }), [rows, metric, opt.rate, opt.pct]);

  const latest = rows[rows.length - 1];
  const reporting = latest
    ? (latest.full_year_reporters ?? 0) + (latest.partial_reporters ?? 0)
    : null;

  // The transition year is found in the data rather than assumed, so this annotation stays
  // correct if the series is rebuilt.
  const dip = useMemo(() => {
    const withCoverage = rows.filter((r) => r.population_coverage != null);
    if (!withCoverage.length) return null;
    return withCoverage.reduce((a, b) =>
      (b.population_coverage as number) < (a.population_coverage as number) ? b : a);
  }, [rows]);
  const beforeDip = dip ? rows.find((r) => r.data_year === dip.data_year - 1) : null;
  const afterDip = dip ? rows.find((r) => r.data_year === dip.data_year + 1) : null;

  return (
    <ChartFrame
      title="National trends"
      subtitle="A line here moves with two things at once: what happened, and who reported it. The reporting context is directly beneath the chart for that reason."
      right={
        <div className="seg" role="tablist" aria-label="Trend metric">
          {TREND_OPTIONS.map((o) => (
            <button key={o.id} role="tab" aria-selected={o.id === metric}
                    className={o.id === metric ? 'on' : ''} onClick={() => setMetric(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          Counts are sums over agencies that reported. A year in which fewer agencies reported
          produces a smaller national count without anything having changed on the ground.
        </>
      }
    >
      <TimeSeries
        points={points}
        unit={opt.unit}
        valueLabel={opt.label}
        yZero={!opt.rate}
        format={opt.pct ? (n) => fmtPct(n, 0) : (n) => fmt(Math.round(n))}
        ariaLabel={`${opt.label} nationally, by year`}
      />

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--rule-soft)' }}>
        <h3>Reporting context</h3>
        <div className="question" style={{ marginBottom: 6 }}>
          Population covered by full-year reporters, {rows[0]?.data_year} to {latest?.data_year}.
        </div>
        <CoverageStrip years={rows} />

        {latest && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 28px', marginTop: 14 }}>
            <Stat label={`Agencies reporting in ${latest.data_year}`} value={fmt(reporting)} />
            <Stat label="Full-year reporters" value={fmt(latest.full_year_reporters)} />
            <Stat label="Partial reporters" value={fmt(latest.partial_reporters)} />
            <Stat label="Did not report" value={fmt(latest.non_reporters)} />
            <Stat
              label="Population coverage"
              value={latest.population_coverage == null ? DASH : fmtPct(latest.population_coverage)}
            />
          </div>
        )}
      </div>

      {dip && beforeDip && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="warn" title={`The series is not continuous across ${dip.data_year}`}>
            {dip.data_year === 2021 ? (
              <>The FBI retired its summary collection at the end of {beforeDip.data_year} and moved
              to NIBRS only. Agencies that had not converted are absent from {dip.data_year} rather
              than reporting zero, and population coverage falls from{' '}</>
            ) : (
              <>Population coverage falls from{' '}</>
            )}
            <span className="num">{fmtPct(beforeDip.population_coverage)}</span> to{' '}
            <span className="num">{fmtPct(dip.population_coverage)}</span>
            {afterDip?.population_coverage != null && (
              <> before recovering to <span className="num">{fmtPct(afterDip.population_coverage)}</span> in {afterDip.data_year}</>
            )}
            . Counts either side of {dip.data_year} are not comparable, and the platform neither
            estimates the missing agencies nor interpolates across the gap.
          </Notice>
        </div>
      )}

      <div className="tablewrap" style={{ marginTop: 14 }}>
        <table className="data">
          <caption className="sr-only">Reporting participation and population coverage by year</caption>
          <thead>
            <tr>
              <th>Year</th>
              <th className="n">Full-year reporters</th>
              <th className="n">Partial reporters</th>
              <th className="n">Did not report</th>
              <th className="n">Population coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.data_year}>
                <td className="num">{r.data_year}</td>
                <td className="n">{fmt(r.full_year_reporters)}</td>
                <td className="n">{fmt(r.partial_reporters)}</td>
                <td className="n">{fmt(r.non_reporters)}</td>
                <td className="n">
                  {r.population_coverage == null
                    ? <span className="withheld neutral">No denominator</span>
                    : fmtPct(r.population_coverage)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className="num num-md">{value}</div>
    </div>
  );
}
