"""Read-only warehouse access for the API.

DuckDB allows many concurrent readers of one file as long as no writer holds it. The API
opens read-only connections and never writes, so a pipeline rebuild is the only thing that
takes the lock — and a rebuild produces a new release, which the API reports.

Every query in the API goes through ``rows()`` or ``one()`` with bound parameters. No
endpoint accepts SQL, and no endpoint reads a canonical table directly: the surface is the
analytics layer plus the two registries.
"""
from __future__ import annotations

import os
import threading
from functools import lru_cache
from typing import Any

import duckdb

from ..config import settings

_local = threading.local()

# The API's read surface. Anything not on this list is not reachable through HTTP, and
# scripts/build_deploy_db.py copies exactly this set into the serving database — so the list
# is both a security boundary and the deployment manifest, and an unused entry costs real
# megabytes in production. Every table here is queried by at least one endpoint.
ALLOWED_TABLES = {
    "analytics_agency_geography", "analytics_agency_year", "analytics_state_year",
    "analytics_reporting_coverage", "analytics_provenance", "analytics_source_usage",
    "dim_agency", "dim_geography", "dim_metric", "dim_source", "dim_time",
    "agency_crosswalk", "agency_history", "data_quality_log", "release_manifest",
}


_all_conns: list[duckdb.DuckDBPyConnection] = []
_conn_lock = threading.Lock()


def _serverless_config() -> dict[str, str]:
    """DuckDB's defaults assume a machine, not a Lambda.

    Left alone it sizes its buffer pool from total system memory, starts one thread per
    detected core, and places both its temporary spill files and its extension directory on
    paths that are read-only in this runtime. Each of those is a hard native failure rather
    than a Python exception, which is why the first deployment returned
    FUNCTION_INVOCATION_FAILED with an empty traceback.
    """
    if not os.environ.get("NLEDP_SERVERLESS"):
        return {}
    return {
        "temp_directory": "/tmp/duckdb-temp",
        "home_directory": "/tmp",
        # The served queries are aggregate reads over a 47 MB file. The ceiling is here to
        # keep DuckDB from sizing itself against the host rather than the container.
        "memory_limit": "512MB",
        "threads": "2",
    }


def conn() -> duckdb.DuckDBPyConnection:
    """One connection per thread. DuckDB connections are not thread-safe to share."""
    c = getattr(_local, "con", None)
    if c is None:
        c = duckdb.connect(str(settings.db_path), read_only=True,
                           config=_serverless_config())
        _local.con = c
        with _conn_lock:
            _all_conns.append(c)
    return c


def close_all() -> None:
    """Close every connection this process opened.

    Left to the interpreter, DuckDB's C++ destructors run during teardown after Python has
    begun dismantling the threads that own them, and abort the process. It is harmless at
    the end of a script and much less harmless in a serverless runtime that reads the exit
    code, so shutdown is explicit.
    """
    with _conn_lock:
        while _all_conns:
            try:
                _all_conns.pop().close()
            except Exception:  # noqa: BLE001 - shutdown must not raise
                pass
    _local.__dict__.pop("con", None)


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
        "crime": scalar("SELECT max(data_year) FROM analytics_agency_year "
                        "WHERE violent_crime_offenses IS NOT NULL"),
        "staffing": scalar("SELECT max(data_year) FROM analytics_agency_year "
                           "WHERE sworn_officers IS NOT NULL"),
        "population": scalar("SELECT max(denominator_year) FROM analytics_agency_year"),
        "finance": scalar("SELECT max(coverage_end_year) FROM dim_source "
                          "WHERE source_id = 'census-gov-finance-2024'"),
    }
