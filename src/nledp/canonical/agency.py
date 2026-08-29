"""dim_agency, agency_history, and the platform's agency-type taxonomy.

The spine is agencies.csv from the NIBRS state extracts, not the agency directory endpoint,
for one reason: it is the only published source carrying both the NIBRS ORI9 and the legacy
ORI9. ori7 is ALWAYS derived from legacy_ori, never from ori. On Delaware, legacy_ori[:7]
matches the PE master for 63 of 63 agencies while ori[:7] matches 62 -- the miss is
DE0029Z0X, whose legacy form is DE0029200. Scaled nationally that difference is hundreds of
agencies silently dropped from every staffing series.

The directory endpoint is still ingested: it covers agencies that are enrolled in UCR but
absent from NIBRS extracts, and it is the only source of point coordinates.
"""
from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path

from ..config import VINTAGES, settings
from ..util.fips import STATE_FIPS, canonical_state_abbr
from ..util.load import bulk_insert

# --- Agency-type classification ----------------------------------------------------------
# The FBI's agency_type_name is coarse: "County" covers both a sheriff's office and a county
# police department, and "Other" covers everything from a port authority to a fire marshal.
# The platform derives a finer type from the agency NAME and records BOTH labels, so a user
# can always see the federal label and the platform's reading of it side by side.

_NAME_RULES: list[tuple[str, str]] = [
    (r"\bSHERIFF", "county_sheriff"),
    (r"\b(STATE POLICE|STATE PATROL|HIGHWAY PATROL|DEPARTMENT OF PUBLIC SAFETY)\b",
     "state_police"),
    (r"\b(UNIVERSITY|COLLEGE|CAMPUS|SCHOOL DISTRICT|BOARD OF EDUCATION)\b", "university_police"),
    (r"\b(TRANSIT|METRO(POLITAN)? TRANSIT|RAIL|RAILROAD|SUBWAY|BUS)\b", "transit_police"),
    (r"\b(AIRPORT|PORT AUTHORITY|SEAPORT|HARBOR|MARITIME)\b", "port_or_airport_police"),
    (r"\b(PARK|FOREST|CONSERVATION|FISH AND WILDLIFE|WILDLIFE|NATURAL RESOURCES)\b",
     "park_or_conservation_police"),
    (r"\b(TRIBAL|NATION|PUEBLO|BAND OF|RESERVATION|INDIAN)\b", "tribal_police"),
    (r"\b(MARSHAL|CONSTABLE)\b", "marshal_or_constable"),
    (r"\b(HOSPITAL|MEDICAL CENTER|HEALTH)\b", "special_jurisdiction"),
    (r"\b(HOUSING AUTHORITY)\b", "special_jurisdiction"),
]

_SOURCE_TYPE_MAP = {
    "city": "municipal_police",
    "county": "county_sheriff",
    "state police": "state_police",
    "university or college": "university_police",
    "tribal": "tribal_police",
    "federal": "federal",
    "other state agency": "state_special_jurisdiction",
    "other": "special_jurisdiction",
}

# Agency types whose served population is transient and nested inside another agency's
# jurisdiction. A per-resident rate for these is not a weak estimate, it is a category
# error, so they are excluded from every rate metric and reported as counts only.
_RATE_INELIGIBLE = {
    "university_police", "transit_police", "port_or_airport_police",
    "park_or_conservation_police", "special_jurisdiction", "state_special_jurisdiction",
    "federal", "marshal_or_constable",
    # State police are excluded for a different reason: their jurisdiction OVERLAPS every
    # local agency in the state. Dividing a state police agency's offenses by the state
    # population produces a number that looks like a crime rate and is not one, because
    # the same residents are already in every local agency's denominator.
    "state_police",
}


def classify_agency(name: str, source_type: str | None) -> str:
    upper = (name or "").upper()
    st = (source_type or "").strip().lower()
    # A name rule wins over the coarse federal label, except that the federal "City" label
    # is trusted when no name rule fires.
    for pattern, label in _NAME_RULES:
        if re.search(pattern, upper):
            if label == "county_sheriff" and st == "city":
                return "county_sheriff"  # a sheriff mislabelled City is still a sheriff
            return label
    mapped = _SOURCE_TYPE_MAP.get(st)
    if mapped == "county_sheriff" and "POLICE" in upper and "SHERIFF" not in upper:
        return "county_police"
    return mapped or "other"


def normalize_name(name: str) -> str:
    """Normalized agency name for deterministic matching.

    Strips the department words and punctuation that vary between sources, so
    "Camden Police Department", "CAMDEN PD" and "Camden Police Dept." collapse together.
    """
    s = (name or "").upper()
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    s = re.sub(
        r"\b(POLICE DEPARTMENT|POLICE DEPT|DEPARTMENT OF POLICE|POLICE|DEPARTMENT|DEPT|"
        r"OFFICE|BUREAU|DIVISION|DIV|PD|SO|CO|COUNTY SHERIFFS?|SHERIFFS?|"
        r"PUBLIC SAFETY|DPS|MARSHALS?|THE|OF|CITY OF|TOWN OF|VILLAGE OF|BOROUGH OF|"
        r"TOWNSHIP OF|UNIVERSITY OF|STATE)\b",
        " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _read_agencies_csv(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def _i(v) -> int | None:
    try:
        s = str(v).strip()
        return int(s) if s and s.lstrip("-").isdigit() else None
    except (TypeError, ValueError):
        return None


def _b(v) -> bool:
    return str(v).strip().upper() in {"Y", "YES", "TRUE", "1"}


def build_dim_agency(con) -> tuple[int, int]:
    # Union every ingested NIBRS agency-dimension year. Agencies drop in and out of NIBRS
    # participation, so a single year misses legacy_ori for thousands of agencies -- the Los
    # Angeles County Sheriff's Office among them, at 14,340 employees. Later years win on
    # conflict, so current attributes are preserved while historical identifiers are recovered.
    directory = json.loads((settings.raw / "fbi" / "agency_directory.json").read_text())
    dir_by_ori = {d["ori"]: d for d in directory}

    agencies: dict[str, dict] = {}
    history: list[tuple] = []

    nibrs_dirs = sorted((settings.raw / "fbi").glob("nibrs_agencies_*"))
    csv_files = [f for d in nibrs_dirs for f in sorted(d.glob("agencies_*.csv"))]
    csv_files.sort(key=lambda p: p.stem.rsplit("_", 1)[-1])   # ascending year
    for f in csv_files:
        for r in _read_agencies_csv(f):
            ori = (r.get("ori") or "").strip()
            if not ori:
                continue
            legacy = (r.get("legacy_ori") or "").strip() or None
            name = (r.get("pub_agency_name") or r.get("ucr_agency_name") or "").strip()
            unit = (r.get("pub_agency_unit") or "").strip()
            display = f"{name} ({unit})" if unit and unit not in name else name
            src_type = (r.get("agency_type_name") or "").strip()
            agencies[ori] = {
                "ori9_nibrs": ori,
                "ori9_legacy": legacy,
                # ALWAYS from legacy_ori. Deriving ORI7 from ori loses agencies whose two
                # forms differ in positions 7-9.
                "ori7": legacy[:7] if legacy else None,
                "ori7_source": "legacy_ori" if legacy else None,
                "covered_by_legacy_ori": (r.get("covered_by_legacy_ori") or "").strip() or None,
                "agency_name": display,
                "agency_name_normalized": normalize_name(name),
                "ucr_agency_name": (r.get("ucr_agency_name") or "").strip() or None,
                "ncic_agency_name": (r.get("ncic_agency_name") or "").strip() or None,
                "agency_type": classify_agency(f"{name} {unit}", src_type),
                "agency_type_source": src_type or None,
                "agency_status": (r.get("agency_status") or "").strip() or None,
                "is_dormant": _b(r.get("dormant_flag")),
                "dormant_year": _i(r.get("dormant_year")),
                "is_covered_by_parent": bool((r.get("covered_by_legacy_ori") or "").strip()),
                "county_name": (r.get("county_name") or "").strip() or None,
                "msa_name": (r.get("msa_name") or "").strip() or None,
                "state_abbr": canonical_state_abbr(r.get("state_abbr")),
                "state_abbr_as_reported": (r.get("state_abbr") or "").strip() or None,
                "population_group_code": (r.get("population_group_code") or "").strip() or None,
                "population_group_desc": (r.get("population_group_desc") or "").strip() or None,
                "fbi_population_served": _i(r.get("population")),
                "nibrs_start_date": (r.get("nibrs_start_date") or "").strip() or None,
                "data_year": _i(r.get("data_year")),
            }
            if _b(r.get("dormant_flag")):
                history.append((ori, _i(r.get("dormant_year")), "dormant", None, "Y",
                                "Agency flagged dormant in the FBI agency dimension."))
            cov = (r.get("covered_by_legacy_ori") or "").strip()
            if cov:
                history.append((ori, _i(r.get("data_year")), "covered_by_parent", None, cov,
                                "Reports are submitted under a parent ORI. Counting this "
                                "agency and its parent separately double-counts."))

    # Agencies present in the live directory but absent from the NIBRS extracts.
    for ori, d in dir_by_ori.items():
        if ori in agencies:
            continue
        name = (d.get("agency_name") or "").strip()
        agencies[ori] = {
            "ori9_nibrs": ori, "ori9_legacy": None,
            # No legacy_ori was ever observed for this agency in any ingested NIBRS year.
            # Fall back to the NIBRS ORI's first seven characters so the agency still joins
            # to the PE master, and record that the derivation is provisional: the two forms
            # differ for a minority of agencies, and this join could be wrong for them.
            "ori7": ori[:7], "ori7_source": "nibrs_ori_fallback",
            "covered_by_legacy_ori": None,
            "agency_name": name, "agency_name_normalized": normalize_name(name),
            "ucr_agency_name": None, "ncic_agency_name": None,
            "agency_type": classify_agency(name, d.get("agency_type_name")),
            "agency_type_source": d.get("agency_type_name"),
            "agency_status": None, "is_dormant": False, "dormant_year": None,
            "is_covered_by_parent": False,
            "county_name": (d.get("counties") or "").strip() or None, "msa_name": None,
            "state_abbr": canonical_state_abbr(d.get("state_abbr")),
            "state_abbr_as_reported": d.get("state_abbr"),
            "population_group_code": None, "population_group_desc": None,
            "fbi_population_served": None,
            "nibrs_start_date": d.get("nibrs_start_date"),
            "data_year": None,
        }

    rows: list[tuple] = []
    for ori, a in agencies.items():
        d = dir_by_ori.get(ori, {})
        atype = a["agency_type"]
        rows.append((
            ori, a["ori9_nibrs"], a["ori9_legacy"], a["ori7"], a.get("ori7_source"),
            a["covered_by_legacy_ori"],
            a["agency_name"], a["agency_name_normalized"], a["ucr_agency_name"],
            a["ncic_agency_name"], atype, a["agency_type_source"], a["agency_status"],
            a["is_dormant"], a["dormant_year"], a["is_covered_by_parent"],
            None,  # city: resolved in agency_crosswalk, never guessed here
            a["county_name"], a["msa_name"], a["state_abbr"],
            a.get("state_abbr_as_reported"), STATE_FIPS.get(a["state_abbr"] or ""),
            d.get("latitude"), d.get("longitude"),
            "county" if atype in {"county_sheriff", "county_police"}
            else "state" if atype in {"state_police", "state_special_jurisdiction"}
            else "municipal" if atype == "municipal_police" else "special",
            a["population_group_code"], a["population_group_desc"],
            a["fbi_population_served"],
            bool(d.get("is_nibrs")) if d else None,
            a["nibrs_start_date"], None, a["data_year"],
            atype not in _RATE_INELIGIBLE,
            "fbi-nibrs-agencies" if a["ori9_legacy"] else "fbi-cde-agency-directory",
        ))

    n = bulk_insert(con, "dim_agency", rows)
    h = bulk_insert(con, "agency_history",
                    [(a, y, t, o, nv, note) for a, y, t, o, nv, note in history])
    return n, h
