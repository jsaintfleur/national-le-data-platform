"""Layer 3 dimension builders: source, metric, time, geography."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from ..config import VINTAGES, settings
from ..util.load import bulk_insert
from ..connectors import census
from ..util.fips import (
    CT_LEGACY_COUNTIES, CONSOLIDATED_CLASSFP, FIPS_STATE, INDEPENDENT_CITY_CLASSFP,
    strip_geoidfq,
)


def _flat(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, (list, tuple)):
        return " | ".join(str(x) for x in v)
    return str(v)


def build_dim_source(con) -> int:
    spec = yaml.safe_load((settings.registry / "sources.yaml").read_text())
    rows = []
    for s in spec["sources"]:
        rows.append((
            s["source_id"], s.get("source_name"), s.get("publisher"), s.get("dataset_name"),
            _flat(s.get("dataset_description")), s.get("source_url"),
            s.get("documentation_url"), s.get("access_method"), s.get("api_endpoint"),
            _flat(s.get("geographic_level")), s.get("coverage_start_year"),
            s.get("coverage_end_year"), s.get("update_frequency"),
            _flat(s.get("latest_release_date")), s.get("license"),
            s.get("primary_identifier"), _flat(s.get("known_limitations")),
            s.get("ingestion_status"), s.get("validation_status"),
            s.get("verified_http_status"),
        ))
    return bulk_insert(con, "dim_source", rows)


def build_dim_metric(con) -> int:
    spec = yaml.safe_load((settings.registry / "metrics.yaml").read_text())
    rows = []
    for m in spec["metrics"]:
        rows.append((
            m["metric_id"], m.get("display_name"), _flat(m.get("description")),
            m.get("formula"), m.get("numerator"), m.get("denominator"), m.get("unit"),
            _flat(m.get("source")), _flat(m.get("frequency")),
            _flat(m.get("preferred_visualization")),
            bool(m.get("comparison_allowed", False)),
            bool(m.get("ranking_allowed", False)),
            m.get("attribution_level"), _flat(m.get("limitations")),
        ))
    return bulk_insert(con, "dim_metric", rows)


def build_dim_time(con, start: int = 1985, end: int = 2026) -> int:
    last_complete = VINTAGES["crime_last_complete_year"]
    rows = []
    for y in range(start, end + 1):
        notes = []
        if y == 2021:
            notes.append(
                "SRS-to-NIBRS transition year; roughly 31% of agencies had not onboarded. "
                "Several FBI CIUS table families skip 2021 entirely."
            )
        if y > last_complete:
            notes.append(
                "Incomplete submission. National monthly violent-crime offenses fall from "
                "87,397 in Dec 2025 to 4,696 in Aug 2026; levels and year-over-year change "
                "are not computable."
            )
        rows.append((y, y <= last_complete, y <= last_complete, y % 5 == 2,
                     " ".join(notes) or None))
    return bulk_insert(con, "dim_time", rows)


# --- Geography ---------------------------------------------------------------------------

def _urbanicity_band(pop: float | None) -> str:
    if pop is None:
        return "Rural (outside any urban area)"
    if pop >= 200_000:
        return "Large urban"
    if pop >= 50_000:
        return "Urban"
    if pop >= 5_000:
        return "Small urban"
    return "Rural (outside any urban area)"


def build_dim_geography(con) -> int:
    geo_dir = settings.raw / "census" / "geo"
    rows: list[tuple] = []

    # Place attributes (CLASSFP, TYPE) come from the 2020 code list; geometry and the
    # authoritative current name come from the 2025 Gazetteer.
    place_class: dict[str, dict] = {}
    pc = geo_dir / "national_place2020.txt"
    if pc.exists():
        for r in census.read_pipe_table(pc):
            gid = (r.get("STATEFP") or "") + (r.get("PLACEFP") or "")
            place_class[gid] = {"classfp": r.get("CLASSFP"), "type": r.get("TYPE")}

    # Urban-area assignment for places. Rural places have empty UA fields -- that is the
    # rural signal, not a parse error. Places split across urban and rural appear on
    # several rows, so keep the row with the largest urban land part.
    ua_by_place: dict[str, tuple[str, str, float]] = {}
    xw = geo_dir / "tab20_ua20_place20_natl.txt"
    if xw.exists():
        for r in census.read_pipe_table(xw):
            pid = (r.get("GEOID_PLACE_20") or "").strip()
            uace = (r.get("GEOID_UA_20") or "").strip()
            if not pid or not uace:
                continue
            try:
                part = float(r.get("AREALAND_PART") or 0)
            except ValueError:
                part = 0.0
            prev = ua_by_place.get(pid)
            if prev is None or part > prev[2]:
                ua_by_place[pid] = (uace.zfill(5), (r.get("NAMELSAD_UA_20") or "").strip(), part)

    ua_pop: dict[str, float] = {}
    ual = geo_dir / "2020_Census_ua_list_all.xlsx"
    if ual.exists():
        for r in census.read_ua_list(ual):
            try:
                ua_pop[str(r["UACE"]).zfill(5)] = float(r.get("POP") or 0)
            except (ValueError, TypeError):
                continue

    def add(level: str, rec: dict) -> None:
        rows.append((
            f"{level}:{rec['geoid']}", level, rec["geoid"], rec.get("name"),
            rec.get("state_abbr"), rec.get("state_fips"), rec.get("county_fips"),
            rec.get("place_fips"), rec.get("cousub_fips"), rec.get("classfp"),
            rec.get("funcstat"), rec.get("lsad"), rec.get("land_sqmi"),
            rec.get("water_sqmi"), rec.get("latitude"), rec.get("longitude"),
            rec.get("uace"), rec.get("urban_area_name"), rec.get("urbanicity_band"),
            rec.get("is_independent_city", False), rec.get("is_consolidated", False),
            VINTAGES["gazetteer"], "census-gazetteer-2025",
        ))

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    # Counties from the Gazetteer -- NOT from codes2020/, which is frozen at the 2020
    # vintage and still lists the eight abolished Connecticut counties.
    cz = geo_dir / f"{census.GAZ_YEAR}_Gaz_counties_national.zip"
    if cz.exists():
        for r in census.read_gazetteer(cz):
            gid = (r.get("GEOID") or strip_geoidfq(r.get("GEOIDFQ")) or "").zfill(5)
            if not gid or gid in CT_LEGACY_COUNTIES:
                continue
            add("county", {
                "geoid": gid, "name": r.get("NAME"), "state_abbr": r.get("USPS"),
                "state_fips": gid[:2], "county_fips": gid[2:],
                "land_sqmi": num(r.get("ALAND_SQMI")), "water_sqmi": num(r.get("AWATER_SQMI")),
                "latitude": num(r.get("INTPTLAT")), "longitude": num(r.get("INTPTLONG")),
            })

    pz = geo_dir / f"{census.GAZ_YEAR}_Gaz_place_national.zip"
    if pz.exists():
        for r in census.read_gazetteer(pz):
            gid = (r.get("GEOID") or strip_geoidfq(r.get("GEOIDFQ")) or "").zfill(7)
            if not gid:
                continue
            cls = place_class.get(gid, {}).get("classfp")
            uace, ua_name, _ = ua_by_place.get(gid, (None, None, 0.0))
            add("place", {
                "geoid": gid, "name": r.get("NAME"), "state_abbr": r.get("USPS"),
                "state_fips": gid[:2], "place_fips": gid[2:], "classfp": cls,
                "funcstat": r.get("FUNCSTAT"), "lsad": r.get("LSAD"),
                "land_sqmi": num(r.get("ALAND_SQMI")), "water_sqmi": num(r.get("AWATER_SQMI")),
                "latitude": num(r.get("INTPTLAT")), "longitude": num(r.get("INTPTLONG")),
                "uace": uace, "urban_area_name": ua_name,
                "urbanicity_band": _urbanicity_band(ua_pop.get(uace) if uace else None),
                "is_independent_city": cls == INDEPENDENT_CITY_CLASSFP,
                "is_consolidated": cls in CONSOLIDATED_CLASSFP,
            })

    # County subdivisions: the general-purpose local government, and therefore the police
    # jurisdiction, throughout New England.
    sz = geo_dir / f"{census.GAZ_YEAR}_Gaz_cousubs_national.zip"
    if sz.exists():
        for r in census.read_gazetteer(sz):
            gid = (r.get("GEOID") or strip_geoidfq(r.get("GEOIDFQ")) or "").zfill(10)
            if not gid:
                continue
            add("cousub", {
                "geoid": gid, "name": r.get("NAME"), "state_abbr": r.get("USPS"),
                "state_fips": gid[:2], "county_fips": gid[2:5], "cousub_fips": gid[5:],
                "funcstat": r.get("FUNCSTAT"),
                "land_sqmi": num(r.get("ALAND_SQMI")), "water_sqmi": num(r.get("AWATER_SQMI")),
                "latitude": num(r.get("INTPTLAT")), "longitude": num(r.get("INTPTLONG")),
            })

    for fips, abbr in sorted(FIPS_STATE.items()):
        add("state", {"geoid": fips, "name": abbr, "state_abbr": abbr, "state_fips": fips})

    return bulk_insert(con, "dim_geography", rows)
