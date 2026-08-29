# Testing and validation

Thirty-two tests, all passing, in two kinds — and the two kinds catch different failures.

**Unit tests pin the parsers to verbatim source records.** Seventeen tests across
`test_parsers.py`, `test_identifiers.py`, `test_crime_reduction.py` and `test_resolution.py`
assert that a known input produces a known output. They need no warehouse and run in a
fraction of a second. What they guard against is layout drift: a fixed-width federal file
whose columns move by one position does not fail, it produces plausible wrong numbers, and a
plausible wrong number is worse than a crash because nothing downstream notices.

**Warehouse invariants assert the platform's promises against the built database.** Fifteen
tests in `test_warehouse_invariants.py` query the warehouse `nledp build` produced and check
the rules the product rests on: no rate across mismatched observation years, no rate on an
unaccepted geography link, no rate for a transient-population agency type, no missing value
silently coerced to zero. These cannot be unit tests, because they are properties of a join
across several tables rather than of any one function. They skip automatically when
`data/warehouse/nledp.duckdb` does not exist.

Neither kind substitutes for the other. A parser can be exactly right about every field and
still be joined to the wrong agency; a join can be exactly right and still be fed a column
read from the wrong offset.

## The test files

**`tests/test_parsers.py`** — seven tests over the two fixed-width formats.

`test_pe_record_layout` builds the Anchorage 2024 Police Employee record from its documented
field widths and asserts 322 male officers + 44 male civilians + 44 female officers + 124
female civilians = 534 total employees, which matches what the CDE API returns for that agency
and year — the layout is not merely parsed, it is checked against an independent publication
of the same number. It also asserts `ori7 == "AK00101"` and that the two-digit year `24`
resolves to 2024. `test_pe_record_rejects_non_pe_lines` asserts a non-record-type-5 line and a
short line both return `None` rather than a partially filled dict.

`test_finance_record_is_32_chars` uses the literal Chicago FY2024 line from `2024FinEstDAT`
— `172031162236E62     22384832024R` — and asserts the government ID, item code E62, amount
2,238,483 thousand dollars, survey year, `R` reported flag, `City` government type and state
FIPS `17`. It guards the boundary between the 12-character ID, the 3-character item code and
the 12-character amount, where an off-by-one silently multiplies or divides every spending
figure. `test_finance_imputation_flag_is_preserved` asserts an `I` flag survives, so an
imputed value can never be presented as reported; `test_finance_item_filter` asserts the
item filter rejects a non-police code.

`test_pid_record_carries_place_and_fiscal_year` asserts the `Fin_PID` layout at the two
positions the platform depends on: the FIPS place crosswalk at 112–116, where an Alabama
county reads `99001` under the county encoding, and the fiscal year ending at 140–144,
reading `0930`. Those two fields are what make the geography-to-government link and the
fiscal-year-alignment flag possible at all. `test_census_of_governments_years` pins the
full-universe rule to 2022 and 2027 and away from 2024.

**`tests/test_identifiers.py`** — five tests over the defects that produce confidently wrong
numbers. `test_leading_zeros_survive` asserts `pad("1", 2) == "01"`,
`place_geoid("1","124") == "0100124"` and `county_geoid("6","37") == "06037"` from both string
and integer inputs; `test_geoidfq_is_stripped` covers the Gazetteer's prefixed form.
`test_fbi_state_code_is_mapped_to_usps` asserts `NB` maps to `NE` — the FBI writes Nebraska in
NCIC codes, and without the map 287 Nebraska agencies lose their geography silently, still
appearing with no location and no rate.
`test_name_normalization_collapses_department_words` asserts "Camden Police Department",
"CAMDEN PD" and "Camden Police Dept." normalize to one string, the precondition for the
exact-name rule making 10,288 of the resolution layer's links. `test_agency_classification`
pins five classifications including the case the taxonomy exists for: a sheriff's office the
FBI labelled `City` still classifies as `county_sheriff`, because the classification decides
which denominator the agency gets.

**`tests/test_crime_reduction.py`** — three tests over the monthly-to-annual reduction.
`test_months_are_summed_per_year` asserts months sum within a year and do not leak across the
year boundary. `test_null_months_are_not_counted_as_zero` is the important one: a fixture with
January and February present and March null must count two months, not three and not twelve.
That count is what makes `value_type = 'partial_year'` possible, and therefore what stops a
seven-month year from being divided into a rate. `test_empty_body_is_safe` asserts a null
response reduces to empty rather than raising.

**`tests/test_resolution.py`** — two tests.
`test_place_normalization_strips_legal_status_words` asserts "Dover city" and "Dover town"
collapse to `DOVER`, that "Nashville-Davidson metropolitan government (balance)" retains
`NASHVILLE`, and that "Athens-Clarke County unified government (balance)" loses `BALANCE` —
the consolidated city-county governments the fallback pass exists for. `test_haversine`
checks DC-to-Baltimore at 50–70 km and asserts a null coordinate returns `None`.

**`tests/test_warehouse_invariants.py`** — fifteen tests over the built warehouse.

`test_agency_ids_are_unique`, `test_every_geoid_has_the_right_width` and
`test_connecticut_uses_planning_regions` guard the identifier layer; the last asserts both
that no abolished Connecticut county is present and that nine `091%` Planning Regions are.

`test_ori7_is_derived_from_legacy_ori` asserts two things, and the second is the unusual one.
Where a legacy ORI exists, `ori7` must equal `ori9_legacy[:7]` — zero violations. And
`substr(ori9_nibrs,1,7) <> ori7` must hold for at least one agency, asserting the rule is
load-bearing rather than vacuous: a rule satisfiable by either derivation would pass the
first assertion forever while quietly permitting the wrong one.

Five tests guard the rate rules: `test_no_rate_is_published_across_observation_years`,
`test_no_rate_on_an_unaccepted_geography_link`,
`test_no_resident_rate_for_transient_population_agencies`,
`test_partial_years_do_not_produce_rates`, and
`test_crime_stops_at_the_completeness_cutoff`. Each asserts zero rows violating a promise the
product makes on every page.

`test_no_staffing_year_is_zero_filled` groups `fact_staffing` by year and asserts no year
sums to zero sworn officers. `pe-2025.zip` downloads cleanly with 26,288 records and every
employment count zero; a loader that trusted it would replace the national police workforce
with zero, and this test is what notices.

`test_sheriffs_use_the_unincorporated_balance` asserts more than a thousand 2024 sheriff
agency-years use `pep_county_balance` as their denominator — the current build has 2,923. It
is a coverage assertion rather than a correctness one: if the balance derivation broke it
would fail silently, falling back to full county population and producing numbers that look
reasonable and are three to ten times too low.

`test_finance_is_never_attributed_to_an_agency` asserts `attribution_level` is
`government_unit` on all 125,816 rows, and `test_metric_registry_marks_spending_as_non_rankable`
asserts `gov_police_current_operations` carries both `comparison_allowed` and
`ranking_allowed` false. Governance is enforced as data, so a contributor cannot add a
spending ranking without changing the registry and failing a test.

`test_every_fact_row_names_its_source` and
`test_every_source_id_used_by_a_fact_exists_in_dim_source` assert provenance across all five
fact tables: no null `source_id`, and no `source_id` that is not a real row in `dim_source`.

## Validation register

Twenty-three checks are defined in `src/nledp/quality/validate.py` and run on every build,
plus three check IDs written during loading. Every check's SQL returns
`(entity_id, data_year, observed)` and every finding becomes a row in `data_quality_log`
carrying the check's own message and expectation. Row counts below are from
`data_quality_log` as built in release `release_2026_08_29_004`: 0 errors, 4,260 warnings,
30,203 info.

### Errors — a build with any of these is wrong

| check_id | Table | What it detects and what it means | Rows |
|---|---|---|---|
| `agency_id_not_unique` | dim_agency | The agency spine has a duplicate key. Every fact join would fan out. | 0 |
| `invalid_state_fips` | dim_agency | `state_fips` is not two digits. A lost leading zero. | 0 |
| `geoid_wrong_width` | dim_geography | A GEOID whose length does not match its summary level — state 2, county 5, place 7, cousub 10. Almost always integer coercion. | 0 |
| `connecticut_legacy_county` | dim_geography | One of the eight counties Connecticut abolished is present, meaning geography was read from the frozen 2020 code list rather than the 2025 Gazetteer. | 0 |
| `negative_population` | fact_demographics | A negative denominator. | 0 |
| `nonstandard_state_abbr` | dim_agency | An agency state code with no match in `dim_geography`. The FBI uses NCIC codes; an unmapped one drops every geography join for that state without an error. | 0 |
| `staffing_year_out_of_range` | fact_staffing | An observation year outside 1960–2025, which means a two-digit year was resolved into the wrong century. | 0 |
| `crime_year_beyond_cutoff` | fact_crime | A crime observation past the completeness cutoff. 2026 submission is fractional and its levels are not computable. | 0 |
| `rate_published_across_years` | analytics_agency_year | A rate exists with no population observation in the same year. The regression guard on the platform's central rule. | 0 |
| `rate_on_unaccepted_link` | analytics_agency_year | A rate exists for an agency whose geography link was never accepted. | 0 |
| `rate_on_ineligible_agency_type` | analytics_agency_year | A per-resident rate exists for a university, transit, park or port agency, whose served population is transient and nested inside another jurisdiction. A category error, not a weak estimate. | 0 |

### Warnings — real findings that need a human, not a fix

| check_id | Table | What it detects and what it means | Rows |
|---|---|---|---|
| `staffing_dropped_to_zero` | fact_staffing | Sworn officers fell from more than 20 to zero in one year. Almost always a reporting gap, not a disbanded department. | 2,757 |
| `clearances_exceed_offenses` | fact_crime | Clearances above 1.5× offenses. Legitimate when old cases close in bulk; above that ratio it is worth review. | 1,074 |
| `duplicate_agency_year_staffing` | fact_staffing | Two PE master records share an ORI7 within one year and disagree on total employees. The larger is kept and the disagreement logged, because silently picking one is indistinguishable from a real staffing change. | 156 |
| `staffing_zero_sworn_with_civilians` | fact_staffing | Zero sworn officers reported alongside civilian staff. Usually a reporting artifact. | 148 |
| `ambiguous_ori7` | fact_staffing | An ORI7 shared by more than one ORI9, so a PE record keyed on it cannot be attributed to a single agency. Fourteen ORI9s share `CA01999`. Bulk staffing is not loaded for these agencies rather than attributed to whichever was read first. | 77 |
| `crime_10x_jump` | fact_crime | Offenses rose tenfold or more year over year with twelve months reported in both years. | 41 |
| `negative_crime_count` | fact_crime | A negative annual offense total, which the FBI's monthly series produces when revisions net below zero. Preserved as published, excluded from every rate. | 7 |
| `implausible_violent_rate` | fact_crime | A full-year violent rate above 10,000 per 100,000 in a place of at least 1,000 residents. Usually a jurisdiction mismatch rather than a real rate. | 0 |
| `pe_zero_filled_year` | fact_staffing | A PE master file that is published and entirely zero-filled was rejected at load time. Written only when such a file is present in `data/raw`; the current ingest stops at the last known-good year, 2024, so no file triggered it. | 0 |
| `likely_contract_policing` | analytics_agency_year | A sheriff above 8 officers per 1,000 once the unincorporated balance is the denominator. The usual cause is contract policing — the office also patrols incorporated cities the balance excludes. Flagged, never corrected, because the contracts appear in no federal source. | — |

### Info — documented context, not defects

| check_id | Table | What it detects and what it means | Rows |
|---|---|---|---|
| `finance_fiscal_year_misaligned` | fact_finance | A government whose fiscal year does not end 31 December, so its E62 figure does not line up with calendar-year crime statistics. | 18,563 |
| `finance_imputed_value` | fact_finance | An E62 value imputed by the Census Bureau or taken from an alternative source rather than reported by the government. | 7,628 |
| `unresolved_agency_geography` | agency_crosswalk | An agency-to-geography link that is unmatched or needs review. The agency still appears; no per-resident rate is computed. | 2,885 |
| `no_denominator_for_year` | fact_crime | A crime observation with no same-year population. Mostly Census Designated Places, which the Population Estimates Program does not cover: ACS supplies a 2024 value and nothing earlier, and borrowing a 2024 denominator for a 2020 numerator is exactly the year mismatch the platform refuses. | 1,127 |
| `agency_covered_by_parent_ori` | dim_agency | An agency whose reports are submitted under a parent ORI. Counting it and its parent separately double-counts. | — |

`likely_contract_policing` and `agency_covered_by_parent_ori` were added to `CHECKS` after
release `release_2026_08_29_004` was cut, so no rows for them are in the log yet. Evaluated
read-only against the current warehouse they return 607 and 90 rows respectively; the next
build will record them.

## Validation never deletes and never corrects

`run_checks` writes to `data_quality_log` and to no other table. No check has a `DELETE`, an
`UPDATE` or a repair branch, and `clear_log` only removes the log's own rows before a rebuild.
This is the platform's first rule applied to its own machinery.

An automatic fix to a published value is a fabrication. Seven agency-years carry a negative
violent-crime total because the FBI's monthly series includes revisions that net below zero.
Clamping them to zero would produce a number no source published, indistinguishable in the
warehouse from a number one did. Instead the value is preserved exactly as published,
flagged, and excluded from every rate, so a user sees a count with a warning rather than a
rate that quietly disagrees with the FBI. The same reasoning covers the 2,757 staffing series
that drop to zero, the 1,074 clearance ratios above 1.5, and the sheriffs above eight officers
per 1,000: each is real evidence of something, and the honest response is a flag and a visible
gap rather than an invented value.

The one place the platform does refuse data outright is a whole file that is demonstrably
not what it claims to be — a zero-filled PE year. That is a rejection at load time, logged
as an error, not a correction of a value.

## Running them

```bash
pytest                                   # 32 tests
pytest tests/test_parsers.py -v          # parsers only; no warehouse needed
pytest tests/test_warehouse_invariants.py   # skips if no warehouse is built

nledp validate                           # re-run all 23 checks against the current
                                         # warehouse without rebuilding it
nledp build                              # validation runs as the last step of a build
                                         # and its summary goes into the release manifest
```

`nledp validate` clears and rewrites `data_quality_log`, preserving the three load-time
check IDs. To read findings directly:

```bash
nledp query "SELECT check_id, severity, count(*) FROM data_quality_log
             GROUP BY 1,2 ORDER BY 3 DESC"

nledp query "SELECT entity_id, data_year, observed FROM data_quality_log
             WHERE check_id = 'staffing_dropped_to_zero' LIMIT 20"
```
