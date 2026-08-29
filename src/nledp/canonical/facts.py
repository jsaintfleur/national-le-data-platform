"""Layer 3 fact builders.

Two rules are enforced structurally rather than by convention:

* A missing value is never a zero. An agency that did not report staffing is absent from
  fact_staffing, not present with 0 officers. The distinction is the difference between
  "this department has no officers" and "we do not know".
* A rate is never computed across mismatched years. Numerator and denominator carry their
  own observation year and the analytics layer refuses to divide across them.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
from pathlib import Path

from ..config import VINTAGES, settings
from ..connectors import census, cde, finance
from ..util.fips import STATE_FIPS
from ..util.load import bulk_insert


def _i(v):
    try:
        s = str(v).strip()
        return int(float(s)) if s and s.replace(".", "").lstrip("-").isdigit() else None
    except (TypeError, ValueError):
        return None


def _b(v) -> bool:
    return str(v).strip().upper() in {"Y", "YES", "TRUE", "1"}


# --- Staffing -----------------------------------------------------------------------------

def build_fact_staffing(con) -> int:
    """PE master files by ORI7, plus the current year from the NIBRS agency dimension.

    The ORI7 join goes through dim_agency.ori7, which is derived from legacy_ori. Joining on
    substr(ori,1,7) instead would drop every agency whose NIBRS and legacy ORIs differ in
    positions 7-9.
    """
    # ORI7 is NOT unique. Fourteen distinct ORI9s share the ORI7 "CA01999", and the pattern
    # repeats wherever a state uses a county-99 block for special agencies. Mapping an
    # ambiguous ORI7 to whichever agency happened to be read first would attribute one
    # department's officers to another, so ambiguous ORI7s are refused and logged instead.
    ori7_rows: dict[str, list[tuple[str, str, str]]] = {}
    for ori7, aid, src, name in con.execute(
        "SELECT ori7, agency_id, ori7_source, agency_name_normalized FROM dim_agency "
        "WHERE ori7 IS NOT NULL"
    ).fetchall():
        ori7_rows.setdefault(ori7, []).append((aid, src, name or ""))

    ori7_to_agency = {k: v[0][0] for k, v in ori7_rows.items() if len(v) == 1}
    ori7_method = {
        k: ("ori7_from_legacy" if v[0][1] == "legacy_ori" else "ori7_fallback")
        for k, v in ori7_rows.items() if len(v) == 1
    }
    contested = {k: v for k, v in ori7_rows.items() if len(v) > 1}
    ori7_candidates = contested          # kept for disambiguation at record level
    ambiguous_ori7 = dict(contested)     # entries resolved below are removed

    rows: list[tuple] = []
    rejected_years: list[int] = []
    dup_keys: list[tuple[str, int]] = []

    pe_rows: dict[tuple, tuple] = {}
    resolved_ori7: dict[str, str] = {}
    pe_dir = settings.raw / "fbi" / "pe"
    for zp in sorted(pe_dir.glob("pe-*.zip")):
        year = int(zp.stem.split("-")[1])
        recs = cde.read_pe_master(zp)
        total = sum(r["total_employees"] or 0 for r in recs)
        if total == 0:
            # pe-2025.zip is published and zero-filled. Loading it would replace real
            # staffing with a national workforce of zero.
            rejected_years.append(year)
            continue
        for r in recs:
            aid = ori7_to_agency.get(r["ori7"])
            method = ori7_method.get(r["ori7"])
            if aid is None:
                aid, method = _disambiguate_ori7(
                    r, ori7_candidates.get(r["ori7"]), resolved_ori7)
            if aid is None:
                continue
            dy = r["data_year"] or year
            sworn = (r["male_officers"] or 0) + (r["female_officers"] or 0)
            civ = (r["male_civilians"] or 0) + (r["female_civilians"] or 0)
            if r["total_employees"] is None:
                continue                      # not reported: absent, not zero
            key = (aid, dy, "fbi-ucr-pe-master")
            cand = (aid, dy, sworn, civ, r["total_employees"],
                    r["male_officers"], r["female_officers"],
                    r["male_civilians"], r["female_civilians"],
                    r["population"], "reported",
                    method or "ori7_fallback", "fbi-ucr-pe-master")
            prev = pe_rows.get(key)
            if prev is None:
                pe_rows[key] = cand
            elif prev[4] != cand[4]:
                # Two PE records share an ORI7 within one year and disagree. Keep the larger
                # and log it; silently picking one would be indistinguishable from a real
                # staffing change in the time series.
                dup_keys.append((aid, dy))
                if (cand[4] or 0) > (prev[4] or 0):
                    pe_rows[key] = cand

    rows.extend(pe_rows.values())

    # Current-year staffing from agencies.csv, which carries PE fields inline.
    year = VINTAGES["crime_last_complete_year"]
    nibrs_dir = settings.raw / "fbi" / f"nibrs_agencies_{year}"
    nibrs_rows: dict[tuple, tuple] = {}
    for f in sorted(nibrs_dir.glob("agencies_*.csv")):
        text = f.read_text(encoding="utf-8-sig", errors="replace")
        for r in csv.DictReader(io.StringIO(text)):
            if not _b(r.get("pe_reported_flag")):
                continue
            ori = (r.get("ori") or "").strip()
            if ori not in ori7_to_agency.values() and ori is None:
                continue
            mo, mc = _i(r.get("male_officer")), _i(r.get("male_civilian"))
            fo, fc = _i(r.get("female_officer")), _i(r.get("female_civilian"))
            if mo is None and fo is None:
                continue
            sworn = (mo or 0) + (fo or 0)
            civ = (mc or 0) + (fc or 0)
            nibrs_rows[(ori, _i(r.get("data_year")) or year, "fbi-nibrs-agencies")] = (
                ori, _i(r.get("data_year")) or year, sworn, civ, sworn + civ,
                mo, fo, mc, fc, _i(r.get("population")), "reported", "direct_ori9",
                "fbi-nibrs-agencies")
    rows.extend(nibrs_rows.values())

    valid = {r[0] for r in con.execute("SELECT agency_id FROM dim_agency").fetchall()}
    rows = [r for r in rows if r[0] in valid]
    n = bulk_insert(con, "fact_staffing", rows)
    for o7 in resolved_ori7:
        ambiguous_ori7.pop(o7, None)
    if resolved_ori7:
        con.executemany(
            "INSERT INTO data_quality_log VALUES (?,?,?,?,?,?,?,?,?)",
            [("ori7_disambiguated", "info", "fact_staffing", aid, None,
              "This ORI7 is shared by more than one agency, and the employment record was "
              "attributed to the one agency that is both the primary ORI (ending 00) and a "
              "name match to the record. Sub-unit ORIs sharing the same ORI7 were not "
              "candidates.", f"ORI7 {o7}", "one agency per ORI7", None)
             for o7, aid in sorted(resolved_ori7.items())])
    if ambiguous_ori7:
        con.executemany(
            "INSERT INTO data_quality_log VALUES (?,?,?,?,?,?,?,?,?)",
            [("ambiguous_ori7", "warning", "fact_staffing", k, None,
              "This ORI7 is shared by more than one ORI9, so a PE master record keyed on it "
              "cannot be attributed to a single agency. Staffing from the bulk file is not "
              "loaded for these agencies.",
              f"{len(v)} agencies share ORI7 {k}", "1 agency per ORI7", None)
             for k, v in sorted(ambiguous_ori7.items())])
    if dup_keys:
        con.executemany(
            "INSERT INTO data_quality_log VALUES (?,?,?,?,?,?,?,?,?)",
            [("duplicate_agency_year_staffing", "warning", "fact_staffing", a, y,
              "Two PE master records for this agency-year disagree on total employees. The "
              "larger value was kept.", "conflicting records", "one record per agency-year",
              None) for a, y in sorted(set(dup_keys))])
    if rejected_years:
        con.executemany(
            "INSERT INTO data_quality_log VALUES (?,?,?,?,?,?,?,?,?)",
            [("pe_zero_filled_year", "error", "fact_staffing", None, y,
              "PE master file for this year is published but zero-filled; it was rejected "
              "at load time rather than loaded as a workforce of zero.",
              "sum(total_employees)=0", "sum(total_employees)>0", None)
             for y in rejected_years])
    return n


# --- Reporting participation ---------------------------------------------------------------

def build_fact_reporting(con) -> int:
    year = VINTAGES["crime_last_complete_year"]
    nibrs_dir = settings.raw / "fbi" / f"nibrs_agencies_{year}"
    seen: set[tuple[str, int]] = set()
    rows: list[tuple] = []
    for f in sorted(nibrs_dir.glob("agencies_*.csv")):
        text = f.read_text(encoding="utf-8-sig", errors="replace")
        for r in csv.DictReader(io.StringIO(text)):
            ori = (r.get("ori") or "").strip()
            dy = _i(r.get("data_year")) or year
            if not ori or (ori, dy) in seen:
                continue
            seen.add((ori, dy))
            rows.append((ori, dy, _b(r.get("participated")),
                         _b(r.get("nibrs_participated")), _b(r.get("pe_reported_flag")),
                         _b(r.get("publishable_flag")), None, None,
                         "fbi-nibrs-agencies"))
    return bulk_insert(con, "fact_reporting", rows)


# --- Population -----------------------------------------------------------------------------

def build_fact_demographics(con) -> int:
    rows: list[tuple] = []

    pep_dir = settings.raw / "census" / "pep"
    place_csv = pep_dir / f"sub-est{census.PEP_VINTAGE}.csv"
    if place_csv.exists():
        for r in census.read_pep_csv(place_csv):
            sumlev = (r.get("SUMLEV") or "").strip()
            st = (r.get("STATE") or "").zfill(2)
            if sumlev == "162":                        # incorporated place
                geo = f"place:{st}{(r.get('PLACE') or '').zfill(5)}"
            elif sumlev == "061":                      # minor civil division
                geo = (f"cousub:{st}{(r.get('COUNTY') or '').zfill(3)}"
                       f"{(r.get('COUSUB') or '').zfill(5)}")
            elif sumlev == "040":
                geo = f"state:{st}"
            else:
                # 170 consolidated cities and 162/061 duplicates would double-count.
                continue
            for y in range(2020, census.PEP_VINTAGE + 1):
                v = _i(r.get(f"POPESTIMATE{y}"))
                if v is not None:
                    rows.append((geo, y, v, None, "pep", "census-pep-2025"))

    county_csv = pep_dir / f"co-est{census.PEP_VINTAGE}-alldata.csv"
    if county_csv.exists():
        for r in census.read_pep_csv(county_csv):
            if (r.get("SUMLEV") or "").strip() != "050":
                continue
            geo = f"county:{(r.get('STATE') or '').zfill(2)}{(r.get('COUNTY') or '').zfill(3)}"
            for y in range(2020, census.PEP_VINTAGE + 1):
                v = _i(r.get(f"POPESTIMATE{y}"))
                if v is not None:
                    rows.append((geo, y, v, None, "pep", "census-pep-2025"))

    acs_dir = settings.raw / "census" / "acs"
    pj = acs_dir / f"acs5_{census.ACS_VINTAGE}_places.json"
    if pj.exists():
        for r in json.loads(pj.read_text()):
            geo = f"place:{(r.get('state') or '').zfill(2)}{(r.get('place') or '').zfill(5)}"
            rows.append((geo, census.ACS_VINTAGE, _i(r.get("B01003_001E")),
                         _i(r.get("B01003_001M")), "acs5", "census-acs5-2024"))
    cj = acs_dir / f"acs5_{census.ACS_VINTAGE}_counties.json"
    if cj.exists():
        for r in json.loads(cj.read_text()):
            geo = f"county:{(r.get('state') or '').zfill(2)}{(r.get('county') or '').zfill(3)}"
            rows.append((geo, census.ACS_VINTAGE, _i(r.get("B01003_001E")),
                         _i(r.get("B01003_001M")), "acs5", "census-acs5-2024"))

    rows.extend(_county_unincorporated_balance(rows))

    dedup: dict[tuple, tuple] = {}
    for r in rows:
        if r[2] is not None:
            dedup[(r[0], r[1], r[4])] = r
    return bulk_insert(con, "fact_demographics", list(dedup.values()))


def _county_unincorporated_balance(rows: list[tuple]) -> list[tuple]:
    """Derive the population of each county OUTSIDE its incorporated places.

    A sheriff's office normally has primary patrol responsibility only for the
    unincorporated balance of its county, because the incorporated cities inside it run
    their own departments. Dividing sheriff-reported offenses by the FULL county population
    understates the rate by a factor of three to ten in urbanized counties -- this is the
    single largest source of error in agency-level crime rates, and it is structural.

    The balance is county population minus the population of every incorporated place whose
    territory lies in that county, apportioned by the place-by-county relationship file.
    It is stored as its own basis so the interface can name the denominator it used.

    It remains WRONG where a sheriff polices an incorporated city under contract --
    widespread in California and Florida. Those cases are flagged, not silently corrected.
    """
    from ..connectors.census import read_pipe_table

    xw = settings.raw / "census" / "geo" / "national_place_by_county2020.txt"
    if not xw.exists():
        return []

    # place GEOID -> set of county GEOIDs it falls in
    place_counties: dict[str, set[str]] = {}
    for r in read_pipe_table(xw):
        # STATE in this file is the two-letter abbreviation; STATEFP is the numeric code.
        st = (r.get("STATEFP") or "").strip().zfill(2)
        pl = (r.get("PLACEFP") or "").strip().zfill(5)
        co = (r.get("COUNTYFP") or "").strip().zfill(3)
        cls = (r.get("CLASSFP") or "").strip()
        if not st or not pl or not co:
            continue
        if not cls.startswith("C"):          # C-classes are incorporated places
            continue
        place_counties.setdefault(f"place:{st}{pl}", set()).add(f"county:{st}{co}")

    pep_place = {(r[0], r[1]): r[2] for r in rows if r[4] == "pep" and r[0].startswith("place:")}
    pep_county = {(r[0], r[1]): r[2] for r in rows if r[4] == "pep" and r[0].startswith("county:")}

    incorporated: dict[tuple[str, int], int] = {}
    for (geo, year), pop in pep_place.items():
        if pop is None:
            continue
        counties = place_counties.get(geo)
        if not counties:
            continue
        share = pop / len(counties)   # split evenly across the counties the place spans
        for c in counties:
            incorporated[(c, year)] = incorporated.get((c, year), 0) + share

    out: list[tuple] = []
    for (geo, year), county_pop in pep_county.items():
        if county_pop is None:
            continue
        inc = incorporated.get((geo, year), 0)
        balance = int(round(max(county_pop - inc, 0)))
        out.append((f"{geo}#balance", year, balance, None, "pep_county_balance",
                    "census-pep-2025"))
    return out


# --- Government finance -----------------------------------------------------------------

def build_fact_finance(con) -> tuple[int, int]:
    wanted = set(finance.POLICE_ITEM_CODES) | set(finance.CONTEXT_ITEM_CODES)
    labels = {**finance.POLICE_ITEM_CODES, **finance.CONTEXT_ITEM_CODES}
    fin_dir = settings.raw / "census" / "finance"
    rows: list[tuple] = []
    all_pid: list[dict] = []

    for zp in sorted(fin_dir.glob("*_Individual_Unit_File.zip")):
        year = int(zp.name[:4])
        fin, pid = finance.read_iuf_zip(zp, wanted)
        pid_by_gov = {p["census_gov_id_12"]: p for p in pid}
        all_pid.extend(pid)
        cog = finance.is_census_of_governments_year(year)
        for r in fin:
            meta = pid_by_gov.get(r["census_gov_id_12"], {})
            flag = (r.get("data_flag") or "")[:1]
            value_type = {"R": "reported", "I": "imputed", "S": "alternative_source",
                          "A": "analyst_correction"}.get(flag, "unknown")
            rows.append((
                r["census_gov_id_12"], r["survey_year"] or year, r["item_code"],
                labels.get(r["item_code"]), r["amount_thousands"], r.get("data_flag"),
                value_type, r["gov_type"], meta.get("unit_name"), meta.get("county_name"),
                r["state_fips"], meta.get("fips_place"), meta.get("fiscal_year_ending"),
                cog, "government_unit", "census-gov-finance-2024",
            ))

    dedup = {(r[0], r[1], r[2]): r for r in rows}
    n = bulk_insert(con, "fact_finance", list(dedup.values()))

    from ..resolution.resolve import resolve_geography_to_government
    seen: dict[str, dict] = {}
    for p in all_pid:
        seen.setdefault(p["census_gov_id_12"], p)
    links = resolve_geography_to_government(con, list(seen.values()))
    return n, links


# --- Crime --------------------------------------------------------------------------------

def build_fact_crime(con) -> int:
    """Reduce the harvested monthly responses to agency-year offense and clearance totals.

    months_reported is COUNTED from the response, not assumed. A year with fewer than twelve
    reported months is marked partial_year so nothing downstream treats it as a full year.
    """
    from ..connectors.crime_harvest import months_present, reduce_response

    crime_dir = settings.raw / "fbi" / "crime"
    rows: dict[tuple, list] = {}
    for gz in sorted(crime_dir.glob("crime_*.ndjson.gz")):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                rec = json.loads(line)
                body = rec.get("body")
                if not body:
                    continue
                ori, offense = rec["ori"], rec["offense"]
                series = reduce_response(body)
                off_series = next((k for k in series if k.endswith(" Offenses")), None)
                clr_series = next((k for k in series if k.endswith(" Clearances")), None)
                if not off_series:
                    continue
                months = months_present(body, off_series)
                for year, total in series[off_series].items():
                    if year > VINTAGES["crime_last_complete_year"]:
                        continue
                    m = months.get(year, 0)
                    if m == 0:
                        continue
                    clear = (series.get(clr_series) or {}).get(year) if clr_series else None
                    rows[(ori, year, offense)] = [
                        ori, year, offense, int(round(total)),
                        int(round(clear)) if clear is not None else None, m,
                        "reported" if m == 12 else "partial_year", "fbi-ucr-summarized",
                    ]
    return bulk_insert(con, "fact_crime", [tuple(v) for v in rows.values()])


# --- ORI7 disambiguation ------------------------------------------------------------------

# A contested ORI7 resolves only when the primary candidate both clears an absolute name
# threshold and beats every rival by this margin. Tuned so Boston (100 vs 0 against Suffolk
# University) resolves and the CHP divisional blocks (all scoring alike) do not.
PRIMARY_NAME_MIN = 85
PRIMARY_NAME_MARGIN = 20

def _disambiguate_ori7(record: dict, candidates: list[tuple[str, str, str]] | None,
                       resolved: dict[str, str]) -> tuple[str | None, str | None]:
    """Attribute a PE record whose ORI7 is shared by several agencies -- but only when two
    independent signals agree.

    Refusing every contested ORI7 outright cost real agencies: Boston Police Department
    (MA01301, 2,129 sworn) shares its ORI7 with Suffolk University Police, and dropping it
    left a major city department with no staffing series at all. Attributing to whichever
    agency was read first would be worse.

    The rule requires both:
      1. exactly one candidate is the PRIMARY ORI for that ORI7 -- its ORI9 ends in "00",
         which is how the FBI numbers a parent agency, while sub-units carry suffixes
         such as 9E (university), 5A and 5Y (state special jurisdiction); and
      2. that candidate's name matches the PE record's name AND wins by a clear margin over
         every other candidate sharing the ORI7.

    Both guards are load-bearing, and the California Highway Patrol shows why. CHP files its
    entire statewide workforce -- 6,837 sworn in 2024 -- as a SINGLE PE record under ORI7
    CA03499, which the FBI labels "HP: Sacramento County". That record resolves, because
    CA0349900 is the primary ORI and no rival comes close on the name. The officers land
    under a CHP ORI carrying the FBI's own sub-unit label, which is where the FBI filed them;
    the alternative was excluding a state police force from the national total. ORI7 CA01999,
    by contrast, is shared by fourteen CHP sub-units and NONE is a primary, so a record filed
    against it stays refused and appears in the staffing reconciliation as a named excluded
    bucket rather than inside one arbitrary sub-unit's profile.
    """
    if not candidates:
        return None, None
    from rapidfuzz import fuzz

    from .agency import normalize_name

    primaries = [c for c in candidates if c[0].endswith("00")]
    if len(primaries) != 1:
        return None, None
    aid, _src, norm_name = primaries[0]
    record_name = normalize_name(record.get("agency_name") or "")
    if not record_name or not norm_name:
        return None, None

    score = fuzz.token_set_ratio(record_name, norm_name)
    if score < PRIMARY_NAME_MIN:
        return None, None
    rivals = [fuzz.token_set_ratio(record_name, c[2])
              for c in candidates if c[0] != aid and c[2]]
    if rivals and score - max(rivals) < PRIMARY_NAME_MARGIN:
        return None, None
    resolved[record["ori7"]] = aid
    return aid, "ori7_disambiguated_primary_and_name"
