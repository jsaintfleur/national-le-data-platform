/**
 * Shared primitives.
 *
 * The four trust markers — source, year, coverage, methodology — are built into the metric
 * component rather than added per screen, so it is not possible to render a value in this
 * application without the context that makes it readable. Every one of the seven data
 * states has a rendered form; none of them is a blank card.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  confidenceChip, confidenceLabel, coverageChip, coverageLabel,
  denominatorLabel, fmt, DASH,
} from '../lib/format';

/* ------------------------------------------------------------------ icons ------------ */

export const Icon = {
  search: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="15" height="15">
      <circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" strokeLinecap="round" />
    </svg>
  ),
  overview: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  map: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1.5 3.5 5.5 2l5 2 4-1.5v10L10.5 14l-5-2-4 1.5z" strokeLinejoin="round" />
      <path d="M5.5 2v10M10.5 4v10" />
    </svg>
  ),
  agencies: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 14h12M3.5 14V6l4.5-3.5L12.5 6v8" strokeLinejoin="round" />
      <path d="M6.5 14v-3.5h3V14" />
    </svg>
  ),
  compare: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 13V6M8 13V3M13 13V9" strokeLinecap="round" />
    </svg>
  ),
  states: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.5 14 5v6L8 14.5 2 11V5z" strokeLinejoin="round" /><path d="M2 5l6 3.5L14 5M8 8.5v6" />
    </svg>
  ),
  quality: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 1.5 13.5 4v4.5c0 3-2.4 5.2-5.5 6-3.1-.8-5.5-3-5.5-6V4z" strokeLinejoin="round" />
      <path d="m5.6 8 1.7 1.7 3.1-3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  book: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 2.5h4a2 2 0 0 1 2 2v9a1.5 1.5 0 0 0-1.5-1.5h-4.5z" strokeLinejoin="round" />
      <path d="M13.5 2.5h-4a2 2 0 0 0-2 2v9a1.5 1.5 0 0 1 1.5-1.5h4.5z" strokeLinejoin="round" />
    </svg>
  ),
  info: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="13" height="13">
      <circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.6" strokeLinecap="round" />
    </svg>
  ),
  close: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" width="16" height="16">
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  ),
  external: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
      <path d="M6.5 3H3.5v9.5H13V9.5" strokeLinejoin="round" /><path d="M9.5 2.5H13V6M13 2.5 7.5 8" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ data states ------ */

export type DataState =
  | 'loading' | 'ok' | 'missing' | 'not_reported'
  | 'partial' | 'not_comparable' | 'error';

export function Loading({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="card-body" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div style={{ display: 'grid', gap: 8 }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton" style={{ height: i === 0 ? 22 : 13, width: i === 0 ? '46%' : `${92 - i * 9}%` }} />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown problem');
  return (
    <div className="state-block" role="alert">
      <div className="title">This section could not be loaded</div>
      <div style={{ marginBottom: retry ? 10 : 0 }}>{message}</div>
      {retry && <button className="btn" onClick={retry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-block">
      <div className="title">{title}</div>
      {detail && <div>{detail}</div>}
    </div>
  );
}

/** A value the platform will not print, with the reason it will not print it. */
export function Withheld({ reason, tone = 'warn' }: { reason: string; tone?: 'warn' | 'neutral' }) {
  return (
    <span className={tone === 'neutral' ? 'withheld neutral' : 'withheld'} title={reason}>
      {reason}
    </span>
  );
}

/* ------------------------------------------------------------------ metric ----------- */

export interface Methodology {
  metric: string;
  formula?: string;
  definition?: string;
  denominatorType?: string | null;
  denominatorValue?: number | null;
  denominatorYear?: number | null;
  denominatorSource?: string | null;
  denominatorConfidence?: string | null;
  denominatorNotes?: string | null;
  coverage?: { months: number | null; status: string | null };
  source?: { name?: string; dataset?: string; url?: string; release?: string | null };
  warning?: string | null;
  limitations?: string[];
}

export function MetricTile(props: {
  label: string;
  value: ReactNode;
  unit?: string;
  year?: number | null;
  note?: string;
  featured?: boolean;
  chips?: ReactNode;
  methodology?: Methodology;
  withheldReason?: string | null;
}) {
  const { label, value, unit, year, note, featured, chips, methodology, withheldReason } = props;
  const [open, setOpen] = useState(false);
  return (
    <div className={`card metric${featured ? ' featured' : ''}`}>
      <div className="metric-label">
        <span>{label}</span>
        {methodology && (
          <button
            className="iconbtn"
            aria-label={`How ${label} is calculated`}
            onClick={() => setOpen(true)}
            style={featured ? { color: 'rgba(255,255,255,.8)' } : undefined}
          >
            <Icon.info />
          </button>
        )}
      </div>
      {withheldReason ? (
        <div style={{ marginTop: 4 }}><Withheld reason={withheldReason} /></div>
      ) : (
        <div className="metric-value">
          <span className="num num-xl">{value}</span>
          {unit && <span className="unit">{unit}</span>}
        </div>
      )}
      {year != null && <div className="metric-year">{year}</div>}
      {chips && <div className="metric-sub">{chips}</div>}
      {note && <div className="metric-note">{note}</div>}
      {open && methodology && <MethodologyDrawer m={methodology} onClose={() => setOpen(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ drawer ----------- */

export function MethodologyDrawer({ m, onClose }: { m: Methodology; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`About ${m.metric}`}>
        <div className="drawer-head">
          <div>
            <div className="eyebrow" style={{ margin: 0 }}>About this metric</div>
            <h2 style={{ margin: '2px 0 0' }}>{m.metric}</h2>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon.close /></button>
        </div>
        <div className="drawer-body">
          {m.definition && <p>{m.definition}</p>}
          {m.formula && (<><h4>Calculation</h4><div className="formula">{m.formula}</div></>)}

          {(m.denominatorType || m.denominatorValue != null) && (
            <>
              <h4>Population denominator</h4>
              <dl>
                <dt>Type</dt><dd>{denominatorLabel(m.denominatorType)}</dd>
                {m.denominatorValue != null && (<><dt>Value</dt><dd className="num">{fmt(m.denominatorValue)}</dd></>)}
                {m.denominatorYear != null && (<><dt>Observation year</dt><dd className="num">{m.denominatorYear}</dd></>)}
                {m.denominatorSource && (<><dt>Source</dt><dd>{m.denominatorSource}</dd></>)}
                {m.denominatorConfidence && (
                  <><dt>Confidence</dt><dd><span className={confidenceChip(m.denominatorConfidence)}>{confidenceLabel(m.denominatorConfidence)}</span></dd></>
                )}
              </dl>
              {m.denominatorNotes && <p style={{ marginTop: 10 }}>{m.denominatorNotes}</p>}
            </>
          )}

          {m.warning && (
            <>
              <h4>Known limitation</h4>
              <div className="notice warn"><span className="t">Methodology warning</span>{m.warning}</div>
            </>
          )}

          {m.coverage && (
            <>
              <h4>Reporting coverage</h4>
              <dl>
                <dt>Months reported</dt><dd className="num">{coverageLabel(m.coverage.months)}</dd>
                <dt>Status</dt><dd><span className={coverageChip(m.coverage.status)}>{m.coverage.status ?? DASH}</span></dd>
              </dl>
            </>
          )}

          {m.limitations && m.limitations.length > 0 && (
            <>
              <h4>Limitations</h4>
              <ul style={{ paddingLeft: '1.1em', margin: 0, fontSize: 13, color: 'var(--ink-2)' }}>
                {m.limitations.map((l, i) => <li key={i} style={{ marginBottom: 6 }}>{l}</li>)}
              </ul>
            </>
          )}

          {m.source && (
            <>
              <h4>Source and provenance</h4>
              <dl>
                {m.source.name && (<><dt>Source</dt><dd>{m.source.name}</dd></>)}
                {m.source.dataset && (<><dt>Dataset</dt><dd>{m.source.dataset}</dd></>)}
                {m.source.release && (<><dt>Source release</dt><dd className="num">{m.source.release}</dd></>)}
              </dl>
              {m.source.url && (
                <p style={{ marginTop: 10 }}>
                  <a href={m.source.url} target="_blank" rel="noreferrer">
                    Open the source <Icon.external />
                  </a>
                </p>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/* ------------------------------------------------------------------ notice ----------- */

export function Notice({ tone = 'info', title, children }: {
  tone?: 'info' | 'warn' | 'plain'; title?: string; children: ReactNode;
}) {
  return (
    <div className={`notice ${tone === 'plain' ? '' : tone}`}>
      {title && <span className="t">{title}</span>}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ hooks ------------ */

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  // error is normalized to Error | null rather than unknown: `{error && <X/>}` in JSX yields
  // the operand's type, and an `unknown` there is a type error at every call site.
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({
    data: null, error: null, loading: true,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (d) => live && setState({ data: d, error: null, loading: false }),
      (e) => live && setState({ data: null, error: e instanceof Error ? e : new Error(String(e)), loading: false }),
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, retry: () => setNonce((n) => n + 1) };
}
