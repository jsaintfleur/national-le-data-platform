"""Invariants asserted against a built warehouse.

These are regression guards on the rules the platform promises: no rate across mismatched
years, no rate on an unaccepted link, no rate for an agency type whose served population is
transient, no missing value silently coerced to zero.
"""
from pathlib import Path

import pytest

from nledp.config import settings

pytestmark = pytest.mark.skipif(
    not settings.db_path.exists(),
    reason="no warehouse built; run `nledp build` first",
)


@pytest.fixture(scope="module")
def con():
    from nledp.warehouse import connect
    c = connect(read_only=True)
    yield c
    c.close()


def _scalar(con, sql):
    return con.execute(sql).fetchone()[0]


def test_agency_ids_are_unique(con):
    assert _scalar(con, "SELECT count(*) - count(DISTINCT agency_id) FROM dim_agency") == 0


def test_every_geoid_has_the_right_width(con):
    assert _scalar(con, """
        SELECT count(*) FROM dim_geography WHERE
          (geo_level='state'  AND length(geoid) <> 2) OR
          (geo_level='county' AND length(geoid) <> 5) OR
          (geo_level='place'  AND length(geoid) <> 7) OR
          (geo_level='cousub' AND length(geoid) <> 10)
    """) == 0


def test_connecticut_uses_planning_regions(con):
    assert _scalar(con, """
        SELECT count(*) FROM dim_geography WHERE geo_level='county'
        AND geoid IN ('09001','09003','09005','09007','09009','09011','09013','09015')
    """) == 0
    assert _scalar(con, """
        SELECT count(*) FROM dim_geography WHERE geo_level='county' AND geoid LIKE '091%'
    """) == 9


def test_ori7_is_derived_from_legacy_ori(con):
    """Where a legacy ORI exists, ori7 must be its first seven characters -- never the
    NIBRS ORI's, which differ for a minority of agencies."""
    assert _scalar(con, """
        SELECT count(*) FROM dim_agency
        WHERE ori9_legacy IS NOT NULL AND ori7 <> substr(ori9_legacy, 1, 7)
    """) == 0
    # And the two forms genuinely do differ for some agencies, so the rule is load-bearing.
    assert _scalar(con, """
        SELECT count(*) FROM dim_agency
        WHERE ori9_legacy IS NOT NULL AND substr(ori9_nibrs,1,7) <> ori7
    """) > 0


def test_no_rate_is_published_across_observation_years(con):
    assert _scalar(con, """
        SELECT count(*) FROM analytics_agency_year ay
        WHERE ay.violent_crime_rate IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM fact_demographics d
            WHERE replace(d.geo_id,'#balance','') = ay.geo_id AND d.data_year = ay.data_year)
    """) == 0


def test_no_rate_on_an_unaccepted_geography_link(con):
    assert _scalar(con, """
        SELECT count(*) FROM analytics_agency_year
        WHERE violent_crime_rate IS NOT NULL AND geo_review_status <> 'accepted'
    """) == 0


def test_no_resident_rate_for_transient_population_agencies(con):
    assert _scalar(con, """
        SELECT count(*) FROM analytics_agency_year
        WHERE violent_crime_rate IS NOT NULL AND NOT rate_denominator_eligible
    """) == 0


def test_partial_years_do_not_produce_rates(con):
    assert _scalar(con, """
        SELECT count(*) FROM analytics_agency_year
        WHERE violent_crime_rate IS NOT NULL AND violent_months_reported <> 12
    """) == 0


def test_crime_stops_at_the_completeness_cutoff(con):
    from nledp.config import VINTAGES
    assert _scalar(con, "SELECT max(data_year) FROM fact_crime") \
        <= VINTAGES["crime_last_complete_year"]


def test_no_staffing_year_is_zero_filled(con):
    """pe-2025.zip is published and entirely zero-filled. If a year's sworn total is zero
    the loader accepted a file it should have rejected."""
    zeros = con.execute("""
        SELECT data_year FROM fact_staffing GROUP BY 1 HAVING sum(sworn_officers) = 0
    """).fetchall()
    assert zeros == []


def test_sheriffs_use_the_unincorporated_balance(con):
    assert _scalar(con, """
        SELECT count(*) FROM analytics_agency_year
        WHERE data_year = 2024 AND agency_type = 'county_sheriff'
          AND denominator_basis = 'pep_county_balance'
    """) > 1000


def test_finance_is_never_attributed_to_an_agency(con):
    assert _scalar(con, """
        SELECT count(*) FROM fact_finance WHERE attribution_level <> 'government_unit'
    """) == 0


def test_metric_registry_marks_spending_as_non_rankable(con):
    row = con.execute("""
        SELECT comparison_allowed, ranking_allowed FROM dim_metric
        WHERE metric_id = 'gov_police_current_operations'
    """).fetchone()
    assert row == (False, False)


def test_every_fact_row_names_its_source(con):
    for table in ("fact_crime", "fact_staffing", "fact_demographics",
                  "fact_finance", "fact_reporting"):
        assert _scalar(con, f"SELECT count(*) FROM {table} WHERE source_id IS NULL") == 0


def test_every_source_id_used_by_a_fact_exists_in_dim_source(con):
    missing = con.execute("""
        SELECT DISTINCT f.source_id FROM (
            SELECT source_id FROM fact_crime UNION
            SELECT source_id FROM fact_staffing UNION
            SELECT source_id FROM fact_demographics UNION
            SELECT source_id FROM fact_finance UNION
            SELECT source_id FROM fact_reporting) f
        LEFT JOIN dim_source s ON s.source_id = f.source_id
        WHERE s.source_id IS NULL
    """).fetchall()
    assert missing == []
