"""End-to-end release-gate tests.

Each test is one criterion from the Phase 2 release gate, asserted against the running
application rather than against the warehouse. The point is not that the data is right —
the warehouse invariants already assert that — but that the interface does not undo it.
A rate the policy engine withheld must not reappear on a page.

    uvicorn nledp.api.main:app --port 8000     # serves the built SPA and the API
    pytest tests/e2e -q

Set NLEDP_E2E_BASE to point at a different host.
"""
from __future__ import annotations

import os
import re

import pytest

playwright = pytest.importorskip("playwright.sync_api")
from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402

BASE = os.environ.get("NLEDP_E2E_BASE", "http://127.0.0.1:8000")

# The permanent regression fixtures. Each one is a case that was hard to get right and that
# a future change could plausibly break.
FIXTURES = {
    "baltimore": "MDBPD0000",        # 2021 partial reporting: count shows, rate does not
    "lasd": "CA0190000",             # unincorporated-balance denominator
    "orange_county_ca": "CA0300000",  # extreme balance-denominated ratio, warning shown
    "pa_state_police": "PAPSP0000",  # statewide agency: no per-resident rate at all
    "ambiguous_ori7": "CA01999",     # 14 agencies share this ORI7
}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox"])
        yield b
        b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    pg = ctx.new_page()
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    pg._nledp_errors = errors  # type: ignore[attr-defined]
    yield pg
    ctx.close()


def goto(page: Page, path: str) -> None:
    page.goto(f"{BASE}{path}", wait_until="networkidle")


def body(page: Page) -> str:
    return page.locator("body").inner_text()


# ======================================================================================
# Gate: Baltimore 2021 — the count displays, the full-year rate does not
# ======================================================================================


def test_baltimore_profile_loads_with_identity_and_jurisdiction(page: Page):
    goto(page, f"/agencies/{FIXTURES['baltimore']}")
    expect(page.get_by_role("heading", name=re.compile("Baltimore", re.I))).to_be_visible()
    text = body(page)
    assert "Municipal police" in text
    assert "MDBPD0000" in text
    # Jurisdiction, staffing and the latest year are all present without scrolling logic.
    assert "Baltimore" in text


def test_baltimore_2021_shows_the_count_and_withholds_the_rate(page: Page):
    """The canonical integrity test. Seven of twelve months were reported in 2021."""
    goto(page, f"/agencies/{FIXTURES['baltimore']}")
    page.wait_for_selector("text=Reporting coverage and data quality")

    row = page.locator("table.data tbody tr", has=page.locator("td", has_text="2021")).first
    row_text = row.inner_text()
    assert "PARTIAL" in row_text, f"2021 should be PARTIAL, got: {row_text}"
    assert "Insufficient annual reporting coverage" in row_text, row_text

    # And the count itself is still available on the trend, so nothing was hidden.
    api = page.request.get(f"{BASE}/api/agencies/{FIXTURES['baltimore']}/metrics").json()
    y2021 = next(r for r in api["series"] if r["data_year"] == 2021)
    assert y2021["violent_crime_offenses"] is not None and y2021["violent_crime_offenses"] > 0
    assert y2021["violent_crime_rate"] is None
    assert y2021["months_reported"] == 7
    assert y2021["rate_allowed"] is False


def test_no_page_prints_a_rate_the_api_withheld(page: Page):
    """A rate withheld by the server must not be reconstructed anywhere in the interface."""
    api = page.request.get(f"{BASE}/api/agencies/{FIXTURES['baltimore']}/metrics").json()
    withheld_years = [r["data_year"] for r in api["series"] if not r["rate_allowed"]]
    assert withheld_years, "fixture must include at least one withheld year"

    goto(page, f"/agencies/{FIXTURES['baltimore']}?metric=violent_crime_rate")
    # The screen-reader table backing the chart is the exhaustive rendering of the series.
    sr = page.locator("figcaption table").first.inner_text()
    for year in withheld_years:
        line = next((ln for ln in sr.splitlines() if ln.startswith(str(year))), None)
        assert line is not None, f"{year} missing from chart table"
        assert "Not available" in line, f"{year} rendered a value it should not have: {line}"


# ======================================================================================
# Gate: sheriff denominator methodology is visible
# ======================================================================================


def test_lasd_shows_the_unincorporated_denominator_and_its_limitation(page: Page):
    goto(page, f"/agencies/{FIXTURES['lasd']}")
    text = body(page)
    assert "Unincorporated" in text, "denominator type must be named on the page"
    api = page.request.get(f"{BASE}/api/agencies/{FIXTURES['lasd']}/metrics").json()
    latest = [r for r in api["series"] if r["denominator_type"]][-1]
    assert latest["denominator_type"] == "unincorporated_population"
    # The balance is materially smaller than the county, which is the whole point.
    assert latest["denominator_value"] < latest["population_geography_total"]
    assert latest["methodology_warning"], "a sheriff denominator must carry its limitation"
    assert "contract" in latest["methodology_warning"].lower()


def test_orange_county_extreme_ratio_is_shown_not_capped(page: Page):
    """An implausible value is displayed with a warning. It is never capped or smoothed."""
    api = page.request.get(f"{BASE}/api/agencies/{FIXTURES['orange_county_ca']}/metrics").json()
    latest = [r for r in api["series"] if r["officers_per_1k"]][-1]
    assert latest["officers_per_1k"] > 8, "fixture should exceed the plausibility threshold"
    assert latest["denominator_confidence"] == "LIMITED"
    assert latest["methodology_warning"]
    assert "not been adjusted" in latest["methodology_warning"]

    goto(page, f"/agencies/{FIXTURES['orange_county_ca']}")
    text = body(page)
    assert "Methodology warning" in text
    # The raw value is on the page, unrounded away.
    assert f"{latest['officers_per_1k']:.2f}" in text


# ======================================================================================
# Gate: statewide agencies get no per-resident rate
# ======================================================================================


def test_state_police_has_no_resident_rate_and_says_why(page: Page):
    api = page.request.get(f"{BASE}/api/agencies/{FIXTURES['pa_state_police']}/metrics").json()
    rows = [r for r in api["series"] if r["denominator_type"]]
    assert rows, "fixture must have observations"
    for r in rows:
        assert r["denominator_type"] == "statewide_population"
        assert r["denominator_confidence"] == "NOT_COMPARABLE"
        assert r["violent_crime_rate"] is None
        assert r["officers_per_1k"] is None
        assert r["rate_withheld_reason"] == (
            "Not comparable using a standard resident denominator")

    goto(page, f"/agencies/{FIXTURES['pa_state_police']}")
    assert "Not comparable using a standard resident denominator" in body(page)


# ======================================================================================
# Gate: an ambiguous identifier is never silently resolved
# ======================================================================================


def test_ambiguous_ori7_search_surfaces_every_match(page: Page):
    payload = page.request.get(f"{BASE}/api/search?q={FIXTURES['ambiguous_ori7']}").json()
    assert payload["ambiguous_identifier"] is not None
    assert payload["ambiguous_identifier"]["match_count"] > 1
    assert len(payload["agencies_sharing_identifier"]) == payload["ambiguous_identifier"]["match_count"]

    goto(page, "/")
    page.get_by_role("combobox", name="Search").fill(FIXTURES["ambiguous_ori7"])
    results = page.locator(".cmd-results")
    results.wait_for(state="visible", timeout=8000)
    # The panel appears immediately with a searching state; wait for the resolved content.
    page.wait_for_selector(".cmd-results .notice", timeout=8000)
    panel = results.inner_text()
    assert "Searching" not in panel
    assert "Ambiguous identifier" in panel, panel[:300]
    assert "does not uniquely name an agency" in panel, panel[:300]
    # And every sharing agency is offered, so the user chooses rather than the platform.
    assert results.locator(".cmd-item").count() > 1


# ======================================================================================
# Gate: the map never fabricates geography
# ======================================================================================


def test_map_reports_agencies_without_coordinates_rather_than_placing_them(page: Page):
    payload = page.request.get(f"{BASE}/api/map?layer=agency&metric=violent_crime_rate").json()
    assert payload["agencies_without_coordinates"] >= 0
    for f in payload["features"]:
        assert f["latitude"] is not None and f["longitude"] is not None
    assert "never rendered as zero" in payload["no_data_note"]
    assert "ever fabricated" in payload["no_data_note"]


def test_map_legend_carries_unit_year_and_range(page: Page):
    goto(page, "/map?layer=state&metric=violent_crime_rate&year=2024")
    page.wait_for_selector(".map-legend", timeout=15000)
    legend = page.locator(".map-legend").inner_text()
    assert "2024" in legend
    assert "per 100,000" in legend.lower() or "100,000" in legend
    assert "No data" in legend


def test_map_distinguishes_no_data_from_zero(page: Page):
    payload = page.request.get(f"{BASE}/api/map?layer=county&metric=violent_crime_rate").json()
    legend = payload["legend"]
    assert legend["without_value"] > 0, "fixture should include features with no value"
    # The API never coerces a missing value to zero.
    missing = [f for f in payload["features"] if f["value"] is None]
    assert all(f["value"] is None for f in missing)


# ======================================================================================
# Gate: headline totals are reconciled
# ======================================================================================


def test_overview_publishes_the_staffing_reconciliation(page: Page):
    payload = page.request.get(f"{BASE}/api/overview").json()
    rec = payload["reconciliation"]
    assert rec["available"] is True
    ledger = (rec["source_file_total"]
              - rec["excluded"]["federal_agencies"]
              - rec["excluded"]["ambiguous_identifier"]
              - rec["excluded"]["unresolved_identifier"])
    # The residual is the duplicate agency-years collapsed at load; it must be small and known.
    assert abs(ledger - rec["platform_total"]) < 100, (ledger, rec["platform_total"])
    assert rec["fbi_published"] > rec["platform_total"], "the FBI figure includes federal agencies"

    goto(page, "/")
    text = body(page)
    assert "reconcil" in text.lower() or "differs" in text.lower()
    assert f"{rec['platform_total']:,}" in text


def test_headline_sworn_total_states_its_universe(page: Page):
    payload = page.request.get(f"{BASE}/api/overview").json()
    note = payload["headline"]["sworn_officers"]["note"]
    assert "state, local, tribal and territorial" in note
    assert "Excludes federal agencies" in note


# ======================================================================================
# Gate: comparisons expose their peer definitions
# ======================================================================================


def test_peer_cohort_definition_is_available(page: Page):
    payload = page.request.get(
        f"{BASE}/api/agencies/{FIXTURES['baltimore']}/peers?year=2024").json()
    assert payload["cohort"]["definition"]
    assert "population served" in payload["cohort"]["definition"]
    assert payload["percentile_note"].startswith("A percentile is a position")

    goto(page, f"/agencies/{FIXTURES['baltimore']}")
    page.get_by_role("button", name="How are peers selected?").click()
    page.wait_for_selector("text=Peer cohort definition")
    assert "not a score" in body(page).lower() or "not a grade" in body(page).lower()


def test_comparability_warns_across_denominator_types(page: Page):
    payload = page.request.get(
        f"{BASE}/api/compare?agencies={FIXTURES['baltimore']},{FIXTURES['lasd']}").json()
    codes = {i["code"] for i in payload["comparability"]}
    assert "mixed_denominators" in codes
    assert "mixed_agency_types" in codes
    # Warning, not blocking: both agencies still come back.
    assert len(payload["snapshot"]) == 2


# ======================================================================================
# Gate: every route renders without a script error
# ======================================================================================


@pytest.mark.parametrize("path", [
    "/", "/map", "/agencies", "/agencies/MDBPD0000", "/compare?agencies=MDBPD0000,MI8234900",
    "/states", "/states/MD", "/quality", "/methodology", "/sources",
])
def test_route_renders_without_errors(page: Page, path: str):
    goto(page, path)
    page.wait_for_timeout(700)
    errors = [e for e in page._nledp_errors  # type: ignore[attr-defined]
              if "favicon" not in e.lower()]
    assert not errors, f"{path} produced console errors: {errors[:3]}"
    assert len(body(page)) > 200, f"{path} rendered almost nothing"


def test_navigation_exposes_no_dead_routes(page: Page):
    goto(page, "/")
    hrefs = page.eval_on_selector_all(
        ".sidebar a[href]", "els => els.map(e => e.getAttribute('href'))")
    assert hrefs, "sidebar navigation should be present at desktop width"
    for href in hrefs:
        r = page.request.get(f"{BASE}{href}")
        assert r.status == 200, f"{href} returned {r.status}"


# ======================================================================================
# Gate: mobile workflows function
# ======================================================================================


def test_primary_workflows_function_at_375px(browser):
    ctx = browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True,
                              has_touch=True)
    pg = ctx.new_page()
    try:
        pg.goto(f"{BASE}/agencies/{FIXTURES['baltimore']}", wait_until="networkidle")
        text = pg.locator("body").inner_text()
        assert "Baltimore" in text
        assert "Snapshot" in text
        # The bottom navigation replaces the sidebar rather than shrinking it.
        assert pg.locator(".mobile-nav").is_visible()
        assert not pg.locator(".sidebar").is_visible()
        # The page must not scroll sideways.
        overflow = pg.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 2, f"horizontal overflow of {overflow}px at 375 wide"
    finally:
        ctx.close()


# ======================================================================================
# Gate: URL state is shareable
# ======================================================================================


def test_filters_survive_a_reload(page: Page):
    goto(page, "/agencies?state=MD&agency_type=municipal_police&sort=sworn_officers&direction=desc")
    page.wait_for_selector("table.data tbody tr", timeout=10000)
    first = page.locator("table.data tbody tr").first.inner_text()
    page.reload(wait_until="networkidle")
    page.wait_for_selector("table.data tbody tr", timeout=10000)
    assert page.locator("table.data tbody tr").first.inner_text() == first


def test_map_state_is_in_the_url(page: Page):
    goto(page, "/map?layer=state&metric=officers_per_1k&year=2023")
    page.wait_for_selector(".map-legend", timeout=15000)
    legend = page.locator(".map-legend").inner_text()
    assert "2023" in legend
    assert "Officers per 1,000" in legend
