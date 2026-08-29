/**
 * The application shell: navigation, the global command bar, and the persistent data-release
 * indicator.
 *
 * Navigation exposes only what works. There are no placeholder destinations, because a dead
 * link in a product about data integrity is a claim the product cannot keep.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchResponse, SearchResult } from '../lib/api';
import { agencyTypeLabel } from '../lib/format';
import { Icon, useAsync } from './primitives';

const NAV = [
  { to: '/', label: 'Overview', icon: Icon.overview, end: true },
  { to: '/map', label: 'Map', icon: Icon.map },
  { to: '/agencies', label: 'Agencies', icon: Icon.agencies },
  { to: '/compare', label: 'Compare', icon: Icon.compare },
  { to: '/states', label: 'States', icon: Icon.states },
  { to: '/quality', label: 'Data Quality', icon: Icon.quality },
];

const SECONDARY = [
  { to: '/methodology', label: 'Methodology' },
  { to: '/sources', label: 'Sources' },
];

const MOBILE = [NAV[0], NAV[1], NAV[2], NAV[4], NAV[5]];

export function Shell({ children }: { children: React.ReactNode }) {
  const { data: release } = useAsync(() => api.release(), []);
  useScrollableRegionsAreKeyboardReachable();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Law Enforcement Data</div>
          <div className="brand-name">National Data &amp; Intelligence Platform</div>
        </div>
        <nav className="nav" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
                     className={({ isActive }) => (isActive ? 'active' : '')}>
              <n.icon /><span>{n.label}</span>
            </NavLink>
          ))}
          <div className="nav-label">Reference</div>
          {SECONDARY.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon.book /><span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="release-chip">
          <span className="dot" />Active data release
          <b>{release?.release_id ?? '—'}</b>
          {release && (
            <span>
              Crime and staffing through {release.latest_years.crime ?? '—'} ·
              {' '}built {release.built_at ? release.built_at.slice(0, 10) : '—'}
            </span>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Link to="/" className="mobile-brand" aria-label="Home">
            <span className="mk" />
            <strong style={{ fontSize: 13 }}>LE Data Platform</strong>
          </Link>
          <CommandBar />
          {release && (
            <span className="chip mono chip-outline" title={`Built ${release.built_at ?? ''}`}
                  style={{ flex: 'none' }}>
              {release.release_id}
            </span>
          )}
        </header>
        <main className="content">{children}</main>
        <nav className="mobile-nav" aria-label="Primary">
          {MOBILE.map((n) => (
            <NavLink key={n.to} to={n.to} end={(n as any).end}
                     className={({ isActive }) => (isActive ? 'active' : '')}>
              <n.icon /><span>{n.label === 'Data Quality' ? 'Quality' : n.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

/**
 * A table that scrolls sideways is unusable by keyboard unless the scroll container can take
 * focus. Wide tables are unavoidable in this product — a comparison of five agencies across
 * a dozen metrics does not collapse into a phone — so the containers that actually overflow
 * are made focusable and announced as regions. Containers that fit are left alone, because a
 * tab stop with nothing to scroll is noise.
 */
function useScrollableRegionsAreKeyboardReachable() {
  const location = useLocation();
  useEffect(() => {
    const mark = () => {
      document.querySelectorAll<HTMLElement>('.tablewrap').forEach((el) => {
        const scrollable = el.scrollWidth > el.clientWidth + 1;
        if (scrollable) {
          el.setAttribute('tabindex', '0');
          el.setAttribute('role', 'region');
          if (!el.getAttribute('aria-label')) {
            const caption = el.querySelector('table')?.getAttribute('aria-label')
              ?? el.closest('section')?.querySelector('h2, h3')?.textContent?.trim();
            el.setAttribute('aria-label', caption ? `${caption} (scrollable table)` : 'Scrollable table');
          }
        } else {
          el.removeAttribute('tabindex');
          el.removeAttribute('role');
        }
      });
    };
    const t = setTimeout(mark, 300);
    window.addEventListener('resize', mark);
    const observer = new MutationObserver(() => { window.clearTimeout(t); setTimeout(mark, 120); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { clearTimeout(t); window.removeEventListener('resize', mark); observer.disconnect(); };
  }, [location.pathname, location.search]);
}

/* ------------------------------------------------------------------ command bar ------ */

function CommandBar() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  // "No matches" is a claim about the data. Making it while a request is still in flight is
  // a false statement, and this product cannot afford small false statements.
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setData(null); setSearching(false); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      api.search(q.trim()).then(
        (d) => { if (live) { setData(d); setCursor(0); setSearching(false); } },
        () => { if (live) setSearching(false); },
      );
    }, 130);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const go = (r: SearchResult) => {
    setOpen(false);
    setQ('');
    if (r.type === 'agency' && r.agency_id) navigate(`/agencies/${r.agency_id}`);
    else if (r.type === 'state' && r.code) navigate(`/states/${r.code}`);
    else if (r.geoid) navigate(`/agencies?q=${encodeURIComponent(r.name ?? '')}`);
  };

  const results = data?.results ?? [];

  return (
    <div className="cmd">
      <span className="cmd-icon"><Icon.search /></span>
      <input
        ref={inputRef}
        className="cmd-input"
        placeholder="Search agencies, states, counties, or an ORI…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          if (e.key === 'Enter' && results[cursor]) { e.preventDefault(); go(results[cursor]); }
        }}
        role="combobox"
        aria-expanded={open && q.length > 1}
        aria-controls="cmd-results"
        aria-label="Search"
      />
      <kbd className="cmd-kbd">⌘K</kbd>

      {open && q.trim().length > 1 && (
        <div className="cmd-results" id="cmd-results" role="listbox">
          {data?.ambiguous_identifier && (
            <div className="notice warn" style={{ margin: 10, borderRadius: 6 }}>
              <span className="t">Ambiguous identifier</span>
              {data.ambiguous_identifier.message}
            </div>
          )}
          {searching && (
            <div className="cmd-empty" role="status">Searching…</div>
          )}
          {!searching && results.length === 0 && (
            <div className="cmd-empty">No matches for “{q}”.</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.type}-${r.agency_id ?? r.geoid ?? r.code}-${i}`}
              className="cmd-item"
              aria-selected={i === cursor}
              role="option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(r)}
            >
              <span className="chip mono chip-outline" style={{ justifySelf: 'start' }}>
                {r.type === 'agency' ? 'Agency' : r.type === 'state' ? 'State' : r.type === 'county' ? 'County' : 'Place'}
              </span>
              <span className="name">{r.agency_name ?? r.name ?? r.code}</span>
              <span className="meta">
                {r.type === 'agency'
                  ? `${agencyTypeLabel(r.agency_type)} · ${r.state_abbr ?? ''}`
                  : r.state_abbr ?? ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
