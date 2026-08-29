# Data model

Every table in the warehouse, in the order `nledp build` creates them. Row counts are from
release `release_2026_08_29_004`; column types are as `DESCRIBE` reports them.

```
dim_source ─┐                     fact_finance ─┐ (census_gov_id_12)
dim_metric ─┤ (registry-defined)                v
dim_time ───┘                    agency_crosswalk (government link) ──> dim_geography
                                 agency_crosswalk (geography link)  ──> dim_geography ─┐
dim_agency ─┬──> agency_history        ^                                               v
            ├──> fact_staffing         │                              fact_demographics
            ├──> fact_reporting  ──────┘
            └──> fact_crime

analytics_agency_geography   <- dim_agency + agency_crosswalk + dim_geography
analytics_agency_population  <- ^ + fact_demographics + fact_staffing
analytics_agency_year        <- ^^ + fact_crime + fact_staffing + fact_reporting
analytics_peer_cohort        <- analytics_agency_year  -> analytics_peer_benchmarks
analytics_state_year, analytics_reporting_coverage <- analytics_agency_year

data_quality_log  <- every table (write-only, by quality/validate.py and canonical/facts.py)
release_manifest  <- table_counts() at the end of a build
```

## Why every FIPS and ORI column is VARCHAR

Integer coercion eating a leading zero is the most common defect in this domain. Alabama is
state `01`, not `1`; place `00124` is not `124`; the 7-digit place GEOID `0100124` is not
`100124`. No column here benefits from being a number, and one that is a number is a defect
waiting to surface as a failed join rather than as an error. `util/fips.py` enforces `str` on
ingest, `SCHEMA_SQL` enforces `VARCHAR` in the DDL, the `geoid_wrong_width` and
`invalid_state_fips` checks assert it on every build, and two tests assert it in CI.

---

## dim_source — 13 rows

One row per ingested or evaluated data source. PK `source_id`. From `registry/sources.yaml`.

```
source_id, source_name, publisher, dataset_name, dataset_description, source_url,
documentation_url, access_method, api_endpoint, geographic_level, update_frequency,
latest_release_date, license, primary_identifier, known_limitations, ingestion_status,
validation_status VARCHAR
coverage_start_year, coverage_end_year, verified_http_status INTEGER
```

Twelve rows are ingested; `bjs-leaic-2012` is present with `ingestion_status: not_ingested`
and `verified_http_status: 403`, because a source the platform could not obtain is a finding,
not an absence. Four further sources sit in the registry's `deferred_sources` block with a
reason each and are not loaded.

## dim_metric — 17 rows

One row per published metric. PK `metric_id`. From `registry/metrics.yaml`.

```
metric_id, display_name, description, formula, numerator, denominator, unit, source,
frequency, preferred_visualization, attribution_level, limitations VARCHAR
comparison_allowed, ranking_allowed BOOLEAN
```

The two booleans are independent: a metric can be accurate and still refuse ranking. The
registry's six `prohibited_metrics` — `spending_per_agency`, `cost_per_sworn_officer`,
`per_capita_spending_ranking`, `regional_spending_total`, `spending_vs_crime_correlation`,
`clearance_rate` — each carry a reason and are deliberately not loaded into this table.

## dim_time — 42 rows

One row per calendar year, 1985 through 2026. PK `data_year`. Derived from
`VINTAGES["crime_last_complete_year"]` (2025), not from a file.

```
data_year INTEGER   is_complete, crime_usable, is_cog_year BOOLEAN   note VARCHAR
```

`is_cog_year` marks the Census of Governments full-universe years, which end in 2 and 7.
2021 and every year after 2025 carry an explanatory `note`.

## dim_geography — 72,055 rows

One row per Census geographic unit: 36,427 county subdivisions, 32,350 places, 3,222
counties, 56 states and equivalents. PK `geo_id`. From the 2025 Gazetteer, the 2020 place
code list and the 2020 urban-area files.

```
geo_id, geo_level, geoid, name, state_abbr, state_fips, county_fips, place_fips,
cousub_fips, classfp, funcstat, lsad, uace, urban_area_name, urbanicity_band,
source_id VARCHAR
land_sqmi, water_sqmi, latitude, longitude DOUBLE      geography_vintage INTEGER
is_independent_city, is_consolidated BOOLEAN
```

`geo_id` is summary-level-prefixed (`place:0644000`, `county:06037`, `cousub:2500107175`,
`state:06`) because a bare GEOID is ambiguous across levels. Counties come from the Gazetteer
rather than `codes2020/`, which is frozen at the 2020 vintage and still lists the eight
counties Connecticut abolished; the nine Planning Regions (`09110`–`09190`) are here instead.

## dim_agency — 19,902 rows

One row per law-enforcement agency, keyed on its NIBRS ORI9. PK `agency_id`. From
`agencies.csv` in every ingested NIBRS year (2020–2025), later years winning on conflict,
plus the live CDE agency directory for agencies enrolled in UCR but absent from NIBRS.

```
agency_id, ori9_nibrs, ori9_legacy, ori7, ori7_source, covered_by_legacy_ori, agency_name,
agency_name_normalized, ucr_agency_name, ncic_agency_name, agency_type, agency_type_source,
agency_status, city, county_name, msa_name, state_abbr, state_abbr_as_reported, state_fips,
jurisdiction_type, population_group_code, population_group_desc, nibrs_start_date,
source_id VARCHAR
is_dormant, is_covered_by_parent, is_nibrs, rate_denominator_eligible BOOLEAN
dormant_year, first_observation_year, latest_observation_year INTEGER
latitude, longitude DOUBLE      fbi_population_served BIGINT
```

The directory is the only source of point coordinates. `city`, `first_observation_year` and
`latest_observation_year` are unpopulated; `city` is resolved through `agency_crosswalk` and
deliberately never guessed here.

**The three ORI forms.** The FBI publishes three identifiers for the same agency, and
`agencies.csv` is the only file carrying two of them together.

| Column | Width | Where it comes from | Example |
|---|---|---|---|
| `ori9_nibrs` | 9, alphanumeric tail possible | CDE API and `agencies.csv.ori` | `DE0029Z0X` |
| `ori9_legacy` | 9, numeric tail | `agencies.csv.legacy_ori` | `DE0029200` |
| `ori7` | 7 | derived; the key of every SRS-era fixed-width master | `DE00292` |

`ori7` is always `ori9_legacy[:7]` and never `ori9_nibrs[:7]`. The two forms diverge in
positions 7–9 for a minority of agencies, and deriving from the wrong one drops them from
every staffing series without an error. `ori7_source` records which derivation produced the
value: 16,054 agencies are `legacy_ori`, authoritative; 3,848 are `nibrs_ori_fallback`,
meaning no legacy ORI was observed in any ingested year, so the NIBRS form's first seven
characters were used instead and the column says, per row, that the join is provisional.

`ori7` is also not unique — fourteen distinct ORI9s share `CA01999`, and the pattern repeats
wherever a state uses a county-99 block for special agencies. An ambiguous ORI7 is refused
rather than attributed to whichever agency was read first; 77 are logged under
`ambiguous_ori7`.

`agency_type` is the platform's taxonomy — 11,705 `municipal_police`, 2,980 `county_sheriff`,
1,331 `university_police`, 1,021 `state_police` and eight further types — derived from the
agency name, with the FBI's coarser label kept unmodified beside it in `agency_type_source`.
`rate_denominator_eligible` is false for the 4,932 agencies whose served population is
transient or nested inside another jurisdiction.

## agency_history — 138 rows

One row per observed change or status flag on an agency. No primary key. From the NIBRS
agency dimension.

```
agency_id, change_type, old_value, new_value, notes VARCHAR   effective_year INTEGER
```

Currently 108 `covered_by_parent` rows — reports submitted under a parent ORI, so counting
both double-counts — and 30 `dormant`.

## agency_crosswalk — 58,329 rows

One row per modelled link from one entity to another. No primary key. This table holds no
facts: every row is an assertion the platform made, carrying the method that made it and a
score.

```
canonical_agency_id, target_domain, target_id, target_name, source, match_method,
review_status, notes VARCHAR      match_score DOUBLE
```

Two `target_domain` values are populated, and they are not the same kind of link:

- **`geography`, source `nledp-resolution`** — 19,902 rows, one per agency, linking an agency
  to the Census geography it appears to police. This is the link the federal government does
  not publish; the platform builds it and scores it.
- **`geography`, source `census-gov-finance-2024`** — 38,427 rows linking a Census government
  unit (`canonical_agency_id` holds the 12-character government ID here) to a place or county
  GEOID, using the crosswalk that ships inside the finance file itself at `Fin_PID` positions
  112–116. Counties are encoded as `99` plus the 3-digit county FIPS; cities and townships
  carry a true 5-digit place FIPS.

The schema comment allows a third value, `census_government`, for a direct agency-to-
government link. It is deliberately never written, because no source supports that claim. The
government link above runs geography-to-government, so a spending figure belongs to a
government unit and stops there.

**`review_status` vocabulary.** Four values are defined; three occur.

| Status | Meaning | Resolution links |
|---|---|---|
| `accepted` | A deterministic rule fired, or a fuzzy match cleared 97 and was corroborated by distance. Rates may be published. | 17,017 |
| `needs_review` | A link was made but the evidence does not carry it alone. Visible in the product and in a review queue; no per-resident rate. | 356 |
| `unmatched` | No link. The agency falls back to its state so it stays locatable, with no rate. | 2,529 |
| `rejected` | Reserved for a link a reviewer has refused. Not yet written by any code path. | 0 |

`match_method` names the rule that fired — `exact_normalized_name_in_state` 10,288,
`exact_normalized_county_name` 3,011, `state_fallback` 2,529, `agency_type_rule` 1,934,
`fuzzy_name_corroborated_by_distance` 1,707, and six smaller methods. The unmatched are
overwhelmingly agencies with no municipal counterpart: 862 university, 336 park and
conservation, 269 special-jurisdiction, 263 marshal and constable, 146 tribal.

## fact_staffing — 183,391 rows

One row per agency per year per source. PK `(agency_id, data_year, source_id)`. From the UCR
Police Employee master files (170,564 rows, 2016–2024) and the NIBRS agency dimension
(12,827 rows, 2025, which the bulk masters do not cover).

```
agency_id, value_type, join_method, source_id VARCHAR       fbi_population BIGINT
data_year, sworn_officers, civilian_personnel, total_personnel, male_officers,
female_officers, male_civilians, female_civilians INTEGER
```

`join_method` records how each row reached its agency — `ori7_from_legacy` 138,456,
`ori7_fallback` 32,108, `direct_ori9` 12,827 — so a series resting on a provisional
identifier derivation can be identified as such. An agency that did not report is absent from
this table, never present with zero officers: "this department has no officers" and "we do
not know" are different claims.

## fact_reporting — 15,129 rows

One row per agency per year. PK `(agency_id, data_year)`. From the 2025 `agencies.csv`
participation flags.

```
agency_id, source_id VARCHAR      data_year, months_reported INTEGER
participated, nibrs_participated, pe_reported, publishable BOOLEAN
reporting_completeness DOUBLE
```

Populated for 2025 only. `months_reported` and `reporting_completeness` are null here; the
measured month count lives in `fact_crime`, where it is counted from the response rather than
reported by the agency.

## fact_demographics — 316,276 rows

One row per geography per year per denominator basis. PK `(geo_id, data_year, basis)`.

```
geo_id, basis, source_id VARCHAR   data_year INTEGER   population, population_moe BIGINT
```

| Basis | Rows | Years | Source |
|---|---|---|---|
| `pep` | 262,152 | 2020–2025 | Population Estimates vintage 2025, bulk CSV — an annual point estimate for 1 July of a named year |
| `acs5` | 35,260 | 2024 | ACS 5-year; the only source covering Census Designated Places and the only source of `population_moe` |
| `pep_county_balance` | 18,864 | 2020–2025 | derived: county population minus the apportioned population of every incorporated place in it |

The three bases sit side by side rather than being reconciled. Balance rows use a `geo_id` of
the form `county:06037#balance`: a sheriff normally patrols only the unincorporated remainder
of a county, and dividing his offenses by the full county population understates the rate by
three to ten times in urbanized counties.

## fact_finance — 125,816 rows

One row per government unit per survey year per item code. PK
`(census_gov_id_12, survey_year, item_code)`. From the Census Annual Survey of State and
Local Government Finances Individual Unit Files, FY2022–FY2024.

```
census_gov_id_12, item_code, item_label, data_flag, value_type, gov_type, unit_name,
county_name, state_fips, fips_place, fiscal_year_ending, attribution_level,
source_id VARCHAR    survey_year INTEGER    amount_thousands BIGINT    is_cog_year BOOLEAN
```

The key is a government unit, never an agency: `attribution_level` is `government_unit` on
all 125,816 rows and a test asserts it. By item code: `E89` 45,495, `E62` police protection
current operations 31,438, `E25` 25,250, `F62` police construction 14,621, `E04` 6,317,
`E05` 2,556, `M62` 139. The corrections and judicial codes are stored alongside E62 because a
sheriff's E62 excludes the jail and the civil functions his headcount includes.

FY2022 contributes 80,984 rows against 22,368 for FY2023 and 22,464 for FY2024, because 2022
is a Census of Governments year — a full universe — while the intervening years are a
voluntary sample; `is_cog_year` marks that boundary and a series crossing it is discontinuous
by design. `fiscal_year_ending` is `MMDD` and is first-class because survey year N spans
individual fiscal years ending between 1 July N−1 and 30 June N.

## fact_crime — 320,190 rows

One row per agency per year per offense group. PK `(agency_id, data_year, offense_group)`.
Reduced from the harvested CDE summarized-crime responses.

```
agency_id, offense_group, value_type, source_id VARCHAR
data_year, months_reported INTEGER        offenses, clearances BIGINT
```

Two offense groups at 160,095 rows each, `violent-crime` and `property-crime`, 2016–2025.
`months_reported` is counted from the response rather than assumed: 276,408 rows are
`reported` with twelve months and 43,782 are `partial_year`. A partial year keeps its count
and is denied a rate downstream. Seven rows carry a negative offense total, which is what the
FBI's monthly series produces when revisions net below zero; they are preserved as published,
flagged, and excluded from every rate, because correcting them would be inventing a number.

## data_quality_log — 34,463 rows

One row per individual finding: a check, a severity, and the entity it fired on. No primary
key. Written by `quality/validate.py` and by the fact loaders.

```
check_id, severity, table_name, entity_id, message, observed, expected,
release_id VARCHAR      data_year INTEGER
```

The current build is 0 errors, 4,260 warnings and 30,203 info rows. `message` and `expected`
are copied from the check definition so a row is readable without the code that produced it,
and `observed` carries the value that tripped it. Twenty-three check IDs run on every build;
three more — `ambiguous_ori7`, `duplicate_agency_year_staffing`, `pe_zero_filled_year` — are
written during loading and survive `clear_log`, because they record decisions made while a
source file was open and cannot be recomputed from the warehouse afterwards. Full register in
[`docs/testing.md`](testing.md).

## release_manifest — 21 rows

One row per table per release: the row count that table had when the release was cut. No
primary key. Written by `release.py` from `table_counts()`.

```
release_id, built_at, git_commit, table_name, note VARCHAR      row_count BIGINT
```

Twenty-one rows is the current build's twenty-one tables for `release_2026_08_29_004`. The
full manifest — SHA-256 per raw artifact and validation summary included — is the JSON in
`data/releases/`; this table is the in-warehouse copy, so `nledp status` and a future API can
name the release they serve without reading a file. `git_commit` reads `uncommitted`, which
is what `git rev-parse HEAD` yields where no commit exists.

---

## Analytics tables

Each is one `CREATE TABLE AS` statement, dropped and rebuilt every build, so its shape is
defined by the query that produces it. None has a declared primary key.

**`analytics_agency_geography` — 19,902 rows.** One row per agency: identity and type joined
to its resolved geography and the review status of that link.

```
agency_id, agency_name, agency_type, agency_type_source, state_abbr, county_name, geo_id,
geo_name, match_method, geo_review_status, geo_level, geoid, urbanicity_band, classfp VARCHAR
latitude, longitude, match_score DOUBLE
rate_denominator_eligible, is_dormant, is_covered_by_parent, is_independent_city,
is_consolidated BOOLEAN
```

**`analytics_agency_population` — 119,310 rows.** One row per agency per year, 2020–2025, for
every agency with a resolved geography.

```
agency_id, geo_id, denominator_basis VARCHAR      data_year INTEGER
population_pep, population_acs5, population_acs5_moe, population_fbi_reported,
population_county_balance, denominator BIGINT     fbi_pep_divergence DOUBLE
```

All four bases sit side by side and `denominator` names the one the platform chose: the
unincorporated balance for a county agency where it exists and is smaller than the county,
otherwise PEP, otherwise ACS. It is null unless the geography link was accepted and the
agency type admits a resident denominator. `fbi_pep_divergence` is the reconciliation signal:
a large gap between the FBI's population field and PEP means the mapping has broken.

**`analytics_agency_year` — 188,853 rows.** One row per agency per year, 2016–2025, for every
agency-year appearing in either `fact_staffing` or `fact_crime`. This is the table the
Phase 2 application reads.

```
agency_id, agency_name, agency_type, state_abbr, geo_id, geo_name, geo_level,
urbanicity_band, geo_review_status, denominator_basis, violent_value_type,
property_value_type VARCHAR
rate_denominator_eligible, participated, nibrs_participated, pe_reported BOOLEAN
data_year, sworn_officers, civilian_personnel, total_personnel, violent_months_reported,
property_months_reported INTEGER
population, population_geography_total, violent_crime_offenses, violent_crime_clearances,
property_crime_offenses BIGINT
officers_per_1k, violent_crime_rate, property_crime_rate, civilian_share DOUBLE
```

The four rate columns are the only division in the platform. Each is null unless its
denominator is positive, its numerator non-negative, the reporting year complete
(`months_reported = 12` for the crime rates), the geography link accepted, and the agency
type rate-eligible. In 2024 the denominators are 16,241 `pep`, 2,923 `pep_county_balance`,
333 `acs5`, and 25 agency-years with no basis at all.

**`analytics_peer_cohort` — 137,065 rows.** One row per rate-eligible agency-year on an
accepted link, carrying its cohort assignment. `cohort_id` is the definition itself —
`agency_type | population_band | urbanicity_band` — stored with the row so the product can
always show what a percentile was measured against.

```
agency_id, agency_type, state_abbr, urbanicity_band, population_band, cohort_id VARCHAR
data_year INTEGER   officers_per_1k, violent_crime_rate, property_crime_rate DOUBLE
population BIGINT
```

**`analytics_peer_benchmarks` — 305 rows.** One row per cohort per year, for cohorts with at
least five members; a cohort of four is not a benchmark.

```
cohort_id VARCHAR   data_year INTEGER   cohort_size BIGINT
officers_per_1k_median/_p25/_p75, violent_rate_median/_p25/_p75 DOUBLE
```

**`analytics_state_year` — 539 rows.** One row per state per year. The state rate divides
full-year reporters' offenses by full-year reporters' population, so numerator and
denominator cover the same agencies rather than the same state.

```
state_abbr VARCHAR  data_year INTEGER   agencies, agencies_participating BIGINT
sworn_officers, civilian_personnel, violent_offenses_full_year,
population_full_year_reporters HUGEINT     violent_crime_rate DOUBLE
```

**`analytics_reporting_coverage` — 539 rows.** One row per state per year, counting who
reported. Coverage is a published metric rather than a caveat: `population_coverage` is the
share of the state's resolved population living under an agency that reported twelve months,
and it is what a trend line has to be shown alongside.

```
state_abbr VARCHAR  data_year INTEGER   agency_years BIGINT
full_year_reporters, partial_reporters, non_reporters, population_total,
population_covered HUGEINT                 population_coverage DOUBLE
```
