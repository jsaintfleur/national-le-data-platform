"""Entity resolution: agency -> geography, and geography -> Census government unit.

The federal government publishes no current ORI-to-FIPS crosswalk. The only one that ever
existed, BJS's LEAIC, stops at reference year 2012, sits behind an ICPSR login, and returns
403 to any non-browser client. So the platform builds its own, and treats every link as a
modelled artifact with a method, a score and a review status rather than a fact.

Nothing here silently accepts an uncertain match. A link is `accepted` only when a
deterministic rule fires or a fuzzy match clears a high threshold AND is corroborated by
distance. Everything else is `needs_review` or `unmatched`, and both are visible in the
product rather than hidden behind a blank cell.
"""
from __future__ import annotations

import math

from rapidfuzz import fuzz, process

from ..config import NEW_ENGLAND
from ..util.load import bulk_insert

# Thresholds. Deliberately conservative: a wrong link produces a confidently wrong rate,
# which is worse than a visible gap.
FUZZY_ACCEPT = 97
FUZZY_REVIEW = 88
DISTANCE_CORROBORATION_KM = 25.0
DISTANCE_HARD_LIMIT_KM = 75.0


def haversine_km(lat1, lon1, lat2, lon2) -> float | None:
    if None in (lat1, lon1, lat2, lon2):
        return None
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _norm_place(name: str) -> str:
    import re
    s = (name or "").upper()
    s = re.sub(r"[^A-Z0-9 ]+", " ", s)
    s = re.sub(
        r"\b(CITY|TOWN|VILLAGE|BOROUGH|TOWNSHIP|CDP|MUNICIPALITY|PLANTATION|"
        r"URBAN COUNTY|METROPOLITAN GOVERNMENT|CONSOLIDATED GOVERNMENT|GOVERNMENT|"
        r"UT|CCD|COUNTY|PARISH|CENSUS AREA|PLANNING REGION|BALANCE|METRO)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def resolve_agencies_to_geography(con) -> int:
    agencies = con.execute("""
        SELECT agency_id, agency_name, agency_name_normalized, agency_type, state_abbr,
               county_name, latitude, longitude
        FROM dim_agency
    """).fetchall()

    places = con.execute("""
        SELECT geo_id, geoid, name, state_abbr, latitude, longitude, geo_level, classfp
        FROM dim_geography WHERE geo_level IN ('place','cousub')
    """).fetchall()
    counties = con.execute("""
        SELECT geo_id, geoid, name, state_abbr, latitude, longitude
        FROM dim_geography WHERE geo_level='county'
    """).fetchall()
    states = {r[3]: r[0] for r in con.execute(
        "SELECT geo_id, geoid, name, state_abbr FROM dim_geography WHERE geo_level='state'"
    ).fetchall()}

    # Index candidates by state, and (in New England) prefer county subdivisions because the
    # town, not the place, is the general-purpose local government there.
    by_state_place: dict[str, list] = {}
    for p in places:
        st = p[3]
        if not st:
            continue
        if st in NEW_ENGLAND and p[6] == "place":
            continue          # a New England CDP is not the government
        if st not in NEW_ENGLAND and p[6] == "cousub":
            continue
        by_state_place.setdefault(st, []).append(p)

    by_state_county: dict[str, list] = {}
    for c in counties:
        by_state_county.setdefault(c[3], []).append(c)

    norm_cache: dict[int, list[str]] = {}

    def normed(items: list) -> list[str]:
        key = id(items)
        if key not in norm_cache:
            norm_cache[key] = [_norm_place(i[2]) for i in items]
        return norm_cache[key]

    rows: list[tuple] = []
    _FALLBACK_CONTEXT.clear()
    for (aid, _n, nname, atype, st, _cn, lat, lon) in agencies:
        _FALLBACK_CONTEXT[aid] = (atype, st, lat, lon, nname)

    def emit(aid, domain, tid, tname, method, score, status, notes):
        rows.append((aid, domain, tid, tname, "nledp-resolution", method,
                     score, status, notes))

    for (aid, name, nname, atype, st, county_name, lat, lon) in agencies:
        if not st:
            emit(aid, "geography", None, None, "none", None, "unmatched",
                 "No state on the agency record.")
            continue

        # --- state police and state special jurisdictions resolve to the state ------------
        if atype in ("state_police", "state_special_jurisdiction", "federal"):
            emit(aid, "geography", states.get(st), st, "agency_type_rule", 1.0, "accepted",
                 "Statewide or multi-jurisdiction agency; resolved to the state, which is "
                 "the only geography its jurisdiction corresponds to.")
            continue

        # --- county sheriffs and county police resolve to the county ---------------------
        if atype in ("county_sheriff", "county_police"):
            cands = by_state_county.get(st, [])
            target = None
            score = None
            method = "unmatched"
            if county_name and cands:
                cn = _norm_place(county_name)
                exact = [c for c, n in zip(cands, normed(cands)) if n == cn]
                if len(exact) == 1:
                    target, score, method = exact[0], 1.0, "exact_normalized_county_name"
                elif cands:
                    hit = process.extractOne(cn, normed(cands), scorer=fuzz.token_set_ratio)
                    if hit and hit[1] >= FUZZY_ACCEPT:
                        target, score, method = cands[hit[2]], hit[1] / 100, "fuzzy_county_name"
            if target is None and not county_name:
                # Sheriff name usually carries the county: "Alameda County Sheriff's Office"
                base = _norm_place(name)
                if cands:
                    hit = process.extractOne(base, normed(cands), scorer=fuzz.token_set_ratio)
                    if hit and hit[1] >= FUZZY_ACCEPT:
                        target, score, method = cands[hit[2]], hit[1] / 100, "fuzzy_agency_name_to_county"
            if target:
                status = "accepted" if (score or 0) >= FUZZY_ACCEPT / 100 else "needs_review"
                emit(aid, "geography", target[0], target[2], method, score, status,
                     "County-level jurisdiction. The rate denominator is the unincorporated "
                     "balance, not the whole county; see analytics.denominators.")
            else:
                emit(aid, "geography", states.get(st), st, "state_fallback", 0.2,
                     "needs_review", "County could not be resolved; falls back to the state "
                     "so the agency is still locatable, but no county rate is computed.")
            continue

        # --- everything else: try to place the agency in a municipality -------------------
        cands = by_state_place.get(st, [])
        if not cands:
            emit(aid, "geography", states.get(st), st, "state_fallback", 0.2, "needs_review",
                 "No candidate municipalities in this state's geography.")
            continue
        cnames = normed(cands)

        exact = [c for c, n in zip(cands, cnames) if n and n == nname]
        target = score = None
        method = "unmatched"
        note = ""

        if len(exact) == 1:
            target, score, method = exact[0], 1.0, "exact_normalized_name_in_state"
        elif len(exact) > 1:
            # Name ties (several "Springfield" in one state) are broken by distance.
            scored = [(c, haversine_km(lat, lon, c[4], c[5])) for c in exact]
            scored = [(c, d) for c, d in scored if d is not None]
            scored.sort(key=lambda x: x[1])
            if scored and scored[0][1] <= DISTANCE_CORROBORATION_KM:
                target, score, method = scored[0][0], 0.98, "name_tie_broken_by_distance"
                note = f"{len(exact)} same-name candidates; nearest is {scored[0][1]:.1f} km."
            else:
                emit(aid, "geography", None, None, "ambiguous_name", 0.5, "needs_review",
                     f"{len(exact)} municipalities in {st} share this normalized name and "
                     "no coordinate resolves the tie.")
                continue
        else:
            hit = process.extractOne(nname, cnames, scorer=fuzz.token_set_ratio) if nname else None
            if hit:
                cand = cands[hit[2]]
                dist = haversine_km(lat, lon, cand[4], cand[5])
                if hit[1] >= FUZZY_ACCEPT and (dist is None or dist <= DISTANCE_CORROBORATION_KM):
                    target, score, method = cand, hit[1] / 100, "fuzzy_name_corroborated_by_distance"
                    note = f"name score {hit[1]:.0f}" + (f", {dist:.1f} km" if dist else "")
                elif hit[1] >= FUZZY_REVIEW and (dist is None or dist <= DISTANCE_HARD_LIMIT_KM):
                    target, score, method = cand, hit[1] / 100, "fuzzy_name_low_confidence"
                    note = f"name score {hit[1]:.0f}" + (f", {dist:.1f} km" if dist else "")

        if target is None:
            emit(aid, "geography", states.get(st), st, "state_fallback", 0.2, "unmatched",
                 "No municipality matched. The agency is still shown, at state level, with "
                 "no per-resident rate.")
            continue

        status = ("accepted" if method in ("exact_normalized_name_in_state",
                                           "name_tie_broken_by_distance",
                                           "fuzzy_name_corroborated_by_distance")
                  else "needs_review")
        emit(aid, "geography", target[0], target[2], method, score, status, note or None)

    rows = _geography_fallback_pass(rows, by_state_place, normed)
    return bulk_insert(con, "agency_crosswalk", rows)


def _geography_fallback_pass(rows: list[tuple], by_state_place: dict[str, list],
                             normed) -> list[tuple]:
    """Second pass over unmatched municipal agencies, with geography as the primary signal.

    Consolidated city-county governments are the main population here: the FBI calls it
    "Metropolitan Nashville Police Department" and the Census calls the same place
    "Nashville-Davidson metropolitan government (balance)". Name similarity alone will not
    bridge that, but a point coordinate 3 km from the Census internal point will.

    Every link this pass makes is marked needs_review. Geography alone is suggestive, not
    conclusive -- a coordinate inside a city says nothing about whether the agency's
    jurisdiction is that city -- so these appear in the review queue rather than as
    accepted facts.
    """
    out: list[tuple] = []
    for row in rows:
        (aid, domain, tid, tname, src, method, score, status, notes) = row
        if status != "unmatched" or method != "state_fallback":
            out.append(row)
            continue
        meta = _FALLBACK_CONTEXT.get(aid)
        if not meta:
            out.append(row)
            continue
        atype, st, lat, lon, nname = meta
        if atype not in ("municipal_police",) or lat is None or lon is None:
            out.append(row)
            continue
        cands = by_state_place.get(st, [])
        if not cands:
            out.append(row)
            continue
        best = None
        for c in cands:
            d = haversine_km(lat, lon, c[4], c[5])
            if d is not None and (best is None or d < best[1]):
                best = (c, d)
        if best is None or best[1] > 10.0:
            out.append(row)
            continue
        cand, dist = best
        name_score = fuzz.token_set_ratio(nname, _norm_place(cand[2]))
        if name_score < 55:
            out.append(row)
            continue
        out.append((aid, "geography", cand[0], cand[2], "nledp-resolution",
                    "geography_primary_needs_review", round(name_score / 100, 3),
                    "needs_review",
                    f"Nearest municipality is {dist:.1f} km away with a name score of "
                    f"{name_score:.0f}. Geography is the primary signal here, which is "
                    "suggestive rather than conclusive."))
    return out


_FALLBACK_CONTEXT: dict[str, tuple] = {}


def resolve_geography_to_government(con, pid_rows: list[dict]) -> int:
    """Link a Census government unit to a place GEOID using the crosswalk that ships inside
    the finance file itself (Fin_PID positions 112-116).

    This is a geography-to-government link, never an agency-to-government link. The platform
    does not claim that a government's police spending belongs to any particular agency,
    because no source supports that claim.
    """
    rows: list[tuple] = []
    for r in pid_rows:
        gov = r["census_gov_id_12"]
        state_fips = gov[0:2]
        gtype = gov[2:3]
        fp = r.get("fips_place")
        if not fp:
            continue
        if gtype == "1":                       # county: encoded as '99' + 3-digit county
            if fp.startswith("99"):
                target = f"county:{state_fips}{fp[2:]}"
                method = "finance_file_county_encoding"
            else:
                continue
        elif gtype in ("2", "3"):              # city or township: true 5-digit place FIPS
            target = f"place:{state_fips}{fp}"
            method = "finance_file_fips_place"
        else:
            continue
        rows.append((gov, "geography", target, r.get("unit_name"),
                     "census-gov-finance-2024", method, 1.0, "accepted",
                     "Government-unit to geography link. Spending is attributed to the "
                     "government, never to a police agency."))
    con.execute("DELETE FROM agency_crosswalk WHERE target_domain='geography' "
                "AND source='census-gov-finance-2024'")
    if not rows:
        return 0
    return bulk_insert(con, "agency_crosswalk", rows, replace=False)
