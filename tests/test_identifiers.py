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
