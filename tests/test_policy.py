"""The analytical policy engine.

These are the rules that decide what the product is allowed to say. They are tested here as
pure functions, separately from the warehouse and the API, because every other layer defers
to them and a silent change here would change what appears on every screen.
"""
from __future__ import annotations

import pytest

from nledp.policy import (
    Confidence, CoverageStatus, DenominatorType, MIN_COHORT_SIZE,
    SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K, comparability, coverage_status,
    denominator_confidence, denominator_type_for, methodology_warning, peer_definition,
    percentile_allowed, population_band, rate_allowed, rate_withheld_reason,
    structurally_not_comparable,
)


# ======================================================================================
# Denominator classification
# ======================================================================================


@pytest.mark.parametrize("agency_type,basis,geo_level,expected", [
    ("municipal_police", "pep", "place", DenominatorType.MUNICIPAL_POPULATION),
    ("municipal_police", "acs5", "place", DenominatorType.MUNICIPAL_POPULATION),
    ("county_sheriff", "pep_county_balance", "county", DenominatorType.UNINCORPORATED_POPULATION),
    ("county_sheriff", "pep", "county", DenominatorType.COUNTY_POPULATION),
    ("county_police", "pep_county_balance", "county", DenominatorType.UNINCORPORATED_POPULATION),
    ("state_police", "pep", "state", DenominatorType.STATEWIDE_POPULATION),
    ("university_police", "pep", "place", DenominatorType.CAMPUS_POPULATION),
    ("transit_police", "pep", "place", DenominatorType.TRANSIT_POPULATION),
    ("federal", None, None, DenominatorType.NOT_APPLICABLE),
])
def test_denominator_type_classification(agency_type, basis, geo_level, expected):
    assert denominator_type_for(agency_type, basis, geo_level) is expected


def test_denominator_type_is_structural_not_year_dependent():
    """A municipal department's denominator TYPE does not change because an estimate is
    missing for an early year. Only the confidence and the withholding reason change."""
    with_value = denominator_type_for("municipal_police", "pep", "place")
    without_value = denominator_type_for("municipal_police", None, "place")
    assert with_value is without_value is DenominatorType.MUNICIPAL_POPULATION


def test_statewide_and_transient_types_are_structurally_not_comparable():
    for t in (DenominatorType.STATEWIDE_POPULATION, DenominatorType.CAMPUS_POPULATION,
              DenominatorType.TRANSIT_POPULATION, DenominatorType.NOT_APPLICABLE,
              DenominatorType.UNKNOWN):
        assert structurally_not_comparable(t)
    for t in (DenominatorType.MUNICIPAL_POPULATION, DenominatorType.COUNTY_POPULATION,
              DenominatorType.UNINCORPORATED_POPULATION):
        assert not structurally_not_comparable(t)


# ======================================================================================
# Denominator confidence
# ======================================================================================


def test_municipal_population_from_pep_on_an_accepted_link_is_high_confidence():
    assert denominator_confidence(
        DenominatorType.MUNICIPAL_POPULATION, "pep", "accepted") is Confidence.HIGH


def test_acs_fallback_is_only_moderate():
    """ACS 5-year is a 60-month period estimate standing in for a single named year."""
    assert denominator_confidence(
        DenominatorType.MUNICIPAL_POPULATION, "acs5", "accepted") is Confidence.MODERATE


def test_an_unreviewed_link_caps_confidence_at_limited():
    assert denominator_confidence(
        DenominatorType.MUNICIPAL_POPULATION, "pep", "needs_review") is Confidence.LIMITED


def test_a_missing_value_is_limited_not_not_comparable():
    """The difference matters to the reader: a coverage gap is not an incomparability."""
    c = denominator_confidence(DenominatorType.MUNICIPAL_POPULATION, None, "accepted",
                               has_value=False)
    assert c is Confidence.LIMITED


def test_sheriff_balance_is_moderate_until_it_becomes_implausible():
    ordinary = denominator_confidence(
        DenominatorType.UNINCORPORATED_POPULATION, "pep_county_balance", "accepted", 3.1)
    assert ordinary is Confidence.MODERATE
    extreme = denominator_confidence(
        DenominatorType.UNINCORPORATED_POPULATION, "pep_county_balance", "accepted",
        SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K + 0.1)
    assert extreme is Confidence.LIMITED


def test_statewide_agencies_are_never_comparable_whatever_the_inputs():
    assert denominator_confidence(
        DenominatorType.STATEWIDE_POPULATION, "pep", "accepted", 0.4) is Confidence.NOT_COMPARABLE


# ======================================================================================
# Coverage and the partial-year rule
# ======================================================================================


@pytest.mark.parametrize("months,expected", [
    (12, CoverageStatus.COMPLETE), (13, CoverageStatus.COMPLETE),
    (11, CoverageStatus.PARTIAL), (7, CoverageStatus.PARTIAL), (1, CoverageStatus.PARTIAL),
    (0, CoverageStatus.NONE), (None, CoverageStatus.UNKNOWN),
])
def test_coverage_status(months, expected):
    assert coverage_status(months) is expected


def test_a_partial_year_yields_no_rate():
    """Baltimore 2021: seven of twelve months. The count is publishable; the rate is not,
    because no source methodology supports assuming the unreported months resemble the rest."""
    assert rate_allowed(7, 576_503, Confidence.HIGH) is False
    assert rate_withheld_reason(7, 576_503, Confidence.HIGH,
                                dtype=DenominatorType.MUNICIPAL_POPULATION) == (
        "Insufficient annual reporting coverage")


def test_a_complete_year_with_a_valid_denominator_yields_a_rate():
    assert rate_allowed(12, 570_053, Confidence.HIGH) is True
    assert rate_withheld_reason(12, 570_053, Confidence.HIGH) is None


def test_a_missing_denominator_yields_no_rate_and_says_so_specifically():
    reason = rate_withheld_reason(12, None, Confidence.LIMITED,
                                  dtype=DenominatorType.MUNICIPAL_POPULATION)
    assert reason == "No population estimate for this year"
    assert reason != "Not comparable using a standard resident denominator"


def test_a_statewide_agency_gets_the_incomparability_reason_not_a_coverage_reason():
    reason = rate_withheld_reason(12, 13_000_000, Confidence.NOT_COMPARABLE,
                                  dtype=DenominatorType.STATEWIDE_POPULATION)
    assert reason == "Not comparable using a standard resident denominator"


def test_no_reporting_is_distinguished_from_partial_reporting():
    assert rate_withheld_reason(0, 100_000, Confidence.HIGH,
                                dtype=DenominatorType.MUNICIPAL_POPULATION) == "Not reported"
    assert rate_withheld_reason(None, 100_000, Confidence.HIGH,
                                dtype=DenominatorType.MUNICIPAL_POPULATION) == "Not reported"


def test_a_negative_source_value_is_never_turned_into_a_rate():
    assert rate_allowed(12, 100_000, Confidence.HIGH, offenses=-1) is False


def test_string_confidence_is_honored_as_well_as_the_enum():
    """The API round-trips these values as strings; a str/Enum mismatch would fail open."""
    assert rate_allowed(12, 100_000, "NOT_COMPARABLE") is False
    assert rate_allowed(12, 100_000, Confidence.NOT_COMPARABLE) is False


# ======================================================================================
# Methodology warnings
# ======================================================================================


def test_every_sheriff_carries_the_contract_policing_limitation():
    w = methodology_warning("county_sheriff", DenominatorType.UNINCORPORATED_POPULATION, 3.0)
    assert w and "Contract-policing" in w


def test_an_extreme_sheriff_ratio_is_flagged_and_explicitly_not_adjusted():
    w = methodology_warning("county_sheriff", DenominatorType.UNINCORPORATED_POPULATION, 15.9)
    assert w
    assert "unusually high" in w
    assert "has not been adjusted" in w


def test_a_municipal_agency_gets_no_denominator_warning():
    assert methodology_warning("municipal_police", DenominatorType.MUNICIPAL_POPULATION, 3.5) is None


# ======================================================================================
# Peer cohorts and percentiles
# ======================================================================================


@pytest.mark.parametrize("pop,band", [
    (0, "<10K"), (9_999, "<10K"), (10_000, "10K-25K"), (49_999, "25K-50K"),
    (570_053, "500K-1M"), (8_596_825, "1M+"), (None, None),
])
def test_population_bands(pop, band):
    assert population_band(pop) == band


def test_a_percentile_needs_a_real_distribution():
    assert percentile_allowed("violent_crime_rate", MIN_COHORT_SIZE, Confidence.HIGH) is True
    assert percentile_allowed("violent_crime_rate", MIN_COHORT_SIZE - 1, Confidence.HIGH) is False
    assert percentile_allowed("violent_crime_rate", None, Confidence.HIGH) is False


def test_an_incomparable_agency_gets_no_percentile():
    assert percentile_allowed("violent_crime_rate", 200, Confidence.NOT_COMPARABLE) is False


def test_the_peer_definition_is_stated_in_full():
    d = peer_definition("municipal_police", "500K-1M", "Large urban", 2024)
    assert "municipal police" in d
    assert "500K-1M" in d
    assert "large urban" in d
    assert "complete reporting in 2024" in d


# ======================================================================================
# Comparability
# ======================================================================================


def _agency(**kw):
    base = {"agency_type": "municipal_police", "denominator_type": "municipal_population",
            "denominator_confidence": "HIGH", "months_reported": 12}
    base.update(kw)
    return base


def test_like_agencies_raise_no_comparability_issues():
    assert comparability([_agency(), _agency()], "violent_crime_rate", 2024) == []


def test_mixing_a_statewide_agency_with_local_ones_warns():
    issues = comparability(
        [_agency(), _agency(agency_type="state_police",
                            denominator_type="statewide_population",
                            denominator_confidence="NOT_COMPARABLE")],
        "violent_crime_rate", 2024)
    codes = {i.code for i in issues}
    assert "statewide_vs_local" in codes
    assert "mixed_denominators" in codes
    assert "not_comparable_member" in codes


def test_mixing_denominator_types_warns_and_names_them():
    issues = comparability(
        [_agency(), _agency(agency_type="county_sheriff",
                            denominator_type="unincorporated_population")],
        "violent_crime_rate", 2024)
    msg = next(i.message for i in issues if i.code == "mixed_denominators")
    assert "municipal population" in msg
    assert "unincorporated population" in msg


def test_incomplete_coverage_in_the_set_is_flagged():
    issues = comparability([_agency(), _agency(months_reported=7)], "violent_crime_rate", 2024)
    assert "incomplete_coverage" in {i.code for i in issues}


def test_comparability_warns_and_never_blocks():
    """Every issue this engine can raise is a warning. Refusing the screen would answer a
    reasonable question with silence."""
    issues = comparability(
        [_agency(), _agency(agency_type="state_police",
                            denominator_type="statewide_population",
                            denominator_confidence="NOT_COMPARABLE", months_reported=4)],
        "violent_crime_rate", 2024)
    assert issues
    assert all(i.severity == "warning" for i in issues)


def test_a_single_agency_has_nothing_to_compare():
    assert comparability([_agency()], "violent_crime_rate", 2024) == []
