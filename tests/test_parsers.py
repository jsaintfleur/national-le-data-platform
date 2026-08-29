"""Fixed-width parsers. Each layout is asserted against a real record from the source."""
from nledp.connectors.cde import parse_pe_record
from nledp.connectors.finance import (
    is_census_of_governments_year, parse_fin_record, parse_pid_record,
)


def test_pe_record_layout():
    # Anchorage 2024: 322 + 44 male, 44 + 124 female -> 534 total, which matches the CDE API.
    line = ("5" + "02" + "AK00101" + "1 " + " 24" + "00001" + "   " + "000291247"
            + "ANCHORAGE               " + "ALASKA"
            + "00322" + "00044" + "00366" + "00044" + "00124" + "00168" + "00534"
            + "013" + "018")
    rec = parse_pe_record(line)
    assert rec is not None
    assert rec["ori7"] == "AK00101"
    assert rec["data_year"] == 2024
    assert rec["male_officers"] == 322
    assert rec["female_officers"] == 44
    assert rec["total_employees"] == 534
    assert rec["male_officers"] + rec["male_civilians"] + \
           rec["female_officers"] + rec["female_civilians"] == 534


def test_pe_record_rejects_non_pe_lines():
    assert parse_pe_record("1" + "0" * 200) is None
    assert parse_pe_record("5short") is None


def test_finance_record_is_32_chars():
    # Chicago FY2024 police current operations, verbatim from 2024FinEstDAT.
    line = '172031162236E62     22384832024R'
    rec = parse_fin_record(line)
    assert rec["census_gov_id_12"] == "172031162236"
    assert rec["item_code"] == "E62"
    assert rec["amount_thousands"] == 2238483        # thousands of dollars
    assert rec["survey_year"] == 2024
    assert rec["data_flag"] == "R"
    assert rec["gov_type"] == "City"
    assert rec["state_fips"] == "17"


def test_finance_imputation_flag_is_preserved():
    rec = parse_fin_record('011001100001E62        60492024I')
    assert rec["data_flag"] == "I"


def test_finance_item_filter():
    assert parse_fin_record('172031162236T01     22384832024R', {"E62"}) is None


def test_pid_record_carries_place_and_fiscal_year():
    line = '011001100001AUTAUGA COUNTY                                                  Autauga                            99001    5975924             093024'
    rec = parse_pid_record(line)
    assert rec["fips_place"] == "99001"     # county encoding: '99' + county FIPS
    assert rec["population"] == 59759
    assert rec["fiscal_year_ending"] == "0930"


def test_census_of_governments_years():
    assert is_census_of_governments_year(2022)
    assert is_census_of_governments_year(2027)
    assert not is_census_of_governments_year(2024)
