"""The analytical API.

The frontend consumes these endpoints and never the warehouse. Two consequences are
deliberate: the policy engine runs server-side, so a rate the platform withholds cannot be
reconstructed by a chart component; and the response shape carries the four trust markers —
source, year, coverage, methodology — on every value that has them, so an interface cannot
render a number without the context that makes it readable.

    uvicorn nledp.api.main:app --port 8000
"""
from __future__ import annotations

import atexit
import math
from contextlib import asynccontextmanager
from typing import Any, Literal

import yaml
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..config import VINTAGES, settings
from ..policy import (
    Confidence, DENOMINATOR_NOTES, DenominatorType, MIN_COHORT_SIZE,
    SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K, comparability, peer_definition,
    percentile_allowed,
)
from . import db


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    db.close_all()


app = FastAPI(
    title="National Law Enforcement Data & Intelligence Platform",
    description="Analytical API over the validated warehouse. Read-only.",
    version="0.2.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
atexit.register(db.close_all)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"],
)

CRIME_YEAR = VINTAGES["crime_last_complete_year"]


def clean(value: Any) -> Any:
    """NaN and infinity are not JSON. They arrive from DuckDB division and must become null,
    never 0 — a zero here would be a fabricated measurement."""
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def scrub(record: dict) -> dict:
    return {k: clean(v) for k, v in record.items()}


# ======================================================================================
# Meta
# ======================================================================================


@app.get("/api/release")
def release() -> dict:
    rel = db.active_release()
    years = db.latest_years()
    return {
        "release_id": rel["release_id"],
        "built_at": rel["built_at"],
        "git_commit": rel["git_commit"],
        "latest_years": years,
        "crime_completeness_cutoff": CRIME_YEAR,
        "vintages": VINTAGES,
    }


@app.get("/api/metrics")
def metrics() -> dict:
    """The metric registry, including the metrics the platform refuses to build."""
    spec = yaml.safe_load((settings.registry / "metrics.yaml").read_text())
    return {
        "denominator_policy": spec["denominator_policy"],
        "metrics": spec["metrics"],
        "prohibited_metrics": spec["prohibited_metrics"],
        "denominator_types": {d.value: DENOMINATOR_NOTES.get(d) for d in DenominatorType},
        "confidence_levels": [c.value for c in Confidence],
        "thresholds": {
            "sheriff_plausibility_officers_per_1k": SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K,
            "minimum_cohort_size": MIN_COHORT_SIZE,
            "months_required_for_rate": 12,
        },
    }


@app.get("/api/sources")
def sources() -> dict:
    spec = yaml.safe_load((settings.registry / "sources.yaml").read_text())
    counts = {r["source_id"]: r["observations"]
              for r in db.rows("SELECT source_id, observations FROM analytics_source_usage")}
    for s in spec["sources"]:
        s["observations_in_warehouse"] = counts.get(s["source_id"], 0)
    return {
        "audited_on": spec["audited_on"],
        "sources": spec["sources"],
        "deferred_sources": spec["deferred_sources"],
    }


# ======================================================================================
# Search
# ======================================================================================


@app.get("/api/search")
def search(q: str = Query(..., min_length=1), limit: int = Query(12, le=50)) -> dict:
    """Typed results. An ambiguous identifier is reported as ambiguous, never resolved."""
    term = q.strip()
    upper = term.upper()
    like = f"%{term.lower()}%"
    results: list[dict] = []

    # An ORI7 shared by several agencies must surface all of them with a warning.
    ori7_hits = db.rows("""
        SELECT agency_id, agency_name, agency_type, state_abbr, ori7
        FROM dim_agency WHERE ori7 = ? ORDER BY agency_id
    """, [upper])
    ambiguous_identifier = None
    if len(ori7_hits) > 1:
        ambiguous_identifier = {
            "identifier": upper,
            "kind": "ORI7",
            "match_count": len(ori7_hits),
            "message": (
                f"{len(ori7_hits)} agencies share the ORI7 {upper}. This identifier does not "
                "uniquely name an agency, so the platform will not choose one for you."
            ),
        }

    for r in db.rows("""
        SELECT agency_id, agency_name, agency_type, state_abbr, county_name,
               ori9_nibrs, ori7
        FROM dim_agency
        WHERE lower(agency_name) LIKE ? OR agency_id = ? OR ori7 = ?
           OR lower(coalesce(ucr_agency_name,'')) LIKE ?
        ORDER BY CASE WHEN agency_id = ? THEN 0
                      WHEN lower(agency_name) = lower(?) THEN 1
                      ELSE 2 END,
                 length(agency_name)
        LIMIT ?
    """, [like, upper, upper, like, upper, term, limit]):
        results.append({"type": "agency", **r})

    for r in db.rows("""
        SELECT DISTINCT state_abbr AS code, state_abbr AS name
        FROM dim_agency WHERE state_abbr IS NOT NULL AND upper(state_abbr) = ?
    """, [upper]):
        results.append({"type": "state", **r})

    for r in db.rows("""
        SELECT geo_id, geoid, name, state_abbr, geo_level
        FROM dim_geography
        WHERE geo_level IN ('county','place') AND lower(name) LIKE ?
        ORDER BY CASE geo_level WHEN 'county' THEN 0 ELSE 1 END, length(name) LIMIT 5
    """, [like]):
        results.append({"type": r.pop("geo_level"), **r})

    return {"query": term, "results": results[:limit],
            "ambiguous_identifier": ambiguous_identifier,
            "agencies_sharing_identifier": ori7_hits if ambiguous_identifier else []}


# ======================================================================================
# Agencies
# ======================================================================================

SORTABLE = {
    "agency_name": "y.agency_name", "state_abbr": "y.state_abbr",
    "population": "y.population", "sworn_officers": "y.sworn_officers",
    "officers_per_1k": "y.officers_per_1k", "violent_crime_rate": "y.violent_crime_rate",
    "months_reported": "y.months_reported",
}


@app.get("/api/agencies")
def agencies(
    q: str | None = None,
    state: str | None = None,
    agency_type: str | None = None,
    year: int = CRIME_YEAR,
    min_population: int | None = None,
    max_population: int | None = None,
    min_sworn: int | None = None,
    max_sworn: int | None = None,
    coverage: Literal["COMPLETE", "PARTIAL", "NONE", "UNKNOWN"] | None = None,
    geo_status: Literal["accepted", "needs_review", "unmatched"] | None = None,
    sort: str = "sworn_officers",
    direction: Literal["asc", "desc"] = "desc",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> dict:
    where = ["y.data_year = ?"]
    params: list = [year]
    if q:
        where.append("(lower(y.agency_name) LIKE ? OR y.agency_id = ?)")
        params += [f"%{q.lower()}%", q.upper()]
    if state:
        where.append("y.state_abbr = ?"); params.append(state.upper())
    if agency_type:
        where.append("y.agency_type = ?"); params.append(agency_type)
    if min_population is not None:
        where.append("y.population >= ?"); params.append(min_population)
    if max_population is not None:
        where.append("y.population <= ?"); params.append(max_population)
    if min_sworn is not None:
        where.append("y.sworn_officers >= ?"); params.append(min_sworn)
    if max_sworn is not None:
        where.append("y.sworn_officers <= ?"); params.append(max_sworn)
    if coverage:
        where.append("y.coverage_status = ?"); params.append(coverage)
    if geo_status:
        where.append("y.geo_review_status = ?"); params.append(geo_status)

    clause = " AND ".join(where)
    total = db.scalar(f"SELECT count(*) FROM analytics_agency_year y WHERE {clause}", params)
    order = SORTABLE.get(sort, "y.sworn_officers")
    offset = (page - 1) * page_size

    data = db.rows(f"""
        SELECT y.agency_id, y.agency_name, y.agency_type, y.state_abbr, y.geo_name,
               y.geo_level, y.geo_review_status, y.data_year, y.population,
               y.denominator_type, y.denominator_confidence, y.sworn_officers,
               y.civilian_personnel, y.officers_per_1k, y.violent_crime_offenses,
               y.violent_crime_rate, y.property_crime_rate, y.months_reported,
               y.coverage_status, y.rate_allowed, y.rate_withheld_reason,
               y.methodology_warning, y.population_band, y.urbanicity_band
        FROM analytics_agency_year y
        WHERE {clause}
        ORDER BY {order} {direction.upper()} NULLS LAST, y.agency_name
        LIMIT ? OFFSET ?
    """, params + [page_size, offset])

    return {
        "year": year, "total": total, "page": page, "page_size": page_size,
        "pages": max(1, -(-total // page_size)),
        "results": [scrub(r) for r in data],
    }


@app.get("/api/agencies/facets")
def agency_facets(year: int = CRIME_YEAR) -> dict:
    return {
        "agency_types": db.rows("""
            SELECT agency_type, count(*) AS n FROM analytics_agency_year
            WHERE data_year = ? GROUP BY 1 ORDER BY 2 DESC
        """, [year]),
        "states": db.rows("""
            SELECT state_abbr, count(*) AS n FROM analytics_agency_year
            WHERE data_year = ? AND state_abbr IS NOT NULL GROUP BY 1 ORDER BY 1
        """, [year]),
        "coverage": db.rows("""
            SELECT coverage_status, count(*) AS n FROM analytics_agency_year
            WHERE data_year = ? GROUP BY 1 ORDER BY 2 DESC
        """, [year]),
        "geo_status": db.rows("""
            SELECT geo_review_status, count(*) AS n FROM analytics_agency_year
            WHERE data_year = ? GROUP BY 1 ORDER BY 2 DESC
        """, [year]),
        "population_bands": db.rows("""
            SELECT population_band, count(*) AS n FROM analytics_agency_year
            WHERE data_year = ? AND population_band IS NOT NULL GROUP BY 1 ORDER BY 2 DESC
        """, [year]),
    }


@app.get("/api/agencies/{agency_id}")
def agency(agency_id: str) -> dict:
    a = db.one("""
        SELECT a.agency_id, a.agency_name, a.agency_type, a.agency_type_source,
               a.agency_status, a.is_dormant, a.dormant_year, a.is_covered_by_parent,
               a.covered_by_legacy_ori, a.ori9_nibrs, a.ori9_legacy, a.ori7, a.ori7_source,
               a.county_name, a.msa_name, a.state_abbr, a.latitude, a.longitude,
               a.jurisdiction_type, a.population_group_desc, a.nibrs_start_date,
               a.rate_denominator_eligible, a.source_id
        FROM dim_agency a WHERE a.agency_id = ?
    """, [agency_id.upper()])
    if not a:
        raise HTTPException(404, f"No agency with id {agency_id}")

    link = db.one("""
        SELECT target_id AS geo_id, target_name AS geo_name, match_method, match_score,
               review_status, notes
        FROM agency_crosswalk
        WHERE canonical_agency_id = ? AND target_domain='geography' AND source='nledp-resolution'
    """, [agency_id.upper()])

    latest = db.one("""
        SELECT * FROM analytics_agency_year
        WHERE agency_id = ? AND (sworn_officers IS NOT NULL OR violent_crime_offenses IS NOT NULL)
        ORDER BY data_year DESC LIMIT 1
    """, [agency_id.upper()])

    history = db.rows("""
        SELECT effective_year, change_type, old_value, new_value, notes
        FROM agency_history WHERE agency_id = ? ORDER BY effective_year
    """, [agency_id.upper()])

    return {
        "agency": scrub(a),
        "geography_link": link,
        "latest": scrub(latest) if latest else None,
        "history": history,
        "release": db.active_release(),
    }


@app.get("/api/agencies/{agency_id}/metrics")
def agency_metrics(agency_id: str) -> dict:
    series = db.rows("""
        SELECT data_year, population, denominator_type, denominator_value, denominator_year,
               denominator_source, denominator_confidence, denominator_notes,
               population_geography_total, sworn_officers, civilian_personnel,
               total_personnel, civilian_share, officers_per_1k,
               violent_crime_offenses, violent_crime_clearances, violent_crime_rate,
               property_crime_offenses, property_crime_rate,
               months_reported, coverage_status, rate_allowed, rate_withheld_reason,
               methodology_warning, implausible_rate_flag, participated, pe_reported
        FROM analytics_agency_year WHERE agency_id = ? ORDER BY data_year
    """, [agency_id.upper()])
    if not series:
        raise HTTPException(404, f"No observations for {agency_id}")
    return {
        "agency_id": agency_id.upper(),
        "series": [scrub(r) for r in series],
        "provenance": {
            "staffing": _provenance(agency_id, "staffing"),
            "crime": _provenance(agency_id, "crime"),
        },
    }


def _provenance(agency_id: str, measure: str) -> list[dict]:
    """Which sources produced this agency's numbers, and over which years.

    Reads the compacted provenance table rather than scanning the fact tables, so the
    serving database does not need to carry them.
    """
    return db.rows("""
        SELECT p.measure, p.source_id, p.first_year, p.last_year, p.observations,
               s.source_name, s.dataset_name, s.source_url, s.latest_release_date,
               s.update_frequency, s.license
        FROM analytics_provenance p
        LEFT JOIN dim_source s ON s.source_id = p.source_id
        WHERE p.agency_id = ? AND p.measure = ?
        ORDER BY p.last_year, p.source_id
    """, [agency_id.upper(), measure])


@app.get("/api/agencies/{agency_id}/coverage")
def agency_coverage(agency_id: str) -> dict:
    rows = db.rows("""
        SELECT y.data_year, y.months_reported, y.coverage_status, y.rate_allowed,
               y.rate_withheld_reason, y.participated, y.nibrs_participated, y.pe_reported,
               y.violent_crime_offenses, y.sworn_officers
        FROM analytics_agency_year y WHERE y.agency_id = ? ORDER BY y.data_year
    """, [agency_id.upper()])
    flags = db.rows("""
        SELECT check_id, severity, data_year, message, observed, expected
        FROM data_quality_log WHERE entity_id = ? ORDER BY severity, check_id
    """, [agency_id.upper()])
    return {"agency_id": agency_id.upper(), "years": [scrub(r) for r in rows],
            "quality_flags": flags}


@app.get("/api/agencies/{agency_id}/peers")
def agency_peers(agency_id: str, year: int = CRIME_YEAR,
                 metric: str = "violent_crime_rate") -> dict:
    if metric not in ("violent_crime_rate", "officers_per_1k", "property_crime_rate"):
        raise HTTPException(400, f"metric {metric} is not available for peer comparison")

    subject = db.one("""
        SELECT agency_id, agency_name, agency_type, state_abbr, population, population_band,
               urbanicity_band, denominator_confidence, months_reported, coverage_status,
               violent_crime_rate, officers_per_1k, property_crime_rate, rate_allowed
        FROM analytics_agency_year WHERE agency_id = ? AND data_year = ?
    """, [agency_id.upper(), year])
    if not subject:
        raise HTTPException(404, f"No {year} observation for {agency_id}")

    definition = peer_definition(subject["agency_type"], subject["population_band"],
                                subject["urbanicity_band"], year)

    peers = db.rows(f"""
        SELECT agency_id, agency_name, state_abbr, population, {metric} AS value
        FROM analytics_agency_year
        WHERE data_year = ? AND agency_type = ? AND population_band = ?
          AND coalesce(urbanicity_band,'') = coalesce(?, '')
          AND rate_allowed AND {metric} IS NOT NULL
    """, [year, subject["agency_type"], subject["population_band"],
          subject["urbanicity_band"]])

    values = sorted(p["value"] for p in peers)
    n = len(values)
    subject_value = subject.get(metric)
    allowed = percentile_allowed(metric, n, subject["denominator_confidence"])

    def quantile(p: float) -> float | None:
        if not values:
            return None
        k = (n - 1) * p
        lo, hi = int(math.floor(k)), int(math.ceil(k))
        return values[lo] if lo == hi else values[lo] + (values[hi] - values[lo]) * (k - lo)

    percentile = None
    if allowed and subject_value is not None and n:
        below = sum(1 for v in values if v < subject_value)
        percentile = round(below / n * 100, 1)

    national = db.one(f"""
        SELECT median({metric}) AS med FROM analytics_agency_year
        WHERE data_year = ? AND rate_allowed AND {metric} IS NOT NULL
    """, [year])
    state_med = db.one(f"""
        SELECT median({metric}) AS med FROM analytics_agency_year
        WHERE data_year = ? AND state_abbr = ? AND rate_allowed AND {metric} IS NOT NULL
    """, [year, subject["state_abbr"]])

    return {
        "agency_id": agency_id.upper(), "year": year, "metric": metric,
        "subject": scrub(subject),
        "cohort": {
            "definition": definition,
            "agency_type": subject["agency_type"],
            "population_band": subject["population_band"],
            "urbanicity_band": subject["urbanicity_band"],
            "size": n,
            "minimum_size": MIN_COHORT_SIZE,
            "sufficient": n >= MIN_COHORT_SIZE,
        },
        "percentile": percentile,
        "percentile_allowed": allowed,
        "percentile_note": (
            "A percentile is a position in a distribution, not a grade. It says where this "
            "agency sits among its peers, not whether that position is good."
        ),
        "peer_median": clean(quantile(0.5)),
        "peer_p25": clean(quantile(0.25)),
        "peer_p75": clean(quantile(0.75)),
        "state_median": clean(state_med["med"]) if state_med else None,
        "national_median": clean(national["med"]) if national else None,
        "peers": sorted(
            [scrub(p) for p in peers],
            key=lambda p: (p["value"] is None, p["value"]),
        ),
    }


# ======================================================================================
# Compare
# ======================================================================================


@app.get("/api/compare")
def compare(agencies: str = Query(..., description="2-5 comma-separated agency ids"),
            year: int = CRIME_YEAR) -> dict:
    ids = [a.strip().upper() for a in agencies.split(",") if a.strip()]
    if not 2 <= len(ids) <= 5:
        raise HTTPException(400, "Compare 2 to 5 agencies.")

    placeholders = ",".join("?" * len(ids))
    snapshot = db.rows(f"""
        SELECT * FROM analytics_agency_year
        WHERE agency_id IN ({placeholders}) AND data_year = ?
    """, ids + [year])
    trends = db.rows(f"""
        SELECT agency_id, agency_name, data_year, population, sworn_officers,
               officers_per_1k, violent_crime_offenses, violent_crime_rate,
               property_crime_offenses, property_crime_rate, months_reported,
               coverage_status, rate_allowed, rate_withheld_reason
        FROM analytics_agency_year
        WHERE agency_id IN ({placeholders}) ORDER BY agency_id, data_year
    """, ids)

    present = {s["agency_id"] for s in snapshot}
    missing = []
    for i in ids:
        if i in present:
            continue
        a = db.one("SELECT agency_id, agency_name, agency_type, state_abbr "
                   "FROM dim_agency WHERE agency_id = ?", [i])
        latest = db.scalar("SELECT max(data_year) FROM analytics_agency_year "
                           "WHERE agency_id = ?", [i])
        missing.append({
            "agency_id": i,
            "agency_name": a["agency_name"] if a else None,
            "reason": ("No observation for this year" if a else "No agency with this id"),
            "latest_year_available": latest,
        })
    issues = comparability(snapshot, "violent_crime_rate", year)

    return {
        "year": year,
        "agency_ids": ids,
        "missing": missing,
        "snapshot": [scrub(s) for s in snapshot],
        "trends": [scrub(t) for t in trends],
        "comparability": [
            {"severity": i.severity, "code": i.code, "message": i.message} for i in issues
        ],
    }


# ======================================================================================
# States
# ======================================================================================


@app.get("/api/states")
def states(year: int = CRIME_YEAR) -> dict:
    return {"year": year, "states": [scrub(r) for r in db.rows("""
        SELECT s.state_abbr, s.data_year, s.agencies, s.agencies_participating,
               s.sworn_officers, s.civilian_personnel, s.violent_offenses_full_year,
               s.violent_crime_rate, c.population_coverage, c.full_year_reporters,
               c.partial_reporters, c.non_reporters
        FROM analytics_state_year s
        LEFT JOIN analytics_reporting_coverage c
               ON c.state_abbr = s.state_abbr AND c.data_year = s.data_year
        WHERE s.data_year = ? AND s.state_abbr IS NOT NULL
        ORDER BY s.state_abbr
    """, [year])]}


@app.get("/api/states/{code}")
def state(code: str, year: int = CRIME_YEAR) -> dict:
    st = code.upper()
    summary = db.one("""
        SELECT s.*, c.population_coverage, c.full_year_reporters, c.partial_reporters,
               c.non_reporters, c.population_total, c.population_covered
        FROM analytics_state_year s
        LEFT JOIN analytics_reporting_coverage c
               ON c.state_abbr = s.state_abbr AND c.data_year = s.data_year
        WHERE s.state_abbr = ? AND s.data_year = ?
    """, [st, year])
    if not summary:
        raise HTTPException(404, f"No data for state {st} in {year}")
    return {
        "state": st, "year": year, "summary": scrub(summary),
        "trend": [scrub(r) for r in db.rows("""
            SELECT s.data_year, s.agencies, s.agencies_participating, s.sworn_officers,
                   s.violent_offenses_full_year, s.violent_crime_rate,
                   c.population_coverage
            FROM analytics_state_year s
            LEFT JOIN analytics_reporting_coverage c
                   ON c.state_abbr = s.state_abbr AND c.data_year = s.data_year
            WHERE s.state_abbr = ? ORDER BY s.data_year
        """, [st])],
        "composition": db.rows("""
            SELECT agency_type, count(*) AS agencies, sum(sworn_officers) AS sworn
            FROM analytics_agency_year WHERE state_abbr = ? AND data_year = ?
            GROUP BY 1 ORDER BY 2 DESC
        """, [st, year]),
        "largest_agencies": [scrub(r) for r in db.rows("""
            SELECT agency_id, agency_name, agency_type, geo_name, population,
                   sworn_officers, officers_per_1k, violent_crime_rate, months_reported,
                   coverage_status, rate_allowed, rate_withheld_reason
            FROM analytics_agency_year
            WHERE state_abbr = ? AND data_year = ? AND sworn_officers IS NOT NULL
            ORDER BY sworn_officers DESC LIMIT 15
        """, [st, year])],
        "quality": db.one("""
            SELECT count(*) AS agencies,
                   sum(CASE WHEN geo_review_status='accepted' THEN 1 ELSE 0 END) AS accepted,
                   sum(CASE WHEN geo_review_status='needs_review' THEN 1 ELSE 0 END) AS needs_review,
                   sum(CASE WHEN geo_review_status='unmatched' THEN 1 ELSE 0 END) AS unmatched
            FROM analytics_agency_geography WHERE state_abbr = ?
        """, [st]),
    }


# ======================================================================================
# National overview
# ======================================================================================


@app.get("/api/overview")
def overview(year: int = CRIME_YEAR) -> dict:
    # The headline staffing year is the last year with a complete Police Employee master
    # file, not simply the last year carrying any staffing value. 2025 staffing exists but
    # comes only from the NIBRS agency dimension and covers 12,827 agencies against 19,343
    # in 2024; publishing it as a national total would report a workforce shrinking by a
    # third. It is also the year the reconciliation ledger is computed for, and the headline
    # and its ledger must describe the same year.
    staffing_year = VINTAGES["pe_master_last_good"]
    rel = db.active_release()

    headline_staffing = db.one("""
        SELECT count(*) AS agencies, sum(sworn_officers) AS sworn,
               sum(civilian_personnel) AS civilian
        FROM analytics_agency_year WHERE data_year = ? AND sworn_officers IS NOT NULL
    """, [staffing_year])

    geo = db.one("""
        SELECT count(*) AS agencies,
               sum(CASE WHEN geo_review_status='accepted' THEN 1 ELSE 0 END) AS accepted,
               sum(CASE WHEN geo_review_status='needs_review' THEN 1 ELSE 0 END) AS needs_review,
               sum(CASE WHEN geo_review_status='unmatched' THEN 1 ELSE 0 END) AS unmatched
        FROM analytics_agency_geography
    """)

    coverage = db.one("""
        SELECT sum(full_year_reporters) AS full_year, sum(partial_reporters) AS partial,
               sum(non_reporters) AS none_reported, sum(agency_years) AS agency_years,
               sum(population_covered) AS population_covered,
               sum(population_total) AS population_total
        FROM analytics_reporting_coverage WHERE data_year = ?
    """, [year])
    pop_cov = None
    if coverage and coverage["population_total"]:
        pop_cov = coverage["population_covered"] / coverage["population_total"]

    composition = db.rows("""
        SELECT y.agency_type, count(*) AS agencies, sum(y.sworn_officers) AS sworn,
               sum(y.civilian_personnel) AS civilian
        FROM analytics_agency_year y WHERE y.data_year = ?
        GROUP BY 1 ORDER BY 2 DESC
    """, [staffing_year])
    total_agencies = sum(c["agencies"] for c in composition) or 1
    for c in composition:
        c["share"] = round(c["agencies"] / total_agencies, 4)

    trend = [scrub(r) for r in db.rows("""
        SELECT c.data_year,
               sum(c.full_year_reporters) AS full_year_reporters,
               sum(c.partial_reporters) AS partial_reporters,
               sum(c.non_reporters) AS non_reporters,
               sum(c.population_covered) AS population_covered,
               sum(c.population_total) AS population_total,
               CASE WHEN sum(c.population_total) > 0
                    THEN sum(c.population_covered) * 1.0 / sum(c.population_total) END
                 AS population_coverage,
               sum(s.violent_offenses_full_year) AS violent_offenses,
               sum(s.sworn_officers) AS sworn_officers,
               CASE WHEN sum(s.population_full_year_reporters) > 0
                    THEN sum(s.violent_offenses_full_year) * 100000.0
                         / sum(s.population_full_year_reporters) END AS violent_crime_rate
        FROM analytics_reporting_coverage c
        LEFT JOIN analytics_state_year s
               ON s.state_abbr = c.state_abbr AND s.data_year = c.data_year
        GROUP BY 1 ORDER BY 1
    """)]

    recon = _reconciliation(staffing_year)

    return {
        "release": rel,
        "years": {"crime": year, "staffing": staffing_year,
                  "completeness_cutoff": CRIME_YEAR},
        "headline": {
            "agencies": {
                "value": geo["agencies"], "label": "Law enforcement agencies",
                "note": "State, local, tribal and territorial agencies enrolled in the FBI's "
                        "UCR program. An ORI is a reporting identifier, so this exceeds the "
                        "count of agencies employing at least one sworn officer.",
            },
            "agencies_geolocated": {
                "value": geo["accepted"], "label": "Agencies matched to a geography",
                "note": f"{geo['needs_review']} links need review and {geo['unmatched']} are "
                        "legitimately unmatched — mostly university, park, transit and "
                        "special-jurisdiction agencies that do not correspond to a municipality.",
            },
            "sworn_officers": {
                "value": headline_staffing["sworn"], "year": staffing_year,
                "label": "Sworn officers",
                "note": recon["headline_note"],
            },
            "population_coverage": {
                "value": pop_cov, "year": year,
                "label": "Population covered by full-year reporters",
                "note": "Share of the population served by agencies that reported all twelve "
                        "months. Coverage is a property of the data, not of any department.",
            },
        },
        "coverage": scrub(coverage or {}),
        "composition": composition,
        "trend": trend,
        "reconciliation": recon,
    }


def _reconciliation(year: int) -> dict:
    """Serve the staffing reconciliation ledger produced by scripts/reconcile_staffing.py."""
    import json
    path = settings.releases / f"reconciliation_staffing_{year}.json"
    if not path.exists():
        return {"available": False,
                "headline_note": "Reconciliation ledger has not been generated for this year."}
    rec = json.loads(path.read_text())
    led = rec["ledger"]
    excl = (led["federal_agency"]["records"] + led["ambiguous_ori7"]["records"]
            + led["unresolved_ori7"]["records"])
    return {
        "available": True,
        "year": year,
        "platform_total": rec["warehouse"]["sworn"],
        "fbi_published": (rec.get("fbi_published") or {}).get("sworn"),
        "source_file_total": rec["source_file"]["sworn"],
        "excluded": {
            "federal_agencies": led["federal_agency"]["sworn"],
            "ambiguous_identifier": led["ambiguous_ori7"]["sworn"],
            "unresolved_identifier": led["unresolved_ori7"]["sworn"],
            "records": excl,
        },
        "headline_note": (
            f"{year} · state, local, tribal and territorial agencies with a resolved "
            f"identity. Excludes federal agencies ({led['federal_agency']['sworn']:,} sworn) "
            f"and {excl:,} records whose agency identity could not be resolved. The FBI's "
            f"own national figure, which includes federal agencies, is "
            f"{(rec.get('fbi_published') or {}).get('sworn', 0):,}."
        ),
        "document": "docs/reconciliation-staffing-2024.md",
    }


# ======================================================================================
# Map
# ======================================================================================


@app.get("/api/map")
def map_data(
    metric: str = "violent_crime_rate",
    year: int = CRIME_YEAR,
    layer: Literal["agency", "state", "county"] = "agency",
    state: str | None = None,
    agency_type: str | None = None,
    limit: int = Query(20000, le=25000),
) -> dict:
    numeric = {
        "violent_crime_rate", "property_crime_rate", "officers_per_1k",
        "sworn_officers", "population", "months_reported",
    }
    if metric not in numeric:
        raise HTTPException(400, f"metric {metric} is not mappable")

    if layer == "agency":
        where = ["y.data_year = ?", "g.latitude IS NOT NULL", "g.longitude IS NOT NULL"]
        params: list = [year]
        if state:
            where.append("y.state_abbr = ?"); params.append(state.upper())
        if agency_type:
            where.append("y.agency_type = ?"); params.append(agency_type)
        features = db.rows(f"""
            SELECT y.agency_id, y.agency_name, y.agency_type, y.state_abbr,
                   g.latitude, g.longitude, y.population, y.sworn_officers,
                   y.officers_per_1k, y.violent_crime_rate, y.property_crime_rate,
                   y.months_reported, y.coverage_status, y.rate_allowed,
                   y.rate_withheld_reason, y.denominator_type, y.denominator_confidence,
                   y.{metric} AS value
            FROM analytics_agency_year y
            JOIN dim_agency g ON g.agency_id = y.agency_id
            WHERE {' AND '.join(where)}
            ORDER BY y.sworn_officers DESC NULLS LAST
            LIMIT ?
        """, params + [limit])
        without_coords = db.scalar("""
            SELECT count(*) FROM analytics_agency_year y
            JOIN dim_agency g ON g.agency_id = y.agency_id
            WHERE y.data_year = ? AND (g.latitude IS NULL OR g.longitude IS NULL)
        """, [year])
    elif layer == "state":
        features = db.rows(f"""
            SELECT state_abbr, count(*) AS agencies, sum(sworn_officers) AS sworn_officers,
                   sum(population) AS population,
                   median({metric}) AS value,
                   sum(CASE WHEN rate_allowed THEN 1 ELSE 0 END) AS reporting_agencies
            FROM analytics_agency_year
            WHERE data_year = ? AND state_abbr IS NOT NULL
            GROUP BY 1 ORDER BY 1
        """, [year])
        without_coords = 0
    else:
        features = db.rows(f"""
            SELECT g.geoid AS county_geoid, g.name AS county_name, g.state_abbr,
                   count(*) AS agencies, sum(y.sworn_officers) AS sworn_officers,
                   median(y.{metric}) AS value
            FROM analytics_agency_year y
            JOIN dim_geography g ON g.geo_id = y.geo_id AND g.geo_level = 'county'
            WHERE y.data_year = ?
            GROUP BY 1,2,3 ORDER BY 1
        """, [year])
        without_coords = 0

    values = [f["value"] for f in features if f.get("value") is not None]
    values_sorted = sorted(values)

    def pct(p: float):
        if not values_sorted:
            return None
        return values_sorted[min(len(values_sorted) - 1,
                                 int(round(p * (len(values_sorted) - 1))))]

    return {
        "metric": metric, "year": year, "layer": layer,
        "unit": METRIC_UNITS.get(metric, ""),
        "legend": {
            "min": clean(min(values)) if values else None,
            "max": clean(max(values)) if values else None,
            "p10": clean(pct(0.10)), "p25": clean(pct(0.25)), "p50": clean(pct(0.50)),
            "p75": clean(pct(0.75)), "p90": clean(pct(0.90)),
            "with_value": len(values), "without_value": len(features) - len(values),
        },
        "features": [scrub(f) for f in features],
        "agencies_without_coordinates": without_coords,
        "no_data_note": (
            "Features without a value are drawn in the no-data pattern. No data is never "
            "rendered as zero, and no coordinate is ever fabricated for an agency that "
            "lacks one."
        ),
    }


METRIC_UNITS = {
    "violent_crime_rate": "Incidents per 100,000 residents",
    "property_crime_rate": "Incidents per 100,000 residents",
    "officers_per_1k": "Sworn officers per 1,000 residents",
    "sworn_officers": "Sworn officers",
    "population": "Residents",
    "months_reported": "Months reported of 12",
}


# ======================================================================================
# Data quality
# ======================================================================================


@app.get("/api/quality")
def quality(year: int = CRIME_YEAR) -> dict:
    return {
        "release": db.active_release(),
        "geography_resolution": db.rows("""
            SELECT geo_review_status AS status, match_method, count(*) AS n
            FROM analytics_agency_geography GROUP BY 1,2 ORDER BY 3 DESC
        """),
        "geography_totals": db.one("""
            SELECT count(*) AS agencies,
                   sum(CASE WHEN geo_review_status='accepted' THEN 1 ELSE 0 END) AS accepted,
                   sum(CASE WHEN geo_review_status='needs_review' THEN 1 ELSE 0 END) AS needs_review,
                   sum(CASE WHEN geo_review_status='unmatched' THEN 1 ELSE 0 END) AS unmatched
            FROM analytics_agency_geography
        """),
        "unmatched_by_type": db.rows("""
            SELECT agency_type, count(*) AS n FROM analytics_agency_geography
            WHERE geo_review_status = 'unmatched' GROUP BY 1 ORDER BY 2 DESC
        """),
        "identifier_resolution": db.one("""
            SELECT count(*) AS agencies,
                   sum(CASE WHEN ori7_source='legacy_ori' THEN 1 ELSE 0 END) AS from_legacy_ori,
                   sum(CASE WHEN ori7_source='nibrs_ori_fallback' THEN 1 ELSE 0 END) AS fallback,
                   sum(CASE WHEN ori9_legacy IS NULL THEN 1 ELSE 0 END) AS no_legacy_ori
            FROM dim_agency
        """),
        "ambiguous_ori7": db.rows("""
            SELECT ori7, count(*) AS agencies FROM dim_agency
            WHERE ori7 IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY 2 DESC LIMIT 25
        """),
        "coverage_by_year": [scrub(r) for r in db.rows("""
            SELECT data_year,
                   sum(full_year_reporters) AS full_year, sum(partial_reporters) AS partial,
                   sum(non_reporters) AS none_reported, sum(agency_years) AS agency_years,
                   CASE WHEN sum(population_total) > 0
                        THEN sum(population_covered) * 1.0 / sum(population_total) END
                     AS population_coverage
            FROM analytics_reporting_coverage GROUP BY 1 ORDER BY 1
        """)],
        "coverage_heatmap": [scrub(r) for r in db.rows("""
            SELECT state_abbr, data_year, full_year_reporters, partial_reporters,
                   non_reporters, agency_years, population_coverage
            FROM analytics_reporting_coverage
            WHERE state_abbr IS NOT NULL ORDER BY state_abbr, data_year
        """)],
        "checks": db.rows("""
            SELECT check_id, severity, count(*) AS n, any_value(message) AS message
            FROM data_quality_log GROUP BY 1,2 ORDER BY
              CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, 3 DESC
        """),
    }


@app.get("/api/quality/coverage/{year}")
def quality_coverage_detail(year: int, state: str | None = None,
                            status: Literal["COMPLETE", "PARTIAL", "NONE", "UNKNOWN"] | None = None,
                            limit: int = Query(200, le=1000)) -> dict:
    where = ["data_year = ?"]
    params: list = [year]
    if state:
        where.append("state_abbr = ?"); params.append(state.upper())
    if status:
        where.append("coverage_status = ?"); params.append(status)
    return {
        "year": year, "state": state, "status": status,
        "agencies": [scrub(r) for r in db.rows(f"""
            SELECT agency_id, agency_name, agency_type, state_abbr, months_reported,
                   coverage_status, violent_crime_offenses, population, rate_allowed,
                   rate_withheld_reason
            FROM analytics_agency_year WHERE {' AND '.join(where)}
            ORDER BY population DESC NULLS LAST LIMIT ?
        """, params + [limit])],
    }


@app.get("/api/quality/flags/{check_id}")
def quality_flag_detail(check_id: str, limit: int = Query(200, le=1000)) -> dict:
    return {"check_id": check_id, "rows": db.rows("""
        SELECT l.entity_id, l.data_year, l.observed, l.expected, l.severity, l.message,
               a.agency_name, a.state_abbr
        FROM data_quality_log l
        LEFT JOIN dim_agency a ON a.agency_id = l.entity_id
        WHERE l.check_id = ? ORDER BY l.data_year DESC NULLS LAST LIMIT ?
    """, [check_id, limit])}


@app.get("/api/health")
def health() -> dict:
    """Liveness plus the two facts that make a deployment diagnosable: which database this
    instance opened, and which release it contains."""
    from pathlib import Path as _Path

    path = _Path(settings.db_path)
    return {
        "ok": True,
        "database": path.name,
        "database_bytes": path.stat().st_size if path.exists() else None,
        "release": db.active_release(),
        "served_tables": sorted(db.ALLOWED_TABLES),
    }


# ======================================================================================
# Static frontend
# ======================================================================================
# In production the API serves the built single-page application from the same origin, so
# there is no CORS surface and no second deployment target. In development Vite proxies
# /api to this process instead.

_web_dist = settings.root / "web" / "dist"
if _web_dist.is_dir():
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse

    app.mount("/assets", StaticFiles(directory=_web_dist / "assets"), name="assets")
    for static_dir in ("geo", "fonts"):
        if (_web_dist / static_dir).is_dir():
            app.mount(f"/{static_dir}",
                      StaticFiles(directory=_web_dist / static_dir), name=static_dir)

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        # A catch-all must never answer for the API. Any /api path that reaches here is an
        # endpoint that does not exist, and it should say so rather than returning the
        # application's HTML with a 200.
        if full_path.startswith("api/"):
            raise HTTPException(404, f"No API endpoint at /{full_path}")
        candidate = _web_dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_web_dist / "index.html")


@app.exception_handler(Exception)
async def unhandled(request, exc):  # pragma: no cover - defensive
    return JSONResponse(status_code=500, content={
        "error": "The request could not be completed.",
        "detail": str(exc)[:400],
    })
