# Technical Blueprint
### National Law Enforcement Data & Intelligence Platform

**Status:** Phase 0 (discovery) and Phase 1 (data foundation) are built and running.
**Build:** `release_2026_08_29_003` · 19,902 agencies · 320,190 crime facts · 183,391 staffing facts
**Data vintage:** crime and staffing through 2025 · geography 2025 · population vintage 2025 · finance FY2024

---

## Summary of the argument

Every design decision below follows from a single finding of the source audit: **the federal
government does not publish a current, machine-retrievable crosswalk between a police agency
and the place it polices, and it does not publish police spending at the agency level at
all.** The only official ORI-to-FIPS crosswalk, BJS's LEAIC, stops at reference year 2012,
sits behind an ICPSR login, and returns HTTP 403 to any non-browser client. Census
expenditure data keys on a government unit, and no crosswalk from a Census government ID to
an FBI ORI exists anywhere.

A platform that ignores this ships confident numbers that are wrong. A platform that stops
because of it ships nothing. This one builds the missing links itself, scores every one of
them, exposes the score, and refuses to publish a figure the link does not support.

---

## A. Product architecture

Five layers, each with a single responsibility and a hard boundary.

| Layer | Contents | Rule |
|---|---|---|
| **1 Raw** | `data/raw/` — source bytes unchanged, SHA-256 and fetch timestamp per artifact | Nothing is edited here, ever |
| **2 Staging** | Parsers in `connectors/` — fixed-width layouts, delimiter sniffing, type coercion | No business logic |
| **3 Canonical** | `dim_*`, `fact_*`, `agency_crosswalk`, `agency_history`, `data_quality_log` | One grain per table, every row names its source |
| **4 Analytics** | `analytics_*` — rates, cohorts, benchmarks, coverage | Every division happens here and nowhere else |
| **5 Application** | API and UI, Phase 2 onward | Reads Layer 4 only; never computes a headline metric |

The Layer 4 rule is the one that matters most. A rate is a join: it aligns a numerator with
a denominator of the same observation year, excludes agency types for which a resident
denominator is a category error, and refuses a geography link the resolution layer did not
accept. That is testable logic, and it cannot be tested if it lives inside a chart
component. Fifteen warehouse invariants assert it on every build.

**Warehouse:** DuckDB in development (single file, 110 MB, zero-configuration, fast enough
for the whole national dataset); PostgreSQL + PostGIS in production when the API needs
concurrent readers and real geometry. The SQL is portable; the ingestion is columnar.

---

## B. Information architecture

Twelve surfaces. Fewer than the brief allows, because navigation depth is itself a
usability cost.

1. **National Overview** — headline metrics, each with its observation year and coverage
2. **Map Explorer** — agency points and geography choropleths, layer-switchable
3. **Agency Explorer** — searchable, filterable, exportable table of all 19,902 agencies
4. **Agency Profile** — the product's centre of gravity; see §L
5. **Compare** — 2 to 5 agencies: snapshot, trend, benchmark, indexed change
6. **States** — per-state profile with participation and peer-adjusted comparison
7. **Crime Trends** — counts, rates, percent change, indexed change, 1/3/5/10-year windows
8. **Staffing** — sworn, civilian, per-1,000, civilian share, trend
9. **Spending** — government-unit expenditure, labelled as such throughout
10. **Reporting & Data Quality** — coverage, missingness heatmap, flag register
11. **Data Explorer** — metric × geography × year × filters → table, map, trend, scatter, distribution
12. **Methodology** — the source registry and metric registry, rendered

Every analytical view is URL-addressable: `/map?metric=violent_crime_rate&year=2024&state=NY`,
`/compare?agencies=MDBPD0000,PABPD0000,MOKCPD000`. Filters survive refresh and are what a
share link carries.

---

## C. Data-source matrix

Thirteen sources are ingested; four were evaluated and deliberately deferred. Every URL and
HTTP status below was verified by live request on 2026-08-29. Full registry:
[`registry/sources.yaml`](../registry/sources.yaml) and [`docs/data-sources.md`](data-sources.md).

| Source | Grain | Years | Access | Status |
|---|---|---|---|---|
| FBI CDE agency directory | agency | live | REST, per-state | ingested — 19,625 ORIs |
| FBI NIBRS `agencies.csv` | agency-year | 2020–2025 | bulk ZIP member | ingested — the identifier bridge |
| FBI UCR PE master files | agency-year | 2016–2024 | bulk ZIP, fixed-width | ingested |
| FBI UCR summarized crime | agency-month | 2016–2025 | REST | ingested — 39,250 calls |
| BJS CSLLEA 2018 | national/state | 2018 | bulk ZIP | ingested (aggregate tables) |
| BJS LEAIC crosswalk | agency | 2012 | ICPSR, login | **blocked** — see §E |
| Census Gazetteer 2025 | place/county/cousub | 2025 | bulk ZIP | ingested — 72,055 geographies |
| Census PEP vintage 2025 | place/county/state | 2020–2025 | bulk CSV | ingested — primary denominator |
| Census ACS 5-year | place/county | 2020–2024 | REST, keyed | ingested — 32,038 places |
| Census urban areas 2020 | urban area | 2020 | bulk XLSX + relationship files | ingested — urbanicity band |
| Census government finance | government unit | 2022–2024 | bulk ZIP, fixed-width | ingested — 125,816 rows |
| Census Government Units 2025 | government unit | 2025 | bulk ZIP | ingested — crosswalk validation |

**Three findings that changed the architecture.**

*The CDE has an unkeyed origin.* `cde.ucr.cjis.gov/LATEST` serves the identical routes as
the keyed `api.usa.gov` gateway with no key and no advertised rate limit — it is the backend
the CDE web app itself calls. The keyed gateway is rate-limited per key (a newly issued key
was observed at 10 requests/hour). The platform uses the unkeyed origin as primary with the
keyed gateway configured as a documented fallback, and notes in the registry that the
unkeyed origin is undocumented and unversioned.

*`pe-2025.zip` is a zero-filled shell.* It downloads cleanly — 26,288 records — and every
employment count is 0. A loader that trusts the file replaces the national police workforce
with zero. The loader asserts a non-zero total per year and rejects the file, logging the
rejection; 2025 staffing comes from the API and from `agencies.csv` instead.

*One member, not the whole archive.* NIBRS ships one ZIP per state per year; California 2025
is 117 MB and Texas 116 MB, and the only member needed is a ~320 KB `agencies.csv`. The
platform reads the ZIP central directory over HTTP range requests and fetches that member
alone, turning a ~2 GB national download into 6.6 MB per year in about 90 seconds.

---

## D. Data model

```
dim_source ──┐
dim_metric ──┤
dim_time ────┤
             ├──> fact_crime         (agency × year × offense group)
dim_agency ──┤    fact_staffing      (agency × year × source)
   │         ├──> fact_reporting     (agency × year)
   │         └──> fact_finance       (government unit × year × item code)
   │
agency_crosswalk ──> dim_geography ──> fact_demographics (geography × year × basis)
agency_history
data_quality_log
release_manifest
```

Every FIPS and ORI column is `VARCHAR`. Integer coercion eating a leading zero — Alabama
`01` becoming `1`, place `00124` becoming `124` — is the most common defect in this domain
and is asserted against in both validation and tests.

`dim_agency` carries three identifiers, not one, because the FBI publishes three:

| Form | Width | Where | Example |
|---|---|---|---|
| `ori9_nibrs` | 9, alphanumeric tail possible | CDE API, `agencies.csv.ori` | `DE0029Z0X` |
| `ori9_legacy` | 9, numeric tail | `agencies.csv.legacy_ori` | `DE0029200` |
| `ori7` | 7 | all SRS fixed-width masters | `DE00292` |

**`ori7` is always `ori9_legacy[:7]`, never `ori9_nibrs[:7]`.** The two differ for agencies
whose forms diverge in positions 7–9, and deriving from the wrong one drops them silently
from every staffing series. A test asserts both the rule and that the rule is load-bearing.
Where no legacy ORI was ever observed, a provisional `ori7` is derived from the NIBRS form
and `ori7_source` records that the derivation is a fallback — 3,848 of 19,902 agencies.

`ori7` is also **not unique**: fourteen distinct ORI9s share `CA01999`. An ambiguous ORI7 is
refused rather than attributed to whichever agency was read first, and logged.

Full schema: [`docs/data-model.md`](data-model.md).

---

## E. Agency-resolution strategy

The LEAIC crosswalk is unavailable and stale, so the platform builds its own and treats every
link as a modelled artifact with a method, a score and a review status — never as a fact.

**Candidate generation** is state-scoped, and switches unit by region: in Connecticut,
Maine, Massachusetts, New Hampshire, Rhode Island and Vermont the general-purpose local
government is the **county subdivision (town)**, not the Census place, so candidates there
are `cousub` rows and everywhere else they are `place` rows. This is a per-state branch in
the join logic, not an exception to patch later — a New England department matched against
places either misses entirely or matches a CDP covering a fraction of the town.

**Rules, in order:**

| Method | Links | Status |
|---|---|---|
| `exact_normalized_name_in_state` | 10,288 | accepted |
| `exact_normalized_county_name` (sheriffs) | 3,011 | accepted |
| `agency_type_rule` (state police → state) | 1,934 | accepted |
| `fuzzy_name_corroborated_by_distance` (≥97 and ≤25 km) | 1,707 | accepted |
| `name_tie_broken_by_distance` | 69 | accepted |
| `fuzzy_name_low_confidence` (≥88) | 283 | needs review |
| `geography_primary_needs_review` (≤10 km, name ≥55) | 47 | needs review |
| `ambiguous_name` (same name, no coordinate to break the tie) | 17 | needs review |
| `state_fallback` | 2,538 | unmatched |

**17,017 accepted · 356 needs review · 2,529 unmatched.** The unmatched are overwhelmingly
university (842), park and conservation (332), special-jurisdiction (267), marshal and
constable (250) and tribal (143) agencies, which genuinely do not correspond to a
municipality. They still appear in the product, at state level, with no per-resident rate.

The `geography_primary_needs_review` pass exists for consolidated city-county governments:
the FBI writes "Metropolitan Nashville Police Department" and the Census writes
"Nashville-Davidson metropolitan government (balance)". Name similarity cannot bridge that;
a coordinate three kilometres from the Census internal point can. Every link that pass makes
is marked for review, because a coordinate inside a city says nothing about whether the
agency's jurisdiction *is* that city.

**Geography → government** is a separate, deterministic link using the FIPS place crosswalk
that ships inside the finance file itself (`Fin_PID` positions 112–116): 38,427 links,
100% populated for counties, cities and townships. It is never presented as an
agency-to-government link, because no source supports that claim.

---

## F. Metric framework

Seventeen metrics are defined in [`registry/metrics.yaml`](../registry/metrics.yaml), each
carrying `comparison_allowed` and `ranking_allowed` independently. A metric can be perfectly
accurate and still carry `ranking_allowed: false`, because ranking incomparable
jurisdictions is the characteristic failure of this genre and the FBI's own *Caution Against
Ranking* warns against exactly it. **Six metrics are defined as prohibited**, with the reason
recorded, so the absence is a documented decision rather than an oversight.

**The denominator policy** is the substantive methodological content:

- **Primary: PEP vintage 2025.** An annual point estimate for 1 July of a named year, so a
  2025 crime count divides by a 2025 population. ACS 5-year "2024" is a 60-month period
  average with an effective midpoint of mid-2022 and would misstate rates in fast-growing
  and shrinking places by 5–15% in the tail.
- **Secondary: ACS 5-year**, which is the only source of demographic composition and the only
  one covering Census Designated Places — 129 agency-years in 2024 fall back to it.
- **Sheriffs get the unincorporated balance.** A sheriff normally patrols only the
  unincorporated remainder of a county, because the incorporated cities inside it run their
  own departments. Dividing sheriff-reported offenses by the full county population
  understates the rate by a factor of three to ten in urbanized counties. The platform
  computes county population minus the apportioned population of every incorporated place in
  it: Los Angeles County goes from 9,748,868 to 969,505, and the LASD officers-per-1,000
  figure goes from a meaningless 0.91 to 9.12. **2,923 agency-years in 2024** use this basis
  and it is named on every one of them.
- **Reconciliation: the FBI's own `population` field**, stored beside the others with a
  divergence flag above ten percent, because that divergence is the signal that the
  agency-to-geography mapping has broken.
- **State police get no per-resident rate at all.** Their jurisdiction overlaps every local
  agency in the state, so the same residents already sit in every local denominator.

**Spending is government-unit only.** Census function code E62 measures what a *government*
spent, not what a *department* budgeted. The platform publishes the government's figure,
labelled as the government's figure, and defines `spending_per_agency` and
`cost_per_sworn_officer` as prohibited. The most defensible comparative spending metric is
E62 as a share of the same unit's own direct general expenditure, because numerator and
denominator share a unit, a fiscal year and a classification, so most drift cancels.

---

## G. UX system

Restrained, dense, and never confident beyond the data. Manrope or Inter for text,
tabular-figure numerals for every metric, a neutral base with a single accent, full light and
dark palettes defined as tokens.

Four rules carry most of the weight:

1. **No number without its year and its coverage.** "412 per 100K · 2024 · 94.4% of
   population covered by full-year reporters" is the unit of display, not "412".
2. **Missing is a rendered state, not an empty cell.** *Not reported · Insufficient coverage ·
   Not comparable · Unavailable* — each with a reason on hover. A blank cell is a bug.
3. **Provenance is always one interaction away.** Every card, chart and table cell reaches
   its metric definition, and every definition reaches its source registry entry.
4. **Percentile is not quality.** Peer comparison always shows the cohort definition next to
   the percentile, and never uses evaluative colour on a rate.

Wide content scrolls inside its own container; the page body never scrolls horizontally.
Keyboard navigation, focus states, screen-reader labels for every chart, and no meaning
carried by colour alone.

---

## H. Technical stack

**Built (Phase 1):** Python 3.11, DuckDB, Polars, PyArrow, httpx, RapidFuzz, Typer, pytest.
One CLI: `nledp ingest | build | validate | status | query`.

**Planned (Phase 2+):** Next.js + TypeScript + Tailwind on the front end; FastAPI over
PostgreSQL/PostGIS for the API; MapLibre with deck.gl for the map, served from vector tiles
rather than a national GeoJSON payload; Observable Plot for charts. Playwright for
end-to-end, Vitest for components.

Performance: national scale means ~20,000 agencies × 20 years × dozens of metrics. The
browser never receives the whole dataset. Aggregation is server-side, geography is tiled,
tables paginate, and the analytics tables are precomputed at build time so a page load is a
lookup rather than a computation.

---

## I. Privacy and governance controls

The analytical unit is **agency, jurisdiction, county, city, state** — never an officer,
suspect, victim, witness or resident. That is a schema-level commitment: no table in the
warehouse has a person grain, and none of the ingested sources carry one. NIBRS
victim, offender and arrestee segments are deliberately not ingested; only `agencies.csv` is
read from those archives.

The platform will not build: home or personal contact details, officer schedules or
locations, victim or witness identification, suspect tracking, personnel records, licence-plate
or facial-recognition data, or any protected-class targeting feature.

Governance is enforced in code, not in a policy document: `attribution_level` is a column on
`fact_finance` and a test asserts it is always `government_unit`; `ranking_allowed` is a
column on `dim_metric`; `rate_denominator_eligible` is a column on `dim_agency` and a test
asserts no rate is ever published against one that is false.

---

## J. Testing strategy

**32 tests, all passing.** Two kinds:

*Unit tests* pin the parsers to verbatim source records. The finance test fixture is the
literal 32-character Chicago FY2024 line from `2024FinEstDAT`; the PE test asserts Anchorage
2024 parses to 322 + 44 + 44 + 124 = 534, which matches the CDE API exactly. A layout drift
fails immediately rather than producing plausible wrong numbers.

*Warehouse invariants* assert the platform's promises against the built database: no rate
across mismatched observation years; no rate on an unaccepted geography link; no rate for a
transient-population agency type; no rate on a partial reporting year; no zero-filled
staffing year; `ori7` always derived from the legacy ORI, and the rule demonstrably
load-bearing; every fact row names a source that exists in `dim_source`.

**Twenty-three validation checks** run on every build and write to `data_quality_log`. Nothing
deletes a row: a flag triggers review, and an automatic "fix" to a published value would be
a fabrication.

Current build: **0 errors, 4,260 warnings, 30,203 info.** The warnings are real findings —
2,757 staffing series that drop to zero (reporting gaps, not disbanded departments), 1,074
clearance-to-offense ratios above 1.5, 41 tenfold single-year jumps, 7 negative annual
offense totals the FBI's own revisions produce.

---

## K. Performance strategy

Ingest: 90.8 MB of source artifacts plus a 138 MB gzipped crime harvest. The harvest is
39,250 API calls at ~27 requests/second — about 25 minutes — resumable per state, and the
partial-ZIP reader keeps the NIBRS pull at 6.6 MB per year instead of ~2 GB.

Build: the full pipeline runs in about four minutes on a laptop. Bulk loading goes through
Arrow rather than `executemany`, which was a 30× difference at 72,000 rows.

Serving (Phase 2): precomputed analytics tables, server-side aggregation, vector tiles,
pagination, HTTP caching keyed on `release_id`. Target under 2.5 seconds to first meaningful
render.

---

## L. Development roadmap

| Phase | Contents | Status |
|---|---|---|
| **0 Discovery** | Source inventory, feasibility, architecture, risks | **complete** |
| **1 Data foundation** | Registries, ingestion, agency master, crosswalk, geography, metrics, validation, reproducible release | **complete** |
| **2 MVP** | National overview, map, agency explorer, agency profile, methodology page | next |
| **3 Analytics** | Compare, state pages, staffing, crime trends, coverage, data explorer | |
| **4 Intelligence** | Peer cohorts in the UI, percentiles, indexed trends, anomaly surfacing, confidence indicator | cohorts and benchmarks already built |
| **5 Hardening** | Playwright suite, performance, accessibility audit, exports, monitoring | |

**The Phase 2 acceptance test** is the one the brief names: search "Baltimore Police
Department" and understand, within seconds, jurisdiction, population served, agency type,
staffing and its trend, violent and property crime trends, peer position, which years exist,
what is missing, and where every number came from. The data for that page exists now:

| Year | Population | Sworn | Civilian | Officers/1k | Violent | Rate/100k | Months |
|---|---|---|---|---|---|---|---|
| 2020 | 583,295 | 2,465 | 475 | 4.23 | 9,398 | 1,611 | 12 |
| 2021 | 576,503 | 2,360 | 483 | 4.09 | 4,987 | *not reported* | **7** |
| 2022 | 570,475 | 2,360 | 483 | 4.14 | 9,753 | 1,710 | 12 |
| 2023 | 567,952 | 2,047 | 474 | 3.60 | 9,578 | 1,686 | 12 |
| 2024 | 570,053 | 1,986 | 527 | 3.48 | 9,161 | 1,607 | 12 |
| 2025 | 569,997 | 2,051 | 588 | 3.60 | 7,602 | 1,334 | 12 |

2021 shows the design working. Baltimore reported seven months that year, so the count is
shown and the rate is withheld. A platform that divided anyway would have published a 39%
one-year drop in violent crime that did not happen.

---

## M. Risks

**Methodological**

1. **Sheriff jurisdiction remains approximate.** The unincorporated balance is a large
   improvement over the full county, and it is still wrong where a sheriff polices
   incorporated cities under contract — widespread in California and Florida. Orange County
   CA lands at 15.87 officers per 1,000 on a 130,770 balance, which is the flag firing
   correctly. Contracts are not published in any federal source, so the platform flags and
   does not correct. *Mitigation: `likely_contract_policing` warning; a Phase 4 project to
   collect contract rosters from state sources.*

2. **The 2021 discontinuity is permanent.** Population coverage falls to 69.5% in 2021 and
   twenty states no longer submit SRS at all. *Mitigation: coverage is a first-class
   published metric; `dim_time.crime_usable` gates the year; trend components must show
   coverage alongside the line.*

3. **Fuzzy links are 10% of accepted matches.** 1,707 links rest on a name score of 97 or
   better plus a 25 km corroboration. *Mitigation: method and score on every row; a review
   queue; sampled manual audit before Phase 2 launch.*

4. **Spending attribution can be misread even when labelled.** A user who sees a city's E62
   next to its police department will read it as the department's budget. Chicago FY2024 is
   the demonstration: Census reports $2,238,483k against a CPD appropriation of $2,011,525k,
   an 11.3% gap in the best-aligned case available. *Mitigation: label text is specified in
   the metric registry, not left to the component; per-agency spending is a prohibited metric.*

**Operational**

5. **The unkeyed CDE origin is undocumented and unversioned.** The `LATEST` path segment
   changes on redeploy and there is no deprecation notice. *Mitigation: keyed api.data.gov
   fallback configured; origin is a settings value; ingestion failures are loud.*

6. **BJS microdata cannot be refreshed by an unattended job.** CSLLEA, LEMAS, LEAR and LEAIC
   all sit behind an ICPSR login on a CDN that rejects browserless clients. *Mitigation:
   automated refresh is designed around the FBI API and Census bulk files; BJS enters through
   a human-in-the-loop step with checked-in file hashes.*

7. **Federal files are revised silently in place.** The 2022 Census finance file was
   reprocessed in July 2026, four years after collection. *Mitigation: SHA-256 per artifact
   in the release manifest; the processing stamp is stored as a version field.*

8. **Pending releases will change the design.** CSLLEA 2022 and LEMAS Core 2024 are both
   confirmed fielded and unreleased, and BJS states CSLLEA 2022 will become the go-forward
   sampling frame. *Mitigation: tracked as watch items in the registry; the agency spine is
   deliberately built on the FBI directory so a BJS release enriches rather than replaces it.*

**Product**

9. **Ranking pressure.** Users will want a "most dangerous cities" list, and the platform
   does not offer one. *Mitigation: peer cohorts and percentiles with the cohort definition
   always visible; `ranking_allowed` is enforced in the data, so a future contributor cannot
   add a ranking without changing the registry and failing a review.*

---

*Every figure in this document was produced by the pipeline in this repository and can be
reproduced with `nledp ingest --crime && nledp build`.*
