/**
 * Agency profile — the Phase 2 acceptance test.
 *
 * Baltimore Police Department is the canonical case because it exercises every hard state at
 * once: a complete series, a partial-reporting year where the count exists and the rate must
 * not, early years with no population estimate, a peer cohort, and a full provenance chain.
 * If this page is right, the pattern generalizes.
 */
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { AgencyYear, PeerResponse } from '../lib/api';
import {
  agencyTypeLabel, confidenceChip, confidenceLabel, coverageChip, coverageLabel,
  DASH, denominatorLabel, fmt, fmtDecimal, fmtDelta, fmtPct, deltaClass, fmtRate, pctChange,
} from '../lib/format';
import { ChartFrame, TimeSeries } from '../components/charts';
import type { Point } from '../components/charts';
import {
  EmptyState, ErrorState, Loading, MetricTile, MethodologyDrawer,
  Notice, useAsync, Withheld,
} from '../components/primitives';

type TrendMetric = 'violent_crime_rate' | 'violent_crime_offenses' | 'property_crime_offenses'
  | 'sworn_officers' | 'officers_per_1k';

const TREND_OPTIONS: { id: TrendMetric; label: string; unit?: string; rate?: boolean }[] = [
  { id: 'violent_crime_offenses', label: 'Violent crime', unit: 'offenses' },
  { id: 'violent_crime_rate', label: 'Violent crime rate', unit: 'per 100K', rate: true },
  { id: 'property_crime_offenses', label: 'Property crime', unit: 'offenses' },
  { id: 'sworn_officers', label: 'Sworn officers', unit: 'officers' },
  { id: 'officers_per_1k', label: 'Officers per 1,000', unit: 'per 1K', rate: true },
];

export default function AgencyProfile() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const metricParam = (params.get('metric') as TrendMetric) || 'violent_crime_offenses';

  const head = useAsync(() => api.agency(id), [id]);
  const series = useAsync(() => api.agencyMetrics(id), [id]);
  const coverage = useAsync(() => api.agencyCoverage(id), [id]);

  if (head.loading) return <div className="card"><Loading rows={5} label="Loading agency" /></div>;
  if (head.error) return <div className="card"><ErrorState error={head.error} retry={head.retry} /></div>;
  if (!head.data) return <EmptyState title="Agency not found" />;

  const a = head.data.agency;
  const link = head.data.geography_link;
  const rows: AgencyYear[] = series.data?.series ?? [];
  const latest = [...rows].reverse().find((r) => r.sworn_officers != null || r.violent_crime_offenses != null);
  const latestYear = latest?.data_year ?? null;

  return (
    <>
      <ProfileHeader agency={a} link={link} latestYear={latestYear} />

      {a.is_covered_by_parent && (
        <Notice tone="warn" title="Reports under a parent ORI">
          This agency's submissions are filed under ORI <code>{a.covered_by_legacy_ori}</code>.
          Counting this agency and its parent separately double-counts.
        </Notice>
      )}

      <section style={{ marginTop: 16 }}>
        <h2 style={{ marginBottom: 10 }}>Snapshot</h2>
        {series.loading ? <div className="card"><Loading /></div>
          : series.error ? <div className="card"><ErrorState error={series.error} retry={series.retry} /></div>
          : latest ? <Snapshot row={latest} provenance={series.data?.provenance} />
          : <div className="card"><EmptyState title="No observations" detail="This agency has no staffing or crime observations in the warehouse." /></div>}
      </section>

      <section style={{ marginTop: 18 }}>
        <TrendPanel
          rows={rows}
          metric={metricParam}
          onMetric={(m) => { params.set('metric', m); setParams(params, { replace: true }); }}
        />
      </section>

      <div className="grid g2" style={{ marginTop: 18, alignItems: 'start' }}>
        <PeerPanel agencyId={id} year={latestYear} />
        <CoveragePanel data={coverage.data} loading={coverage.loading} error={coverage.error} retry={coverage.retry} />
      </div>

      <section style={{ marginTop: 18 }}>
        <ProvenancePanel provenance={series.data?.provenance} agency={a} link={link} />
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ header ----------- */

function ProfileHeader({ agency: a, link, latestYear }: { agency: any; link: any; latestYear: number | null }) {
  return (
    <header className="page-head">
      <div className="eyebrow">Agency profile</div>
      <h1>{a.agency_name}</h1>
      <div className="controls" style={{ marginTop: 8, gap: 6 }}>
        <span className="chip chip-info">{agencyTypeLabel(a.agency_type)}</span>
        {a.county_name && <span className="chip">{a.county_name}</span>}
        {a.state_abbr && <Link to={`/states/${a.state_abbr}`} className="chip">{a.state_abbr}</Link>}
        <span className="chip mono chip-outline" title="NIBRS ORI">{a.ori9_nibrs}</span>
        {a.ori7 && <span className="chip mono chip-outline" title={`ORI7 derived from ${a.ori7_source === 'legacy_ori' ? 'the legacy ORI' : 'the NIBRS ORI (provisional)'}`}>ORI7 {a.ori7}</span>}
        {latestYear && <span className="chip chip-outline">Latest data {latestYear}</span>}
        {a.is_dormant && <span className="chip chip-warn">Dormant{a.dormant_year ? ` since ${a.dormant_year}` : ''}</span>}
      </div>
      <p style={{ marginTop: 8 }}>
        {link?.review_status === 'accepted' ? (
          <>Jurisdiction resolved to <strong>{link.target_name ?? link.geo_name}</strong> by{' '}
            <code style={{ fontSize: 12 }}>{link.match_method}</code>.</>
        ) : link?.review_status === 'needs_review' ? (
          <>Jurisdiction provisionally matched to <strong>{link.target_name ?? link.geo_name}</strong> — this link needs human review, so no per-resident rate is published.</>
        ) : (
          <>No municipality matched this agency, so it is shown at state level with no per-resident rate. That is expected for university, transit, park and special-jurisdiction agencies.</>
        )}
        {a.ori7_source === 'nibrs_ori_fallback' && (
          <> Its ORI7 is provisional: no legacy ORI was observed in any ingested year.</>
        )}
      </p>
    </header>
  );
}

/* ------------------------------------------------------------------ snapshot --------- */

function Snapshot({ row, provenance }: { row: AgencyYear; provenance: any }) {
  const staffingSource = provenance?.staffing?.slice(-1)?.[0];
  const crimeSource = provenance?.crime?.slice(-1)?.[0];

  const denomMeta = {
    denominatorType: row.denominator_type,
    denominatorValue: row.denominator_value,
    denominatorYear: row.denominator_year,
    denominatorSource: row.denominator_source,
    denominatorConfidence: row.denominator_confidence,
    denominatorNotes: row.denominator_notes,
    warning: row.methodology_warning,
    coverage: { months: row.months_reported, status: row.coverage_status },
  };

  const rateWithheld = !row.rate_allowed ? row.rate_withheld_reason ?? 'Not available' : null;

  return (
    <div className="grid g4">
      <MetricTile
        label="Sworn officers" value={fmt(row.sworn_officers)} year={row.data_year}
        methodology={{
          metric: 'Sworn officers',
          definition: 'Full-time sworn officers with general arrest powers, as reported by the agency to the FBI.',
          formula: 'male_officers + female_officers',
          source: staffingSource && { name: staffingSource.source_name, dataset: staffingSource.dataset_name, url: staffingSource.source_url, release: staffingSource.latest_release_date },
          limitations: [
            'Reported as of 31 October of the data year, not an annual average.',
            'An agency that did not report is absent, not zero.',
          ],
        }}
      />
      <MetricTile
        label="Population served" value={fmt(row.denominator_value)} year={row.denominator_year}
        chips={<>
          <span className={confidenceChip(row.denominator_confidence)}>{confidenceLabel(row.denominator_confidence)}</span>
          <span className="chip chip-outline">{denominatorLabel(row.denominator_type)}</span>
        </>}
        methodology={{ metric: 'Population served', ...denomMeta, definition: row.denominator_notes ?? undefined }}
        withheldReason={row.denominator_value == null ? 'No population estimate for this year' : null}
      />
      <MetricTile
        label="Officers per 1,000 residents"
        value={fmtDecimal(row.officers_per_1k)} year={row.data_year}
        withheldReason={row.officers_per_1k == null
          ? (row.denominator_confidence === 'NOT_COMPARABLE'
            ? 'Not comparable using a standard resident denominator'
            : 'No population estimate for this year')
          : null}
        chips={row.methodology_warning ? <span className="chip chip-warn">Methodology warning</span> : undefined}
        methodology={{
          metric: 'Officers per 1,000 residents',
          formula: 'sworn officers ÷ population served × 1,000',
          ...denomMeta,
        }}
      />
      <MetricTile
        label="Civilian personnel" value={fmt(row.civilian_personnel)} year={row.data_year}
        note={row.civilian_share != null ? `${fmtPct(row.civilian_share, 0)} of total personnel` : undefined}
        methodology={{
          metric: 'Civilian personnel',
          definition: 'Full-time non-sworn employees.',
          source: staffingSource && { name: staffingSource.source_name, dataset: staffingSource.dataset_name, url: staffingSource.source_url },
          limitations: ['Varies with what a jurisdiction outsources — dispatch, records, crime lab — more than with any policy choice.'],
        }}
      />
      <MetricTile
        label="Violent crime" value={fmt(row.violent_crime_offenses)} unit="offenses" year={row.data_year}
        chips={<span className={coverageChip(row.coverage_status)}>{coverageLabel(row.months_reported)}</span>}
        methodology={{
          metric: 'Violent crime offenses',
          definition: 'Murder and nonnegligent manslaughter, rape, robbery and aggravated assault, as reported by the agency.',
          source: crimeSource && { name: crimeSource.source_name, dataset: crimeSource.dataset_name, url: crimeSource.source_url },
          coverage: { months: row.months_reported, status: row.coverage_status },
          limitations: ['Counts reflect what agencies reported, not what occurred.'],
        }}
      />
      <MetricTile
        label="Violent crime rate" value={fmtRate(row.violent_crime_rate)} unit="per 100K"
        year={row.data_year} withheldReason={rateWithheld}
        chips={<span className={coverageChip(row.coverage_status)}>{coverageLabel(row.months_reported)}</span>}
        methodology={{
          metric: 'Violent crime rate',
          formula: 'violent crime offenses ÷ population served × 100,000',
          definition: 'Published only when the agency reported all twelve months, the population estimate is for the same year, and the geography link was accepted.',
          ...denomMeta,
          source: crimeSource && { name: crimeSource.source_name, dataset: crimeSource.dataset_name, url: crimeSource.source_url },
        }}
      />
      <MetricTile
        label="Property crime" value={fmt(row.property_crime_offenses)} unit="offenses" year={row.data_year}
        methodology={{ metric: 'Property crime offenses', definition: 'Burglary, larceny-theft and motor vehicle theft. Arson is reported separately.' }}
      />
      <MetricTile
        label="Reporting coverage" value={row.months_reported ?? DASH} unit="of 12 months"
        year={row.data_year}
        chips={<span className={coverageChip(row.coverage_status)}>{row.coverage_status ?? 'UNKNOWN'}</span>}
        note="Coverage is a property of the data, not of the department."
        methodology={{
          metric: 'Reporting coverage',
          definition: 'Months in the data year for which the agency submitted, counted from the source response rather than assumed. A year below twelve months yields counts but no annual rate, because the platform does not annualize partial-year data.',
          coverage: { months: row.months_reported, status: row.coverage_status },
        }}
      />
      {row.methodology_warning && (
        <div style={{ gridColumn: '1 / -1' }}>
          <Notice tone="warn" title="Methodology warning">{row.methodology_warning}</Notice>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ trend ------------ */

function TrendPanel({ rows, metric, onMetric }: {
  rows: AgencyYear[]; metric: TrendMetric; onMetric: (m: TrendMetric) => void;
}) {
  const opt = TREND_OPTIONS.find((o) => o.id === metric) ?? TREND_OPTIONS[0];

  const points: Point[] = useMemo(() => rows.map((r) => {
    const raw = (r as any)[metric] as number | null;
    const isRate = !!opt.rate;
    const partial = r.coverage_status === 'PARTIAL';
    return {
      x: r.data_year,
      y: raw ?? null,
      partial: partial && (metric.startsWith('violent') || metric.startsWith('property')),
      count: metric === 'violent_crime_rate' ? r.violent_crime_offenses : null,
      withheldReason: raw == null
        ? (isRate ? r.rate_withheld_reason ?? 'Not available' : 'Not reported')
        : null,
    };
  }), [rows, metric, opt.rate]);

  const first = points.find((p) => p.y !== null);
  const last = [...points].reverse().find((p) => p.y !== null);
  const change = pctChange(first?.y ?? null, last?.y ?? null);
  const withheldYears = points.filter((p) => p.y === null).length;
  const partialYears = rows.filter((r) => r.coverage_status === 'PARTIAL').length;

  return (
    <ChartFrame
      title="Trend"
      subtitle="Lines break where a year is missing. Partial-reporting years are drawn as hollow points and never produce a rate."
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
          {first && last && first.x !== last.x && change != null && (
            <span>
              {first.x}–{last.x}:{' '}
              <span className={`num ${deltaClass(change)}`}>{fmtDelta(change)}</span>
            </span>
          )}
          {partialYears > 0 && <span>{partialYears} partial-reporting year{partialYears > 1 ? 's' : ''}</span>}
          {withheldYears > 0 && <span>{withheldYears} year{withheldYears > 1 ? 's' : ''} without a published value</span>}
          <span className="legend" style={{ marginLeft: 'auto' }}>
            <span><i className="sw" style={{ background: 'var(--blue-600)' }} />Published</span>
            <span><i className="sw" style={{ background: 'var(--surface)', border: '2px solid var(--warn)' }} />Partial year</span>
          </span>
        </div>
      }
    >
      <TimeSeries
        points={points}
        unit={opt.unit}
        valueLabel={opt.label}
        yZero={!opt.rate}
        format={opt.id === 'officers_per_1k' ? (n) => n.toFixed(2) : (n) => fmt(Math.round(n))}
        ariaLabel={`${opt.label} by year`}
      />
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ peers ------------ */

function PeerPanel({ agencyId, year }: { agencyId: string; year: number | null }) {
  const [metric, setMetric] = useState<'violent_crime_rate' | 'officers_per_1k'>('violent_crime_rate');
  const [showDef, setShowDef] = useState(false);
  const { data, loading, error, retry } = useAsync<PeerResponse | null>(
    () => (year ? api.agencyPeers(agencyId, year, metric) : Promise.resolve(null)),
    [agencyId, year, metric],
  );

  const fmtVal = (n: number | null | undefined) =>
    metric === 'officers_per_1k' ? fmtDecimal(n) : fmtRate(n);

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Peer context</h2>
          <div className="question">How does this agency compare with appropriate peers?</div>
        </div>
        <div className="seg">
          <button className={metric === 'violent_crime_rate' ? 'on' : ''} onClick={() => setMetric('violent_crime_rate')}>Violent rate</button>
          <button className={metric === 'officers_per_1k' ? 'on' : ''} onClick={() => setMetric('officers_per_1k')}>Officers / 1K</button>
        </div>
      </div>
      <div className="card-body">
        {loading && <Loading rows={4} />}
        {error && <ErrorState error={error} retry={retry} />}
        {!loading && !error && !data && <EmptyState title="No year available for peer comparison" />}
        {data && (
          <>
            <div className="tablewrap">
              <table className="data">
                <tbody>
                  <tr>
                    <td>This agency</td>
                    <td className="n">
                      {data.subject.rate_allowed || metric === 'officers_per_1k'
                        ? fmtVal((data.subject as any)[metric])
                        : <Withheld reason={data.subject.rate_withheld_reason ?? 'Not available'} />}
                    </td>
                  </tr>
                  <tr><td>Peer median</td><td className="n">{fmtVal(data.peer_median)}</td></tr>
                  <tr><td>Peer 25th–75th</td><td className="n">{fmtVal(data.peer_p25)} – {fmtVal(data.peer_p75)}</td></tr>
                  <tr><td>State median</td><td className="n">{fmtVal(data.state_median)}</td></tr>
                  <tr><td>National median</td><td className="n">{fmtVal(data.national_median)}</td></tr>
                  <tr>
                    <td>Percentile in cohort</td>
                    <td className="n">
                      {data.percentile_allowed && data.percentile != null
                        ? `${data.percentile}`
                        : <Withheld tone="neutral" reason={data.cohort.sufficient ? 'Not comparable' : `Cohort of ${data.cohort.size} is below the minimum of ${data.cohort.minimum_size}`} />}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => setShowDef(true)}>How are peers selected?</button>
              <span className="chip chip-outline">{data.cohort.size} agencies in cohort</span>
              <span className="chip chip-outline">{data.year}</span>
            </div>
            <p className="question" style={{ marginTop: 10 }}>{data.percentile_note}</p>
            {showDef && (
              <MethodologyDrawer
                onClose={() => setShowDef(false)}
                m={{
                  metric: 'Peer cohort definition',
                  definition: data.cohort.definition,
                  limitations: [
                    `Cohort size is ${data.cohort.size}; a benchmark requires at least ${data.cohort.minimum_size}.`,
                    'Peers are selected deterministically from agency type, population band and urbanicity. There is no clustering model, and no agency is placed in a cohort it does not structurally belong to.',
                    'A percentile is a position in a distribution. It is not a score and it is not a judgment about performance.',
                  ],
                }}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ coverage --------- */

function CoveragePanel({ data, loading, error, retry }: {
  data: any; loading: boolean; error: unknown; retry: () => void;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Reporting coverage and data quality</h2>
          <div className="question">How complete is the evidence for this agency?</div>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        {loading && <Loading rows={4} />}
        {error && <ErrorState error={error} retry={retry} />}
        {data && (
          <>
            <div className="tablewrap">
              <table className="data">
                <thead>
                  <tr><th>Year</th><th className="n">Months</th><th>Status</th><th>Rate</th></tr>
                </thead>
                <tbody>
                  {data.years.map((y: any) => (
                    <tr key={y.data_year}>
                      <td className="num">{y.data_year}</td>
                      <td className="n">{y.months_reported ?? DASH}</td>
                      <td><span className={coverageChip(y.coverage_status)}>{y.coverage_status}</span></td>
                      <td>{y.rate_allowed
                        ? <span className="chip chip-ok">Published</span>
                        : <Withheld tone="neutral" reason={y.rate_withheld_reason ?? 'Not available'} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.quality_flags?.length > 0 && (
              <div style={{ padding: 14, borderTop: '1px solid var(--rule-soft)' }}>
                <h3>Quality flags on this agency</h3>
                <div style={{ display: 'grid', gap: 8 }}>
                  {data.quality_flags.slice(0, 6).map((f: any, i: number) => (
                    <Notice key={i} tone={f.severity === 'warning' ? 'warn' : 'plain'} title={f.check_id}>
                      {f.message}
                      {f.observed && <div className="num" style={{ marginTop: 4, fontSize: 12 }}>Observed: {f.observed}</div>}
                    </Notice>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ provenance ------- */

function ProvenancePanel({ provenance, agency, link }: { provenance: any; agency: any; link: any }) {
  const sources: any[] = [];
  const seen = new Set<string>();
  for (const group of ['staffing', 'crime']) {
    for (const p of provenance?.[group] ?? []) {
      if (!seen.has(p.source_id)) { seen.add(p.source_id); sources.push({ ...p, group }); }
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Where these numbers come from</h2>
          <div className="question">Every value on this page traces to a named federal release.</div>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr><th>Measure</th><th>Source</th><th>Dataset</th><th>Source release</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {sources.map((s, i) => (
                <tr key={i}>
                  <td style={{ textTransform: 'capitalize' }}>{s.group}</td>
                  <td className="wide">{s.source_name ?? s.source_id}</td>
                  <td className="wide">{s.dataset_name ?? DASH}</td>
                  <td className="num">{s.latest_release_date ?? DASH}</td>
                  <td>{s.update_frequency ?? DASH}</td>
                </tr>
              ))}
              <tr>
                <td>Identity</td>
                <td className="wide">Platform entity resolution</td>
                <td className="wide">
                  ORI7 from {agency.ori7_source === 'legacy_ori' ? 'the legacy ORI' : 'the NIBRS ORI (provisional)'}
                </td>
                <td className="num">—</td>
                <td>per build</td>
              </tr>
              <tr>
                <td>Jurisdiction</td>
                <td className="wide">Platform entity resolution</td>
                <td className="wide">
                  {link ? <>{link.match_method} · score {link.match_score ?? DASH} · {link.review_status}</> : 'unmatched'}
                </td>
                <td className="num">—</td>
                <td>per build</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-foot">
        The federal government publishes no current crosswalk between a police agency and the
        place it polices, so the jurisdiction link above is built by this platform and carries
        a method and a score rather than being presented as a fact.
      </div>
    </section>
  );
}
