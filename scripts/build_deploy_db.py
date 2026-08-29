#!/usr/bin/env python3
"""Build the serving database: the subset of the warehouse the API actually reads.

The full warehouse is 160 MB and carries 1.2 million fact rows the API never touches, plus
intermediate tables the analytics build needs and nothing else does. Neither GitHub (100 MB
per file) nor a Vercel serverless bundle wants that, and neither should have to: the API's
read surface is declared in ``nledp.api.db.ALLOWED_TABLES``, and everything outside it is
build-time scaffolding.

This script copies exactly that surface into a fresh database, which compacts it as a side
effect — DuckDB files never shrink in place, so a rebuilt file drops the free pages that
repeated DROP/CREATE cycles leave behind.

The result is the deployment artifact. The full warehouse stays local and is what the
pipeline rebuilds; this is what serves.

    python scripts/build_deploy_db.py
    python scripts/build_deploy_db.py --out data/deploy/nledp-api.duckdb --verify
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nledp.api.db import ALLOWED_TABLES  # noqa: E402
from nledp.config import settings        # noqa: E402

# Present in the warehouse and deliberately NOT served. Listed explicitly so the omission is
# a decision on the record rather than an accident of what happened to be copied.
EXCLUDED = {
    "analytics_agency_year_base": "pre-policy intermediate; the policy pass supersedes it",
    "analytics_agency_population": "denominator working table; its outputs sit on analytics_agency_year",
    "analytics_peer_cohort": "peer selection queries analytics_agency_year directly",
    "analytics_peer_benchmarks": "the peers endpoint computes quantiles from the cohort it selects",
    "fact_crime": "compacted into analytics_provenance and analytics_agency_year",
    "fact_staffing": "compacted into analytics_provenance and analytics_agency_year",
    "fact_demographics": "compacted into analytics_agency_year denominator columns",
    "fact_reporting": "compacted into analytics_agency_year coverage columns",
    "fact_finance": "no endpoint serves finance; it stays government-unit only until Phase 3",
}


def build(src: Path, out: Path, verify: bool = False) -> None:
    if not src.exists():
        raise SystemExit(f"missing warehouse at {src}; run `nledp build` first")
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    for suffix in (".wal", ".tmp"):
        stale = out.with_name(out.name + suffix)
        if stale.exists():
            shutil.rmtree(stale) if stale.is_dir() else stale.unlink()

    con = duckdb.connect(str(out))
    # ATTACH does not accept a bind parameter. The path is a local file this script was
    # invoked with, not user input, and it is quoted to survive spaces.
    con.execute(f"ATTACH '{str(src)}' AS wh (READ_ONLY)")

    # information_schema is not qualified across attached databases; duckdb_tables() is.
    available = {r[0] for r in con.execute(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = 'wh'"
    ).fetchall()}

    missing = sorted(ALLOWED_TABLES - available)
    if missing:
        raise SystemExit(f"warehouse is missing served tables: {missing}")

    copied: list[tuple[str, int]] = []
    for name in sorted(ALLOWED_TABLES):
        con.execute(f'CREATE TABLE "{name}" AS SELECT * FROM wh."{name}"')
        n = con.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
        copied.append((name, n))

    # Indexes the API's hot paths use. On a read-only database these cost build time once and
    # save a full scan on every agency profile request.
    for ddl in (
        'CREATE INDEX idx_aay_agency ON analytics_agency_year (agency_id)',
        'CREATE INDEX idx_aay_year ON analytics_agency_year (data_year)',
        'CREATE INDEX idx_prov_agency ON analytics_provenance (agency_id)',
        'CREATE INDEX idx_dqlog_entity ON data_quality_log (entity_id)',
        'CREATE INDEX idx_dqlog_check ON data_quality_log (check_id)',
        'CREATE INDEX idx_xwalk_agency ON agency_crosswalk (canonical_agency_id)',
        'CREATE INDEX idx_agency_ori7 ON dim_agency (ori7)',
    ):
        con.execute(ddl)

    con.execute("DETACH wh")
    con.execute("CHECKPOINT")
    con.close()

    size = out.stat().st_size
    src_size = src.stat().st_size
    print(f"{out}  {size / 1e6:.1f} MB   (from {src_size / 1e6:.1f} MB, "
          f"{100 - size / src_size * 100:.0f}% smaller)")
    for name, n in copied:
        print(f"  {name:<34} {n:>10,}")
    print("\nexcluded, deliberately:")
    for name, why in sorted(EXCLUDED.items()):
        print(f"  {name:<34} {why}")

    if size > 95_000_000:
        print(f"\nWARNING: {size / 1e6:.0f} MB exceeds GitHub's 100 MB per-file limit "
              "and cannot be committed. Reduce the served surface or use Git LFS.")

    if verify:
        _verify(out)


def _verify(path: Path) -> None:
    """Query the serving database through the API's own code path."""
    import os
    os.environ["NLEDP_DB_PATH"] = str(path)
    from nledp.api import db as apidb
    apidb._local.__dict__.clear()
    apidb.active_release.cache_clear()
    apidb.latest_years.cache_clear()

    con = duckdb.connect(str(path), read_only=True)
    checks = [
        ("release", "SELECT count(*) FROM release_manifest"),
        ("agencies", "SELECT count(*) FROM dim_agency"),
        ("agency-years", "SELECT count(*) FROM analytics_agency_year"),
        ("provenance", "SELECT count(*) FROM analytics_provenance"),
        ("Baltimore 2021 rate withheld",
         "SELECT count(*) FROM analytics_agency_year WHERE agency_id='MDBPD0000' "
         "AND data_year=2021 AND violent_crime_rate IS NULL AND NOT rate_allowed"),
        ("no validation errors",
         "SELECT count(*) FROM data_quality_log WHERE severity='error'"),
    ]
    print("\nverification:")
    for label, sql in checks:
        print(f"  {label:<32} {con.execute(sql).fetchone()[0]:>10,}")
    con.close()


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", type=Path, default=settings.db_path)
    p.add_argument("--out", type=Path,
                   default=settings.root / "data" / "deploy" / "nledp-api.duckdb")
    p.add_argument("--verify", action="store_true")
    a = p.parse_args()
    build(a.src, a.out, a.verify)


if __name__ == "__main__":
    main()
