# Deployment

Running the pipeline and cutting a release. Everything below is Phase 1: a batch pipeline
producing a versioned DuckDB file. There is no service to deploy yet; see the last section.

## Prerequisites

Python 3.11 or later. No database server, no container, no cloud account — the warehouse is a
single file. Roughly 400 MB of free disk for a full run with the crime harvest, and outbound
HTTPS to `cde.ucr.cjis.gov`, `api.census.gov`, `www2.census.gov`, `bjs.ojp.gov` and the S3
hosts the FBI's presigned URLs resolve to. Dependencies are pinned as floors in
`pyproject.toml`: duckdb ≥1.1, polars ≥1.0, httpx ≥0.27, pyyaml, pydantic, typer, rich,
openpyxl, rapidfuzz, pyarrow ≥16; the `dev` extra adds pytest, pytest-cov and ruff.

## Environment

Two free API keys, both from federal self-service signup pages.

| Variable | Where the key comes from | Required |
|---|---|---|
| `CENSUS_API_KEY` | https://api.census.gov/data/key_signup.html | Yes, for the ACS pull |
| `FBI_CDE_API_KEY` | https://api.data.gov/signup/ | No, unless you override the CDE origin |
| `NLEDP_CDE_ORIGIN` | not a key; overrides the CDE base URL | No |

The Census key is genuinely mandatory. Keyless data requests now return HTTP 302 to a
"Missing Key" page rather than an error, so a client that follows redirects gets HTML and no
useful failure. `census.acs5` refuses to issue a request without one.

The FBI key is optional because the default origin, `https://cde.ucr.cjis.gov/LATEST`, is the
CDE web application's own unkeyed backend and serves the identical routes with no advertised
rate limit. The keyed `api.usa.gov` gateway is a documented fallback and is rate-limited per
key — a newly issued key was observed at 10 requests/hour, unusable for a 39,250-call harvest.
Set `NLEDP_CDE_ORIGIN` to switch, and expect days rather than minutes if you do.

`config.py` reads `.env.local` then `.env`, looking in the current working directory, the
directory above the repository, and `~/nledp`. It uses `os.environ.setdefault`, so a real
environment variable always wins over a file. Run the CLI from the repository root and a
`.env` there is picked up.

## Install

```bash
git clone <repo> && cd national-le-data-platform
pip install -e ".[dev]"
cp .env.example .env        # then paste the two keys
```

`.gitignore` excludes `.env`, `data/raw/**`, `data/staging/**` and the DuckDB file: raw bytes
and the warehouse are build products, reproducible from the registry and the manifest.

## Running the pipeline

```bash
nledp ingest --crime        # ~30 minutes
nledp build                 # ~4 minutes
nledp status                # row counts and the active release
pytest                      # 32 tests
```

**Ingest** is dominated by the crime harvest. Without `--crime` it is 80 artifacts and
90.8 MB of bulk files and API responses in a few minutes, most of it spent waiting on
`www2.census.gov`. With `--crime` it adds 39,250 requests against the summarized-crime
endpoint — 19,625 agencies × two offense groups — run asynchronously at concurrency 16 and
measured at about 27 requests per second, so roughly 24 minutes. The harvest is resumable per
state: a state whose `crime_<ST>.ndjson.gz` exists is skipped, so an interrupted run picks up
where it stopped. The NIBRS agency-dimension pull inside ingest stays small only because of
the partial-ZIP reader: 6.6 MB per year across 51 states in about 90 seconds, against roughly
2 GB if the archives were downloaded whole.

**Build** reads only `data/raw`, so it is fast and repeatable: about four minutes for all five
layers plus validation and the release manifest.

### Disk footprint

| Path | Size | Contents |
|---|---|---|
| `data/raw/fbi/crime` | 144.2 MB | 54 gzipped NDJSON files, one per state and territory |
| `data/raw/census/finance` | 28 MB | three Individual Unit Files plus the 2025 Government Units listing |
| `data/raw/fbi/pe` | 21 MB | nine Police Employee master ZIPs, 2016–2024 |
| `data/raw/census/geo` | 14 MB | Gazetteer, place codes, urban-area crosswalks |
| `data/raw/census/pep` | 9.2 MB | place, county and state Population Estimates CSVs |
| `data/raw/fbi/agency_directory.json` | 6.1 MB | 19,625 ORIs from the live directory |
| `data/raw/fbi/nibrs_agencies_<year>` | 4.8–6.4 MB each | `agencies.csv` per state, 2020–2025 |
| `data/raw/census/acs` | 4.0 MB | ACS 5-year place and county totals |
| `data/raw/bjs` | 44 KB | CSLLEA 2018 aggregate tables |
| **`data/raw`** | **263 MB** | |
| **`data/warehouse/nledp.duckdb`** | **110.6 MB** | the whole national dataset |

`data/raw/manifest.json` records 80 artifacts totalling 90.8 MB with a SHA-256 each. It does
not cover the crime harvest, which keeps its own `_manifest.json` under
`data/raw/fbi/crime`, nor the NIBRS years beyond the current one.

## Commands

**`nledp ingest`** — Layer 1. Downloads every source to `data/raw` with a SHA-256 per
artifact.

| Option | Default | Effect |
|---|---|---|
| `--crime / --no-crime` | `--no-crime` | Also run the agency-level crime harvest, about 25 minutes |
| `--agency-years TEXT` | `2020,2021,2022,2023,2024,2025` | NIBRS agency-dimension years to union into `dim_agency` |

The current completeness year is always pulled by `ingest_all`; `--agency-years` adds the
others. Unioning several years matters: agencies drop in and out of NIBRS participation, and a
single year misses `legacy_ori` for thousands of them, the Los Angeles County Sheriff's Office
among them.

**`nledp build`** — Layers 2 through 5. Stage, resolve, load, validate, analyze, release.

| Option | Default | Effect |
|---|---|---|
| `--skip-ingest / --no-skip-ingest` | `--skip-ingest` | Assume `data/raw` is populated; `--no-skip-ingest` runs `ingest_all` first |
| `--notes TEXT` | `""` | Free text stored in the release manifest |

**`nledp validate`** — re-runs all 23 checks against the current warehouse without
rebuilding, printing severity, check ID and row count. No options.

**`nledp status`** — a table of row counts for all 21 tables, plus the active release ID,
build time and the first twelve characters of its commit. No options.

**`nledp query SQL`** — runs one statement read-only, prints the first 200 rows and the full
row count.

## Release identity

`new_release_id` allocates `release_YYYY_MM_DD_NNN`, where the sequence is one more than the
number of manifests already in `data/releases/` for that date. The current build is
`release_2026_08_29_004`.

`write_release` produces `data/releases/<release_id>.json` with five sections:

- **`release_id`**, **`built_at`** (UTC, seconds precision), **`git_commit`** and **`notes`**.
  `git_commit` runs `git rev-parse HEAD` in the repository root, falling back to `uncommitted`
  when the command returns nothing and `unavailable` when it cannot run at all. This checkout
  is not a git repository, so the current manifest reads `uncommitted`.
- **`row_counts`** — every table with its row count, read at write time.
- **`source_versions`** — one entry per `source_id` from `data/raw/manifest.json`: artifact
  count, total bytes, and a SHA-256 for every artifact. This is the version identifier that
  matters, because federal files are revised silently in place; the 2022 Census finance file
  was reprocessed in July 2026, four years after collection.
- **`validation`** — every check with its severity, row count, table and message.

The same content, one row per table, is written into the `release_manifest` table so a query
against the warehouse can name the release it is reading without opening a file.

## Refresh cadence

Derived from `update_frequency` in `registry/sources.yaml` and the vintages pinned in
`src/nledp/config.py`. Changing a vintage is a deliberate edit, not a default.

| Source | Cadence | Pinned vintage | What a refresh involves |
|---|---|---|---|
| `fbi-cde-agency-directory` | continuous | `live` | Re-pulled on every ingest; 51 states plus 5 territories |
| `fbi-cde-api` | continuous | — | Endpoint metadata; no artifact |
| `fbi-ucr-summarized` | monthly | `crime_last_complete_year: 2025` | The 39,250-call harvest. Delete `data/raw/fbi/crime` to force a full re-pull, or delete one state's file to refresh that state |
| `fbi-nibrs-agencies` | annual | 2020–2025 ingested | One new year per release cycle; add it to `--agency-years` |
| `fbi-ucr-pe-master` | annual | `pe_master_last_good: 2024` | Advance only after confirming the new year is not zero-filled |
| `census-pep-2025` | annual | `pep_vintage: 2025` | New vintage each winter; changes every denominator, so it is a release-level change |
| `census-gazetteer-2025` | annual | `gazetteer: 2025` | New geography vintage; watch for format changes — 2025 moved from tab to pipe delimiters and added GEOIDFQ |
| `census-acs5-2024` | annual | `acs5: 2024` | 51 keyed requests for places plus one national county request |
| `census-gov-finance-2024` | annual, full universe in years ending 2 and 7 | `finance_annual: 2024`, `finance_last_census_year: 2022` | Annual years are a voluntary sample; a series crossing a Census of Governments year is discontinuous by design |
| `census-gus-2025` | irregular | `gus: 2025` | Government Units listing; used for crosswalk validation |
| `census-urban-areas-2020` | decennial | `urban_areas: 2020` | Nothing until the 2030 Census |
| `bjs-csllea-2018` | irregular | 2018 | Human-in-the-loop. CSLLEA 2022 is fielded and unreleased |
| `bjs-leaic-2012` | discontinued | — | Never refreshes; recorded as `not_ingested` with HTTP 403 |

## Troubleshooting

**Census returns HTML instead of JSON.** A keyless data request is redirected (302) to
`missing_key.html`, and `httpx` follows redirects, so the client receives a page rather than
an error. `census.acs5` refuses outright when `CENSUS_API_KEY` is unset, naming the signup
URL. With a key present but invalid or revoked the redirect is followed, `r.json()` raises,
and `get_json` retries four times before raising. Note the failure mode:
`acs5_places_all_states` catches per-state exceptions and continues, so a bad key surfaces as
`ACS 2024: 0 places, ...` in the ingest output rather than as a traceback.

**HTTP 429 from api.data.gov.** Only reachable if `NLEDP_CDE_ORIGIN` points at the keyed
gateway. `get_json` handles 429 explicitly, sleeping 5, 10, 20 then 40 seconds across four
attempts before raising. Inside the crime harvest, `_fetch_one` sleeps 5, 10 then 15 seconds
across three attempts and, if all fail, records `http_status: null` and `body: null` — a
silently missing agency-offense pair rather than a crash. The fix is to unset
`NLEDP_CDE_ORIGIN` and use the unkeyed origin, or to lower the harvest's `concurrency` from
its default of 16.

**A presigned S3 URL expired.** `signed_url` resolves an S3 object key to a URL valid for
900 seconds. A 21 MB PE ZIP finishes well inside that, but a slow link, a stalled transfer,
or a resumed session past fifteen minutes will not, and `download` retries three times
against the same now-stale URL before failing. Re-run the command: a new URL is minted and
files already on disk are skipped, so nothing is re-fetched. In `fetch_state_agencies_csv`
the exception is caught and `None` is returned, which means an expired URL is recorded as
`"error": "no NIBRS archive or member for this state-year"` and is indistinguishable from a
genuinely absent archive. Count the files: a complete year is 51.

**A PE year is zero-filled.** `pe-2025.zip` downloads cleanly, holds 26,288 records, and every
employment count is 0. `build_fact_staffing` sums `total_employees` for the year before
loading anything, rejects the file when the total is zero, and writes a `pe_zero_filled_year`
error to `data_quality_log`; `test_no_staffing_year_is_zero_filled` asserts no loaded year
sums to zero. Ingest also stops at `pe_master_last_good` (2024) and stamps a note on any
artifact fetched beyond it, so the rejection is a backstop rather than the primary defence.
If a whole year of staffing vanishes from a build, look here first.

**A NIBRS state archive does not exist for a year.** Not every state publishes a NIBRS
extract for every year. `signed_url` or `RemoteZip` raises, `fetch_state_agencies_csv`
returns `None`, and `collect_agencies_csv` records that state-year with an error and moves
on — a partial year is not a failed ingest. Because `dim_agency` unions every ingested year
with later years winning, a missing state-year costs only that year's attributes for those
agencies; their identifiers survive from any other year that has them. Check
`ls data/raw/fbi/nibrs_agencies_<year> | wc -l` against 51 to see which years are complete.

## Phase 2 deployment — not yet built

None of the following exists in this repository. It is recorded here so the Phase 1 output
can be evaluated against what will consume it.

The API will be FastAPI over PostgreSQL with PostGIS rather than DuckDB, because an embedded
single-writer engine is not a serving architecture for concurrent readers. The analytics
tables migrate essentially unchanged: the SQL is portable, geometry was never stored in
DuckDB, and every FIPS and ORI column is already `VARCHAR`. What Postgres adds is indexes on
the join keys, a connection pool and a materialised-view refresh.

The map will be served as vector tiles rather than a national GeoJSON payload — 72,055
geographies and 19,902 agency points are not a browser download.

Caching will be keyed on `release_id`. Because every number belongs to exactly one release,
and that release names the SHA-256 of every byte it was built from, a cache entry can be held
indefinitely and invalidated by a single identifier changing. That is the operational payoff
of the release manifest, and the reason it is written into the warehouse as well as to disk.
