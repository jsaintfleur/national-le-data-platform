"""Identifier handling. These are the defects that produce confidently wrong numbers."""
from nledp.canonical.agency import classify_agency, normalize_name
from nledp.util.fips import (
    canonical_state_abbr, county_geoid, pad, place_geoid, strip_geoidfq,
)


def test_leading_zeros_survive():
    assert pad("1", 2) == "01"
    assert pad(1, 2) == "01"
    assert place_geoid("1", "124") == "0100124"
    assert county_geoid("6", "37") == "06037"


def test_geoidfq_is_stripped():
    assert strip_geoidfq("1600000US0100100") == "0100100"
    assert strip_geoidfq("0500000US01001") == "01001"
    assert strip_geoidfq(None) is None


def test_fbi_state_code_is_mapped_to_usps():
    # The FBI writes Nebraska as NB. Without this map, 287 agencies lose their geography.
    assert canonical_state_abbr("NB") == "NE"
    assert canonical_state_abbr("ne") == "NE"
    assert canonical_state_abbr(None) is None


def test_name_normalization_collapses_department_words():
    a = normalize_name("Camden Police Department")
    assert a == normalize_name("CAMDEN PD")
    assert a == normalize_name("Camden Police Dept.")
    assert "POLICE" not in a


def test_agency_classification():
    assert classify_agency("Alameda County Sheriff's Office", "County") == "county_sheriff"
    assert classify_agency("Dover Police Department", "City") == "municipal_police"
    assert classify_agency("University of Delaware Police", "University or College") \
        == "university_police"
    assert classify_agency("Metro Transit Police", "Other") == "transit_police"
    # A sheriff mislabelled "City" by the source is still a sheriff.
    assert classify_agency("Whatcom County Sheriff", "City") == "county_sheriff"


def test_ori7_disambiguation_requires_two_agreeing_signals():
    """Boston PD shares ORI7 MA01301 with Suffolk University Police. Refusing the whole
    contested ORI7 dropped a major city department's entire staffing series."""
    from nledp.canonical.facts import _disambiguate_ori7

    candidates = [
        ("MA0130100", "legacy_ori", normalize_name("Boston")),
        ("MA013019E", "nibrs_ori_fallback", normalize_name("Suffolk University")),
    ]
    resolved: dict[str, str] = {}
    aid, method = _disambiguate_ori7(
        {"ori7": "MA01301", "agency_name": "BOSTON"}, candidates, resolved)
    assert aid == "MA0130100"
    assert method == "ori7_disambiguated_primary_and_name"
    assert resolved["MA01301"] == "MA0130100"


def test_ori7_disambiguation_refuses_when_the_name_disagrees():
    from nledp.canonical.facts import _disambiguate_ori7

    candidates = [
        ("MA0130100", "legacy_ori", normalize_name("Boston")),
        ("MA013019E", "nibrs_ori_fallback", normalize_name("Suffolk University")),
    ]
    aid, _ = _disambiguate_ori7(
        {"ori7": "MA01301", "agency_name": "SOMEWHERE ELSE"}, candidates, {})
    assert aid is None


def test_ori7_disambiguation_refuses_when_no_candidate_is_primary():
    """ORI7 CA01999 is shared by fourteen California Highway Patrol sub-units and none is
    the primary ORI, so no candidate may absorb a record filed against it."""
    from nledp.canonical.facts import _disambiguate_ori7

    candidates = [
        ("CA0199901", "legacy_ori", normalize_name("Highway Patrol: (Southern Division)")),
        ("CA0199910", "legacy_ori", normalize_name("Highway Patrol: (Southern ISU)")),
        ("CA0199925", "legacy_ori", normalize_name("Highway Patrol: (Baldwin Park Area)")),
    ]
    aid, _ = _disambiguate_ori7(
        {"ori7": "CA01999", "agency_name": "HP: LOS ANGELES COUNTY"}, candidates, {})
    assert aid is None


def test_ori7_disambiguation_refuses_without_a_clear_winner():
    """Two same-named sub-units and a primary that beats neither by a margin: refuse."""
    from nledp.canonical.facts import _disambiguate_ori7

    candidates = [
        ("XX1234500", "legacy_ori", normalize_name("Metro Transit Authority North")),
        ("XX1234501", "legacy_ori", normalize_name("Metro Transit Authority South")),
    ]
    aid, _ = _disambiguate_ori7(
        {"ori7": "XX12345", "agency_name": "METRO TRANSIT AUTHORITY"}, candidates, {})
    assert aid is None
