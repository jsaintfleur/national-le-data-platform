"""FIPS handling. Every FIPS field is a fixed-width STRING, never an integer.

The single most common defect in this domain is integer coercion eating a leading zero:
Alabama '01' becomes 1, place '00124' becomes 124, the 7-digit place GEOID '0100124'
becomes 100124. Enforce str on ingest and VARCHAR in the schema.
"""
from __future__ import annotations

STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09",
    "DE": "10", "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17",
    "IN": "18", "IA": "19", "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24",
    "MA": "25", "MI": "26", "MN": "27", "MS": "28", "MO": "29", "MT": "30", "NE": "31",
    "NV": "32", "NH": "33", "NJ": "34", "NM": "35", "NY": "36", "NC": "37", "ND": "38",
    "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46",
    "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54",
    "WI": "55", "WY": "56", "AS": "60", "GU": "66", "MP": "69", "PR": "72", "VI": "78",
}
FIPS_STATE = {v: k for k, v in STATE_FIPS.items()}

# The FBI's agency files use NCIC state codes, which are not USPS codes. Nebraska is "NB"
# in agencies.csv and "NE" everywhere in Census geography. 287 Nebraska agencies fail every
# geography join without this map, and they fail silently -- the agencies still appear, they
# just have no location and no rate.
STATE_ABBR_ALIASES = {"NB": "NE"}


def canonical_state_abbr(abbr: str | None) -> str | None:
    if not abbr:
        return None
    a = abbr.strip().upper()
    return STATE_ABBR_ALIASES.get(a, a)


def pad(value: object, width: int) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    return s.zfill(width)


def place_geoid(state_fips: str, place_fips: str) -> str | None:
    s, p = pad(state_fips, 2), pad(place_fips, 5)
    return f"{s}{p}" if s and p else None


def county_geoid(state_fips: str, county_fips: str) -> str | None:
    s, c = pad(state_fips, 2), pad(county_fips, 3)
    return f"{s}{c}" if s and c else None


def cousub_geoid(state_fips: str, county_fips: str, cousub_fips: str) -> str | None:
    s, c, u = pad(state_fips, 2), pad(county_fips, 3), pad(cousub_fips, 5)
    return f"{s}{c}{u}" if s and c and u else None


def strip_geoidfq(geoidfq: str | None) -> str | None:
    """'1600000US0100100' -> '0100100'."""
    if not geoidfq:
        return None
    return geoidfq.split("US", 1)[1] if "US" in geoidfq else geoidfq


# Connecticut abolished its eight counties; nine Planning Regions replaced them in the 2022
# geography vintage. codes2020/ still carries the old codes with CLASSFP=H4 / FUNCSTAT=N.
CT_LEGACY_COUNTIES = {"09001", "09003", "09005", "09007", "09009", "09011", "09013", "09015"}
CT_PLANNING_REGIONS = {
    "09110": "Capitol Planning Region",
    "09120": "Greater Bridgeport Planning Region",
    "09130": "Lower Connecticut River Valley Planning Region",
    "09140": "Naugatuck Valley Planning Region",
    "09150": "Northeastern Connecticut Planning Region",
    "09160": "Northwest Hills Planning Region",
    "09170": "South Central Connecticut Planning Region",
    "09180": "Southeastern Connecticut Planning Region",
    "09190": "Western Connecticut Planning Region",
}

# Places that are also county equivalents (CLASSFP C7). Joining one of these on a 5-digit
# county FIPS instead of a 7-digit place GEOID swaps, e.g., Fairfax city (~24k) for
# Fairfax County (~1.1M).
INDEPENDENT_CITY_CLASSFP = "C7"
CONSOLIDATED_CLASSFP = {"C8", "C9"}
