"""API contract tests.

These run in-process against the FastAPI app with a read-only warehouse connection, so they
exercise the real SQL and the real policy engine without needing a server. They assert the
contract the frontend depends on: shapes, filters, and — most of it — that the API never
emits a value the policy engine withheld.
"""
from __future__ import annotations

import pytest

from nledp.config import settings

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

pytestmark = pytest.mark.skipif(
    not settings.db_path.exists(), reason="no warehouse built; run `nledp build` first")

BALTIMORE = "MDBPD0000"
LASD = "CA0190000"
ORANGE_CA = "CA0300000"
PA_STATE_POLICE = "PAPSP0000"
AMBIGUOUS_ORI7 = "CA01999"


@pytest.fixture(scope="module")
def client():
    from nledp.api.main import app
    with TestClient(app) as c:
        yield c


def ok(client, path: str):
    r = client.get(path)
    assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text[:200]}"
    return r.json()


# ======================================================================================
# Meta and registries
# ======================================================================================


def test_release_reports_the_active_build_and_the_completeness_cutoff(client):
    d = ok(client, "/api/release")
    assert d["release_id"].startswith("release_")
    assert d["crime_completeness_cutoff"] == 2025
    assert d["latest_years"]["crime"] <= d["crime_completeness_cutoff"]


def test_metric_registry_exposes_prohibited_metrics_as_first_class(client):
    d = ok(client, "/api/metrics")
    ids = {m["metric_id"] for m in d["prohibited_metrics"]}
    assert "spending_per_agency" in ids
    assert "cost_per_sworn_officer" in ids
    for m in d["prohibited_metrics"]:
        assert m["reason"], f"{m['metric_id']} must state why it is not built"


def test_spending_metrics_are_marked_not_comparable_and_not_rankable(client):
    d = ok(client, "/api/metrics")
    spend = next(m for m in d["metrics"] if m["metric_id"] == "gov_police_current_operations")
    assert spend["comparison_allowed"] is False
    assert spend["ranking_allowed"] is False
    assert spend["attribution_level"] == "government_unit"


def test_no_crime_rate_metric_permits_ranking(client):
    d = ok(client, "/api/metrics")
    for m in d["metrics"]:
        if m["metric_id"].endswith("_rate") and "crime" in m["metric_id"]:
            assert m["ranking_allowed"] is False, m["metric_id"]


def test_sources_carry_limitations_and_a_verified_status(client):
    d = ok(client, "/api/sources")
    assert len(d["sources"]) >= 12
    for s in d["sources"]:
        assert s["source_id"] and s["publisher"]
        assert "verified_http_status" in s
    assert d["deferred_sources"], "deliberately excluded sources are part of the record"


# ======================================================================================
# Search
# ======================================================================================


def test_search_finds_an_agency_by_name(client):
    d = ok(client, "/api/search?q=Baltimore")
    ids = {r.get("agency_id") for r in d["results"] if r["type"] == "agency"}
    assert BALTIMORE in ids


def test_an_ambiguous_ori7_is_reported_not_resolved(client):
    d = ok(client, f"/api/search?q={AMBIGUOUS_ORI7}")
    amb = d["ambiguous_identifier"]
    assert amb is not None
    assert amb["match_count"] > 1
    assert len(d["agencies_sharing_identifier"]) == amb["match_count"]
    assert "will not choose one for you" in amb["message"]


def test_an_unambiguous_identifier_raises_no_ambiguity_flag(client):
    d = ok(client, f"/api/search?q={BALTIMORE}")
    assert d["ambiguous_identifier"] is None


# ======================================================================================
# Agencies
# ======================================================================================


def test_agency_list_paginates_and_reports_a_total(client):
    d = ok(client, "/api/agencies?state=MD&page_size=5&page=1")
    assert d["total"] > 5
    assert len(d["results"]) == 5
    assert d["pages"] == -(-d["total"] // 5)


@pytest.mark.parametrize("param,value,field", [
    ("state", "MD", "state_abbr"),
    ("agency_type", "county_sheriff", "agency_type"),
    ("coverage", "PARTIAL", "coverage_status"),
    ("geo_status", "unmatched", "geo_review_status"),
])
def test_every_filter_actually_filters(client, param, value, field):
    d = ok(client, f"/api/agencies?{param}={value}&page_size=25")
    assert d["results"], f"{param}={value} returned nothing"
    assert all(r[field] == value for r in d["results"])


def test_population_and_staffing_ranges_filter(client):
    d = ok(client, "/api/agencies?min_sworn=1000&page_size=25")
    assert all(r["sworn_officers"] >= 1000 for r in d["results"])


def test_agency_detail_carries_all_three_identifier_forms(client):
    d = ok(client, f"/api/agencies/{BALTIMORE}")
    a = d["agency"]
    assert a["ori9_nibrs"] == BALTIMORE
    assert a["ori7"] and len(a["ori7"]) == 7
    assert a["ori7_source"] in ("legacy_ori", "nibrs_ori_fallback")
    assert d["geography_link"]["review_status"] in ("accepted", "needs_review", "unmatched")


def test_unknown_agency_is_a_404_not_an_empty_success(client):
    assert client.get("/api/agencies/ZZ0000000").status_code == 404


def test_agency_metrics_include_full_denominator_metadata(client):
    d = ok(client, f"/api/agencies/{BALTIMORE}/metrics")
    row = next(r for r in d["series"] if r["data_year"] == 2024)
    for field in ("denominator_type", "denominator_value", "denominator_year",
                  "denominator_source", "denominator_confidence", "denominator_notes",
                  "coverage_status", "months_reported", "rate_allowed"):
        assert field in row, field
    assert row["denominator_year"] == row["data_year"], "numerator and denominator must align"


def test_every_series_row_is_internally_consistent(client):
    """The API must never emit a rate alongside rate_allowed=false."""
    for agency in (BALTIMORE, LASD, ORANGE_CA, PA_STATE_POLICE):
        d = ok(client, f"/api/agencies/{agency}/metrics")
        for r in d["series"]:
            if not r["rate_allowed"]:
                assert r["violent_crime_rate"] is None, (agency, r["data_year"])
                assert r["rate_withheld_reason"], (agency, r["data_year"])
            else:
                assert r["months_reported"] == 12
                assert r["population"] and r["population"] > 0


def test_provenance_names_a_real_source_for_every_measure(client):
    d = ok(client, f"/api/agencies/{BALTIMORE}/metrics")
    for group in ("staffing", "crime"):
        assert d["provenance"][group], group
        for p in d["provenance"][group]:
            assert p["source_id"]
            assert p["source_name"], f"{p['source_id']} is not in dim_source"


# ======================================================================================
# The regression fixtures, at the API layer
# ======================================================================================


def test_baltimore_2021_count_survives_and_rate_does_not(client):
    d = ok(client, f"/api/agencies/{BALTIMORE}/metrics")
    y = next(r for r in d["series"] if r["data_year"] == 2021)
    assert y["months_reported"] == 7
    assert y["coverage_status"] == "PARTIAL"
    assert y["violent_crime_offenses"] > 0
    assert y["violent_crime_rate"] is None
    assert y["rate_withheld_reason"] == "Insufficient annual reporting coverage"


def test_lasd_uses_the_unincorporated_balance(client):
    d = ok(client, f"/api/agencies/{LASD}/metrics")
    row = next(r for r in reversed(d["series"]) if r["denominator_value"])
    assert row["denominator_type"] == "unincorporated_population"
    assert row["denominator_value"] < row["population_geography_total"]
    assert "Contract-policing" in row["methodology_warning"]


def test_orange_county_extreme_ratio_is_published_with_a_warning(client):
    d = ok(client, f"/api/agencies/{ORANGE_CA}/metrics")
    row = next(r for r in reversed(d["series"]) if r["officers_per_1k"])
    assert row["officers_per_1k"] > 8
    assert row["denominator_confidence"] == "LIMITED"
    assert "has not been adjusted" in row["methodology_warning"]


def test_state_police_get_no_resident_rate_in_any_year(client):
    d = ok(client, f"/api/agencies/{PA_STATE_POLICE}/metrics")
    for r in d["series"]:
        assert r["denominator_type"] == "statewide_population"
        assert r["violent_crime_rate"] is None
        assert r["officers_per_1k"] is None


# ======================================================================================
# Peers and comparison
# ======================================================================================


def test_peers_expose_the_cohort_definition_and_its_size(client):
    d = ok(client, f"/api/agencies/{BALTIMORE}/peers?year=2024")
    assert d["cohort"]["definition"]
    assert d["cohort"]["size"] >= d["cohort"]["minimum_size"]
    assert d["percentile_allowed"] is True
    assert 0 <= d["percentile"] <= 100
    assert d["peer_p25"] <= d["peer_median"] <= d["peer_p75"]


def test_peers_are_drawn_only_from_agencies_with_a_publishable_rate(client):
    d = ok(client, f"/api/agencies/{BALTIMORE}/peers?year=2024")
    assert all(p["value"] is not None for p in d["peers"])


def test_an_unsupported_peer_metric_is_rejected(client):
    assert client.get(f"/api/agencies/{BALTIMORE}/peers?metric=sworn_officers").status_code == 400


def test_compare_requires_between_two_and_five_agencies(client):
    assert client.get(f"/api/compare?agencies={BALTIMORE}").status_code == 400
    assert client.get("/api/compare?agencies=A,B,C,D,E,F").status_code == 400


def test_compare_warns_across_denominator_types_without_dropping_anyone(client):
    d = ok(client, f"/api/compare?agencies={BALTIMORE},{LASD}")
    codes = {i["code"] for i in d["comparability"]}
    assert "mixed_denominators" in codes
    assert len(d["snapshot"]) == 2
    assert all(i["severity"] == "warning" for i in d["comparability"])


def test_compare_explains_a_missing_agency_rather_than_dropping_it(client):
    d = ok(client, f"/api/compare?agencies={BALTIMORE},ZZ0000000")
    assert len(d["missing"]) == 1
    m = d["missing"][0]
    assert m["agency_id"] == "ZZ0000000"
    assert m["reason"]


# ======================================================================================
# States, map, quality
# ======================================================================================


def test_state_profile_carries_composition_coverage_and_largest_agencies(client):
    d = ok(client, "/api/states/MD?year=2024")
    assert d["summary"]["agencies"] > 0
    assert d["composition"]
    assert d["largest_agencies"]
    assert d["quality"]["accepted"] + d["quality"]["needs_review"] + d["quality"]["unmatched"] \
        == d["quality"]["agencies"]


def test_unknown_state_is_a_404(client):
    assert client.get("/api/states/ZZ").status_code == 404


def test_map_never_emits_a_feature_without_a_coordinate(client):
    d = ok(client, "/api/map?layer=agency&metric=violent_crime_rate&state=MD")
    assert all(f["latitude"] is not None and f["longitude"] is not None for f in d["features"])
    assert d["agencies_without_coordinates"] >= 0


def test_map_legend_reports_how_many_features_have_no_value(client):
    d = ok(client, "/api/map?layer=county&metric=violent_crime_rate")
    L = d["legend"]
    assert L["with_value"] + L["without_value"] == len(d["features"])
    assert d["unit"]


def test_an_unmappable_metric_is_rejected(client):
    assert client.get("/api/map?metric=civilian_share").status_code == 400


def test_quality_reports_resolution_coverage_and_the_check_register(client):
    d = ok(client, "/api/quality")
    g = d["geography_totals"]
    assert g["accepted"] + g["needs_review"] + g["unmatched"] == g["agencies"]
    assert d["identifier_resolution"]["agencies"] == g["agencies"]
    assert d["ambiguous_ori7"], "the ORI7 ambiguity must be visible, not hidden"
    assert d["coverage_by_year"]
    assert d["checks"]
    assert not [c for c in d["checks"] if c["severity"] == "error"], (
        "a release with validation errors must not be served")


def test_coverage_drilldown_returns_agencies_for_a_state_year(client):
    d = ok(client, "/api/quality/coverage/2021?state=MD&status=PARTIAL")
    assert d["agencies"]
    assert all(a["coverage_status"] == "PARTIAL" for a in d["agencies"])


def test_overview_headline_states_its_universe_and_reconciles(client):
    d = ok(client, "/api/overview")
    note = d["headline"]["sworn_officers"]["note"]
    assert "state, local, tribal and territorial" in note
    rec = d["reconciliation"]
    assert rec["available"]
    residual = (rec["source_file_total"]
                - rec["excluded"]["federal_agencies"]
                - rec["excluded"]["ambiguous_identifier"]
                - rec["excluded"]["unresolved_identifier"]
                - rec["platform_total"])
    assert abs(residual) < 100, f"ledger does not close: residual {residual}"


def test_no_endpoint_leaks_a_raw_warehouse_table(client):
    """The API surface is the analytics layer plus the registries. There is no passthrough."""
    schema = ok(client, "/api/openapi.json")
    paths = set(schema["paths"])
    assert not any("/table" in p or "/sql" in p or "/query" in p for p in paths)
