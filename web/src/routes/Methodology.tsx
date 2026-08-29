/**
 * Methodology.
 *
 * Everything on this page is read from the same registry the build reads: `registry/metrics.yaml`
 * and the thresholds in `src/nledp/policy.py`, served by `/api/metrics`. Nothing is retyped into
 * the interface, because a methodology page that drifts from the engine is worse than no
 * methodology page — it documents a system that no longer exists and is believed anyway.
 *
 * The two long-form sections in the middle are the exceptions the platform is most often asked
 * about, and both are decisions rather than defaults: state police get no per-resident rate, and
 * sheriffs are denominated on the unincorporated balance. The prose there is written against the
 * policy module, so it says what the code does and not what the product wishes it did.
 */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Overview } from '../lib/api';
import { confidenceChip, confidenceLabel, denominatorLabel, fmt, fmtPct } from '../lib/format';
import { EmptyState, ErrorState, Loading, Notice, useAsync } from '../components/primitives';

/* ------------------------------------------------------------------ shapes ----------- */

interface MetricDef {
  metric_id: string;
  display_name: string;
  description?: string;
  formula?: string;
  numerator?: string;
  denominator?: string;
  unit: string;
  source: string;
  frequency?: string;
  preferred_visualization?: string;
  comparison_allowed: boolean;
  ranking_allowed: boolean;
  attribution_level?: string;
  limitations?: string[];
}

interface MetricsPayload {
  denominator_policy: {
    primary: string; secondary: string; reconciliation: string;
    divergence_flag_threshold: number; rule: string;
  };
  metrics: MetricDef[];
  prohibited_metrics: { metric_id: string; reason: string }[];
  denominator_types: Record<string, string | null>;
  confidence_levels: string[];
  thresholds: Record<string, number>;
}

/* Glosses for registry identifiers. Keys that are not listed fall through to the raw value,
   so a new source added to the registry appears here rather than disappearing. */
const SOURCE_GLOSS: Record<string, string> = {
  pep_place_or_cousub:
    'Census Population Estimates Program, place or county-subdivision level, vintage matched to the data year',
  acs5_place_or_cousub:
    'American Community Survey five-year estimates at the same geography, used where no PEP estimate exists',
  fbi_agency_population:
    "The population figure the FBI attaches to the agency's own submission",
};

const CONFIDENCE_MEANING: Record<string, { what: string; when: string }> = {
  HIGH: {
    what: 'The denominator is the resident population of the jurisdiction the agency actually polices.',
    when: 'A municipal department whose geography link was accepted, denominated on a population estimate for the same year as the numerator.',
  },
  MODERATE: {
    what: 'The denominator is defensible by construction but cannot be exactly right.',
    when: "A sheriff denominated on the unincorporated balance, a consolidated city-county on the full county population, or a place standing on a five-year survey estimate rather than a single-year estimate.",
  },
  LIMITED: {
    what: 'The denominator type is valid, but something about this observation weakens it.',
    when: 'No population estimate exists for this year, or the geography link has not been accepted, or a balance-denominated sheriff is above the plausibility threshold below.',
  },
  NOT_COMPARABLE: {
    what: 'No resident denominator can ever apply, in any year.',
    when: 'Statewide agencies, campus, transit, port and park police, and any agency whose served population no federal source establishes. Counts are published; rates are not.',
  },
};

const THRESHOLD_META: Record<string, { label: string; note: string; format: (n: number) => string }> = {
  sheriff_plausibility_officers_per_1k: {
    label: 'Sheriff plausibility ceiling',
    note: 'Above this many officers per 1,000 residents on an unincorporated-balance denominator, the value carries a methodology warning. It is never capped, hidden or replaced. Raising it hides real signal; lowering it warns on ordinary rural sheriffs.',
    format: (n) => `${n} per 1,000`,
  },
  minimum_cohort_size: {
    label: 'Minimum peer cohort size',
    note: 'Below this many peers, no percentile is shown. A cohort of four is not a distribution.',
    format: (n) => `${fmt(n)} agencies`,
  },
  months_required_for_rate: {
    label: 'Months required for an annual rate',
    note: 'A rate is published only on complete reporting. Counts are published on partial reporting.',
    format: (n) => `${n} of 12 months`,
  },
};

const UNIT_LABEL: Record<string, string> = {
  count: 'count',
  persons: 'persons',
  ratio: 'ratio',
  per_1000: 'per 1,000 residents',
  per_100k: 'per 100,000 residents',
  index: 'index',
  usd_thousands: 'US$ thousands',
};

/* ------------------------------------------------------------------ page ------------- */

export default function Methodology() {
  const metrics = useAsync<MetricsPayload>(() => api.metrics(), []);
  const overview = useAsync<Overview>(() => api.overview(), []);

  if (metrics.loading) return <div className="card"><Loading rows={6} label="Loading the metric registry" /></div>;
  if (metrics.error) return <div className="card"><ErrorState error={metrics.error} retry={metrics.retry} /></div>;
  if (!metrics.data) return <EmptyState title="No metric registry in this release" />;

  const m = metrics.data;

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Reference</div>
        <h1>Methodology</h1>
        <p className="question">How is every number on this platform produced?</p>
        <p>
          Every metric, denominator rule and threshold below is read at request time from the
          registry the build itself reads. If a rule changes, this page changes with it; there is
          no second copy of the methodology maintained by hand.
        </p>
      </header>

      <DenominatorPolicy policy={m.denominator_policy} />
      <ConfidenceLevels levels={m.confidence_levels} />
      <DenominatorTypes types={m.denominator_types} />
      <StatePoliceSection />
      <SheriffSection threshold={m.thresholds.sheriff_plausibility_officers_per_1k} />
      <PartialYearSection months={m.thresholds.months_required_for_rate} />
      <MetricRegistry metrics={m.metrics} />
      <ProhibitedMetrics rows={m.prohibited_metrics} />
      <ReconciliationSection
        reconciliation={overview.data?.reconciliation}
        loading={overview.loading}
        error={overview.error}
        retry={overview.retry}
      />
      <ThresholdsSection thresholds={m.thresholds} />
    </>
  );
}

/* ------------------------------------------------------------------ denominators ----- */

function DenominatorPolicy({ policy }: { policy: MetricsPayload['denominator_policy'] }) {
  return (
    <section className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div>
          <h2>Denominator policy</h2>
          <div className="question">
            Which population estimate sits under a rate, and what happens when the candidates
            disagree.
          </div>
        </div>
      </div>
      <div className="card-body">
        <dl className="deflist">
          <dt>Primary source</dt>
          <dd>
            <code>{policy.primary}</code>
            <div style={{ color: 'var(--muted)' }}>{SOURCE_GLOSS[policy.primary] ?? 'See the source register.'}</div>
          </dd>
          <dt>Secondary source</dt>
          <dd>
            <code>{policy.secondary}</code>
            <div style={{ color: 'var(--muted)' }}>{SOURCE_GLOSS[policy.secondary] ?? 'See the source register.'}</div>
          </dd>
          <dt>Reconciliation source</dt>
          <dd>
            <code>{policy.reconciliation}</code>
            <div style={{ color: 'var(--muted)' }}>{SOURCE_GLOSS[policy.reconciliation] ?? 'See the source register.'}</div>
          </dd>
          <dt>Divergence flag threshold</dt>
          <dd className="num">{fmtPct(policy.divergence_flag_threshold, 0)}</dd>
        </dl>
        <div className="notice info" style={{ marginTop: 14 }}>
          <span className="t">The rule</span>
          {policy.rule.trim()}
        </div>
        <p className="question" style={{ marginTop: 12 }}>
          The reason all three are kept rather than one being chosen and the others discarded: a
          large disagreement between them is the only cheap signal that the agency-to-geography
          link is wrong. A single denominator would still produce a rate, and the rate would look
          exactly as confident as a correct one.
        </p>
      </div>
    </section>
  );
}

function ConfidenceLevels({ levels }: { levels: string[] }) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>Denominator confidence</h2>
          <div className="question">
            Four levels, attached to every rate the platform publishes. The level is about the
            denominator, never about the agency.
          </div>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <caption className="sr-only">Denominator confidence levels</caption>
            <thead>
              <tr>
                <th>Level</th>
                <th>What it means</th>
                <th>When it is assigned</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((c) => {
                const meaning = CONFIDENCE_MEANING[c];
                return (
                  <tr key={c}>
                    <td><span className={confidenceChip(c)}>{confidenceLabel(c)}</span></td>
                    <td className="wide">{meaning ? meaning.what : 'Defined in the policy module; no description is published for this level.'}</td>
                    <td className="wide">{meaning ? meaning.when : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-foot">
        A NOT_COMPARABLE denominator is not a data gap that a future release will close. It is a
        statement that the question "how many officers per resident?" does not apply to that
        agency.
      </div>
    </section>
  );
}

function DenominatorTypes({ types }: { types: Record<string, string | null> }) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>Denominator types</h2>
          <div className="question">What the population under a rate actually represents.</div>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <caption className="sr-only">Denominator types and what each represents</caption>
            <thead>
              <tr><th>Type</th><th>Definition</th></tr>
            </thead>
            <tbody>
              {Object.entries(types).map(([id, note]) => (
                <tr key={id}>
                  <td>
                    {denominatorLabel(id)}
                    <div><code style={{ fontSize: 11.5, color: 'var(--faint)' }}>{id}</code></div>
                  </td>
                  <td className="wide">
                    {note
                      ? note
                      : <span className="withheld neutral">No definition is registered for this type</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-foot">
        A denominator type is a structural property of an agency and its jurisdiction. It does not
        change from year to year because an estimate happens to be missing — a city department is
        municipally denominated in 2016 exactly as in 2025, and the absence of a 2016 rate is a
        coverage gap, not a change of kind.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ two decisions ---- */

function StatePoliceSection() {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>State police get no per-resident staffing or crime rate</h2>
          <div className="question">The most frequently questioned omission on the platform.</div>
        </div>
        <span className={confidenceChip('NOT_COMPARABLE')}>Not comparable</span>
      </div>
      <div className="card-body prose">
        <p>
          A statewide agency's jurisdiction is the whole state. Every resident it serves is already
          inside the denominator of the municipal department or sheriff's office that also serves
          them. Divide a state police headcount by the state population and the resulting figure
          shares its denominator with several hundred local figures at once; add those figures
          together, or place them on the same axis, and the same residents have been counted
          repeatedly.
        </p>
        <p>
          This is not a data-quality problem and no future release will fix it. The state
          population is known precisely. The rate is arithmetically computable and would look
          entirely ordinary on a chart. It is the <em>meaning</em> that fails: officers per
          resident is a measure of how thickly one agency covers a population it is solely
          responsible for, and no statewide agency is solely responsible for anyone.
        </p>
        <p>
          So the platform assigns these agencies the <code>statewide_population</code> denominator
          type, which carries NOT_COMPARABLE confidence, and displays{' '}
          <span className="withheld">Not comparable using a standard resident denominator</span> in
          place of the number. Counts — sworn officers, civilian personnel, offenses reported —
          are published in full, because those are facts about the agency that do not require a
          denominator.
        </p>
        <p>
          The same reasoning, for a different reason, excludes university, transit, port and
          airport, and park and conservation police. Their served population is transient and
          nested inside another agency's jurisdiction: a campus force polices a daytime population
          that no resident count describes, and a transit force polices a linear network that
          corresponds to no Census geography. There a resident denominator is a category error, not
          a weak estimate.
        </p>
      </div>
    </section>
  );
}

function SheriffSection({ threshold }: { threshold: number }) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>Sheriff denominators use the unincorporated balance</h2>
          <div className="question">
            A large correction that is right in direction and still imperfect in magnitude.
          </div>
        </div>
        <span className={confidenceChip('MODERATE')}>Moderate</span>
      </div>
      <div className="card-body prose">
        <p>
          A sheriff's office does not police everyone in its county. The incorporated cities inside
          the county run their own departments, and the sheriff's patrol responsibility normally
          covers what is left: the <strong>unincorporated balance</strong>, which is the county
          population minus the population of every incorporated place within it. Denominating a
          sheriff on the full county population therefore divides by residents another agency
          serves, and produces a staffing figure that is too low by a factor that varies with how
          urbanized the county is.
        </p>
        <p>
          The correction is not marginal. Los Angeles County has a resident population of{' '}
          <span className="num">9,748,868</span>; its unincorporated balance is{' '}
          <span className="num">969,505</span> — a tenth of the county. Two figures for the same
          agency in the same year that differ tenfold are not a rounding choice, and a platform that
          quietly picked one would be making the single most consequential decision about sheriffs
          invisibly.
        </p>
        <p>
          The balance is still not exactly right, and cannot be. Sheriffs' offices frequently police
          incorporated cities under contract — the city pays the county to provide patrol instead of
          running a department — and those residents are inside the sheriff's actual workload and
          outside the balance. No federal source publishes those contracts. There is no file to
          join, no field to read, and no way to compute the true served population from anything the
          government releases.
        </p>
        <p>
          So the platform does what it can defend and says so. Where the officers-per-1,000 figure
          on a balance denominator exceeds{' '}
          <strong className="num">{threshold}</strong>, the value is published{' '}
          <strong>with a methodology warning</strong> naming contract policing as the usual cause.
          It is not capped. It is not winsorized. It is not smoothed, hidden, replaced with a
          modelled estimate, or excluded from the distribution. The threshold is configurable
          precisely because it is a judgment: raise it and real signal disappears, lower it and
          ordinary rural sheriffs are warned about for having small populations.
        </p>
        <p>
          Every agency past the threshold is enumerated on the{' '}
          <Link to="/quality">Data Quality Center</Link> under the{' '}
          <code>likely_contract_policing</code> check, with the observed figure and the balance it
          was computed on.
        </p>
        <Notice tone="warn" title="What the warning does not claim">
          The flag says the denominator is probably too small for this agency. It does not say the
          agency is overstaffed, and the platform publishes no view on what an appropriate staffing
          level is.
        </Notice>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ partial year ----- */

const COVERAGE_RULE: { months: string; status: string; chip: string; rate: string; counts: string }[] = [
  { months: '12', status: 'COMPLETE', chip: 'chip chip-ok', rate: 'Published', counts: 'Published' },
  { months: '1–11', status: 'PARTIAL', chip: 'chip chip-warn', rate: 'Withheld — insufficient annual reporting coverage', counts: 'Published' },
  { months: '0', status: 'NONE', chip: 'chip chip-crit', rate: 'Withheld — not reported', counts: 'Not published; the agency reported nothing' },
  { months: 'no submission record', status: 'UNKNOWN', chip: 'chip chip-outline', rate: 'Withheld — not reported', counts: 'Not published; absence is not a zero' },
];

function PartialYearSection({ months }: { months: number }) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <div>
          <h2>The partial-year rule</h2>
          <div className="question">
            Counts may be shown on partial reporting. An annual rate may not.
          </div>
        </div>
      </div>
      <div className="card-body prose">
        <p>
          Reporting completeness is read from the twelve monthly reported flags in the FBI's master
          files, not inferred from whether a record exists. Those months determine a coverage
          status, and the coverage status determines whether a rate is allowed.
        </p>
      </div>
      <div className="card-body" style={{ paddingTop: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <caption className="sr-only">Months reported to coverage status to rate permission</caption>
            <thead>
              <tr>
                <th className="n">Months reported</th>
                <th>Coverage status</th>
                <th>Annual rate</th>
                <th>Counts</th>
              </tr>
            </thead>
            <tbody>
              {COVERAGE_RULE.map((r) => (
                <tr key={r.status}>
                  <td className="n num">{r.months}</td>
                  <td><span className={r.chip}>{r.status}</span></td>
                  <td className="wide">{r.rate}</td>
                  <td className="wide">{r.counts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-body prose" style={{ paddingTop: 14 }}>
        <p>
          The threshold is {months} of 12 and there is no partial credit, because annualizing a
          partial year requires assuming the unreported months resemble the reported ones. No source
          methodology supports that assumption, and for the cases where it matters most — a
          department that stopped submitting mid-year during a records-system migration — it is
          most likely to be wrong. Scaling a seven-month count to twelve produces a number that
          never existed, presented with the same authority as one that did.
        </p>

        <h3>Worked example: Baltimore Police Department, 2021</h3>
        <p>
          Baltimore submitted <strong>7 of 12 months</strong> in 2021, during the national
          transition from the Summary Reporting System to NIBRS. The platform therefore publishes
          the offense counts Baltimore reported for those seven months, labelled as covering seven
          months, and publishes <strong>no 2021 violent crime rate</strong> — the year is drawn as
          a hollow point on the trend and the value reads{' '}
          <span className="withheld">Insufficient annual reporting coverage</span>.
        </p>
        <p>
          The 2020 and 2022 rates on either side are published normally, and the line between them
          breaks rather than bridging the gap, because a straight segment across 2021 is a claim
          about a year nobody measured. See the{' '}
          <Link to="/agencies/MDBPD0000">Baltimore Police Department profile</Link>, where the same
          seven-month year is visible in the snapshot, the trend and the coverage table.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ registry --------- */

function MetricRegistry({ metrics }: { metrics: MetricDef[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const rankable = useMemo(() => metrics.filter((m) => m.ranking_allowed).length, [metrics]);

  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Metric registry</h2>

      <Notice tone="info" title="A metric can be accurate and still carry ranking_allowed: false">
        The two permissions below answer different questions. <strong>Comparison</strong> asks
        whether two agencies' values are measuring the same thing on the same basis.{' '}
        <strong>Ranking</strong> asks whether ordering many agencies by the value produces a list
        that means what a reader will take it to mean. A violent crime rate can be exactly correct
        for both of two cities and an ordered league table of them still be misleading, because the
        order is driven by reporting practice, jurisdiction boundaries and the composition of the
        population as much as by anything a department did. Ranking jurisdictions by crime rate is
        the specific practice the FBI's own <em>Caution Against Ranking</em> warns against, and this
        platform does not offer it. {rankable} of {metrics.length} registered metrics permit
        ranking; the rest are offered with peer cohorts and percentiles instead, with the cohort
        definition shown.
      </Notice>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <h2>{fmt(metrics.length)} registered metrics</h2>
            <div className="question">Select a metric for its formula, source and limitations.</div>
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="tablewrap">
            <table className="data">
              <caption className="sr-only">The metric registry</caption>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Unit</th>
                  <th>Comparison</th>
                  <th>Ranking</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <MetricRow
                    key={m.metric_id}
                    metric={m}
                    open={open === m.metric_id}
                    onToggle={() => setOpen(open === m.metric_id ? null : m.metric_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </section>
  );
}

function MetricRow({ metric: m, open, onToggle }: { metric: MetricDef; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td className="wide">
          <button className="rowtoggle" onClick={onToggle} aria-expanded={open}>
            <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
            {m.display_name}
          </button>
          <div><code style={{ fontSize: 11.5, color: 'var(--faint)' }}>{m.metric_id}</code></div>
        </td>
        <td>{UNIT_LABEL[m.unit] ?? m.unit}</td>
        <td>
          <span className={m.comparison_allowed ? 'chip chip-ok' : 'chip chip-warn'}>
            {m.comparison_allowed ? 'Comparison allowed' : 'Comparison not allowed'}
          </span>
        </td>
        <td>
          <span className={m.ranking_allowed ? 'chip chip-ok' : 'chip chip-outline'}>
            {m.ranking_allowed ? 'Ranking allowed' : 'Ranking not offered'}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={4}>
            {m.description && <p style={{ margin: '0 0 10px', color: 'var(--ink-2)' }}>{m.description.trim()}</p>}
            {m.formula && <div className="formula">{m.formula}</div>}
            <dl className="deflist" style={{ marginTop: 12 }}>
              <dt>Source</dt><dd><code>{m.source}</code></dd>
              {m.numerator && (<><dt>Numerator</dt><dd><code>{m.numerator}</code></dd></>)}
              {m.denominator && (<><dt>Denominator</dt><dd><code>{m.denominator}</code></dd></>)}
              {m.frequency && (<><dt>Frequency</dt><dd>{m.frequency}</dd></>)}
              {m.attribution_level && (
                <>
                  <dt>Attributed to</dt>
                  <dd>
                    {m.attribution_level.replace(/_/g, ' ')} — not to a law enforcement agency.
                  </dd>
                </>
              )}
            </dl>
            {m.limitations && m.limitations.length > 0 ? (
              <>
                <h3 style={{ margin: '14px 0 4px' }}>Limitations</h3>
                <ul>
                  {m.limitations.map((l, i) => <li key={i}>{l.trim()}</li>)}
                </ul>
              </>
            ) : (
              <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
                No limitations are registered for this metric.
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ prohibited ------- */

function ProhibitedMetrics({ rows }: { rows: { metric_id: string; reason: string }[] }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Metrics this platform will not build</h2>
      <p className="question" style={{ marginBottom: 12, maxWidth: '78ch' }}>
        These are registered refusals, not gaps in the roadmap. Each one is a figure that other
        products publish, that this platform could compute from data it already holds, and that
        would be wrong in a way the reader could not see. The registry carries them so that the
        decision is auditable and so that nobody rebuilds one by accident.
      </p>
      <div className="grid g2">
        {rows.map((r) => (
          <div className="card" key={r.metric_id}>
            <div className="card-head">
              <div>
                <h2 style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{r.metric_id}</h2>
              </div>
              <span className="chip chip-crit">Not built</span>
            </div>
            <div className="card-body" style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {r.reason.trim()}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ reconciliation --- */

function ReconciliationSection({ reconciliation, loading, error, retry }: {
  reconciliation: Overview['reconciliation'] | undefined;
  loading: boolean; error: unknown; retry: () => void;
}) {
  return (
    <section className="card" style={{ marginTop: 20 }}>
      <div className="card-head">
        <div>
          <h2>Staffing reconciliation</h2>
          <div className="question">
            Why the platform's national sworn figure differs from the FBI's, and why that is a
            ledger rather than a discrepancy.
          </div>
        </div>
      </div>
      <div className="card-body prose">
        {loading && <Loading rows={3} label="Loading the reconciliation ledger" />}
        {!!error && <ErrorState error={error} retry={retry} />}
        {!loading && !error && !reconciliation?.available && (
          <p>
            No reconciliation is published for the current release. The national sworn figure is
            shown on the <Link to="/">Overview</Link> with its exclusions named beside it.
          </p>
        )}
        {reconciliation?.available && (
          <>
            <p>
              For {reconciliation.year} the platform reports{' '}
              <strong className="num">{fmt(reconciliation.platform_total)}</strong> sworn officers.
              The FBI's own published national figure for the same year is{' '}
              <strong className="num">{fmt(reconciliation.fbi_published)}</strong>. Both are drawn
              from the same collection. They differ because they describe{' '}
              <strong>different universes</strong>, and every record between them is accounted for.
            </p>
            <dl className="deflist">
              <dt>FBI Police Employee master file</dt>
              <dd className="num">{fmt(reconciliation.source_file_total)}</dd>
              {Object.entries(reconciliation.excluded ?? {})
                .filter(([k]) => k !== 'records')
                .map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>Less: {k.replace(/_/g, ' ')}</dt>
                    <dd className="num">−{fmt(v)}</dd>
                  </Fragment>
                ))}
              <dt>Platform national total</dt>
              <dd className="num"><strong>{fmt(reconciliation.platform_total)}</strong></dd>
            </dl>
            <p style={{ marginTop: 12 }}>
              Federal agencies are excluded because this platform's universe is state, local,
              tribal and territorial — the same scope as the BJS agency census. The other two
              exclusions are identifier problems: records on an ORI7 shared by several agencies,
              which are refused rather than misattributed, and records on an ORI7 with no agency in
              the directory. The residual after the three exclusions is zero. Nothing was adjusted
              to make the two figures agree.
            </p>
            <p>
              The consequence for reading the headline:{' '}
              <strong className="num">{fmt(reconciliation.platform_total)}</strong> is valid for the
              platform's stated universe and must never be read as a count of all US law enforcement
              officers. The exclusion counts travel with the figure on the{' '}
              <Link to="/">Overview</Link> rather than living only here, so a reader who wants the
              federal-inclusive number can compute it from what is on screen.
            </p>
            {reconciliation.document && (
              <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Full ledger, including the per-ORI detail behind each exclusion:{' '}
                <code>{reconciliation.document}</code>, regenerated by{' '}
                <code>scripts/reconcile_staffing.py</code> on every build.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ thresholds ------- */

function ThresholdsSection({ thresholds }: { thresholds: Record<string, number> }) {
  return (
    <section className="card" style={{ marginTop: 20, marginBottom: 8 }}>
      <div className="card-head">
        <div>
          <h2>Thresholds</h2>
          <div className="question">
            The numbers that decide what is shown. All of them are configurable, and all of them
            are judgments rather than findings.
          </div>
        </div>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <caption className="sr-only">Configured policy thresholds</caption>
            <thead>
              <tr>
                <th>Threshold</th>
                <th className="n">Value</th>
                <th>What it controls</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(thresholds).map(([k, v]) => {
                const meta = THRESHOLD_META[k];
                return (
                  <tr key={k}>
                    <td>
                      {meta ? meta.label : k.replace(/_/g, ' ')}
                      <div><code style={{ fontSize: 11.5, color: 'var(--faint)' }}>{k}</code></div>
                    </td>
                    <td className="n num">{meta ? meta.format(v) : fmt(v)}</td>
                    <td className="wide">
                      {meta ? meta.note : 'Defined in the policy module; no description is registered for this threshold.'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card-foot">
        Thresholds live in <code>src/nledp/policy.py</code> and are read by the analytics SQL, the
        API and this interface from the same place, so a component cannot quietly apply a different
        one.
      </div>
    </section>
  );
}
