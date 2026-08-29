"""Entity resolution behaviour."""
from nledp.resolution.resolve import _norm_place, haversine_km


def test_place_normalization_strips_legal_status_words():
    assert _norm_place("Dover city") == _norm_place("Dover town") == "DOVER"
    assert _norm_place("Autauga County") == "AUTAUGA"
    # Consolidated governments must collapse onto their city name.
    assert "NASHVILLE" in _norm_place("Nashville-Davidson metropolitan government (balance)")
    assert "BALANCE" not in _norm_place("Athens-Clarke County unified government (balance)")


def test_haversine():
    d = haversine_km(38.9072, -77.0369, 39.2904, -76.6122)   # DC to Baltimore
    assert 50 < d < 70
    assert haversine_km(None, 0, 0, 0) is None
