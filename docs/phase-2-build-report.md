# Phase 2 Build Report

**Data release** `release_2026_08_29_006` · built 2026-08-29 · commit `2f84a08`
**Application build** `web/dist`, 4.16 MB total · Vite + React 19 + TypeScript
**Tests** 124 unit / integration + 28 end-to-end = **152 passing**
**Accessibility** 0 WCAG 2.1 AA violations across 20 page-viewport combinations
**Validation** 0 errors · 5,065 warnings · 30,293 informational

---

## 1. Product summary — what now works

The warehouse from Phase 1 is unchanged as a system of record. Phase 2 added the layers above
it: a denominator confidence system, a central analytical policy engine, a read-only API, and
a twelve-route application.

The thing that makes this not a government dashboard is that **the policy engine runs on the
server and the interface cannot reach around it.** A rate the platform withholds is `null` in
the API response, arrives with a `rate_withheld_reason`, and is rendered as that reason. There
is no code path that reconstructs it, and a test asserts there is none.

**Working:**

- **National Overview** with a reconciled sworn-officer headline, the agency-type landscape,
  national trends, and reporting context printed directly beneath every chart.
- **Map** — state, county and agency-point layers over Census 2025 cartographic geometry, with
  metric layers, year and filter controls, a click-through side panel, and a legend that
  always carries unit, year and range. No-data polygons are drawn in a hatch pattern, not a
  pale fill.
- **Agency Explorer** — nine filters, server-side sort and pagination, CSV export with a
  metadata header, every filter in the URL.
- **Agency Profile** — the acceptance test. Snapshot, trend with broken lines and hollow
  partial-year points, peer benchmarking with a visible cohort definition, a coverage table,
  a methodology drawer per metric, and a full provenance table.
- **Compare** — 2 to 5 agencies in snapshot, trend, indexed and change modes, with a
  comparability engine that warns and never blocks.
- **States** — a sortable national table and a per-state profile with composition, trend,
  coverage, largest agencies and a data-quality summary.
- **Data Quality Center** — geography resolution, identifier resolution with the ambiguous-ORI7
  register, an interactive state × year coverage heatmap that drills through to agencies, and
  the full validation check register with per-check entity lists.
- **Methodology** and **Sources** — the metric registry rendered with its `comparison_allowed`
  and `ranking_allowed` flags, the prohibited-metric list as a first-class section, the
  denominator policy, the partial-year rule, and the source matrix with freshness indicators.

**Navigation exposes no dead routes.** A test walks every sidebar link and asserts a 200.

---

## 2. Routes

| Route | Question it answers |
|---|---|
| `/` | What does American law enforcement look like nationally? |
| `/map` | Where do agencies and patterns differ geographically? |
| `/agencies` | Which agencies match what I am looking for? |
| `/agencies/:id` | What do we know about this agency? |
| `/compare` | How does this agency differ from appropriate peers? |
| `/states` | How does law enforcement differ between states? |
| `/states/:code` | What does law enforcement look like within this state? |
| `/quality` | How much confidence should I place in these numbers? |
| `/methodology` | How is every number on this platform produced? |
| `/sources` | Where does every number come from, and how current is it? |

Every analytical view is URL-addressable and its state survives a reload:

```
/map?layer=state&metric=violent_crime_rate&year=2024
/agencies?state=MD&agency_type=municipal_police&sort=sworn_officers&direction=desc&page=2
/compare?agencies=MDBPD0000,PAPEP0000,MI8234900&year=2025&mode=indexed
/agencies/MDBPD0000?metric=violent_crime_rate
```

### API

```
GET /api/release            GET /api/agencies              GET /api/states
GET /api/metrics            GET /api/agencies/facets       GET /api/states/{code}
GET /api/sources            GET /api/agencies/{id}         GET /api/compare
GET /api/search             GET /api/agencies/{id}/metrics GET /api/map
GET /api/overview           GET /api/agencies/{id}/coverage GET /api/quality
GET /api/quality/coverage/{year}                           GET /api/quality/flags/{check_id}
GET /api/agencies/{id}/peers
```

No endpoint exposes a raw warehouse table, and none accepts SQL. A test asserts the OpenAPI
schema contains no passthrough path.

---

## 3. The staffing reconciliation

This was the non-negotiable gate, and answering it corrected a claim in the Phase 1 handoff.

**My earlier statement that the FBI publishes "about 720K" sworn officers was wrong.** The
FBI's own national figure for 2024, from its Police Employee endpoint, is **772,732**. The
platform's figure is not above the federal number; it is **36,134 below** it, and the whole
difference is a ledger.

| | Records | Sworn |
|---|---:|---:|
| FBI Police Employee master file, 2024 | 26,136 | 772,777 |
| − Federal agencies (outside the platform's universe) | 142 | −21,806 |
| − Ambiguous ORI7 (refused, not misattributed) | 200 | −8,036 |
| − ORI7 with no agency in the directory | 6,260 | −6,298 |
| − Duplicate agency-years collapsed at load | 191 | −39 |
| **Platform national total, 2024** | **19,343** | **736,598** |

The residual is zero. The FBI's published figure and the master file differ by 45 because the
API refreshes more often than the bulk file; both are the FBI's own numbers.

**The verdict:** 736,598 is valid for the platform's stated universe — state, local, tribal
and territorial agencies whose identity resolves to exactly one agency — and must never be
presented as a count of all U.S. law-enforcement officers. The headline on `/` carries that
universe in its label, the exclusion lines are on the page rather than in a footnote, and a
reader who wants the federal-inclusive number can add them back from what is on screen. Full
ledger: [`docs/reconciliation-staffing-2024.md`](reconciliation-staffing-2024.md), regenerated
by `scripts/reconcile_staffing.py`.

**Answering it also found and fixed a real defect.** Boston Police Department shares ORI7
`MA01301` with Suffolk University Police, and the blanket refusal of contested ORI7s was
dropping a major city department's entire staffing series. A disambiguation rule now resolves
a contested ORI7 only when the candidate is both the primary ORI for the block (ORI9 ending
`00`) and a clear name match that beats every rival by a margin. That recovered **4,917 sworn
officers across 37 records**, including Boston, Huntsville, Boise, Aurora and Lakewood, and it
still refuses ORI7 `CA01999`, where fourteen Highway Patrol sub-units share one identifier and
none is primary. Three tests pin the rule.

---

## 4. Data validation

`nledp validate` against `release_2026_08_29_006`:

| Severity | Checks firing | Rows |
|---|---:|---:|
| error | 0 of 11 | **0** |
| warning | 7 | 5,065 |
| info | 5 | 30,293 |

The four regression guards that protect the policy all read zero: no rate published across
mismatched observation years, no rate on an unaccepted geography link, no rate for a
transient-population agency type, no partial year producing a rate.

**Row counts after the Phase 2 changes:**

| Table | Rows | Δ from Phase 1 |
|---|---:|---|
| `dim_agency` | 19,902 | — |
| `dim_geography` | 72,055 | — |
| `fact_crime` | 320,190 | — |
| `fact_staffing` | 183,716 | +325 (ORI7 disambiguation) |
| `fact_demographics` | 316,276 | +18,864 (county balance series) |
| `fact_finance` | 125,816 | — |
| `analytics_agency_year` | 188,877 | now carries 13 policy columns |
| `analytics_peer_cohort` | 62,020 | −75,045 (cohorts now require `rate_allowed`) |
| `data_quality_log` | 35,358 | +2 new checks |

The peer-cohort drop is the point: a rate the policy withholds no longer reaches a peer median.

**2024 denominator distribution** — every rate now names what it divided by:

| Denominator type | Agency-years | Rate published |
|---|---:|---|
| `municipal_population` | 11,880 | yes |
| `unincorporated_population` | 2,923 | yes, with a methodology warning |
| `unknown` | 2,293 | no |
| `campus_population` | 1,217 | no |
| `statewide_population` | 1,018 | no |
| `county_population` | 100 | yes |
| `transit_population` | 92 | no |

11,161 of 19,523 agency-years in 2024 carry a publishable rate; 8,362 carry a named reason
why they do not.

---

## 5. Test results

```
tests/test_identifiers.py          8 passed   ORI forms, disambiguation, state-code aliases
tests/test_parsers.py              7 passed   fixed-width layouts, verbatim source fixtures
tests/test_resolution.py           2 passed   place normalization, distance
tests/test_crime_reduction.py      3 passed   monthly→annual, null months not counted as zero
tests/test_warehouse_invariants.py 16 passed  the platform's promises, against the database
tests/test_policy.py               40 passed  denominators, coverage, comparability, percentiles
tests/test_api.py                  48 passed  API contract and the regression fixtures
tests/e2e/test_release_gate.py     28 passed  the release gate, in a real browser
                                  ---
                                  152 passed
```

### Permanent regression fixtures

| Fixture | ID | What it guards |
|---|---|---|
| Baltimore Police Department | `MDBPD0000` | 2021 partial reporting — the count shows, the rate does not |
| Los Angeles County Sheriff | `CA0190000` | unincorporated-balance denominator, 9,748,868 → 969,505 |
| Orange County Sheriff, CA | `CA0300000` | 15.87 officers per 1,000 shown with a warning, never capped |
| Pennsylvania State Police | `PAPSP0000` | statewide agency, no per-resident rate in any year |
| ORI7 `CA01999` | — | 14 agencies share it; the platform never picks one |

---

## 6. Performance

Measured in headless Chromium against the production build, API and SPA on one origin.

| Route | First contentful paint | DOM content loaded | Transfer |
|---|---:|---:|---:|
| Overview | 148 ms | 64 ms | 531 KB |
| Agency profile | 68 ms | 21 ms | 44 KB |
| Agency explorer | 60 ms | 20 ms | 59 KB |
| Compare | 56 ms | 24 ms | 34 KB |
| Data Quality | 220 ms | 183 ms | 117 KB |
| Map | 72 ms | 18 ms | 1,776 KB |

All routes are well inside the 2.5-second target. Two notes on the outliers. The map's
1.78 MB is MapLibre (960 KB) plus the county boundary GeoJSON (1.48 MB uncompressed); both are
lazily loaded, so no other route pays for them, and the state layer alone is 250 KB. The Data
Quality page's 183 ms is 539 heatmap cells plus the full check register rendered at once — it
is the heaviest page in the product by design and is still an order of magnitude inside target.

The browser never receives the national dataset: aggregation is server-side, tables paginate,
and the analytics tables are precomputed at build time.

---

## 7. Accessibility

**0 WCAG 2.1 AA violations** measured with axe-core 4.10.2 across all ten routes at 1440 px
and 390 px. Four defects were found and fixed during the build:

- `--faint` was `#8494B3`, a 3.06:1 contrast ratio. Now `#5E6E95` at 5.07:1.
- Links inside prose were distinguished by color alone. Links are now underlined by default;
  navigation, chips and buttons opt out.
- The coverage heatmap's fourth ramp step failed with white text at 3.94:1. Now 5.48:1.
- Horizontally scrollable tables were not keyboard-reachable. Containers that actually
  overflow now take focus and are announced as regions; containers that fit are left alone.

Also in place: every chart emits a screen-reader table of its own data, the heatmap is a real
`<table>` with a `<button>` per cell and the percentage printed in each one, sortable headers
carry `aria-sort`, and no status is carried by color alone.

---

## 8. Responsive design

Verified at 375, 390, 768, 1024 and 1440 px. Zero horizontal page overflow on every route at
every width — a test asserts it at 375 px. Mobile is not a shrunk desktop: the sidebar is
replaced by bottom navigation, search leads, and comparison tables scroll inside their own
containers rather than collapsing into unreadable stacks.

---

## 9. Known limitations — specific

1. **Sheriff denominators remain approximate, and 607 of them are flagged.** The unincorporated
   balance is a large correction but it is still wrong wherever a sheriff polices incorporated
   cities under contract. Orange County CA at 15.87 officers per 1,000 on a 130,770 balance is
   the flag working. Contract rosters are not published in any federal source, so the platform
   flags and does not correct.

2. **6,602 PE records — 14,334 sworn officers — could not be attributed to an agency.** 200
   sit on ambiguous ORI7s and 6,260 on ORI7s with no directory entry. The largest single one
   is `NY301SG` at 5,148 sworn, a state-police county sub-unit with no ORI9. This is a work
   item on the Data Quality page, not a rounding error.

3. **`agencies_participating` is 0 rather than null for every year before 2025.** It derives
   from the source's `participated` flag, which `fact_reporting` only carries for the current
   ingested agency-dimension year. The States pages render it as withheld rather than printing
   a zero, but the underlying gap is real and should be closed by ingesting the flag for the
   earlier years already on disk.

4. **Population coverage is null for 2016–2019.** The PEP series begins in 2020, so those
   years have counts and no denominator. Charts break the line rather than implying zero.

5. **County map values are medians across the agencies resolved to a county**, not county-wide
   rates. A sheriff and the municipal departments inside one county serve different
   populations, so no single county rate is defensible. The side panel says so.

6. **Finance data is not on agency profiles.** It remains at government-unit level. The
   `agency_government_crosswalk` that Phase 3 finance analytics requires does not exist yet,
   and no fuzzy attribution was made in its place.

7. **The map bundle is 960 KB.** MapLibre is lazily loaded so only `/map` pays for it, but it
   dominates that route's transfer. A tiled vector service would fix it and is Phase 5 work.

8. **Peer cohorts require five agencies.** Small or unusual agencies fall below that and get no
   benchmark. That is the intended behavior; a cohort of four is not a distribution.

9. **The unkeyed FBI CDE origin remains undocumented and unversioned.** A keyed api.data.gov
   fallback is configured, but a redeploy that changes the `LATEST` path segment would break
   ingestion until the setting is updated.

---

## 10. Methodology decisions made during implementation

Each of these was a decision, not a default, and each is enforced somewhere testable.

1. **Denominator type is structural; denominator confidence is per-year.** Baltimore's
   denominator is a municipal population in 2016 exactly as in 2024. The reason there is no
   2016 rate is that the estimates series starts in 2020 — a coverage gap, not an
   incomparability. Conflating the two produced the wrong on-screen reason, and separating them
   is what lets the interface say the true thing in each case.

2. **State police are excluded from per-resident rates for a different reason than universities
   are.** A campus population is transient and nested; a statewide jurisdiction *overlaps* every
   local agency, so the same residents already sit in every local denominator. Both produce
   "Not comparable using a standard resident denominator", but the methodology page explains
   them separately.

3. **A contested ORI7 resolves only on two agreeing signals with a margin.** Primary ORI plus a
   name match that beats every rival by 20 points. California Highway Patrol files its entire
   statewide workforce as one record under a county-labelled ORI7 and resolves; ORI7 `CA01999`,
   shared by fourteen sub-units with no primary, does not.

4. **Peer cohorts are built only from agency-years with a publishable rate.** Including a
   withheld agency-year would let a value the platform refuses to print influence a median it
   does print.

5. **Negative annual offense totals are preserved and excluded from rates.** Seven agency-years
   net below zero because the FBI's monthly series includes revisions. They are shown as
   published and never corrected, because correcting a published value is inventing one.

6. **The map draws no-data as a hatch pattern, not a pale fill.** A pale fill sits inside the
   sequential ramp and reads as a low value. This was found by comparing the legend's promise
   to what the map actually drew.

7. **Fonts are self-hosted.** A public data platform should not make its readers fetch a font
   from a third party — a privacy surface, an availability dependency, and the first thing to
   fail on a restricted network. 384 KB of IBM Plex, subset to latin and latin-ext.

8. **The command bar says "Searching…" rather than "No matches" while a request is in flight.**
   Found by a release-gate test. A momentary false statement is still a false statement, and
   this product cannot afford small ones.

---

## 11. Release identifiers

```
Data release        release_2026_08_29_006   built 2026-08-29T17:27:11Z   commit 2f84a08
Application build   web/dist                 4.16 MB
Warehouse           data/warehouse/nledp.duckdb   112 MB
Source artifacts    263 MB across 80 hashed files
Reconciliation      docs/reconciliation-staffing-2024.md
Screenshots         docs/screenshots/ (19 files, desktop and mobile)
Performance         docs/performance.json
Accessibility       docs/accessibility.json
```

Run it:

```bash
uvicorn nledp.api.main:app --port 8000     # serves the API and the built application
pytest tests --ignore=tests/e2e            # 124 unit and integration tests
pytest tests/e2e                           # 28 release-gate tests, needs the server running
```
