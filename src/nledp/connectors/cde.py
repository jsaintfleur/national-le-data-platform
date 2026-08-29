"""FBI Crime Data Explorer / UCR connectors.

Three facts from the Phase 0 audit drive everything in this module:

1. ORI is not one identifier, it is three. The CDE API emits a NIBRS ORI9 that may carry
   an alphanumeric tail ("DE0029Z0X"). The SRS-era fixed-width master files key on ORI7.
   The correct bridge is ``legacy_ori[:7]`` -- NOT ``ori[:7]``, which silently drops
   agencies whose two forms differ in positions 7-9. ``agencies.csv`` inside each NIBRS
   state ZIP is the only published source carrying both forms, which is why it, and not
   the agency directory endpoint, is the spine of dim_agency.

2. ``pe-2025.zip`` downloads cleanly and is a zero-filled shell: 26,288 records, every
   employment count 0. Bulk PE is trustworthy only through 2024. The 2025 staffing values
   come from the API and from agencies.csv.

3. There is no national agency download endpoint. The directory is per-state.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..config import STATES, TERRITORIES, settings
from ..util.http import FetchResult, RemoteZip, _client, download, get_json


def _origin() -> str:
    return settings.cde_origin


def signed_url(key: str) -> str:
    """Resolve an S3 object key to a presigned URL. Expires in 900 seconds."""
    payload = get_json(f"{_origin()}/s3/signedurl", {"key": key})
    if isinstance(payload, dict) and payload:
        return str(next(iter(payload.values())))
    raise RuntimeError(f"unexpected signedurl payload for {key!r}: {payload!r}")


# --- 1. Agency directory ----------------------------------------------------------------

def fetch_agency_directory(include_territories: bool = True) -> list[dict]:
    """Live ORI directory. One request per state; the response is keyed by county name."""
    out: list[dict] = []
    scopes = STATES + (TERRITORIES if include_territories else [])
    for st in scopes:
        payload = get_json(f"{_origin()}/agency/byStateAbbr/{st}")
        if not isinstance(payload, dict):
            continue
        for county_key, agencies in payload.items():
            if not isinstance(agencies, list):
                continue
            for a in agencies:
                if isinstance(a, dict) and a.get("ori"):
                    out.append({**a, "_county_key": county_key})
    # An ORI can appear under several county keys for multi-county agencies.
    dedup: dict[str, dict] = {}
    for rec in out:
        dedup.setdefault(rec["ori"], rec)
    return list(dedup.values())


# --- 2. NIBRS agencies.csv (the real agency dimension) ----------------------------------

AGENCIES_MEMBER = "agencies.csv"


def fetch_state_agencies_csv(state: str, year: int) -> bytes | None:
    """Pull only agencies.csv out of a NIBRS state ZIP using HTTP range requests.

    California 2025 is a 117 MB archive; agencies.csv inside it is 320 KB. Reading the
    central directory and fetching one member turns a ~2 GB national download into ~40 MB.
    """
    try:
        url = signed_url(f"nibrs/incident/{year}/{state}-{year}.zip")
    except Exception:
        return None
    try:
        with RemoteZip(url) as rz:
            return rz.read(AGENCIES_MEMBER)
    except Exception:
        return None


def collect_agencies_csv(year: int, dest_dir: Path, states: list[str] | None = None) -> list[dict]:
    """Fetch agencies.csv for every state and land the raw bytes unchanged."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    for st in (states or STATES):
        out = dest_dir / f"agencies_{st}_{year}.csv"
        if out.exists():
            manifest.append({"state": st, "year": year, "path": str(out),
                             "bytes": out.stat().st_size, "from_cache": True})
            continue
        data = fetch_state_agencies_csv(st, year)
        if data is None:
            manifest.append({"state": st, "year": year, "path": None, "bytes": 0,
                             "error": "no NIBRS archive or member for this state-year"})
            continue
        out.write_bytes(data)
        manifest.append({"state": st, "year": year, "path": str(out),
                         "bytes": len(data), "from_cache": False})
    return manifest


# --- 3. Police Employee (PE) master files -----------------------------------------------
# Fixed-width, LRECL 7689, ORI7. Layout confirmed against the FBI's own
# "Police Employee Record Description" and validated numerically: Anchorage 2024 parses to
# 322 + 44 + 44 + 124 = 534 total employees, matching the API exactly.

PE_LAYOUT = {
    "record_type": (0, 1),
    "state_code_numeric": (1, 3),
    "ori7": (3, 10),
    "group": (10, 12),
    "year2": (13, 15),
    "sequence": (15, 20),
    "population": (23, 32),
    "agency_name": (32, 56),
    "state_name": (56, 62),
    "male_officers": (62, 67),
    "male_civilians": (67, 72),
    "male_total": (72, 77),
    "female_officers": (77, 82),
    "female_civilians": (82, 87),
    "female_total": (87, 92),
    "total_employees": (92, 97),
    "officer_rate_x10": (97, 100),
    "employee_rate_x10": (100, 103),
}


def parse_pe_record(line: str) -> dict | None:
    if len(line) < 103 or not line.startswith("5"):
        return None
    rec: dict = {}
    for field, (a, b) in PE_LAYOUT.items():
        rec[field] = line[a:b].strip()
    for k in ("population", "male_officers", "male_civilians", "male_total",
              "female_officers", "female_civilians", "female_total", "total_employees",
              "officer_rate_x10", "employee_rate_x10"):
        v = rec.get(k, "")
        rec[k] = int(v) if v.isdigit() else None
    yy = rec.get("year2") or ""
    if yy.isdigit():
        n = int(yy)
        rec["data_year"] = 1900 + n if n >= 80 else 2000 + n
    else:
        rec["data_year"] = None
    return rec


def fetch_pe_master(year: int, dest: Path) -> FetchResult:
    return download(signed_url(f"master_files/pe/pe-{year}.zip"), dest)


def read_pe_master(zip_path: Path) -> list[dict]:
    import zipfile

    rows: list[dict] = []
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if name.lower().endswith((".txt", ".dat")) or "/" not in name:
                if name.lower().endswith((".pdf", ".doc", ".docx")):
                    continue
                with zf.open(name) as fh:
                    text = io.TextIOWrapper(fh, encoding="latin-1", newline="")
                    for line in text:
                        rec = parse_pe_record(line.rstrip("\r\n"))
                        if rec:
                            rows.append(rec)
    return rows


# --- 4. Agency-level employment from the API (covers 2025, which bulk does not) ----------

def fetch_pe_agency(state: str, ori: str, from_year: int, to_year: int) -> dict | None:
    try:
        return get_json(f"{_origin()}/pe/{state}/{ori}",
                        {"from": str(from_year), "to": str(to_year)})  # type: ignore[return-value]
    except Exception:
        return None


# --- 5. Summarized crime (SRS + NIBRS-derived), agency grain ----------------------------
# Date parameters are MM-YYYY. A bare YYYY returns HTTP 400.

OFFENSES = [
    "violent-crime", "homicide", "rape", "robbery", "aggravated-assault",
    "property-crime", "burglary", "larceny", "motor-vehicle-theft", "arson",
]


def fetch_summarized(level: str, key: str | None, offense: str,
                     from_year: int, to_year: int) -> dict | None:
    if level == "national":
        path = f"{_origin()}/summarized/national/{offense}"
    elif level == "state":
        path = f"{_origin()}/summarized/state/{key}/{offense}"
    elif level == "agency":
        path = f"{_origin()}/summarized/agency/{key}/{offense}"
    else:
        raise ValueError(f"unknown level {level!r}")
    try:
        return get_json(path, {"from": f"01-{from_year}", "to": f"12-{to_year}",
                               "type": "counts"})  # type: ignore[return-value]
    except Exception:
        return None


def refresh_dates() -> dict | None:
    try:
        return get_json(f"{_origin()}/refresh-date")  # type: ignore[return-value]
    except Exception:
        return None
