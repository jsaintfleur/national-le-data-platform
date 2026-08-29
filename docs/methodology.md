# Methodology

This document states what each derived figure means, how it is computed, and — the part that
matters more — what it does not mean. Where the platform declines to publish something, the
reason is here.

---

## 1. The agency universe

The platform counts **19,902 agencies**. That number needs qualification, because the two
authoritative federal counts disagree and neither is wrong.

| Figure | Source | Year | What it counts |
|---|---|---|---|
| 17,541 | BJS CSLLEA 2018 | 2018 | Agencies employing at least one FTE sworn officer |
| ~19,600 | FBI CDE agency directory | 2026 | ORIs enrolled in the UCR program |
| 16,675 | FBI, *Reported Crimes in the Nation, 2024* | 2024 | Agencies that actually submitted data |

They differ because they count different objects. BJS counts *agencies*; the FBI counts
*ORIs*, which are reporting identifiers — one agency can hold several, and some ORIs are not
operational police agencies at all. BJS excludes agencies below one FTE sworn officer; UCR
enrollment has no floor. BJS does active nonresponse follow-up and reaches tiny agencies;
UCR participation is voluntary and unadjusted.

The platform builds its spine from the FBI directory because it is the only source that is
current, ORI-keyed, geocoded and retrievable without a human logging in. CSLLEA 2018 is
carried as the reconciliation benchmark. Where an agency's reports are submitted under a
parent ORI, `dim_agency.is_covered_by_parent` is set and the platform warns that counting the
agency and its parent separately double-counts.

### Agency-type classification

The FBI's `agency_type_name` has seven values and is too coarse: "County" covers both a
sheriff's office and a county police department, and "Other" covers everything from a port
authority to a fire marshal. The platform derives a twelve-value taxonomy from the agency
**name**, applied in a fixed rule order, and stores **both** labels — `agency_type` and
`agency_type_source` — so the federal label and the platform's reading of it are always
visible side by side.

| Platform type | Agencies | Rule |
|---|---|---|
| `municipal_police` | 11,705 | Source type "City" with no name rule firing |
| `county_sheriff` | 2,980 | Name contains SHERIFF, or source type "County" |
| `university_police` | 1,331 | UNIVERSITY, COLLEGE, CAMPUS, SCHOOL DISTRICT |
| `state_police` | 1,021 | STATE POLICE, STATE PATROL, HIGHWAY PATROL, DEPT OF PUBLIC SAFETY |
| `state_special_jurisdiction` | 913 | Source type "Other State Agency" |
| `park_or_conservation_police` | 604 | PARK, FOREST, CONSERVATION, WILDLIFE, NATURAL RESOURCES |
| `special_jurisdiction` | 440 | HOSPITAL, HOUSING AUTHORITY, or source type "Other" |
| `marshal_or_constable` | 431 | MARSHAL, CONSTABLE |
| `tribal_police` | 240 | TRIBAL, NATION, PUEBLO, BAND OF, RESERVATION |
| `port_or_airport_police` | 99 | AIRPORT, PORT AUTHORITY, SEAPORT, HARBOR, MARITIME |
| `transit_police` | 93 | TRANSIT, RAIL, SUBWAY, BUS |
| `county_police` | 45 | Source type "County" with POLICE and not SHERIFF in the name |

A name rule beats the source label. A sheriff's office mislabelled "City" is still a
sheriff's office, and 2,980 against CSLLEA's 3,051 sheriffs' offices suggests the rule is
close to right. This is a heuristic and it is documented as one.

---

## 2. Identifier resolution

### The three ORI forms

| Form | Width | Where it appears | Example |
|---|---|---|---|
| NIBRS ORI9 | 9, alphanumeric tail possible | CDE API, `agencies.csv.ori` | `DE0029Z0X` |
| Legacy ORI9 | 9, numeric tail | `agencies.csv.legacy_ori` | `DE0029200` |
| ORI7 | 7 | All SRS fixed-width master files | `DE00292` |

**ORI7 is derived from the legacy form, never the NIBRS form.** For agencies whose two forms
differ in positions 7–9, `ori[:7]` produces an identifier that matches nothing, and the
agency vanishes from every staffing series with no error. The rule and its necessity are both
asserted by `test_ori7_is_derived_from_legacy_ori`.

Where no legacy ORI was ever observed across the six ingested NIBRS years — 3,848 of 19,902
agencies — a provisional ORI7 is derived from the NIBRS form and `ori7_source` records
`nibrs_ori_fallback`. `fact_staffing.join_method` carries that provenance to every row, so a
staffing figure that rests on a provisional identifier can be identified as such.

**ORI7 is not unique.** Fourteen distinct ORI9s share `CA01999`, and the pattern repeats
wherever a state uses a county-99 block for special agencies. An ambiguous ORI7 is refused
rather than attributed to whichever agency was read first; 61 ambiguous ORI7s are logged.

### Agency to geography

No current federal ORI-to-FIPS crosswalk exists. BJS's LEAIC, the only one ever published,
stops at reference year 2012, requires an ICPSR login and returns HTTP 403 to browserless
clients. The platform builds its own and scores every link.

Candidate generation is state-scoped and switches unit by region. In **Connecticut, Maine,
Massachusetts, New Hampshire, Rhode Island and Vermont**, the general-purpose local
government — and therefore the police jurisdiction — is the **county subdivision (town)**,
not the Census place. Matching a New England department against places either misses entirely
or matches a Census Designated Place covering a fraction of the town. This is a per-state
branch in the join logic.

| Method | Links | Status | Rule |
|---|---|---|---|
| `exact_normalized_name_in_state` | 10,288 | accepted | Normalized names identical, one candidate |
| `exact_normalized_county_name` | 3,011 | accepted | Sheriff's county name matches exactly |
| `agency_type_rule` | 1,934 | accepted | State-jurisdiction agency resolved to its state |
| `fuzzy_name_corroborated_by_distance` | 1,707 | accepted | Token-set ≥97 **and** ≤25 km |
| `name_tie_broken_by_distance` | 69 | accepted | Same-name candidates, nearest ≤25 km |
| `fuzzy_name_low_confidence` | 283 | needs review | Token-set ≥88, ≤75 km |
| `geography_primary_needs_review` | 47 | needs review | ≤10 km and name ≥55 |
| `ambiguous_name` | 17 | needs review | Same name, no coordinate to break the tie |
| `state_fallback` | 2,538 | unmatched | No municipality matched |

**17,017 accepted · 356 needs review · 2,529 unmatched.** Thresholds are deliberately
conservative: a wrong link produces a confidently wrong rate, which is worse than a visible
gap. The unmatched are overwhelmingly university (842), park and conservation (332),
special-jurisdiction (267), marshal and constable (250) and tribal (143) agencies, which
genuinely do not correspond to a municipality. They appear in the product at state level
with no per-resident rate.

The `geography_primary_needs_review` pass exists for consolidated city-county governments.
The FBI writes "Metropolitan Nashville Police Department"; the Census writes
"Nashville-Davidson metropolitan government (balance)". Name similarity cannot bridge that,
and a coordinate three kilometres from the Census internal point can. Every link that pass
makes is marked for review, because a coordinate inside a city says nothing about whether the
agency's jurisdiction *is* that city.

### Geography to government

Separate, deterministic, and never presented as an agency-to-government link. The FIPS place
crosswalk ships inside the finance file itself (`Fin_PID` positions 112–116), 100% populated
for counties, cities and townships: 38,427 links. Counties are encoded as `99` plus the
three-digit county FIPS.

---

## 3. Denominators

This is the most consequential methodological choice in the platform, and the one that most
often goes wrong elsewhere.

### Primary: Population Estimates Program, vintage 2025

PEP is an annual point estimate for 1 July of a named year, so a 2025 crime count divides by
a 2025 population. ACS 5-year "2024" is a 60-month period average whose effective midpoint is
mid-2022; using it would misstate rates in fast-growing and shrinking places by 5–15% in the
tail. PEP is used for **10,875 of 13,927 agency-years** with a denominator in 2024.

Two operational cautions. PEP vintages are **not** a time series — each vintage re-estimates
all prior years — so the platform loads one vintage and does not mix them. And `SUMLEV` is
load-bearing: `162` rows are incorporated places, `061` rows are minor civil divisions, and
loading both without discrimination double-counts.

### Secondary: ACS 5-year, 2024

The only source of demographic composition, and the only one covering **Census Designated
Places**, which PEP does not publish. 129 agency-years fall back to ACS in 2024. Margins of
error are stored and must be carried through any derived figure.

### Sheriffs: the unincorporated balance

A sheriff's office normally has primary patrol responsibility only for the **unincorporated
balance** of its county, because the incorporated cities inside it run their own departments.
Dividing sheriff-reported offenses by the full county population understates the rate by a
factor of three to ten in urbanized counties. This is structural, not a data-cleaning problem,
and it is the largest single source of error in agency-level crime rates.

The platform computes county population minus the apportioned population of every
incorporated place in that county, using the 2020 place-by-county relationship file. A place
spanning several counties is split evenly across them.

| County | Full county | Unincorporated balance | Officers/1k full | Officers/1k balance |
|---|---|---|---|---|
| Los Angeles, CA | 9,748,868 | 969,505 | 0.91 | **9.12** |
| Miami-Dade, FL | 2,812,144 | 1,221,496 | 1.11 | **2.57** |
| San Diego, CA | 3,287,542 | 503,630 | 0.74 | **4.83** |
| Cook, IL | 5,188,791 | 1,494,395 | 0.35 | **1.23** |

**2,923 agency-years in 2024** use this basis, and `denominator_basis` names it on every one.

It remains wrong where a sheriff polices incorporated cities **under contract** — widespread
in California and Florida. Orange County CA lands at 15.87 officers per 1,000 on a 130,770
balance, which is the `likely_contract_policing` flag firing correctly. Contract rosters are
not published in any federal source, so the platform flags and does not correct. Where the
balance is not smaller than the county total — consolidated city-counties such as Jacksonville
— the full figure is used and labelled `pep`.

### Reconciliation: the FBI's own population field

Stored beside the others, never published as the denominator. It is agency-self-reported,
revised irregularly, sometimes zero or missing, and derived from Census inputs anyway. Its
value is as a check: `fbi_pep_divergence` above ten percent is the signal that the
agency-to-geography mapping has broken.

### Agency types with no per-resident rate

3,826 agencies are marked `rate_denominator_eligible = false`. Two different reasons:

**Transient and nested populations.** University, transit, port and airport, park and
conservation, special-jurisdiction and marshal or constable agencies serve populations that
are largely non-resident and sit inside another agency's jurisdiction. A university police
department's offenses divided by the campus resident population is not a weak estimate, it is
a category error — 40,000 people are present on a weekday and the group-quarters resident
count bears no relation to them. Transit police are the limiting case: jurisdiction is a
linear network crossing dozens of places, and no Census geography corresponds to it at all.

**Overlapping jurisdictions.** State police are excluded for a different reason. Their
jurisdiction overlaps every local agency in the state, so dividing their offenses by the state
population produces a figure that looks like a crime rate and is not one — the same residents
already sit in every local agency's denominator.

These agencies are shown with **counts**, never rates.

---

## 4. Derived metrics

```
violent_crime_rate = violent_crime_offenses / population * 100000
```

Published only when: the geography link is `accepted`; the agency type is
`rate_denominator_eligible`; the population observation is in the **same year** as the crime
observation; the agency reported **all twelve months**; and the offense total is not negative.
Four warehouse invariants assert each of those conditions, and they are regression guards,
not aspirations.

```
officers_per_1k = sworn_officers / population * 1000
```

Same gating on link and eligibility. The platform publishes no view on what an appropriate
staffing level is; no source supports one.

```
indexed_change = value_year / value_base_year * 100
```

How the platform compares trends between agencies of very different size without implying
their levels are comparable.

```
reporting_completeness = months_reported / 12
```

`months_reported` is **counted** from the response, not assumed. A null month is a null, not
a zero. A year below twelve months is marked `partial_year` and produces no rate.

### Ranking

Nine of seventeen metrics carry `ranking_allowed: false`, including every crime rate. This is
the practice the FBI's own *Caution Against Ranking* warns against, and it is the
characteristic failure of this genre. Peer cohorts and percentiles are offered instead, with
the cohort definition always visible.

Cohorts are `agency_type | population band | urbanicity band`, with bands at 10K, 25K, 50K,
100K, 250K, 500K and 1M. A benchmark is published only for a cohort of **five or more**
agencies — a cohort of four is not a benchmark.

Urbanicity comes from the 2020 Census urban areas: Large urban (≥200,000), Urban
(50,000–199,999), Small urban (5,000–49,999), Rural (outside any urban area). In the place
relationship file, rural places have all seven urban-area fields empty — that is the rural
signal, not a parse error.

---

## 5. Government finance

Census function code **E62** is police-protection current operations. Read the label the
platform attaches to it, because it is the whole methodology:

> **This is what a government spent, not what a police department's budget was.** It covers
> all police-protection activity of this government unit — which may include more than one
> law enforcement agency, or none.

**Why per-agency spending is not published.** The Census collects from a government unit —
a city, a county — not from a police agency. The mapping between the two is many-to-many in
both directions and no source publishes it. Every "per-agency spending" figure derived from
Census finance data is an assumption dressed as a measurement.

Six specific failure modes, all documented in `registry/metrics.yaml`:

1. **Coverage.** The annual survey is a voluntary stratified sample: 2024 covers 57.8% of
   counties, 20.8% of municipalities and 4.9% of townships. Only 5,931 governments have any
   E62 record, against 19,711 in the 2022 Census-of-Governments year. A year-over-year change
   for a small city is very often a change in whether the city was surveyed.
2. **Imputation.** 1,569 of 5,931 E62 values in 2024 — 26.5% — are imputed, not reported. The
   flag travels to the interface and is never dropped in aggregation.
3. **County aggregation.** A county's E62 covers the sheriff's office and any county police
   department together, and excludes jail operations and court and civil functions, which the
   Census classifies under E04, E05 and E25. Those three are stored alongside E62 for exactly
   this reason.
4. **Contract policing.** A city that buys policing from a county reports the payment as
   direct E62 while the same policing sits in the provider's total. Never sum a county with
   its cities.
5. **Pensions.** Employer pension contributions are **excluded** from E62 for a government
   running its own pension fund and **included** for one enrolled in a state system. Nothing
   in the source flags which regime applies, and the difference can be 15–30% of compensation
   cost. A per-capita ranking is partly a ranking of pension administration structure.
6. **Fiscal year.** Survey year N spans individual fiscal years ending 1 July N−1 through 30
   June N — about a 24-month window across units. 62% of units close 30 June; only 17% close
   31 December and align with calendar-year crime data. `fiscal_year_ending` is a first-class
   column and is displayed.

**F62 is construction, not capital outlay.** G62 (land and existing structures) and K62
(equipment) have zero records in the public-use file, and K62 is not collected for most local
governments. Calling F62 "capital outlay" would overstate what the source measures.

**The scale of the residual error, in the best case available.** Chicago's fiscal year is the
calendar year, so alignment is as good as it ever gets. Census reports **$2,238,483,000** for
Chicago FY2024. The city's own budget ordinance appropriates $2,011,524,627 to the Police
Department, and $2,032,886,209 including every police-governance body. Census exceeds the
department appropriation by 11.3%. That is the floor on the discrepancy, not the ceiling.

**The one defensible comparative spending metric** is E62 as a share of the same government's
own direct general expenditure, because numerator and denominator share a unit, a fiscal year
and a classification, so most drift cancels.

---

## 6. Time

`crime_last_complete_year = 2025`. This is a hard cutoff, not a preference.

National monthly violent-crime offenses fall from 87,397 in December 2025 to 42,498 in July
2026 to 4,696 in August 2026. Those are submission artifacts. `dim_time.crime_usable` is
false beyond 2025 and `test_crime_stops_at_the_completeness_cutoff` enforces it.

**2021 is a discontinuity, not a data point.** The SRS-to-NIBRS transition means roughly 31%
of agencies had not onboarded that year, and several FBI CIUS table families skip 2021
entirely. Population coverage measured by this platform:

| Year | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|---|---|
| Population covered by full-year reporters | 92.4% | **69.5%** | 90.6% | 93.0% | 94.4% | 96.5% |

Any trend component that crosses 2021 must show coverage alongside the line. Twenty states no
longer submit SRS at all — Arkansas, Colorado, Delaware, Idaho, Iowa, Kentucky, Michigan,
Montana, Nevada, New Hampshire, North Carolina, North Dakota, Rhode Island, South Carolina,
South Dakota, Tennessee, Vermont, Virginia, West Virginia, Wyoming. That is structural and
will not backfill.

---

## 7. Missing data

A missing value is never a zero, and never a blank cell.

| Rendered state | Meaning |
|---|---|
| **Not reported** | The agency did not submit for this year |
| **Insufficient coverage** | Fewer than twelve months reported; the count is shown, the rate is not |
| **Not comparable** | The value exists but the comparison the user asked for is not defensible |
| **Unavailable** | No source publishes this figure for this entity and year |
| **Estimated, not reported** | Imputed by the source agency (finance only) |

An agency that did not report staffing is **absent** from `fact_staffing`, not present with
zero officers. The distinction is the difference between "this department has no officers"
and "we do not know".

Seven agency-years carry a **negative** annual offense total, because the FBI's monthly series
includes revisions that net below zero. They are preserved in `fact_crime` exactly as
published, flagged, and excluded from every rate. They are not corrected, because correcting a
published value would be inventing a number.

---

## 8. Reproducibility

Every build produces a `release_id` and a manifest containing a SHA-256 per source artifact,
row counts per table, full validation results, the build timestamp and the git commit. Federal
files are revised silently in place — the 2022 Census finance file was reprocessed in July
2026, four years after collection — so the hash and the fetch timestamp are the only reliable
version identifiers for most of these sources.

```bash
nledp ingest --crime && nledp build
```

Every figure in this document was produced that way and can be reproduced.
