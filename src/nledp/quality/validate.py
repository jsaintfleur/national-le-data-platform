"""Validation, outlier detection, and the data-quality log.

Nothing here deletes a row. Every check writes to data_quality_log, and flags are meant to
trigger review, not silent correction -- an automatic fix to a value the source published is
a fabrication, and the platform's first rule is that it does not fabricate.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..config import VINTAGES

Severity = str  # error | warning | info


@dataclass
class Check:
    check_id: str
    severity: Severity
    table: str
    sql: str
    message: str
    expected: str


# Each SQL returns (entity_id, data_year, observed).
CHECKS: list[Check] = [
    Check("agency_id_not_unique", "error", "dim_agency",
          "SELECT agency_id, NULL, CAST(count(*) AS VARCHAR) FROM dim_agency "
          "GROUP BY 1 HAVING count(*) > 1",
          "agency_id appears more than once in dim_agency.", "exactly one row per agency"),

    Check("invalid_state_fips", "error", "dim_agency",
          "SELECT agency_id, NULL, coalesce(state_fips,'NULL') FROM dim_agency "
          "WHERE state_fips IS NOT NULL AND (length(state_fips) <> 2 "
          "OR NOT regexp_matches(state_fips,'^[0-9]{2}$'))",
          "state_fips is not a two-digit string.", "two-digit zero-padded FIPS"),

    Check("geoid_wrong_width", "error", "dim_geography",
          "SELECT geo_id, NULL, geoid FROM dim_geography WHERE "
          "(geo_level='state' AND length(geoid)<>2) OR (geo_level='county' AND length(geoid)<>5) "
          "OR (geo_level='place' AND length(geoid)<>7) OR (geo_level='cousub' AND length(geoid)<>10)",
          "GEOID width does not match its summary level; a leading zero was probably lost.",
          "state 2, county 5, place 7, cousub 10"),

    Check("connecticut_legacy_county", "error", "dim_geography",
          "SELECT geo_id, NULL, geoid FROM dim_geography WHERE geo_level='county' "
          "AND geoid IN ('09001','09003','09005','09007','09009','09011','09013','09015')",
          "An abolished Connecticut county is present. Connecticut uses nine Planning "
          "Regions (09110-09190) in the current geography vintage.",
          "no legacy CT counties"),

    Check("negative_population", "error", "fact_demographics",
          "SELECT geo_id, data_year, CAST(population AS VARCHAR) FROM fact_demographics "
          "WHERE population < 0",
          "Negative population.", "population >= 0"),

    Check("negative_crime_count", "warning", "fact_crime",
          "SELECT agency_id, data_year, CAST(offenses AS VARCHAR) FROM fact_crime "
          "WHERE offenses < 0",
          "Negative annual offense total. The FBI's monthly series carries revisions that "
          "can net below zero. The value is preserved as published and excluded from every "
          "rate; it is not corrected, because correcting it would be inventing a number.",
          "offenses >= 0"),

    Check("nonstandard_state_abbr", "error", "dim_agency",
          "SELECT agency_id, NULL, state_abbr FROM dim_agency a WHERE state_abbr IS NOT NULL "
          "AND NOT EXISTS (SELECT 1 FROM dim_geography g WHERE g.geo_level='state' "
          "AND g.state_abbr = a.state_abbr)",
          "Agency state abbreviation does not exist in the geography dimension. The FBI uses "
          "NCIC codes, not USPS codes, and an unmapped one drops every geography join for "
          "that state silently.", "a state present in dim_geography"),

    Check("clearances_exceed_offenses", "warning", "fact_crime",
          "SELECT agency_id, data_year, CAST(clearances AS VARCHAR) FROM fact_crime "
          "WHERE clearances IS NOT NULL AND offenses IS NOT NULL AND clearances > offenses * 1.5",
          "Clearances substantially exceed offenses. Clearances can legitimately exceed "
          "offenses in a year when older cases close, but a ratio above 1.5 is worth review.",
          "clearances <= 1.5 x offenses"),

    Check("staffing_year_out_of_range", "error", "fact_staffing",
          f"SELECT agency_id, data_year, CAST(data_year AS VARCHAR) FROM fact_staffing "
          f"WHERE data_year < 1960 OR data_year > {VINTAGES['crime_last_complete_year']}",
          "Staffing observation year is outside the plausible range.",
          f"1960 to {VINTAGES['crime_last_complete_year']}"),

    Check("crime_year_beyond_cutoff", "error", "fact_crime",
          f"SELECT agency_id, data_year, CAST(data_year AS VARCHAR) FROM fact_crime "
          f"WHERE data_year > {VINTAGES['crime_last_complete_year']}",
          "Crime observation beyond the platform's completeness cutoff. 2026 submission is "
          "fractional and its levels are not computable.",
          f"data_year <= {VINTAGES['crime_last_complete_year']}"),

    Check("staffing_zero_sworn_with_civilians", "warning", "fact_staffing",
          "SELECT agency_id, data_year, CAST(total_personnel AS VARCHAR) FROM fact_staffing "
          "WHERE sworn_officers = 0 AND civilian_personnel > 0",
          "Zero sworn officers alongside civilian staff. Often a reporting artifact rather "
          "than a department without officers.", "sworn > 0 where the agency is operational"),

    Check("staffing_dropped_to_zero", "warning", "fact_staffing",
          """
          WITH s AS (SELECT agency_id, data_year, sworn_officers,
                            lag(sworn_officers) OVER (PARTITION BY agency_id ORDER BY data_year) prev
                     FROM fact_staffing WHERE source_id='fbi-ucr-pe-master')
          SELECT agency_id, data_year, CAST(prev AS VARCHAR) FROM s
          WHERE prev > 20 AND sworn_officers = 0
          """,
          "Sworn officers fell from more than 20 to zero in one year. Almost always a "
          "reporting gap, not a disbanded department.", "no discontinuous drop to zero"),

    Check("crime_10x_jump", "warning", "fact_crime",
          """
          WITH c AS (SELECT agency_id, data_year, offense_group, offenses,
                            lag(offenses) OVER (PARTITION BY agency_id, offense_group
                                                ORDER BY data_year) prev
                     FROM fact_crime WHERE months_reported = 12)
          SELECT agency_id, data_year, CAST(prev AS VARCHAR) || ' -> ' || CAST(offenses AS VARCHAR)
          FROM c WHERE prev >= 20 AND offenses >= prev * 10
          """,
          "Offenses rose tenfold or more year over year on twelve months of reporting in "
          "both years.", "no order-of-magnitude single-year jump"),

    Check("implausible_violent_rate", "warning", "fact_crime",
          """
          SELECT c.agency_id, c.data_year,
                 CAST(round(c.offenses * 100000.0 / d.population, 1) AS VARCHAR)
          FROM fact_crime c
          JOIN agency_crosswalk x ON x.canonical_agency_id = c.agency_id
                                 AND x.target_domain='geography' AND x.review_status='accepted'
          JOIN fact_demographics d ON d.geo_id = x.target_id AND d.data_year = c.data_year
                                  AND d.basis='pep'
          WHERE c.offense_group='violent-crime' AND c.months_reported=12
            AND d.population >= 1000
            AND c.offenses * 100000.0 / d.population > 10000
          """,
          "Violent crime rate above 10,000 per 100,000 residents. Usually a jurisdiction "
          "mismatch rather than a real rate.", "rate below 10,000 per 100k"),

    Check("no_denominator_for_year", "info", "fact_crime",
          """
          SELECT c.agency_id, c.data_year, 'no PEP population for this year'
          FROM fact_crime c
          JOIN agency_crosswalk x ON x.canonical_agency_id = c.agency_id
                                 AND x.target_domain='geography' AND x.review_status='accepted'
          LEFT JOIN fact_demographics d ON d.geo_id = x.target_id AND d.data_year = c.data_year
                                       AND d.basis='pep'
          WHERE c.offense_group='violent-crime' AND d.geo_id IS NULL AND c.data_year >= 2020
          """,
          "No population observation in the same year as the crime observation, so no rate is "
          "published for this agency-year. Mostly Census Designated Places, which the "
          "Population Estimates Program does not cover -- ACS supplies a 2024 value and "
          "nothing earlier, and borrowing a 2024 denominator for a 2020 numerator is exactly "
          "the year mismatch this platform refuses to make.",
          "matching observation years"),

    Check("rate_published_across_years", "error", "analytics_agency_year",
          """
          SELECT ay.agency_id, ay.data_year, 'rate present without same-year population'
          FROM analytics_agency_year ay
          WHERE ay.violent_crime_rate IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM fact_demographics d
              WHERE replace(d.geo_id,'#balance','') = ay.geo_id
                AND d.data_year = ay.data_year)
          """,
          "A rate was published for an agency-year with no population observation in the "
          "same year. This is a regression guard: the analytics layer must never divide "
          "across observation years.", "no rate without a same-year denominator"),

    Check("rate_on_unaccepted_link", "error", "analytics_agency_year",
          "SELECT agency_id, data_year, geo_review_status FROM analytics_agency_year "
          "WHERE violent_crime_rate IS NOT NULL AND geo_review_status <> 'accepted'",
          "A rate was published for an agency whose geography link was never accepted.",
          "rates only on accepted links"),

    Check("rate_on_ineligible_agency_type", "error", "analytics_agency_year",
          "SELECT agency_id, data_year, 'rate on transient-population agency' "
          "FROM analytics_agency_year "
          "WHERE violent_crime_rate IS NOT NULL AND NOT rate_denominator_eligible",
          "A per-resident rate was published for an agency type whose served population is "
          "transient and nested inside another jurisdiction (university, transit, park, "
          "port). For these a resident denominator is a category error, not a weak estimate.",
          "no per-resident rate for transient-population agency types"),

    Check("likely_contract_policing", "warning", "analytics_agency_year",
          """
          SELECT agency_id, data_year,
                 CAST(round(officers_per_1k, 1) AS VARCHAR) || ' officers per 1k on a '
                 || CAST(population AS VARCHAR) || ' balance'
          FROM analytics_agency_year
          WHERE agency_type IN ('county_sheriff','county_police')
            AND denominator_basis = 'pep_county_balance'
            AND officers_per_1k > 8
          """,
          "A sheriff's officers-per-resident figure is far above the plausible range once "
          "the unincorporated balance is used as the denominator. The usual cause is "
          "contract policing: the office also patrols incorporated cities whose population "
          "the balance excludes. The figure is shown with this flag rather than corrected, "
          "because the contracts are not published in any federal source.",
          "officers per 1,000 below 8 for a balance-denominated sheriff"),

    Check("agency_covered_by_parent_ori", "info", "dim_agency",
          "SELECT agency_id, NULL, covered_by_legacy_ori FROM dim_agency "
          "WHERE is_covered_by_parent",
          "This agency's reports are submitted under a parent ORI. Counting it and its "
          "parent separately double-counts.", "independent reporting"),

    Check("unresolved_agency_geography", "info", "agency_crosswalk",
          "SELECT canonical_agency_id, NULL, review_status FROM agency_crosswalk "
          "WHERE target_domain='geography' AND review_status IN ('unmatched','needs_review')",
          "Agency-to-geography link is unresolved or needs human review. The agency is still "
          "shown; no per-resident rate is computed for it.", "accepted link"),

    Check("finance_imputed_value", "info", "fact_finance",
          "SELECT census_gov_id_12, survey_year, value_type FROM fact_finance "
          "WHERE item_code='E62' AND value_type <> 'reported'",
          "Police spending value was imputed or taken from an alternative source rather "
          "than reported by the government.", "reported value"),

    Check("finance_fiscal_year_misaligned", "info", "fact_finance",
          "SELECT census_gov_id_12, survey_year, fiscal_year_ending FROM fact_finance "
          "WHERE item_code='E62' AND fiscal_year_ending IS NOT NULL "
          "AND fiscal_year_ending <> '1231'",
          "The government's fiscal year does not end on 31 December, so this figure does "
          "not line up with calendar-year crime statistics.", "fiscal year ending 1231"),
]


def run_checks(con, release_id: str | None = None, max_rows_per_check: int = 20000) -> dict:
    summary: dict[str, dict] = {}
    for chk in CHECKS:
        try:
            rows = con.execute(chk.sql).fetchall()
        except Exception as e:  # noqa: BLE001
            summary[chk.check_id] = {"severity": "error", "count": -1, "error": str(e)}
            continue
        summary[chk.check_id] = {"severity": chk.severity, "count": len(rows),
                                 "table": chk.table, "message": chk.message}
        if not rows:
            continue
        payload = [
            (chk.check_id, chk.severity, chk.table,
             str(r[0]) if r[0] is not None else None,
             int(r[1]) if len(r) > 1 and r[1] is not None else None,
             chk.message, str(r[2]) if len(r) > 2 and r[2] is not None else None,
             chk.expected, release_id)
            for r in rows[:max_rows_per_check]
        ]
        con.executemany("INSERT INTO data_quality_log VALUES (?,?,?,?,?,?,?,?,?)", payload)
    return summary


def clear_log(con, keep_load_time: bool = True) -> None:
    if keep_load_time:
        con.execute(
            "DELETE FROM data_quality_log WHERE check_id NOT IN "
            "('ambiguous_ori7','duplicate_agency_year_staffing','pe_zero_filled_year')")
    else:
        con.execute("DELETE FROM data_quality_log")
