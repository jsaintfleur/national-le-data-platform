"""Layer 1: raw ingestion. Source bytes land unchanged, with a SHA-256 and a fetch time."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console

from .config import STATES, VINTAGES, settings
from .connectors import census, cde, finance
from .util.http import sha256_file, write_manifest

console = Console()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _record(source_id: str, name: str, path: Path | None, url: str = "",
            note: str = "") -> dict:
    return {
        "source_id": source_id,
        "artifact": name,
        "path": str(path) if path else None,
        "bytes": path.stat().st_size if path and path.exists() else 0,
        "sha256": sha256_file(path) if path and path.exists() else None,
        "url": url,
        "fetched_at": _now(),
        "note": note,
    }


def ingest_cde_agency_directory() -> list[dict]:
    out = settings.raw / "fbi" / "agency_directory.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    agencies = cde.fetch_agency_directory()
    out.write_text(json.dumps(agencies, indent=1, sort_keys=True))
    console.print(f"  agency directory: [bold]{len(agencies):,}[/] ORIs")
    return [_record("fbi-cde-agency-directory", "agency_directory.json", out,
                    f"{settings.cde_origin}/agency/byStateAbbr/{{ST}}")]


def ingest_nibrs_agencies(year: int) -> list[dict]:
    dest = settings.raw / "fbi" / f"nibrs_agencies_{year}"
    manifest = cde.collect_agencies_csv(year, dest)
    ok = [m for m in manifest if m.get("path")]
    console.print(f"  NIBRS agencies.csv {year}: [bold]{len(ok)}[/]/{len(manifest)} states, "
                  f"{sum(m['bytes'] for m in ok) / 1e6:.1f} MB")
    return [_record("fbi-nibrs-agencies", Path(m["path"]).name, Path(m["path"]))
            for m in ok]


def ingest_pe_masters(years: list[int]) -> list[dict]:
    recs: list[dict] = []
    dest = settings.raw / "fbi" / "pe"
    dest.mkdir(parents=True, exist_ok=True)
    for y in years:
        try:
            fr = cde.fetch_pe_master(y, dest / f"pe-{y}.zip")
        except Exception as e:  # noqa: BLE001
            console.print(f"  [yellow]PE {y}: {e}[/]")
            continue
        note = ""
        if y > VINTAGES["pe_master_last_good"]:
            note = ("beyond the last known-good bulk year; the file is published but "
                    "zero-filled and is rejected at load time")
        recs.append(_record("fbi-ucr-pe-master", f"pe-{y}.zip", Path(fr.path), fr.url, note))
    console.print(f"  PE master files: [bold]{len(recs)}[/] years")
    return recs


def ingest_census_geography() -> list[dict]:
    recs: list[dict] = []
    dest = settings.raw / "census" / "geo"
    dest.mkdir(parents=True, exist_ok=True)
    for layer in ("place", "counties", "cousubs", "ua"):
        fr = census.fetch_gazetteer(layer, dest)
        recs.append(_record("census-gazetteer-2025", Path(fr.path).name, Path(fr.path), fr.url))
    for url in (census.UA_LIST_URL, census.UA_PLACE_XWALK_URL, census.UA_COUNTY_XWALK_URL,
                census.PLACE_BY_COUNTY_URL, census.PLACE_CODES_URL):
        fr = census.fetch_simple(url, dest)
        sid = ("census-urban-areas-2020" if "/ua/" in url or "ua_list" in url
               else "census-gazetteer-2025")
        recs.append(_record(sid, Path(fr.path).name, Path(fr.path), fr.url))
    console.print(f"  Census geography: [bold]{len(recs)}[/] files")
    return recs


def ingest_census_population() -> list[dict]:
    recs: list[dict] = []
    dest = settings.raw / "census" / "pep"
    dest.mkdir(parents=True, exist_ok=True)
    for level in ("place", "county", "state"):
        fr = census.fetch_pep(level, dest)
        recs.append(_record("census-pep-2025", Path(fr.path).name, Path(fr.path), fr.url))
    console.print(f"  PEP vintage {census.PEP_VINTAGE}: [bold]{len(recs)}[/] files")
    return recs


def ingest_acs() -> list[dict]:
    """ACS place and county totals. Place has no national wildcard: 51 requests."""
    dest = settings.raw / "census" / "acs"
    dest.mkdir(parents=True, exist_ok=True)
    recs: list[dict] = []
    vars_ = ["NAME", "B01003_001E", "B01003_001M"]

    places = census.acs5_places_all_states(vars_)
    p = dest / f"acs5_{census.ACS_VINTAGE}_places.json"
    p.write_text(json.dumps(places))
    recs.append(_record("census-acs5-2024", p.name, p,
                        f"{settings.census_api}/{census.ACS_VINTAGE}/acs/acs5"))

    counties = census.acs5_counties_national(vars_)
    c = dest / f"acs5_{census.ACS_VINTAGE}_counties.json"
    c.write_text(json.dumps(counties))
    recs.append(_record("census-acs5-2024", c.name, c,
                        f"{settings.census_api}/{census.ACS_VINTAGE}/acs/acs5"))

    console.print(f"  ACS {census.ACS_VINTAGE}: [bold]{len(places):,}[/] places, "
                  f"[bold]{len(counties):,}[/] counties")
    return recs


def ingest_finance(years: list[int]) -> list[dict]:
    recs: list[dict] = []
    dest = settings.raw / "census" / "finance"
    dest.mkdir(parents=True, exist_ok=True)
    for y in years:
        fr = finance.fetch_iuf(y, dest)
        note = ("Census of Governments year - full universe"
                if finance.is_census_of_governments_year(y)
                else "annual sample year - partial universe, see registry")
        recs.append(_record("census-gov-finance-2024", Path(fr.path).name,
                            Path(fr.path), fr.url, note))
    fr = finance.fetch_gus(2025, dest)
    recs.append(_record("census-gus-2025", Path(fr.path).name, Path(fr.path), fr.url))
    console.print(f"  Government finance: [bold]{len(recs)}[/] files")
    return recs


def ingest_bjs() -> list[dict]:
    from .util.http import download

    dest = settings.raw / "bjs"
    dest.mkdir(parents=True, exist_ok=True)
    fr = download("https://bjs.ojp.gov/media/67831/download", dest / "csllea18_tables.zip")
    console.print("  BJS CSLLEA 2018 aggregate tables: 1 file")
    return [_record("bjs-csllea-2018", "csllea18_tables.zip", Path(fr.path), fr.url,
                    "aggregate publication tables only; microdata is ICPSR auth-gated")]


def ingest_all(crime_years: tuple[int, int] = (2016, 2025)) -> Path:
    settings.ensure_dirs()
    records: list[dict] = []
    console.rule("[bold]Layer 1 — raw ingestion")
    records += ingest_cde_agency_directory()
    records += ingest_nibrs_agencies(VINTAGES["crime_last_complete_year"])
    records += ingest_pe_masters(list(range(crime_years[0], VINTAGES["pe_master_last_good"] + 1)))
    records += ingest_census_geography()
    records += ingest_census_population()
    records += ingest_acs()
    records += ingest_finance([2024, 2023, 2022])
    records += ingest_bjs()

    manifest = settings.raw / "manifest.json"
    write_manifest(manifest, records)
    total = sum(r["bytes"] for r in records)
    console.print(f"\n[bold green]raw ingest complete[/] — {len(records)} artifacts, "
                  f"{total / 1e6:.1f} MB, manifest at {manifest}")
    return manifest
