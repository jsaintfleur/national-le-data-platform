"""Monthly-to-annual reduction, including the completeness count."""
from nledp.connectors.crime_harvest import months_present, reduce_response

BODY = {
    "offenses": {
        "actuals": {
            "Testville Offenses": {
                "01-2024": 10, "02-2024": 12, "03-2024": None,
                "01-2025": 5, "02-2025": 5,
            },
            "Testville Clearances": {"01-2024": 4, "02-2024": 3},
        }
    }
}


def test_months_are_summed_per_year():
    out = reduce_response(BODY)
    assert out["Testville Offenses"][2024] == 22
    assert out["Testville Offenses"][2025] == 10


def test_null_months_are_not_counted_as_zero():
    counts = months_present(BODY, "Testville Offenses")
    assert counts[2024] == 2      # March is null, not zero
    assert counts[2025] == 2


def test_empty_body_is_safe():
    assert reduce_response(None) == {}
    assert months_present(None, "x") == {}
