# Architecture

Five layers, each with one responsibility and a hard boundary. The boundaries are not
organisational tidiness — each one exists because a specific class of defect crosses it,
and putting the wall there is what makes that defect testable.

| Layer | Where it lives | What it owns | Rule |
|---|---|---|---|
| 1 Raw | `data/raw/`, `src/nledp/ingest.py`, `src/nledp/util/http.py` | source bytes, SHA-256 and fetch timestamp per artifact | nothing is edited here, ever |
| 2 Staging | `src/nledp/connectors/` | fixed-width layouts, delimiter sniffing, type coercion | no business logic |
| 3 Canonical | `src/nledp/canonical/`, `src/nledp/resolution/` | `dim_*`, `fact_*`, `agency_crosswalk`, `agency_history` | one grain per table, every row names its source |
| 4 Analytics | `src/nledp/analytics/build.py` | `analytics_*` — rates, cohorts, benchmarks, coverage | every division happens here and nowhere else |
| 5 Application | Phase 2 onward, not built | API and UI | reads Layer 4 only |

## Why the boundaries are where they are

**Raw / staging.** Federal files are revised silently and in place — the 2022 Census finance
file was reprocessed in July 2026, four years after collection. A hash plus a fetch timestamp
is the only reliable version identifier for most of these sources, and it is only meaningful
if the bytes are never touched.

**Staging / canonical.** A parser that also decides what a record means is a parser you
cannot pin to a source record. `parse_pe_record` returns the fields at the offsets the FBI
documents and nothing more; the decision that a zero-filled year is not a workforce of zero
belongs to `canonical/facts.py`, where it can be asserted against the built warehouse.

**Canonical / analytics.** This is the load-bearing one. A rate is a join: it aligns a
numerator with a denominator of the same observation year, excludes agency types for which a
resident denominator is a category error, and refuses a geography link the resolution layer
did not accept. That cannot be tested if it lives inside a chart component. Fifteen warehouse
invariants assert it on every build.

**Analytics / application.** The application never computes a headline metric. If a number
appears on a screen it exists as a column in an `analytics_*` table, which means it has a
row count, a validation check, and a release it belongs to.

## Module map

`src/nledp/` is 3,446 lines across eighteen modules that carry code, plus eight empty
package files.

**`config.py`** owns every path and credential. `VINTAGES` pins the data vintage of each
source — `pe_master_last_good: 2024`, `crime_last_complete_year: 2025`, `pep_vintage: 2025` —
as one dictionary the rest of the code reads, so changing a vintage is a deliberate edit
rather than a default drifting under a caller. It also carries `STATES`, `TERRITORIES` and
`NEW_ENGLAND`, the six states where the general-purpose local government is the county
subdivision. It does not fetch and does not parse.

**`util/http.py`** owns fetching: `download` (streaming, skips a file already on disk),
`get_json` (retry with backoff, explicit 429 handling), `sha256_file`, and `RemoteZip`. It
does not know what any source is.

**`util/fips.py`** owns identifier width. `pad`, `place_geoid`, `county_geoid`,
`cousub_geoid` and `strip_geoidfq` all return strings; `canonical_state_abbr` maps the FBI's
NCIC codes onto USPS, which keeps 287 Nebraska agencies (`NB`) from failing every geography
join silently. It also holds the abolished Connecticut counties, the Planning Regions that
replaced them, and the CLASSFP codes for independent and consolidated cities. No I/O.

**`util/load.py`** owns bulk insertion into DuckDB — one function, `bulk_insert`.

**`connectors/cde.py`** owns the FBI: presigned-URL resolution, the per-state agency
directory, `agencies.csv` extraction from NIBRS archives, the Police Employee fixed-width
layout, and the summarized-crime endpoint. It does not classify agencies, does not derive
ORI7, and does not decide whether a file is trustworthy.

**`connectors/crime_harvest.py`** owns the asynchronous agency-level crime harvest and the
monthly-to-annual reduction (`reduce_response`, `months_present`). It stores exactly what
the server returned, one NDJSON line per (ORI, offense), gzipped per state, and is resumable
because a state whose file exists is skipped. `months_present` counts non-null months rather
than assuming twelve — the reason a partial reporting year can be detected downstream at all.

**`connectors/census.py`** owns the Gazetteer, the Population Estimates bulk CSVs, the ACS
API and the 2020 urban-area files, including the per-file delimiter sniff — the 2025
Gazetteer is pipe-delimited, earlier years are tab — and the hard failure when
`CENSUS_API_KEY` is absent.

**`connectors/finance.py`** owns the Census government-finance layouts: `parse_fin_record`
(32 characters — 12-character government ID, 3-character item code, 12-character amount in
thousands, 4-character year, 1-character flag) and `parse_pid_record` (146 characters,
carrying the FIPS place crosswalk at 112–116 and the fiscal year ending at 140–144), plus the
item-code and imputation-flag vocabularies. It does not attribute a figure to an agency, and
there is no code path by which it could.

`staging/` is a package with no modules: parsing lives in `connectors/`, and
`data/staging/` on disk is a directory the pipeline creates but does not currently write to.

**`canonical/agency.py`** owns `dim_agency`, `agency_history`, the agency-type taxonomy,
name normalization, and `_RATE_INELIGIBLE` — the agency types for which a per-resident rate is
a category error. It records the FBI's own label and the platform's reading of it side by
side, and never overwrites the federal label.

**`canonical/dimensions.py`** owns `dim_source` and `dim_metric` (both read straight from
`registry/*.yaml`, so the registries are the definition rather than documentation of one),
`dim_time`, and `dim_geography`.

**`canonical/facts.py`** owns the five fact builders and the unincorporated-balance
denominator. Two rules are structural here: a missing value is never a zero, and a fact row
never carries a rate.

**`resolution/resolve.py`** owns both crosswalk directions: agency to geography (rule-ordered,
state-scoped, New England switching to county subdivisions) and geography to Census
government unit. Every link it emits carries a method, a score and a review status. It never
emits an agency-to-government link, because no source supports that claim.

**`analytics/build.py`** owns `ANALYTICS_SQL` — one statement building seven tables. Every
division in the platform is in this file.

**`quality/validate.py`** owns the 23 checks in `CHECKS`, `run_checks`, and `clear_log`. It
writes to `data_quality_log` and changes no other table.

**`warehouse.py`** owns the canonical DDL (`SCHEMA_SQL`), `connect`, `init_schema` and
`table_counts`. The analytics tables are deliberately not here: they are `CREATE TABLE AS`
statements in `analytics/build.py`, so their shape is defined by the query that produces
them and cannot drift from it.

**`release.py`** owns release identity: `new_release_id`, `git_commit` and `write_release`.
**`ingest.py`** and **`cli.py`** are orchestration; `cli.py` exposes five commands —
`ingest`, `build`, `validate`, `status`, `query`.

## DuckDB, and the path off it

The warehouse is a single 110.6 MB DuckDB file. It was chosen for three properties that
matter during a data foundation phase: zero configuration, so a build is reproducible on a
laptop with no service to stand up; columnar execution fast enough that the whole national
dataset — 320,190 crime observations, 316,276 population observations, 188,853 agency-years
— rebuilds in about four minutes; and native Arrow ingestion, which is what makes the load
path in `util/load.py` viable.

It is the wrong choice for the Phase 2 API for one reason: concurrent readers. DuckDB is an
embedded single-writer engine. The target is PostgreSQL with PostGIS, and the migration is
small because of what was avoided:

- The SQL is portable. `ANALYTICS_SQL` uses `median`, `quantile_cont`, `lag() OVER`,
  `regexp_matches` and ordinary CTEs — all of which Postgres has, with `quantile_cont`
  spelled `percentile_cont`.
- Geometry was never stored. `dim_geography` carries `latitude`, `longitude`, `land_sqmi`
  and `water_sqmi` as doubles, and distance is computed in Python (`haversine_km`) rather
  than in SQL. PostGIS adds real geometry to that table; nothing existing has to be undone.
- Types are already explicit and already conservative. Every FIPS and ORI column is
  `VARCHAR`, so no leading zero is at risk in the transfer.

What Postgres has to add is the serving-side apparatus DuckDB has no need for: indexes on
the join keys, a connection pool, and a materialised-view refresh keyed on `release_id`.

## Build sequence

`nledp build` runs the layers in dependency order. The order is not incidental — each step
reads tables the previous ones wrote.

```
init_schema                  create canonical tables if absent
new_release_id               allocate release_YYYY_MM_DD_NNN

dim_source                   <- registry/sources.yaml
dim_metric                   <- registry/metrics.yaml
dim_time                     <- VINTAGES (no file input)
dim_geography                <- Gazetteer, place codes, UA crosswalks
dim_agency, agency_history   <- NIBRS agencies.csv (all years) + agency directory
agency_crosswalk (geography) <- dim_agency x dim_geography
fact_staffing                <- PE masters, joined via dim_agency.ori7
fact_reporting               <- NIBRS agencies.csv, current year
fact_demographics            <- PEP, ACS, + derived county balance
fact_finance                 <- Census IUF; also emits the government crosswalk
agency_crosswalk (government)<- Fin_PID place codes x dim_geography
fact_crime                   <- harvested NDJSON, reduced to agency-year

analytics (7 tables)         <- everything above
clear_log; run_checks        -> data_quality_log
write_release                -> data/releases/<release_id>.json, release_manifest
```

Three dependencies there are easy to miss. `agency_crosswalk` is built before any fact table
because `fact_crime`'s validation checks join through it. `fact_staffing` joins on
`dim_agency.ori7` rather than the PE file's own ORI7, which is the point of building
`dim_agency` first. And `build_fact_finance` returns two counts, because resolving government
units to geography needs the `Fin_PID` records that exist only while the finance ZIP is open.

Validation runs last and writes only to `data_quality_log`. `clear_log` preserves the three
check IDs written during loading rather than by `run_checks` — `ambiguous_ori7`,
`duplicate_agency_year_staffing` and `pe_zero_filled_year` — because those record decisions
made while a file was open and cannot be recomputed from the warehouse afterwards.

## Reading one ZIP member over HTTP

The FBI ships NIBRS as one ZIP per state per year. California 2025 is 117 MB and Texas is
116 MB. The only member the platform needs from any of them is `agencies.csv`, about 320 KB —
the single published file carrying both the NIBRS ORI9 and the legacy ORI9, and therefore the
bridge between the two identifier systems. Downloading the archives whole would be roughly
2 GB per year to retain 6.6 MB.

`RemoteZip` in `util/http.py` reads the archive in place instead, using the ZIP format's own
index:

1. **Size.** A `Range: bytes=0-0` request, not a `HEAD`. The FBI's URLs are S3 presigned and
   the signature is GET-scoped, so `HEAD` is rejected; the one-byte GET returns
   `Content-Range`, whose suffix is the total length.
2. **End of central directory.** Fetch the last 64 KB and scan backwards for `PK\x05\x06`.
   That record gives the size and offset of the central directory.
3. **ZIP64.** If either field reads `0xFFFFFFFF`, the real values are 64-bit. The code finds
   the ZIP64 locator (`PK\x06\x07`), follows it to the ZIP64 end-of-central-directory record
   (`PK\x06\x06`), verifies the signature, and reads the 64-bit size and offset from it.
   Archives near or above 4 GB, and archives whose members cross that boundary, are the
   reason this branch exists.
4. **Central directory.** One ranged GET for the whole directory, then a walk over its
   `PK\x01\x02` entries recording, per member, the local-header offset, compressed size,
   uncompressed size and compression method. A member whose sizes or offset are sentinel
   values has them replaced from its ZIP64 extra field (header ID `0x0001`).
5. **The member.** Read 30 bytes of the local file header to recover the filename and extra
   field lengths — they can differ from the central directory's — compute the data offset,
   issue one ranged GET for exactly the compressed bytes, and inflate with
   `zlib.decompress(raw, -15)`. Stored members are returned as-is; any other compression
   method raises rather than guessing.

The result is roughly four small requests plus one member-sized request per state-year:
6.6 MB for a national year, in about 90 seconds.

## Bulk loading through Arrow

`bulk_insert` was originally `executemany`, and `executemany` is row-at-a-time. At the scale
of this warehouse that is the dominant cost of a build: `fact_demographics` alone is 316,276
rows and `fact_crime` is 320,190.

The replacement builds one `pyarrow.Array` per column from the row tuples, assembles a
`pa.Table` with the column names read from `information_schema.columns` in ordinal position,
registers it, and lets DuckDB scan it with a single `INSERT INTO … SELECT * FROM`. The
measured difference was about 30× at 72,000 rows.

Two properties matter beyond speed. Types stay explicit: Arrow infers a column type once from
the whole column rather than per row, so a column of integers with a single `None` arrives as
a nullable integer column rather than a mix DuckDB has to reconcile. And the column-count
check — `if len(cols) != len(rows[0])` — fails loudly at load time when a builder's tuple no
longer matches its table's DDL, which is the drift that otherwise shows up as values silently
shifted one column to the left.
