"""Attach denominator metadata and coverage policy to every agency-year row.

This runs between the base analytics SQL and everything downstream. It is written in Python
rather than SQL for one reason: the rules live in ``nledp.policy``, and the API answers the
same questions from the same module. A SQL reimplementation would be a second source of
truth that drifts.
"""
from __future__ import annotations

from ..policy import (
    Confidence, DENOMINATOR_NOTES, IMPLAUSIBLE_VIOLENT_RATE_PER_100K,
    coverage_status, denominator_confidence, denominator_type_for, methodology_warning,
    population_band, rate_allowed, rate_withheld_reason,
)
from ..util.load import bulk_insert

POLICY_DDL = """
DROP TABLE IF EXISTS analytics_agency_year;
CREATE TABLE analytics_agency_year (
    agency_id                 VARCHAR,
    agency_name               VARCHAR,
    agency_type               VARCHAR,
    state_abbr                VARCHAR,
    geo_id                    VARCHAR,
    geo_name                  VARCHAR,
    geo_level                 VARCHAR,
    urbanicity_band           VARCHAR,
    geo_review_status         VARCHAR,
    rate_denominator_eligible BOOLEAN,
    data_year                 INTEGER,
    population                BIGINT,
    denominator_basis         VARCHAR,
    population_geography_total BIGINT,
    sworn_officers            INTEGER,
    civilian_personnel        INTEGER,
    total_personnel           INTEGER,
    violent_crime_offenses    BIGINT,
    violent_crime_clearances  BIGINT,
    violent_months_reported   INTEGER,
    violent_value_type        VARCHAR,
    property_crime_offenses   BIGINT,
    property_months_reported  INTEGER,
    property_value_type       VARCHAR,
    officers_per_1k           DOUBLE,
    violent_crime_rate        DOUBLE,
    property_crime_rate       DOUBLE,
    civilian_share            DOUBLE,
    participated              BOOLEAN,
    nibrs_participated        BOOLEAN,
    pe_reported               BOOLEAN,
    -- policy columns -----------------------------------------------------------------
    denominator_type          VARCHAR,
    denominator_value         BIGINT,
    denominator_year          INTEGER,
    denominator_source        VARCHAR,
    denominator_confidence    VARCHAR,
    denominator_notes         VARCHAR,
    coverage_status           VARCHAR,
    months_reported           INTEGER,
    rate_allowed              BOOLEAN,
    rate_withheld_reason      VARCHAR,
    methodology_warning       VARCHAR,
    population_band           VARCHAR,
    implausible_rate_flag     BOOLEAN
);
"""

BASE_COLUMNS = [
    "agency_id", "agency_name", "agency_type", "state_abbr", "geo_id", "geo_name",
    "geo_level", "urbanicity_band", "geo_review_status", "rate_denominator_eligible",
    "data_year", "population", "denominator_basis", "population_geography_total",
    "sworn_officers", "civilian_personnel", "total_personnel",
    "violent_crime_offenses", "violent_crime_clearances", "violent_months_reported",
    "violent_value_type", "property_crime_offenses", "property_months_reported",
    "property_value_type", "officers_per_1k", "violent_crime_rate", "property_crime_rate",
    "civilian_share", "participated", "nibrs_participated", "pe_reported",
]

DENOMINATOR_SOURCE = {
    "pep": "census-pep-2025",
    "pep_county_balance": "census-pep-2025 (derived: county minus incorporated places)",
    "acs5": "census-acs5-2024",
}


def apply_policy(con) -> int:
    con.execute(POLICY_DDL)
    rows = con.execute(
        f"SELECT {', '.join(BASE_COLUMNS)} FROM analytics_agency_year_base"
    ).fetchall()

    out: list[tuple] = []
    for r in rows:
        rec = dict(zip(BASE_COLUMNS, r))
        atype = rec["agency_type"] or ""
        basis = rec["denominator_basis"]
        pop = rec["population"]
        months = rec["violent_months_reported"]
        offenses = rec["violent_crime_offenses"]

        dtype = denominator_type_for(atype, basis, rec["geo_level"])
        per_1k = rec["officers_per_1k"]
        conf = denominator_confidence(dtype, basis, rec["geo_review_status"], per_1k,
                                      has_value=pop is not None)

        allowed = rate_allowed(months, pop, conf, offenses)
        reason = rate_withheld_reason(months, pop, conf, offenses, dtype)
        warn = methodology_warning(atype, dtype, per_1k)

        # A rate the policy withholds must not survive from the base table.
        v_rate = rec["violent_crime_rate"] if allowed else None
        p_rate = (rec["property_crime_rate"]
                  if rate_allowed(rec["property_months_reported"], pop, conf,
                                  rec["property_crime_offenses"]) else None)
        o_rate = per_1k if conf is not Confidence.NOT_COMPARABLE else None

        implausible = bool(v_rate is not None and v_rate > IMPLAUSIBLE_VIOLENT_RATE_PER_100K)

        out.append((
            rec["agency_id"], rec["agency_name"], atype, rec["state_abbr"], rec["geo_id"],
            rec["geo_name"], rec["geo_level"], rec["urbanicity_band"],
            rec["geo_review_status"], rec["rate_denominator_eligible"], rec["data_year"],
            pop, basis, rec["population_geography_total"], rec["sworn_officers"],
            rec["civilian_personnel"], rec["total_personnel"], offenses,
            rec["violent_crime_clearances"], months, rec["violent_value_type"],
            rec["property_crime_offenses"], rec["property_months_reported"],
            rec["property_value_type"], o_rate, v_rate, p_rate, rec["civilian_share"],
            rec["participated"], rec["nibrs_participated"], rec["pe_reported"],
            dtype.value,
            int(pop) if pop is not None else None,
            rec["data_year"] if pop is not None else None,
            DENOMINATOR_SOURCE.get(basis) if basis else None,
            conf.value,
            DENOMINATOR_NOTES.get(dtype),
            coverage_status(months).value,
            months,
            allowed,
            reason,
            warn,
            population_band(pop),
            implausible,
        ))

    return bulk_insert(con, "analytics_agency_year", out)
