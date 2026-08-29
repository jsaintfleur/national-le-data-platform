#!/usr/bin/env python3
"""Export the API's answers as a static bundle, for a self-contained build of the platform.

A single-file build has no server, and the temptation is to reimplement the API's queries in
the browser. That would break the one architectural rule this platform is built on: the
policy engine decides what may be published, server-side, and no client reconstructs a value
it withheld.

So nothing is reimplemented. Every response that has a bounded shape — the overview, the
quality register, all 51 state profiles, the metric and source registries, peer benchmarks —
is computed here, by the same code paths the API uses, and shipped as an answer. Everything
unbounded (agency filtering, sorting, an individual profile) is served from rows in which the
policy columns are already decided: `rate_allowed`, `rate_withheld_reason`,
`denominator_confidence` and `methodology_warning` travel with each row, and the client's job
is lookup and layout, never adjudication.

The encoding is columnar with dictionary-coded strings, which is what makes 188,877
agency-years fit inside an artifact's size budget at all.

    python scripts/export_static_bundle.py --out web/static-bundle.json
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import duckdb  # noqa: E402

from nledp.config import settings  # noqa: E402

DB = settings.root / "data" / "deploy" / "nledp-api.duckdb"

SNAPSHOT_YEAR = 2024
# Columns the client derives arithmetically are not shipped: total_personnel is
# sworn + civilian, civilian_share is their ratio, denominator_year equals data_year
# wherever a denominator exists. Derivation is not adjudication, so this costs no integrity.
# denominator_notes and denominator_source are functions of denominator_type and are shipped
# once as lookups rather than 188,877 times.
SERIES_COLUMNS = [
    "agency_id", "data_year", "population", "population_geography_total",
    "sworn_officers", "civilian_personnel",
    "officers_per_1k", "violent_crime_offenses", "violent_crime_clearances",
    "violent_crime_rate", "property_crime_offenses", "property_crime_rate",
    "months_reported", "coverage_status", "rate_allowed", "rate_withheld_reason",
    "methodology_warning", "denominator_type", "denominator_value",
    "denominator_confidence", "participated", "pe_reported",
]
AGENCY_COLUMNS = [
    "agency_id", "agency_name", "agency_type", "agency_type_source", "state_abbr",
    "county_name", "msa_name", "latitude", "longitude", "ori9_nibrs", "ori9_legacy",
    "ori7", "ori7_source", "is_dormant", "dormant_year", "is_covered_by_parent",
    "covered_by_legacy_ori", "population_group_desc", "nibrs_start_date",
    "rate_denominator_eligible",
]


def columnar(rows: list[tuple], columns: list[str]) -> dict:
    """Transpose to one array per column and dictionary-code low-cardinality strings.

    Row-of-objects JSON repeats every key 188,877 times. Columnar with dictionaries turns
    17.5 MB into something that fits, and costs one `decode()` in the client.
    """
    n = len(columns)
    cols: list[list] = [[] for _ in range(n)]
    for r in rows:
        for i in range(n):
            cols[i].append(r[i])

    out_cols: list[dict] = []
    for name, values in zip(columns, cols):
        distinct = {v for v in values if isinstance(v, str)}
        # Dictionary-code where it pays: repeated strings, not free text or identifiers.
        if distinct and len(distinct) <= max(64, len(values) // 200):
            table = sorted(distinct)
            index = {v: i for i, v in enumerate(table)}
            out_cols.append({"n": name, "d": table,
                             "v": [index.get(v) if v is not None else None for v in values]})
        else:
            out_cols.append({"n": name, "v": values})
    return {"count": len(rows), "columns": out_cols}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=settings.root / "web" / "static-bundle.json")
    args = ap.parse_args()

    if not DB.exists():
        raise SystemExit(f"missing {DB}; run `nledp deploy-db` first")

    con = duckdb.connect(str(DB), read_only=True)

    def rows(sql: str, params: list | None = None) -> list[dict]:
        cur = con.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    def one(sql: str, params: list | None = None):
        r = rows(sql, params)
        return r[0] if r else None

    # The API is imported and called directly, so precomputed responses are produced by the
    # same functions the served API uses rather than by a parallel implementation here.
    import os
    os.environ["NLEDP_DB_PATH"] = str(DB)
    from nledp.api import main as api  # noqa: E402

    bundle: dict = {"generated_by": "scripts/export_static_bundle.py"}

    # --- bounded responses: computed once, shipped as answers -------------------------
    bundle["release"] = api.release()
    bundle["overview"] = api.overview()
    bundle["metrics"] = api.metrics()
    bundle["sources"] = api.sources()
    bundle["quality"] = api.quality()
    bundle["facets"] = api.agency_facets()
    bundle["states_list"] = api.states()
    bundle["states"] = {}
    for st in [r["state_abbr"] for r in bundle["states_list"]["states"]]:
        try:
            bundle["states"][st] = api.state(st)
        except Exception:  # noqa: BLE001 - a state with no observations is simply absent
            continue

    # --- unbounded data: policy already decided, client does lookup and layout ---------
    bundle["agencies"] = columnar(
        con.execute(f"SELECT {','.join(AGENCY_COLUMNS)} FROM dim_agency ORDER BY agency_id"
                    ).fetchall(), AGENCY_COLUMNS)
    bundle["series"] = columnar(
        con.execute(f"SELECT {','.join(SERIES_COLUMNS)} FROM analytics_agency_year "
                    "ORDER BY agency_id, data_year").fetchall(), SERIES_COLUMNS)

    geo_cols = ["agency_id", "geo_id", "geo_name", "geo_level", "urbanicity_band",
                "geo_review_status", "match_method", "match_score"]
    bundle["geography"] = columnar(
        con.execute(f"SELECT {','.join(geo_cols)} FROM analytics_agency_geography "
                    "ORDER BY agency_id").fetchall(), geo_cols)

    # --- provenance, per agency --------------------------------------------------------
    prov_cols = ["agency_id", "measure", "source_id", "first_year", "last_year"]
    bundle["provenance"] = columnar(
        con.execute(f"SELECT {','.join(prov_cols)} FROM analytics_provenance "
                    "ORDER BY agency_id").fetchall(), prov_cols)
    bundle["source_meta"] = {
        r["source_id"]: r for r in rows(
            "SELECT source_id, source_name, dataset_name, source_url, latest_release_date, "
            "update_frequency, license FROM dim_source")
    }

    # --- quality flags per agency ------------------------------------------------------
    flag_cols = ["entity_id", "check_id", "severity", "data_year", "message", "observed"]
    bundle["agency_flags"] = columnar(
        con.execute(f"""SELECT {','.join(flag_cols)} FROM data_quality_log
                        WHERE entity_id IN (SELECT agency_id FROM dim_agency)
                        ORDER BY entity_id""").fetchall(), flag_cols)

    hist_cols = ["agency_id", "effective_year", "change_type", "old_value", "new_value", "notes"]
    bundle["agency_history"] = columnar(
        con.execute(f"SELECT {','.join(hist_cols)} FROM agency_history ORDER BY agency_id"
                    ).fetchall(), hist_cols)

    # Quality-log detail, capped at the same 200 rows per check the API returns by default.
    log_cols = ["check_id", "entity_id", "data_year", "observed", "expected", "severity",
                "message"]
    bundle["quality_log"] = columnar(con.execute(f"""
        SELECT {','.join(log_cols)} FROM (
            SELECT {','.join(log_cols)},
                   row_number() OVER (PARTITION BY check_id ORDER BY data_year DESC NULLS LAST) AS rn
            FROM data_quality_log)
        WHERE rn <= 200
    """).fetchall(), log_cols)

    # The comparability rules' thresholds and message text, so the static build states the
    # same things in the same words rather than paraphrasing them.
    from nledp.policy import (
        MIN_COHORT_SIZE, OVERLAPPING_JURISDICTION_TYPES, REQUIRED_MONTHS_FOR_RATE,
        SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K,
    )
    bundle["policy"] = {
        "overlapping_jurisdiction_types": sorted(OVERLAPPING_JURISDICTION_TYPES),
        "required_months_for_rate": REQUIRED_MONTHS_FOR_RATE,
        "minimum_cohort_size": MIN_COHORT_SIZE,
        "sheriff_plausibility_officers_per_1k": SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K,
        "comparability_messages": {
            "statewide_vs_local":
                "Statewide police agencies are included alongside local agencies. A statewide "
                "agency's jurisdiction overlaps every local agency in its state, so "
                "per-resident rates are not on a common basis. Counts remain comparable.",
            "mixed_denominators":
                "These agencies use different population denominators: {types}. Rates measure "
                "different populations and are not directly comparable.",
            "not_comparable_member":
                "At least one agency has no valid resident denominator, so it contributes "
                "counts but no rate to this comparison.",
            "mixed_agency_types":
                "Agency types differ ({types}). Departments of different types serve different "
                "functions and populations.",
            "incomplete_coverage":
                "At least one agency reported fewer than {months} months in {year}. Its counts "
                "are shown; its rate is withheld.",
        },
    }

    # --- peer benchmarks: policy, precomputed -------------------------------------------
    # Cohort selection, the minimum-size rule and percentile eligibility are all decisions
    # the policy engine makes. They are made here, once, and shipped as results.
    # Normalized: a cohort's median, quartiles and size are properties of the COHORT, not of
    # each of its members. Repeating them per agency-year cost 14.7 MB; a cohort table plus a
    # per-agency percentile costs a fifth of that and says exactly the same thing.
    cohort_rows: list[tuple] = []
    member_rows: list[tuple] = []
    for metric in ("violent_crime_rate", "officers_per_1k"):
        cohort_rows += con.execute(f"""
            WITH pool AS (
                SELECT agency_id, data_year, agency_type, state_abbr, population_band,
                       coalesce(urbanicity_band,'') AS urb, {metric} AS v
                FROM analytics_agency_year
                WHERE rate_allowed AND {metric} IS NOT NULL AND population_band IS NOT NULL
            )
            SELECT '{metric}', agency_type, population_band, urb, data_year,
                   count(*), median(v), quantile_cont(v, 0.25), quantile_cont(v, 0.75)
            FROM pool GROUP BY 1,2,3,4,5
        """).fetchall()
        member_rows += con.execute(f"""
            WITH pool AS (
                SELECT agency_id, data_year, agency_type, state_abbr, population_band,
                       coalesce(urbanicity_band,'') AS urb, {metric} AS v
                FROM analytics_agency_year
                WHERE rate_allowed AND {metric} IS NOT NULL AND population_band IS NOT NULL
            )
            SELECT '{metric}', p.agency_id, p.data_year,
                   p.agency_type || '|' || p.population_band || '|' || p.urb AS cohort_key,
                   round((SELECT count(*) FROM pool q
                          WHERE q.data_year = p.data_year AND q.agency_type = p.agency_type
                            AND q.population_band = p.population_band AND q.urb = p.urb
                            AND q.v < p.v) * 100.0
                         / (SELECT count(*) FROM pool q2
                            WHERE q2.data_year = p.data_year AND q2.agency_type = p.agency_type
                              AND q2.population_band = p.population_band AND q2.urb = p.urb), 1)
            FROM pool p
        """).fetchall()

    medians_state = con.execute("""
        SELECT 'violent_crime_rate', state_abbr, data_year, median(violent_crime_rate)
        FROM analytics_agency_year WHERE rate_allowed AND violent_crime_rate IS NOT NULL
        GROUP BY 1,2,3
        UNION ALL
        SELECT 'officers_per_1k', state_abbr, data_year, median(officers_per_1k)
        FROM analytics_agency_year WHERE rate_allowed AND officers_per_1k IS NOT NULL
        GROUP BY 1,2,3
    """).fetchall()
    medians_national = con.execute("""
        SELECT 'violent_crime_rate', data_year, median(violent_crime_rate)
        FROM analytics_agency_year WHERE rate_allowed AND violent_crime_rate IS NOT NULL
        GROUP BY 1,2
        UNION ALL
        SELECT 'officers_per_1k', data_year, median(officers_per_1k)
        FROM analytics_agency_year WHERE rate_allowed AND officers_per_1k IS NOT NULL
        GROUP BY 1,2
    """).fetchall()

    bundle["peer_cohorts"] = columnar(cohort_rows, [
        "metric", "agency_type", "population_band", "urbanicity_band", "data_year",
        "cohort_size", "peer_median", "peer_p25", "peer_p75"])
    bundle["peer_members"] = columnar(member_rows, [
        "metric", "agency_id", "data_year", "cohort_key", "percentile"])
    bundle["median_state"] = columnar(medians_state,
                                      ["metric", "state_abbr", "data_year", "median"])
    bundle["median_national"] = columnar(medians_national, ["metric", "data_year", "median"])

    # Denominator prose, shipped once per type rather than once per row.
    from nledp.policy import DENOMINATOR_NOTES
    bundle["denominator_notes"] = {k.value: v for k, v in DENOMINATOR_NOTES.items()}
    bundle["denominator_sources"] = dict(con.execute("""
        SELECT DISTINCT denominator_type, any_value(denominator_source)
        FROM analytics_agency_year WHERE denominator_source IS NOT NULL GROUP BY 1
    """).fetchall())


    con.close()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(bundle, separators=(",", ":"), default=str)
    args.out.write_text(text)

    # The artifact embeds the gzipped bytes as base64 and inflates them with the browser's
    # native DecompressionStream. 46 MB of JSON becomes about 8 MB of page, which is the
    # difference between shipping the whole national dataset and shipping a sample of it.
    import base64
    packed = base64.b64encode(gzip.compress(text.encode(), 9)).decode()
    args.out.with_suffix(".b64").write_text(packed)

    print(f"{args.out}  {len(text)/1e6:.2f} MB raw  "
          f"{len(gzip.compress(text.encode()))/1e6:.2f} MB gzipped  "
          f"{len(packed)/1e6:.2f} MB base64")
    for key in ("agencies", "series", "geography", "provenance", "agency_flags",
                "agency_history", "quality_log", "peer_cohorts", "peer_members",
                "median_state", "median_national"):
        block = bundle[key]
        part = len(json.dumps(block, separators=(",", ":"), default=str))
        print(f"  {key:<14} {block['count']:>8,} rows  {part/1e6:>6.2f} MB")
    for key in ("overview", "quality", "metrics", "sources", "states"):
        part = len(json.dumps(bundle[key], separators=(",", ":"), default=str))
        print(f"  {key:<14} {'':>8}       {part/1e6:>6.2f} MB")


if __name__ == "__main__":
    main()
