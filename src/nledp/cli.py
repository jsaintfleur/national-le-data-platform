"""Command line entry point: `nledp <command>`."""
from __future__ import annotations

import json

import typer
from rich.console import Console
from rich.table import Table

from .analytics.build import build_analytics
from .canonical.agency import build_dim_agency
from .canonical.dimensions import (
    build_dim_geography, build_dim_metric, build_dim_source, build_dim_time,
)
from .canonical.facts import (
    build_fact_crime, build_fact_demographics, build_fact_finance,
    build_fact_reporting, build_fact_staffing,
)
from .config import VINTAGES, settings
from .ingest import ingest_all
from .quality.validate import clear_log, run_checks
from .release import new_release_id, write_release
from .resolution.resolve import resolve_agencies_to_geography
from .warehouse import connect, init_schema, table_counts

app = typer.Typer(help="National Law Enforcement Data & Intelligence Platform — data pipeline",
                  no_args_is_help=True)
console = Console()


@app.command()
def ingest(
    crime: bool = typer.Option(False, help="Also harvest agency-level crime (~25 minutes)."),
    agency_years: str = typer.Option("2020,2021,2022,2023,2024,2025",
                                     help="NIBRS agency-dimension years to union."),
) -> None:
    """Layer 1: download every source to data/raw with a SHA-256 per artifact."""
    from .ingest import ingest_nibrs_agencies
    ingest_all()
    for y in sorted({int(x) for x in agency_years.split(",") if x.strip()}):
        if y != VINTAGES["crime_last_complete_year"]:
            ingest_nibrs_agencies(y)
    if crime:
        from pathlib import Path
        from .connectors.crime_harvest import harvest
        m = harvest(settings.raw / "fbi" / "agency_directory.json",
                    settings.raw / "fbi" / "crime")
        Path(settings.raw / "fbi" / "crime" / "_manifest.json").write_text(
            json.dumps(m, indent=1))


@app.command()
def build(
    skip_ingest: bool = typer.Option(True, help="Assume data/raw is already populated."),
    notes: str = typer.Option("", help="Free-text note stored in the release manifest."),
) -> None:
    """Layers 2-5: stage, resolve, load, validate, analyze, and cut a release."""
    if not skip_ingest:
        ingest_all()

    con = connect()
    init_schema(con)
    release_id = new_release_id()
    console.rule(f"[bold]Building {release_id}")

    steps: list[tuple[str, object]] = []
    steps.append(("dim_source", build_dim_source(con)))
    steps.append(("dim_metric", build_dim_metric(con)))
    steps.append(("dim_time", build_dim_time(con)))
    steps.append(("dim_geography", build_dim_geography(con)))
    n_ag, n_hist = build_dim_agency(con)
    steps.append(("dim_agency", n_ag))
    steps.append(("agency_history", n_hist))
    steps.append(("agency_crosswalk (geography)", resolve_agencies_to_geography(con)))
    steps.append(("fact_staffing", build_fact_staffing(con)))
    steps.append(("fact_reporting", build_fact_reporting(con)))
    steps.append(("fact_demographics", build_fact_demographics(con)))
    n_fin, n_link = build_fact_finance(con)
    steps.append(("fact_finance", n_fin))
    steps.append(("agency_crosswalk (government)", n_link))
    steps.append(("fact_crime", build_fact_crime(con)))

    for name, count in steps:
        console.print(f"  {name:<32} {count:>10,}")

    console.rule("[bold]Analytics")
    for name, count in build_analytics(con).items():
        console.print(f"  {name:<32} {count:>10,}")

    console.rule("[bold]Validation")
    clear_log(con)
    validation = run_checks(con, release_id)
    t = Table("check", "severity", "rows")
    for cid, res in sorted(validation.items(),
                           key=lambda kv: (kv[1]["severity"], -kv[1]["count"])):
        style = {"error": "red", "warning": "yellow"}.get(res["severity"], "dim")
        t.add_row(cid, f"[{style}]{res['severity']}[/]", f"{res['count']:,}")
    console.print(t)

    path = write_release(con, release_id, validation, notes)
    con.close()
    console.print(f"\n[bold green]{release_id}[/] written to {path}")


@app.command()
def validate() -> None:
    """Re-run validation against the current warehouse without rebuilding it."""
    con = connect()
    clear_log(con)
    for cid, res in sorted(run_checks(con).items()):
        console.print(f"{res['severity']:<8} {cid:<36} {res['count']:>8,}")
    con.close()


@app.command()
def status() -> None:
    """Row counts and the active release."""
    con = connect(read_only=True)
    t = Table("table", "rows")
    for name, count in table_counts(con).items():
        t.add_row(name, f"{count:,}")
    console.print(t)
    rel = con.execute(
        "SELECT DISTINCT release_id, built_at, git_commit FROM release_manifest "
        "ORDER BY built_at DESC LIMIT 1").fetchall()
    if rel:
        console.print(f"\nactive release: [bold]{rel[0][0]}[/]  built {rel[0][1]}  "
                      f"commit {rel[0][2][:12]}")
    con.close()


@app.command("deploy-db")
def deploy_db(
    out: str = typer.Option("", help="Output path; defaults to data/deploy/nledp-api.duckdb"),
    verify: bool = typer.Option(True, help="Query the result before declaring success."),
) -> None:
    """Build the serving database: exactly the tables the API reads, compacted.

    This is the deployment artifact. The full warehouse stays local.
    """
    import subprocess
    import sys

    cmd = [sys.executable, str(settings.root / "scripts" / "build_deploy_db.py")]
    if out:
        cmd += ["--out", out]
    if verify:
        cmd += ["--verify"]
    raise typer.Exit(subprocess.call(cmd))


@app.command()
def query(sql: str) -> None:
    """Run one SQL statement against the warehouse."""
    con = connect(read_only=True)
    rows = con.execute(sql).fetchall()
    cols = [d[0] for d in con.description]
    t = Table(*cols)
    for r in rows[:200]:
        t.add_row(*["" if v is None else str(v) for v in r])
    console.print(t)
    console.print(f"{len(rows):,} rows")
    con.close()


if __name__ == "__main__":
    app()
