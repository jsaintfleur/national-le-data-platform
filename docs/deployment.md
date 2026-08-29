# Deployment

The platform ships as two artifacts from one repository: a static single-page application on
Vercel's CDN, and a Python serverless function serving the analytical API over a compacted,
read-only DuckDB file committed alongside the code.

There is no database server. The warehouse is immutable within a release, so the serving
artifact is a file — which is what makes the whole thing deployable by `git push`.

---

## The two databases

| | Full warehouse | Serving database |
|---|---|---|
| Path | `data/warehouse/nledp.duckdb` | `data/deploy/nledp-api.duckdb` |
| Size | 164 MB | **47 MB** |
| Built by | `nledp build` | `scripts/build_deploy_db.py` |
| In git | no | **yes** |
| Contains | everything, including 1.2M fact rows | exactly `nledp.api.db.ALLOWED_TABLES` |

`ALLOWED_TABLES` is both the API's security boundary and the deployment manifest: the build
script copies that set and nothing else, so an unused entry costs real megabytes in
production and an entry that is missing fails the build loudly.

**What the serving database deliberately leaves out**, and why it can:

| Excluded | Because |
|---|---|
| `fact_crime`, `fact_staffing` | compacted into `analytics_provenance` — 51,246 agency-source pairs answer "where did this come from" as completely as 1.2 million rows |
| `fact_demographics` | its outputs are the denominator columns on `analytics_agency_year` |
| `fact_reporting` | its outputs are the coverage columns on `analytics_agency_year` |
| `fact_finance` | no endpoint serves finance; it stays government-unit only until Phase 3 |
| `analytics_agency_year_base` | pre-policy intermediate, superseded by the policy pass |
| `analytics_agency_population` | denominator working table |
| `analytics_peer_cohort`, `analytics_peer_benchmarks` | the peers endpoint selects its cohort and computes quantiles from `analytics_agency_year` directly |

Copying into a fresh file also compacts it. DuckDB never shrinks a file in place, so the
repeated `DROP`/`CREATE` cycles of an analytics rebuild leave free pages behind; a rebuilt
file drops them.

---

## Cutting a release

```bash
nledp build                              # rebuild the warehouse (~4 min from data/raw)
python scripts/reconcile_staffing.py     # regenerate the staffing ledger
python scripts/build_deploy_db.py --verify
pytest tests --ignore=tests/e2e          # 124 tests, incl. 38 API contract tests
git add data/deploy/nledp-api.duckdb docs/reconciliation-staffing-2024.md
git commit -m "release_YYYY_MM_DD_NNN"
git push                                 # Vercel builds and deploys
```

The API contract tests run against whichever database `NLEDP_DB_PATH` points at, so the
serving artifact is tested as the artifact rather than by proxy:

```bash
NLEDP_DB_PATH=data/deploy/nledp-api.duckdb pytest tests/test_api.py -q
```

---

## Vercel

`vercel.json` does four things:

1. **Builds the frontend** — `cd web && npm ci && npm run build`, output `web/dist`.
2. **Routes `/api/*`** to `api/index.py`, the Python function, with 1 GB of memory and a
   30-second ceiling.
3. **Rewrites everything else** to `index.html` for client-side routing, with `api/`,
   `assets/`, `geo/` and `fonts/` excluded from the fallback so a missing endpoint returns a
   404 rather than the application's HTML with a 200.
4. **Sets cache headers** — content-hashed assets and fonts immutable for a year, boundary
   GeoJSON for a day, API responses `s-maxage=3600` with `stale-while-revalidate`. API
   responses are safe to cache aggressively because they are immutable within a release.

`api/index.py` points `NLEDP_DB_PATH` at the serving database before importing
`nledp.config`, because `Settings` resolves the path once at class-definition time. It adds
no routes: the deployed API and the local one are the same application.

`requirements.txt` carries only what the API imports — `duckdb`, `fastapi`, `pydantic`,
`PyYAML`. The pipeline's heavier dependencies (`polars`, `pyarrow`, `rapidfuzz`, `httpx`,
`typer`) build the warehouse and never run in the function, so they stay out of the bundle.

**Bundle budget.** duckdb ≈ 30 MB, fastapi + pydantic + PyYAML ≈ 25 MB, serving database
47 MB — roughly 102 MB against Vercel's 250 MB uncompressed limit.

---

## Running locally

Two supported shapes.

**Single origin**, closest to production, and what the end-to-end tests target:

```bash
cd web && npm run build && cd ..
uvicorn nledp.api.main:app --port 8000
# http://127.0.0.1:8000 — the API serves the built SPA from web/dist
```

**Split**, for frontend work with hot reload:

```bash
uvicorn nledp.api.main:app --port 8000     # terminal 1
cd web && npm run dev                       # terminal 2, proxies /api to :8000
```

To serve the compacted database locally exactly as production does:

```bash
NLEDP_DB_PATH=data/deploy/nledp-api.duckdb uvicorn nledp.api.main:app --port 8000
```

---

## Health

`GET /api/health` returns which database the instance opened, its size, and the active
release. It is the first thing to check when a deployment behaves unlike development:

```json
{
  "ok": true,
  "database": "nledp-api.duckdb",
  "database_bytes": 47513600,
  "release": { "release_id": "release_2026_08_29_006", "built_at": "...", "git_commit": "..." },
  "served_tables": ["agency_crosswalk", "agency_history", "analytics_agency_year", "..."]
}
```

Every response the application renders also carries `release_id` in the shell, so a figure on
screen can always be traced to the build that produced it.

---

## Notes and limits

- **Cold starts.** Opening a 47 MB DuckDB read-only is memory-mapped and fast, but a cold
  Lambda still pays Python import time. The aggressive `s-maxage` means most requests are
  served by the CDN and never reach the function.
- **The committed database grows history.** Each release adds ~47 MB. After a handful of
  releases, move it to Git LFS or a release asset; the build script is unchanged either way.
- **Read-only filesystem.** The function opens DuckDB read-only so it never attempts a
  write-ahead log next to a file it cannot write. `HOME` is set to `/tmp` for spill files.
- **Finance is not deployed.** `fact_finance` is excluded because no endpoint serves it. When
  Phase 3 adds the `agency_government_crosswalk`, it re-enters `ALLOWED_TABLES` and the
  serving database grows accordingly.
