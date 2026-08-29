/**
 * Charts, hand-built in SVG.
 *
 * A charting library was not used here, and the reason is the product's central rule. This
 * platform must break a line where a year is missing, mark a partial-reporting year with a
 * different symbol, refuse to interpolate across either, and never draw a value the policy
 * engine withheld. Every general-purpose library treats those as edge cases to configure
 * around; here they are the main case, so the marks are drawn directly.
 *
 * Every chart also emits a screen-reader table, because a picture of a series is not an
 * accessible presentation of it.
 */
import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DASH, fmt } from '../lib/format';

export interface Point {
  x: number;                       // year
  y: number | null;                // null = no value; never rendered as zero
  partial?: boolean;               // reported, but fewer than 12 months
  withheldReason?: string | null;  // why y is null when a count exists
  count?: number | null;           // the count that exists even when the rate does not
}

interface TimeSeriesProps {
  points: Point[];
  height?: number;
  unit?: string;
  valueLabel?: string;
  format?: (n: number) => string;
  yZero?: boolean;
  reference?: { value: number; label: string } | null;
  ariaLabel: string;
}

/** A single series with real gaps: segments break wherever a value is missing. */
export function TimeSeries({
  points, height = 190, unit, valueLabel = 'Value', format = (n) => fmt(Math.round(n)),
  yZero = true, reference = null, ariaLabel,
}: TimeSeriesProps) {
  const gid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = height, PAD = { t: 14, r: 16, b: 26, l: 52 };

  const values = points.filter((p) => p.y !== null).map((p) => p.y as number);
  if (reference) values.push(reference.value);
  const hasData = values.length > 0;
  const rawMin = hasData ? Math.min(...values) : 0;
  const rawMax = hasData ? Math.max(...values) : 1;
  const min = yZero ? Math.min(0, rawMin) : rawMin - (rawMax - rawMin) * 0.12;
  const max = rawMax === min ? rawMax + 1 : rawMax + (rawMax - min) * 0.10;

  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const px = (x: number) => PAD.l + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PAD.l - PAD.r);
  const py = (y: number) => H - PAD.b - ((y - min) / (max - min)) * (H - PAD.t - PAD.b);

  // Break the path into contiguous runs of present values.
  const segments = useMemo(() => {
    const out: Point[][] = [];
    let run: Point[] = [];
    for (const p of points) {
      if (p.y === null) { if (run.length) out.push(run); run = []; }
      else run.push(p);
    }
    if (run.length) out.push(run);
    return out;
  }, [points]);

  const ticks = useMemo(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
  }, [min, max]);

  if (!hasData) {
    return (
      <div className="state-block">
        <div className="title">No values to plot</div>
        <div>Every year in this range is missing, not reported, or withheld.</div>
      </div>
    );
  }

  const hoverPoint = hover !== null ? points.find((p) => p.x === hover) : null;

  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}
           preserveAspectRatio="none" style={{ height }}>
        <defs>
          <linearGradient id={`area${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2E7CF6" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#2E7CF6" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={PAD.l} x2={W - PAD.r} y1={py(t)} y2={py(t)} />
            <text className="axis-text" x={PAD.l - 7} y={py(t) + 3} textAnchor="end">{format(t)}</text>
          </g>
        ))}

        {reference && (
          <g>
            <line className="ref-line" x1={PAD.l} x2={W - PAD.r} y1={py(reference.value)} y2={py(reference.value)} />
            <text className="axis-text" x={W - PAD.r} y={py(reference.value) - 5} textAnchor="end">{reference.label}</text>
          </g>
        )}

        {segments.map((seg, i) => {
          const d = seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${px(p.x)},${py(p.y as number)}`).join(' ');
          const area = `${d} L${px(seg[seg.length - 1].x)},${H - PAD.b} L${px(seg[0].x)},${H - PAD.b} Z`;
          return (
            <g key={i}>
              {seg.length > 1 && <path d={area} fill={`url(#area${gid})`} />}
              <path className="series-line" d={d} />
            </g>
          );
        })}

        {points.map((p, i) => {
          if (p.y === null) {
            return (
              <g key={i}>
                <line x1={px(p.x)} x2={px(p.x)} y1={PAD.t} y2={H - PAD.b}
                      stroke="var(--rule)" strokeDasharray="2 4" />
                <circle cx={px(p.x)} cy={H - PAD.b} r={3} fill="var(--surface)"
                        stroke="var(--faint)" strokeWidth={1.5} />
              </g>
            );
          }
          const last = i === points.length - 1;
          return (
            <circle key={i} cx={px(p.x)} cy={py(p.y)} r={p.partial ? 4.5 : last ? 4.5 : 3}
                    className={p.partial ? 'pt-partial' : last ? 'pt-end' : 'pt'} />
          );
        })}

        {points.map((p, i) => (
          <g key={`x${i}`}>
            <text className="axis-text" x={px(p.x)} y={H - 8} textAnchor="middle">{p.x}</text>
            <rect x={px(p.x) - 14} y={PAD.t} width={28} height={H - PAD.t - PAD.b}
                  fill="transparent" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover(p.x)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}

        {hoverPoint && (
          <line x1={px(hoverPoint.x)} x2={px(hoverPoint.x)} y1={PAD.t} y2={H - PAD.b}
                stroke="var(--blue-400)" strokeWidth={1} />
        )}
      </svg>

      {hoverPoint && (
        <div className="notice" style={{ marginTop: 8, borderLeftColor: 'var(--blue-500)' }}>
          <span className="t num">{hoverPoint.x}</span>
          {hoverPoint.count != null && (
            <div>Count: <span className="num">{fmt(hoverPoint.count)}</span></div>
          )}
          <div>
            {valueLabel}:{' '}
            {hoverPoint.y === null
              ? <span style={{ color: 'var(--warn)' }}>{hoverPoint.withheldReason ?? 'Not available'}</span>
              : <span className="num">{format(hoverPoint.y)}{unit ? ` ${unit}` : ''}</span>}
          </div>
        </div>
      )}

      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead><tr><th>Year</th><th>{valueLabel}</th><th>Note</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.x}>
                <td>{p.x}</td>
                <td>{p.y === null ? 'Not available' : format(p.y)}</td>
                <td>{p.withheldReason ?? (p.partial ? 'Partial year' : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ overlay ---------- */

/**
 * Five fixed series identities. Colour alone never carries the meaning: each series also has
 * its own dash pattern and its own marker, the legend repeats both, and the screen-reader
 * table names every series in a column header.
 */
const SERIES_STYLE = [
  { color: '#0B4FDB', dash: undefined as string | undefined },
  { color: '#9A5B00', dash: '7 3' },
  { color: '#0F7B54', dash: '2 3' },
  { color: '#A81E2D', dash: '9 3 2 3' },
  { color: '#5B6B8C', dash: '1 4' },
];

export interface SeriesSpec {
  id: string;
  label: string;
  points: Point[];
  /** Shown under the label in the legend, e.g. the base year an index was rebased to. */
  note?: string;
}

/**
 * Several series on one pair of axes.
 *
 * This exists for one job only: an indexed comparison, where rebasing has already put every
 * series on a shared scale and overlaying them is the entire point. Raw values from agencies
 * of different sizes are not drawn this way — they get one chart each, so a small department
 * is not flattened against the bottom axis of a large one.
 *
 * The rules of the single series hold here without exception. A line breaks wherever a value
 * is missing, nothing is interpolated across the gap, a partial-reporting year is drawn
 * hollow, and a withheld value is a gap rather than a point.
 */
export function MultiSeries({
  series, height = 260, unit, valueLabel = 'Value', format = (n) => fmt(Math.round(n)),
  yZero = false, reference = null, ariaLabel,
}: {
  series: SeriesSpec[];
  height?: number;
  unit?: string;
  valueLabel?: string;
  format?: (n: number) => string;
  yZero?: boolean;
  reference?: { value: number; label: string } | null;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 760, H = height, PAD = { t: 14, r: 16, b: 26, l: 56 };

  const years = useMemo(() => {
    const set = new Set<number>();
    for (const s of series) for (const p of s.points) set.add(p.x);
    return [...set].sort((a, b) => a - b);
  }, [series]);

  // Every series is expanded onto the shared year axis, so a year one agency never reported
  // is an explicit gap in that agency's line rather than a shortened line.
  const aligned = useMemo(() => series.map((s) => {
    const byYear = new Map(s.points.map((p) => [p.x, p]));
    return { ...s, points: years.map((y) => byYear.get(y) ?? { x: y, y: null }) };
  }), [series, years]);

  const values: number[] = [];
  for (const s of aligned) for (const p of s.points) if (p.y !== null) values.push(p.y);
  if (reference) values.push(reference.value);

  if (values.length === 0 || years.length === 0) {
    return (
      <div className="state-block">
        <div className="title">No values to plot</div>
        <div>Every year of every selected agency is missing, not reported, or withheld.</div>
      </div>
    );
  }

  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  const min = yZero ? Math.min(0, rawMin) : rawMin - (rawMax - rawMin) * 0.12;
  const max = rawMax === min ? rawMax + 1 : rawMax + (rawMax - min) * 0.10;

  const xMin = years[0], xMax = years[years.length - 1];
  const px = (x: number) => PAD.l + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PAD.l - PAD.r);
  const py = (y: number) => H - PAD.b - ((y - min) / (max - min)) * (H - PAD.t - PAD.b);
  const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
  const step = Math.max(1, Math.ceil(years.length / 12));

  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}
           preserveAspectRatio="none" style={{ height }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={PAD.l} x2={W - PAD.r} y1={py(t)} y2={py(t)} />
            <text className="axis-text" x={PAD.l - 7} y={py(t) + 3} textAnchor="end">{format(t)}</text>
          </g>
        ))}

        {reference && (
          <g>
            <line className="ref-line" x1={PAD.l} x2={W - PAD.r} y1={py(reference.value)} y2={py(reference.value)} />
            <text className="axis-text" x={W - PAD.r} y={py(reference.value) - 5} textAnchor="end">{reference.label}</text>
          </g>
        )}

        {aligned.map((s, si) => {
          const style = SERIES_STYLE[si % SERIES_STYLE.length];
          const runs: Point[][] = [];
          let run: Point[] = [];
          for (const p of s.points) {
            if (p.y === null) { if (run.length) runs.push(run); run = []; }
            else run.push(p);
          }
          if (run.length) runs.push(run);
          return (
            <g key={s.id}>
              {runs.map((seg, i) => (
                <path key={i} fill="none" stroke={style.color} strokeWidth={2}
                      strokeDasharray={style.dash} strokeLinecap="round" strokeLinejoin="round"
                      d={seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${px(p.x)},${py(p.y as number)}`).join(' ')} />
              ))}
              {s.points.map((p, i) => p.y === null ? null : (
                <circle key={i} cx={px(p.x)} cy={py(p.y)} r={p.partial ? 4.5 : 3}
                        fill={p.partial ? 'var(--surface)' : style.color}
                        stroke={style.color} strokeWidth={p.partial ? 2 : 0} />
              ))}
            </g>
          );
        })}

        {years.map((y, i) => (
          <g key={`x${y}`}>
            {i % step === 0 && (
              <text className="axis-text" x={px(y)} y={H - 8} textAnchor="middle">{y}</text>
            )}
            <rect x={px(y) - 14} y={PAD.t} width={28} height={H - PAD.t - PAD.b}
                  fill="transparent" style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover(y)} onMouseLeave={() => setHover(null)} />
          </g>
        ))}

        {hover !== null && (
          <line x1={px(hover)} x2={px(hover)} y1={PAD.t} y2={H - PAD.b}
                stroke="var(--blue-400)" strokeWidth={1} />
        )}
      </svg>

      <div className="legend" style={{ marginTop: 10 }}>
        {aligned.map((s, si) => {
          const style = SERIES_STYLE[si % SERIES_STYLE.length];
          return (
            <span key={s.id}>
              <svg width="22" height="10" aria-hidden="true" style={{ marginRight: 5, verticalAlign: -1 }}>
                <line x1="0" y1="5" x2="22" y2="5" stroke={style.color} strokeWidth="2"
                      strokeDasharray={style.dash} />
                <circle cx="11" cy="5" r="2.6" fill={style.color} />
              </svg>
              {s.label}{s.note ? ` · ${s.note}` : ''}
            </span>
          );
        })}
      </div>

      {hover !== null && (
        <div className="notice" style={{ marginTop: 8, borderLeftColor: 'var(--blue-500)' }}>
          <span className="t num">{hover}</span>
          {aligned.map((s) => {
            const p = s.points.find((q) => q.x === hover);
            return (
              <div key={s.id}>
                {s.label}:{' '}
                {!p || p.y === null
                  ? <span style={{ color: 'var(--warn)' }}>{p?.withheldReason ?? 'Not available'}</span>
                  : <span className="num">{format(p.y)}{unit ? ` ${unit}` : ''}{p.partial ? ' (partial year)' : ''}</span>}
              </div>
            );
          })}
        </div>
      )}

      <figcaption className="sr-only">
        <table>
          <caption>{ariaLabel}</caption>
          <thead>
            <tr><th>Year</th>{aligned.map((s) => <th key={s.id}>{s.label}</th>)}</tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}>
                <td>{y}</td>
                {aligned.map((s) => {
                  const p = s.points.find((q) => q.x === y);
                  return (
                    <td key={s.id}>
                      {!p || p.y === null
                        ? (p?.withheldReason ?? 'Not available')
                        : `${format(p.y)}${unit ? ` ${unit}` : ''}${p.partial ? ' (partial year)' : ''}`}
                      {' '}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p>{valueLabel}</p>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ bars ------------- */

export function BarRows({ rows, format = fmt, max: maxIn, ariaLabel }: {
  rows: { label: string; value: number | null; sub?: string; href?: string }[];
  format?: (n: number) => string;
  max?: number;
  ariaLabel: string;
}) {
  const max = maxIn ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <div role="table" aria-label={ariaLabel} style={{ display: 'grid', gap: 7 }}>
      {rows.map((r, i) => (
        <div key={i} role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,1.3fr) minmax(0,2fr) 74px', gap: 10, alignItems: 'center' }}>
          <div role="cell" style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.href ? <a href={r.href}>{r.label}</a> : r.label}
            {r.sub && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.sub}</div>}
          </div>
          <div role="cell" style={{ background: 'var(--rule-soft)', borderRadius: 3, height: 8, overflow: 'hidden' }}>
            <div style={{
              width: `${((r.value ?? 0) / max) * 100}%`, height: '100%',
              background: r.value === null ? 'var(--rule)' : 'var(--grad-accent)',
              borderRadius: 3,
            }} />
          </div>
          <div role="cell" className="num num-sm" style={{ textAlign: 'right' }}>
            {r.value === null ? DASH : format(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ coverage --------- */

/** The strip that sits under any national or state trend, so a line is never read alone. */
export function CoverageStrip({ years }: {
  years: { data_year: number; population_coverage: number | null }[];
}) {
  return (
    <div>
      <div className="coverage-strip">
        {years.map((y) => {
          const c = y.population_coverage;
          const bg = c === null ? 'var(--rule)'
            : c >= 0.9 ? 'var(--ok)' : c >= 0.75 ? 'var(--blue-400)' : 'var(--warn)';
          return <i key={y.data_year} style={{ background: bg }} title={`${y.data_year}: ${c === null ? 'unknown' : `${Math.round(c * 100)}%`} population coverage`} />;
        })}
      </div>
      <div className="legend" style={{ marginTop: 7 }}>
        <span><i className="sw" style={{ background: 'var(--ok)' }} />90%+ population covered</span>
        <span><i className="sw" style={{ background: 'var(--blue-400)' }} />75–90%</span>
        <span><i className="sw" style={{ background: 'var(--warn)' }} />below 75%</span>
      </div>
    </div>
  );
}

export function ChartFrame({ title, subtitle, right, children, footer }: {
  title: string; subtitle?: string; right?: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="question">{subtitle}</div>}
        </div>
        {right}
      </div>
      <div className="card-body">{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}
