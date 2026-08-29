"""Read-only warehouse access for the API.

DuckDB allows many concurrent readers of one file as long as no writer holds it. The API
opens read-only connections and never writes, so a pipeline rebuild is the only thing that
takes the lock — and a rebuild produces a new release, which the API reports.

Every query in the API goes through ``rows()`` or ``one()`` with bound parameters. No
endpoint accepts SQL, and no endpoint reads a canonical table directly: the surface is the
analytics layer plus the two registries.
"""
from __future__ import annotations

import threading
from functools import lru_cache
from typing import Any

import duckdb

from ..config import settings

_local = threading.local()

# The API's read surface. Anything not on this list is not reachable through HTTP.
ALLOWED_TABLES = {
    "analytics_agency_geography", "analytics_agency_population", "analytics_agency_year",
    "analytics_peer_cohort", "analytics_peer_benchmarks", "analytics_state_year",
    "analytics_reporting_coverage",
    "dim_agency", "dim_geography", "dim_metric", "dim_source", "dim_time",
    "agency_crosswalk", "agency_history", "data_quality_log", "release_manifest",
    "fact_crime", "fact_staffing", "fact_reporting", "fact_finance", "fact_demographics",
}


def conn() -> duckdb.DuckDBPyConnection:
    """One connection per thread. DuckDB connections are not thread-safe to share."""
    c = getattr(_local, "con", None)
    if c is None:
        c = duckdb.connect(str(settings.db_path), read_only=True)
        _local.con = c
    return c


def rows(sql: str, params: list | None = None) -> list[dict]:
    cur = conn().execute(sql, params or [])
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def one(sql: str, params: list | None = None) -> dict | None:
    r = rows(sql, params)
    return r[0] if r else None


def scalar(sql: str, params: list | None = None) -> Any:
    r = conn().execute(sql, params or []).fetchone()
    return r[0] if r else None


@lru_cache(maxsize=1)
def active_release() -> dict:
    r = one("""
        SELECT release_id, built_at, git_commit
        FROM release_manifest ORDER BY built_at DESC LIMIT 1
    """)
    return r or {"release_id": "unbuilt", "built_at": None, "git_commit": None}


@lru_cache(maxsize=1)
def latest_years() -> dict:
    return {
        "crime": scalar("SELECT max(data_year) FROM fact_crime"),
        "staffing": scalar("SELECT max(data_year) FROM fact_staffing"),
        "population": scalar("SELECT max(data_year) FROM fact_demographics WHERE basis='pep'"),
        "finance": scalar("SELECT max(survey_year) FROM fact_finance"),
    }
