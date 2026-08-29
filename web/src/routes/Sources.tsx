/**
 * Source register.
 *
 * Provenance is the platform's only real warrant. Every figure on every other screen came from
 * one of the rows below, and this page is where a reader goes to decide whether to believe it:
 * who published it, when they last published, what it does not cover, and whether the endpoint
 * still answered when the release was built.
 *
 * The freshness treatment is deliberate. A federal statistical release is old by the time it is
 * usable, and the honest response is to label the age rather than to present the newest thing
 * available as though it described the present. `freshness()` computes that label from the
 * coverage end year, so no source can be described as current by being written about warmly.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import type { Release } from '../lib/api';
import { DASH, fmt, freshness } from '../lib/format';
import { EmptyState, ErrorState, Icon, Loading, Notice, useAsync } from '../components/primitives';

/* ------------------------------------------------------------------ shapes ----------- */

interface SourceFallback {
  api_endpoint?: string;
  verified_http_status?: number;
  note?: string;
}

interface Source {
  source_id: string;
  source_name: string;
  publisher: string;
  dataset_name: string;
  dataset_description?: string;
  source_url?: string;
  documentation_url?: string;
  access_method: string;
  api_endpoint?: string;
  geographic_level: string[];
  coverage_start_year: number | null;
  coverage_end_year: number | null;
  update_frequency: string;
  latest_release_date: string | null;
  license: string;
  primary_identifier: string;
  ingestion_status: string;
  validation_status: string;
  verified_http_status: number | null;
  known_limitations?: string[];
  fallback?: SourceFallback;
  observations_in_warehouse: number | null;
}

interface SourcesPayload {
  audited_on: string;
  sources: Source[];
  deferred_sources: { source_id: string; reason: string }[];
}

const DOMAIN_LABEL: Record<string, { label: string; detail: string }> = {
  crime: {
    label: 'Crime',
    detail: 'Offense and clearance counts from the FBI summarized and NIBRS collections.',
  },
  staffing: {
    label: 'Staffing',
    detail: 'Sworn and civilian personnel from the FBI Police Employee collection, reported as of 31 October.',
  },
  population: {
    label: 'Population',
    detail: 'Census Population Estimates Program, used as the denominator for every published rate.',
  },
  finance: {
    label: 'Government finance',
    detail: 'Census Annual Survey of State and Local Government Finances, at government-unit level.',
  },
};

/* ------------------------------------------------------------------ page ------------- */

export default function Sources() {
  const sources = useAsync<SourcesPayload>(() => api.sources(), []);
  const release = useAsync<Release>(() => api.release(), []);

  if (sources.loading) return <div className="card"><Loading rows={6} label="Loading the source register" /></div>;
  if (sources.error) return <div className="card"><ErrorState error={sources.error} retry={sources.retry} /></div>;
  if (!sources.data) return <EmptyState title="No source register in this release" />;

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Reference</div>
        <h1>Sources</h1>
        <p className="question">Where does every number come from, and how current is it?</p>
        <p>
          Thirteen federal datasets, audited on {sources.data.audited_on}. Each row records what the
          publisher covers, what it does not, and the HTTP status the endpoint returned when this
          release was built.
        </p>
      </header>

      <FreshnessPanel release={release.data} loading={release.loading} error={release.error} retry={release.retry} />

      <SourceMatrix sources={sources.data.sources} />

      <DeferredSources rows={sources.data.deferred_sources} />

      <FinanceNote />
    </>
  );
}

/* ------------------------------------------------------------------ freshness -------- */

function FreshnessPanel({ release, loading, error, retry }: {
  release: Release | null; loading: boolean; error: unknown; retry: () => void;
}) {
  return (
    <section className="card" style={{ marginTop: 18 }}>
      <div className="card-head">
        <div>
          <h2>Data freshness</h2>
          <div className="question">
            The most recent year available in each domain, and the warehouse release that holds it.
          </div>
        </div>
        {release && <span className="chip mono chip-outline">{release.release_id}</span>}
      </div>
      <div className="card-body">
        {loading && <Loading rows={3} label="Loading release metadata" />}
        {!!error && <ErrorState error={error} retry={retry} />}
        {release && (
          <>
            <div className="tablewrap">
              <table className="data">
                <caption className="sr-only">Latest available data year by domain</caption>
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th className="n">Latest year available</th>
                    <th>Age</th>
                    <th>What it covers</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(release.latest_years).map(([domain, year]) => {
                    const meta = DOMAIN_LABEL[domain];
                    const f = freshness(year);
                    return (
                      <tr key={domain}>
                        <td>{meta ? meta.label : domain.replace(/_/g, ' ')}</td>
                        <td className="n num">{year ?? DASH}</td>
                        <td><span className={f.cls}>{f.label}</span></td>
                        <td className="wide">{meta ? meta.detail : 'No description is registered for this domain.'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <dl className="deflist" style={{ marginTop: 16 }}>
              <dt>Active warehouse release</dt>
              <dd><code>{release.release_id}</code></dd>
              <dt>Built</dt>
              <dd className="num">{release.built_at ? release.built_at.replace('T', ' ').slice(0, 19) : DASH}</dd>
              {release.git_commit && (
                <>
                  <dt>Build commit</dt>
                  <dd><code>{release.git_commit.slice(0, 12)}</code></dd>
                </>
              )}
              <dt>Crime completeness cutoff</dt>
              <dd className="num">{release.crime_completeness_cutoff}</dd>
            </dl>

            {Object.keys(release.vintages ?? {}).length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>Source vintages in this build</h3>
                <div className="controls">
                  {Object.entries(release.vintages).map(([k, v]) => (
                    <span key={k} className="chip chip-outline mono" title={k}>
                      {k.replace(/_/g, ' ')}: {String(v)}
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="card-foot">
        The age column is computed from the latest year each source covers, not from when the file
        was downloaded. A dataset retrieved this morning that describes 2024 is a 2024 dataset.
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ matrix ----------- */

function statusChip(code: number | null): { cls: string; label: string } {
  if (code === null) return { cls: 'chip chip-outline', label: 'Not checked' };
  if (code >= 200 && code < 300) return { cls: 'chip chip-ok', label: String(code) };
  if (code === 403 || code === 401) return { cls: 'chip chip-warn', label: `${code} gated` };
  return { cls: 'chip chip-crit', label: String(code) };
}

function SourceMatrix({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ marginBottom: 10 }}>Source matrix</h2>
      <p className="question" style={{ marginBottom: 12 }}>
        Select a source for its description, its known limitations and its links. Every limitation
        listed there is one the platform works around rather than one it has solved.
      </p>

      <section className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div className="tablewrap">
            <table className="data">
              <caption className="sr-only">Federal source register</caption>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Publisher</th>
                  <th>Dataset</th>
                  <th>Geographic level</th>
                  <th className="n">Coverage</th>
                  <th>Freshness</th>
                  <th>Access</th>
                  <th>Update frequency</th>
                  <th className="n">Latest release</th>
                  <th className="n">Observations held</th>
                  <th>Primary identifier</th>
                  <th>License</th>
                  <th className="n">Verified status</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <SourceRow
                    key={s.source_id}
                    source={s}
                    open={open === s.source_id}
                    onToggle={() => setOpen(open === s.source_id ? null : s.source_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-foot">
          A source holding no observations is one the platform reads for identity, geography or
          reference — the agency directory, the Gazetteer, the government-units listing — rather
          than one it stores as measured rows, or one whose ingestion status says it could not be
          retrieved. Verified status is the HTTP response the endpoint gave when this release was
          built.
        </div>
      </section>
    </section>
  );
}

function SourceRow({ source: s, open, onToggle }: { source: Source; open: boolean; onToggle: () => void }) {
  const f = freshness(s.coverage_end_year);
  const st = statusChip(s.verified_http_status);
  const obs = s.observations_in_warehouse;

  return (
    <>
      <tr>
        <td className="wide">
          <button className="rowtoggle" onClick={onToggle} aria-expanded={open}>
            <span className="caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
            {s.source_name}
          </button>
          <div><code style={{ fontSize: 11.5, color: 'var(--faint)' }}>{s.source_id}</code></div>
        </td>
        <td className="wide">{s.publisher}</td>
        <td className="wide">{s.dataset_name}</td>
        <td className="wide">{s.geographic_level?.length ? s.geographic_level.join(', ').replace(/_/g, ' ') : DASH}</td>
        <td className="n num">
          {s.coverage_start_year ?? DASH}–{s.coverage_end_year ?? DASH}
        </td>
        <td><span className={f.cls}>{f.label}</span></td>
        <td>{s.access_method.replace(/_/g, ' ')}</td>
        <td>{s.update_frequency.replace(/_/g, ' ')}</td>
        <td className="n num">{s.latest_release_date ?? DASH}</td>
        <td className="n">
          {obs === null || obs === undefined
            ? DASH
            : obs === 0
              ? <span className="withheld neutral">None held</span>
              : <span className="num">{fmt(obs)}</span>}
        </td>
        <td><code style={{ fontSize: 11.5 }}>{s.primary_identifier}</code></td>
        <td className="wide">{s.license}</td>
        <td className="n"><span className={st.cls}>{st.label}</span></td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={13}>
            {s.dataset_description && (
              <p style={{ margin: '0 0 12px', color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: '86ch' }}>
                {s.dataset_description.trim()}
              </p>
            )}

            <dl className="deflist">
              <dt>Ingestion status</dt>
              <dd>
                <span className={s.ingestion_status.startsWith('active') ? 'chip chip-ok' : 'chip chip-warn'}>
                  {s.ingestion_status}
                </span>
              </dd>
              <dt>Validation status</dt>
              <dd>{s.validation_status}</dd>
              {s.api_endpoint && (
                <>
                  <dt>Endpoint</dt>
                  <dd><code style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{s.api_endpoint}</code></dd>
                </>
              )}
            </dl>

            <h3 style={{ margin: '16px 0 4px' }}>Known limitations</h3>
            {s.known_limitations && s.known_limitations.length > 0 ? (
              <ul>
                {s.known_limitations.map((l, i) => <li key={i}>{l.trim()}</li>)}
              </ul>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
                No limitations are recorded for this source. That is a statement about the register,
                not a claim that none exist.
              </p>
            )}

            {s.fallback && (
              <div className="notice info" style={{ marginTop: 14, maxWidth: '86ch' }}>
                <span className="t">Configured fallback</span>
                {s.fallback.api_endpoint && (
                  <div><code style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{s.fallback.api_endpoint}</code></div>
                )}
                {s.fallback.note && <div style={{ marginTop: 4 }}>{s.fallback.note.trim()}</div>}
              </div>
            )}

            <div className="controls" style={{ marginTop: 14 }}>
              {s.source_url && (
                <a className="btn" href={s.source_url} target="_blank" rel="noreferrer">
                  Open the source <Icon.external />
                </a>
              )}
              {s.documentation_url && (
                <a className="btn" href={s.documentation_url} target="_blank" rel="noreferrer">
                  Documentation <Icon.external />
                </a>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ deferred --------- */

function DeferredSources({ rows }: { rows: { source_id: string; reason: string }[] }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ marginBottom: 10 }}>Sources evaluated and deliberately not ingested</h2>
      <p className="question" style={{ marginBottom: 12, maxWidth: '78ch' }}>
        Each of these was assessed against the same criteria as the sources above and rejected for a
        stated reason. They are recorded because a source that is absent without explanation is
        indistinguishable from a source nobody looked for, and because the reasons are the argument
        for the platform's scope.
      </p>
      <div className="grid g2">
        {rows.map((r) => (
          <div className="card" key={r.source_id}>
            <div className="card-head">
              <div>
                <h2 style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>{r.source_id}</h2>
              </div>
              <span className="chip chip-outline">Not ingested</span>
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

/* ------------------------------------------------------------------ finance ---------- */

function FinanceNote() {
  return (
    <section style={{ marginTop: 22, marginBottom: 8 }}>
      <Notice tone="warn" title="Finance data stays at government-unit level and is never attributed to an agency">
        The Census Bureau collects expenditure from a <strong>government</strong> — a city, a county,
        a township — under function code E62, police protection. It does not collect from a police
        agency, and no published crosswalk maps one to the other. The relationship is many-to-many in
        both directions: a county's figure covers the sheriff's office and any county police
        department together while excluding jail and court functions their headcount includes, and a
        city that buys policing under contract books the payment as its own direct spending while the
        same policing also sits in the provider's total.
        <div style={{ marginTop: 8 }}>
          So the platform publishes what a government spent, labelled as what a government spent, and
          builds no per-agency, per-officer or per-capita-ranked spending metric on top of it. Those
          are listed as registered refusals on the Methodology page. The survey is also a voluntary
          stratified sample — roughly a quarter of 2024 values are imputed rather than reported, and
          the imputation flag travels with the value into the interface rather than being dropped in
          aggregation — and most units close their fiscal year on 30 June, so a finance figure does
          not line up with a calendar-year crime count.
        </div>
      </Notice>
    </section>
  );
}
