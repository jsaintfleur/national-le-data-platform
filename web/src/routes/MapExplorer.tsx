/**
 * The national map.
 *
 * Three rules shape every decision here, and they are the reason this is not a generic
 * choropleth screen.
 *
 * Raw counts are never mapped as though geographic area explained magnitude — the metric
 * list offers rates, per-capita staffing and coverage, and where a count IS offered
 * (sworn officers on the agency point layer) it is sized, labelled as a count, and never
 * poured into a polygon.
 *
 * No-data is never colored as zero. A feature without a value gets a hatch pattern that
 * cannot be mistaken for a low value, and it says so in the legend.
 *
 * No coordinate is ever invented. Agencies without a published point are counted and named
 * in the panel so a user knows what is off the map, and they remain fully searchable.
 *
 * Geometry is the Census 2025 cartographic boundary files at 20m generalization, converted
 * to GeoJSON at build time — small enough to ship, authoritative, and shoreline-clipped so
 * coastal states do not render with their territorial water.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '../lib/api';
import type { MapResponse } from '../lib/api';
import {
  agencyTypeLabel, confidenceChip, confidenceLabel, coverageChip, coverageLabel,
  DASH, denominatorLabel, fmt, fmtCompact, fmtDecimal, fmtRate,
} from '../lib/format';
import { EmptyState, ErrorState, Loading, Notice, Withheld, useAsync } from '../components/primitives';

type Layer = 'agency' | 'state' | 'county';

const METRICS: { id: string; label: string; layers: Layer[]; kind: 'rate' | 'count' | 'coverage' }[] = [
  { id: 'violent_crime_rate', label: 'Violent crime rate', layers: ['agency', 'state', 'county'], kind: 'rate' },
  { id: 'property_crime_rate', label: 'Property crime rate', layers: ['agency', 'state', 'county'], kind: 'rate' },
  { id: 'officers_per_1k', label: 'Officers per 1,000', layers: ['agency', 'state', 'county'], kind: 'rate' },
  { id: 'sworn_officers', label: 'Sworn officers', layers: ['agency'], kind: 'count' },
  { id: 'population', label: 'Population served', layers: ['agency'], kind: 'count' },
  { id: 'months_reported', label: 'Reporting completeness', layers: ['agency', 'state'], kind: 'coverage' },
];

// A five-step sequential ramp from the palette's own blues. Sequential, not diverging:
// none of these metrics has a meaningful midpoint that would justify two hues.
const RAMP = ['#DCE9FB', '#A8CDFF', '#56A6FF', '#2E7CF6', '#0B4FDB'];
const NO_DATA = '#E7ECF4';

export default function MapExplorer() {
  const [params, setParams] = useSearchParams();
  const metric = params.get('metric') ?? 'violent_crime_rate';
  const layer = (params.get('layer') as Layer) ?? 'state';
  const year = Number(params.get('year') ?? 2025);
  const state = params.get('state') ?? '';
  const agencyType = params.get('agency_type') ?? '';

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    // Switching layers can strand a metric that layer cannot draw.
    if (k === 'layer') {
      const m = METRICS.find((x) => x.id === next.get('metric'));
      if (m && !m.layers.includes(v as Layer)) next.set('metric', 'violent_crime_rate');
    }
    setParams(next, { replace: true });
  };

  const { data, loading, error, retry } = useAsync<MapResponse>(
    () => api.map({ metric, year, layer, state: state || undefined, agency_type: agencyType || undefined }),
    [metric, year, layer, state, agencyType],
  );

  const [selected, setSelected] = useState<any | null>(null);
  const available = METRICS.filter((m) => m.layers.includes(layer));
  const metricMeta = METRICS.find((m) => m.id === metric);

  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Map explorer</div>
        <h1>Where do agencies and patterns differ geographically?</h1>
        <p className="question">
          Every layer is normalized or explicitly labelled as a count. Features without a value
          are drawn in the no-data pattern and are never shaded as zero.
        </p>
      </header>

      <div className="controls" style={{ marginBottom: 12 }}>
        <div className="field">
          <label htmlFor="m-layer">Geography</label>
          <div className="seg" id="m-layer">
            {(['state', 'county', 'agency'] as Layer[]).map((l) => (
              <button key={l} className={l === layer ? 'on' : ''} onClick={() => setParam('layer', l)}>
                {l === 'agency' ? 'Agency points' : l === 'state' ? 'States' : 'Counties'}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="m-metric">Metric</label>
          <select id="m-metric" value={metric} onChange={(e) => setParam('metric', e.target.value)}>
            {available.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="m-year">Year</label>
          <select id="m-year" value={year} onChange={(e) => setParam('year', e.target.value)}>
            {[2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016].map((y) =>
              <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {layer === 'agency' && (
          <>
            <div className="field">
              <label htmlFor="m-state">State</label>
              <input id="m-state" type="text" placeholder="All" value={state} maxLength={2}
                     style={{ width: 74, textTransform: 'uppercase' }}
                     onChange={(e) => setParam('state', e.target.value.toUpperCase())} />
            </div>
            <div className="field">
              <label htmlFor="m-type">Agency type</label>
              <select id="m-type" value={agencyType} onChange={(e) => setParam('agency_type', e.target.value)}>
                <option value="">All types</option>
                {['municipal_police', 'county_sheriff', 'state_police', 'university_police',
                  'tribal_police', 'transit_police', 'park_or_conservation_police',
                  'special_jurisdiction'].map((t) =>
                    <option key={t} value={t}>{agencyTypeLabel(t)}</option>)}
              </select>
            </div>
          </>
        )}
      </div>

      {error && <div className="card"><ErrorState error={error} retry={retry} /></div>}

      <div className="map-shell">
        <div className="map-canvas">
          {loading && !data && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 4 }}>
              <div className="card" style={{ padding: 0, width: 260 }}><Loading rows={2} label="Loading map" /></div>
            </div>
          )}
          {data && (
            <MapCanvas data={data} layer={layer} onSelect={setSelected}
                       fitToFeatures={Boolean(state) || Boolean(agencyType)} />
          )}
          {data && <Legend data={data} kind={metricMeta?.kind ?? 'rate'} />}
        </div>

        <SidePanel
          selected={selected}
          data={data}
          layer={layer}
          onClear={() => setSelected(null)}
        />
      </div>

      {data && data.agencies_without_coordinates > 0 && layer === 'agency' && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="plain" title="Agencies not on this map">
            {fmt(data.agencies_without_coordinates)} agencies in {year} have no published
            coordinate. No location was estimated for them. They remain fully searchable in the{' '}
            <Link to="/agencies">Agency Explorer</Link>.
          </Notice>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ canvas ----------- */

function MapCanvas({ data, layer, onSelect, fitToFeatures }: {
  data: MapResponse; layer: Layer; onSelect: (f: any) => void; fitToFeatures: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      // No external basemap. Tiles would be a third-party dependency and a privacy surface,
      // and this product's geography is administrative, not topographic.
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#EDF2FA' } }],
      },
      // No symbol layers are used, so no glyph endpoint is needed. Declaring `glyphs` as
      // undefined fails MapLibre's style validation; omitting the key is the correct form.
      center: [-97, 38.6],
      zoom: 3.3,
      minZoom: 2.4,
      maxZoom: 11,
      attributionControl: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: 'Boundaries: U.S. Census Bureau 2025 cartographic files',
    }));
    m.on('load', () => {
      // A real hatch pattern for no-data polygons. A pale flat fill would sit inside the
      // sequential ramp and read as a low value, which is the exact confusion this product
      // exists to prevent — and the legend already promises a hatch.
      const S = 8;
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx2 = cv.getContext('2d')!;
      ctx2.fillStyle = '#F2F5FA';
      ctx2.fillRect(0, 0, S, S);
      ctx2.strokeStyle = '#B8C6DE';
      ctx2.lineWidth = 1.4;
      ctx2.beginPath();
      ctx2.moveTo(-S, S); ctx2.lineTo(S, -S);
      ctx2.moveTo(0, 2 * S); ctx2.lineTo(2 * S, 0);
      ctx2.stroke();
      const img = ctx2.getImageData(0, 0, S, S);
      if (!m.hasImage('nodata-hatch')) {
        m.addImage('nodata-hatch', { width: S, height: S, data: new Uint8Array(img.data) });
      }
      setReady(true);
    });
    map.current = m;
    return () => { m.remove(); map.current = null; };
  }, []);

  // Value lookup and breaks derived from the response, so the ramp always matches the legend.
  const { valueBy, breaks } = useMemo(() => {
    const by = new Map<string, any>();
    for (const f of data.features) {
      const key = layer === 'state' ? f.state_abbr : layer === 'county' ? f.county_geoid : f.agency_id;
      if (key) by.set(String(key), f);
    }
    const L = data.legend;
    return { valueBy: by, breaks: [L.p10, L.p25, L.p50, L.p75, L.p90].filter((v) => v != null) as number[] };
  }, [data, layer]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    let cancelled = false;

    (async () => {
      for (const id of ['choropleth', 'choropleth-nodata', 'choropleth-line',
                        'agency-points', 'state-outline']) {
        if (m.getLayer(id)) m.removeLayer(id);
      }
      for (const id of ['poly', 'points', 'states']) if (m.getSource(id)) m.removeSource(id);

      const statesGeo = await fetch('/geo/states.geojson').then((r) => r.json());
      if (cancelled) return;

      const color = (v: number | null | undefined) => {
        if (v === null || v === undefined) return NO_DATA;
        let i = 0;
        while (i < breaks.length && v > breaks[i]) i += 1;
        return RAMP[Math.min(i, RAMP.length - 1)];
      };

      if (layer === 'agency') {
        m.addSource('states', { type: 'geojson', data: statesGeo });
        m.addLayer({
          id: 'state-outline', type: 'line', source: 'states',
          paint: { 'line-color': '#C6D4EA', 'line-width': 0.8 },
        });
        const pts = {
          type: 'FeatureCollection',
          features: data.features
            .filter((f: any) => f.longitude != null && f.latitude != null)
            .map((f: any) => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [f.longitude, f.latitude] },
              properties: {
                ...f,
                _color: color(f.value),
                _hasValue: f.value === null || f.value === undefined ? 0 : 1,
                _size: Math.max(3, Math.min(20, Math.sqrt((f.sworn_officers ?? 4) || 4) * 0.62)),
              },
            })),
        };
        m.addSource('points', { type: 'geojson', data: pts as any });
        m.addLayer({
          id: 'agency-points', type: 'circle', source: 'points',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, ['*', ['get', '_size'], 0.55], 9, ['get', '_size']],
            'circle-color': ['get', '_color'],
            // A point with no value is hollow, so it can never read as a low value.
            'circle-opacity': ['case', ['==', ['get', '_hasValue'], 1], 0.85, 0.18],
            'circle-stroke-width': ['case', ['==', ['get', '_hasValue'], 1], 0.6, 1.2],
            'circle-stroke-color': ['case', ['==', ['get', '_hasValue'], 1], '#FFFFFF', '#8494B3'],
          },
        });
        m.on('click', 'agency-points', (e) => {
          const f = e.features?.[0];
          if (f) onSelect(f.properties);
        });
        m.on('mouseenter', 'agency-points', () => { m.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', 'agency-points', () => { m.getCanvas().style.cursor = ''; });

        // With a state filter applied, staying at national extent leaves the user looking
        // at an almost-empty country. Fit to what is drawn — but only when filtered, because
        // the unfiltered set includes Pacific territories that would stretch the view.
        const coords = pts.features.map((f: any) => f.geometry.coordinates as [number, number]);
        if (fitToFeatures && coords.length) {
          const b = coords.reduce(
            (acc, c) => acc.extend(c),
            new maplibregl.LngLatBounds(coords[0], coords[0]),
          );
          m.fitBounds(b, { padding: 60, maxZoom: 9, duration: 0 });
        }
      } else {
        const src = layer === 'state'
          ? statesGeo
          : await fetch('/geo/counties.geojson').then((r) => r.json());
        if (cancelled) return;
        const keyed = {
          ...src,
          features: src.features.map((f: any) => {
            const key = layer === 'state' ? f.properties.STUSPS : f.properties.GEOID;
            const row = valueBy.get(String(key));
            return {
              ...f,
              properties: {
                ...f.properties,
                ...(row ?? {}),
                _key: key,
                _color: color(row?.value),
                _hasValue: row?.value === null || row?.value === undefined ? 0 : 1,
              },
            };
          }),
        };
        m.addSource('poly', { type: 'geojson', data: keyed });
        // Two layers, not one: a value gets a ramp color, an absent value gets the hatch.
        m.addLayer({
          id: 'choropleth-nodata', type: 'fill', source: 'poly',
          filter: ['==', ['get', '_hasValue'], 0],
          paint: { 'fill-pattern': 'nodata-hatch' },
        });
        m.addLayer({
          id: 'choropleth', type: 'fill', source: 'poly',
          filter: ['==', ['get', '_hasValue'], 1],
          paint: { 'fill-color': ['get', '_color'], 'fill-opacity': 0.9 },
        });
        m.addLayer({
          id: 'choropleth-line', type: 'line', source: 'poly',
          paint: { 'line-color': '#FFFFFF', 'line-width': layer === 'state' ? 1 : 0.35 },
        });
        for (const id of ['choropleth', 'choropleth-nodata']) {
          m.on('click', id, (e) => {
            const f = e.features?.[0];
            if (f) onSelect(f.properties);
          });
          m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer'; });
          m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [ready, data, layer, valueBy, breaks, onSelect, fitToFeatures]);

  return <div ref={container} style={{ position: 'absolute', inset: 0 }} aria-label="National map" role="application" />;
}

/* ------------------------------------------------------------------ legend ----------- */

function Legend({ data, kind }: { data: MapResponse; kind: string }) {
  const L = data.legend;
  const f = kind === 'rate' && data.metric === 'officers_per_1k'
    ? (n: number | null) => fmtDecimal(n)
    : kind === 'count' ? (n: number | null) => fmtCompact(n) : (n: number | null) => fmtRate(n);
  const metricLabel = METRICS.find((m) => m.id === data.metric)?.label ?? data.metric;
  return (
    <div className="map-legend">
      <div className="t">{metricLabel}</div>
      <div className="u">{data.year} · {data.unit}</div>
      <div className="ramp">{RAMP.map((c) => <i key={c} style={{ background: c }} />)}</div>
      <div className="ends">
        <span>{f(L.min)}</span>
        <span>{f(L.p50)}</span>
        <span>{f(L.max)}</span>
      </div>
      <div className="nodata">
        <span className="sw" />
        No data ({fmt(L.without_value)} of {fmt(L.with_value + L.without_value)} features)
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ panel ------------ */

function SidePanel({ selected, data, layer, onClear }: {
  selected: any | null; data: MapResponse | null; layer: Layer; onClear: () => void;
}) {
  if (!selected) {
    return (
      <aside className="card">
        <div className="card-head"><h2>Selection</h2></div>
        <div className="card-body">
          <EmptyState
            title={layer === 'agency' ? 'Click an agency' : 'Click a jurisdiction'}
            detail={layer === 'agency'
              ? 'Point size is sworn officers; fill is the selected metric. Hollow points have no value for this metric and year.'
              : 'Fill is the selected metric. Hatched areas have no value and are not zero.'}
          />
          {data && (
            <div className="tablewrap" style={{ marginTop: 10 }}>
              <table className="data">
                <tbody>
                  <tr><td>Features drawn</td><td className="n">{fmt(data.features.length)}</td></tr>
                  <tr><td>With a value</td><td className="n">{fmt(data.legend.with_value)}</td></tr>
                  <tr><td>Without a value</td><td className="n">{fmt(data.legend.without_value)}</td></tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="question" style={{ marginTop: 10 }}>{data?.no_data_note}</p>
        </div>
      </aside>
    );
  }

  if (layer === 'agency') {
    const s = selected;
    return (
      <aside className="card">
        <div className="card-head">
          <div>
            <h2 style={{ marginBottom: 2 }}>{s.agency_name}</h2>
            <div className="question">{agencyTypeLabel(s.agency_type)} · {s.state_abbr}</div>
          </div>
          <button className="btn" onClick={onClear}>Clear</button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="tablewrap">
            <table className="data">
              <tbody>
                <tr><td>Population served</td><td className="n">{fmt(s.population)}</td></tr>
                <tr>
                  <td>Denominator</td>
                  <td className="n" style={{ textAlign: 'left' }}>
                    {denominatorLabel(s.denominator_type)}{' '}
                    <span className={confidenceChip(s.denominator_confidence)}>
                      {confidenceLabel(s.denominator_confidence)}
                    </span>
                  </td>
                </tr>
                <tr><td>Sworn officers</td><td className="n">{fmt(s.sworn_officers)}</td></tr>
                <tr><td>Officers per 1,000</td><td className="n">{fmtDecimal(s.officers_per_1k)}</td></tr>
                <tr>
                  <td>Violent crime rate</td>
                  <td className="n">
                    {s.rate_allowed === true || s.rate_allowed === 'true'
                      ? fmtRate(s.violent_crime_rate)
                      : <Withheld reason={s.rate_withheld_reason || 'Not available'} />}
                  </td>
                </tr>
                <tr>
                  <td>Reporting</td>
                  <td className="n" style={{ textAlign: 'left' }}>
                    <span className={coverageChip(s.coverage_status)}>{coverageLabel(s.months_reported)}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="card-foot">
          <Link className="btn btn-primary" to={`/agencies/${s.agency_id}`}>Open full profile</Link>
        </div>
      </aside>
    );
  }

  const s = selected;
  const name = layer === 'state' ? (s.NAME ?? s.state_abbr) : `${s.NAME ?? s.county_name} County`;
  const hasValue = s.value !== null && s.value !== undefined;
  return (
    <aside className="card">
      <div className="card-head">
        <div>
          <h2 style={{ marginBottom: 2 }}>{name}</h2>
          <div className="question">{layer === 'state' ? 'State' : `${s.STUSPS ?? s.state_abbr ?? ''} county`}</div>
        </div>
        <button className="btn" onClick={onClear}>Clear</button>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table className="data">
            <tbody>
              <tr>
                <td>{METRICS.find((m) => m.id === data?.metric)?.label ?? 'Value'}</td>
                <td className="n">
                  {hasValue ? fmtRate(s.value) : <Withheld tone="neutral" reason="No value for this metric and year" />}
                </td>
              </tr>
              {s.agencies != null && <tr><td>Agencies</td><td className="n">{fmt(s.agencies)}</td></tr>}
              {s.sworn_officers != null && <tr><td>Sworn officers</td><td className="n">{fmt(s.sworn_officers)}</td></tr>}
              {s.reporting_agencies != null && (
                <tr><td>Agencies with a publishable rate</td><td className="n">{fmt(s.reporting_agencies)}</td></tr>
              )}
              {s.population != null && <tr><td>Population</td><td className="n">{fmt(s.population)}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {layer === 'state' && (s.STUSPS || s.state_abbr) && (
        <div className="card-foot">
          <Link className="btn btn-primary" to={`/states/${s.STUSPS ?? s.state_abbr}`}>Open state profile</Link>
        </div>
      )}
      {layer !== 'state' && (
        <div className="card-foot">
          A county value is the median across the agencies resolved to that county, not a
          county-wide rate. Sheriffs and municipal departments inside one county serve
          different populations. {DASH}
        </div>
      )}
    </aside>
  );
}
