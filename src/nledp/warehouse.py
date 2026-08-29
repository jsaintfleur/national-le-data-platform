"""DuckDB warehouse: schema, connection, and release bookkeeping."""
from __future__ import annotations

import duckdb

from .config import settings

SCHEMA_SQL = """
-- ============================ Layer 3: canonical ==============================
-- Every FIPS and ORI column is VARCHAR. Integer coercion silently eats leading zeros
-- and is the most common defect in this domain.

CREATE TABLE IF NOT EXISTS dim_source (
    source_id            VARCHAR PRIMARY KEY,
    source_name          VARCHAR,
    publisher            VARCHAR,
    dataset_name         VARCHAR,
    dataset_description  VARCHAR,
    source_url           VARCHAR,
    documentation_url    VARCHAR,
    access_method        VARCHAR,
    api_endpoint         VARCHAR,
    geographic_level     VARCHAR,
    coverage_start_year  INTEGER,
    coverage_end_year    INTEGER,
    update_frequency     VARCHAR,
    latest_release_date  VARCHAR,
    license              VARCHAR,
    primary_identifier   VARCHAR,
    known_limitations    VARCHAR,
    ingestion_status     VARCHAR,
    validation_status    VARCHAR,
    verified_http_status INTEGER
);

CREATE TABLE IF NOT EXISTS dim_metric (
    metric_id                VARCHAR PRIMARY KEY,
    display_name             VARCHAR,
    description              VARCHAR,
    formula                  VARCHAR,
    numerator                VARCHAR,
    denominator              VARCHAR,
    unit                     VARCHAR,
    source                   VARCHAR,
    frequency                VARCHAR,
    preferred_visualization  VARCHAR,
    comparison_allowed       BOOLEAN,
    ranking_allowed          BOOLEAN,
    attribution_level        VARCHAR,
    limitations              VARCHAR
);

CREATE TABLE IF NOT EXISTS dim_time (
    data_year        INTEGER PRIMARY KEY,
    is_complete      BOOLEAN,
    crime_usable     BOOLEAN,
    is_cog_year      BOOLEAN,
    note             VARCHAR
);

CREATE TABLE IF NOT EXISTS dim_geography (
    geo_id           VARCHAR PRIMARY KEY,   -- summary-level-prefixed, e.g. 'place:0644000'
    geo_level        VARCHAR,               -- state | county | place | cousub | urban_area
    geoid            VARCHAR,
    name             VARCHAR,
    state_abbr       VARCHAR,
    state_fips       VARCHAR,
    county_fips      VARCHAR,
    place_fips       VARCHAR,
    cousub_fips      VARCHAR,
    classfp          VARCHAR,
    funcstat         VARCHAR,
    lsad             VARCHAR,
    land_sqmi        DOUBLE,
    water_sqmi       DOUBLE,
    latitude         DOUBLE,
    longitude        DOUBLE,
    uace             VARCHAR,
    urban_area_name  VARCHAR,
    urbanicity_band  VARCHAR,
    is_independent_city  BOOLEAN,
    is_consolidated      BOOLEAN,
    geography_vintage    INTEGER,
    source_id        VARCHAR
);

CREATE TABLE IF NOT EXISTS dim_agency (
    agency_id            VARCHAR PRIMARY KEY,  -- canonical; equals ori9_nibrs
    ori9_nibrs           VARCHAR,
    ori9_legacy          VARCHAR,
    ori7                 VARCHAR,              -- ALWAYS derived from ori9_legacy[:7]
    ori7_source          VARCHAR,              -- legacy_ori (authoritative) | nibrs_ori_fallback
    covered_by_legacy_ori VARCHAR,
    agency_name          VARCHAR,
    agency_name_normalized VARCHAR,
    ucr_agency_name      VARCHAR,
    ncic_agency_name     VARCHAR,
    agency_type          VARCHAR,             -- platform taxonomy
    agency_type_source   VARCHAR,             -- FBI's own label, unmodified
    agency_status        VARCHAR,
    is_dormant           BOOLEAN,
    dormant_year         INTEGER,
    is_covered_by_parent BOOLEAN,
    city                 VARCHAR,
    county_name          VARCHAR,
    msa_name             VARCHAR,
    state_abbr           VARCHAR,             -- canonical USPS
    state_abbr_as_reported VARCHAR,           -- the source's own code (FBI uses NCIC)
    state_fips           VARCHAR,
    latitude             DOUBLE,
    longitude            DOUBLE,
    jurisdiction_type    VARCHAR,
    population_group_code VARCHAR,
    population_group_desc VARCHAR,
    fbi_population_served BIGINT,
    is_nibrs             BOOLEAN,
    nibrs_start_date     VARCHAR,
    first_observation_year INTEGER,
    latest_observation_year INTEGER,
    rate_denominator_eligible BOOLEAN,       -- false for transient-population agency types
    source_id            VARCHAR
);

CREATE TABLE IF NOT EXISTS agency_history (
    agency_id      VARCHAR,
    effective_year INTEGER,
    change_type    VARCHAR,      -- observed_name | dormant | covered_by_parent | status
    old_value      VARCHAR,
    new_value      VARCHAR,
    notes          VARCHAR
);

CREATE TABLE IF NOT EXISTS agency_crosswalk (
    canonical_agency_id VARCHAR,
    target_domain       VARCHAR,   -- geography | census_government | source_identifier
    target_id           VARCHAR,
    target_name         VARCHAR,
    source              VARCHAR,
    match_method        VARCHAR,
    match_score         DOUBLE,
    review_status       VARCHAR,   -- accepted | needs_review | rejected | unmatched
    notes               VARCHAR
);

-- ------------------------------- facts ---------------------------------------
CREATE TABLE IF NOT EXISTS fact_staffing (
    agency_id        VARCHAR,
    data_year        INTEGER,
    sworn_officers   INTEGER,
    civilian_personnel INTEGER,
    total_personnel  INTEGER,
    male_officers    INTEGER,
    female_officers  INTEGER,
    male_civilians   INTEGER,
    female_civilians INTEGER,
    fbi_population   BIGINT,
    value_type       VARCHAR,     -- reported | missing
    join_method      VARCHAR,     -- ori7_from_legacy | ori7_fallback | direct_ori9
    source_id        VARCHAR,
    PRIMARY KEY (agency_id, data_year, source_id)
);

CREATE TABLE IF NOT EXISTS fact_crime (
    agency_id        VARCHAR,
    data_year        INTEGER,
    offense_group    VARCHAR,
    offenses         BIGINT,
    clearances       BIGINT,
    months_reported  INTEGER,
    value_type       VARCHAR,     -- reported | partial_year | missing
    source_id        VARCHAR,
    PRIMARY KEY (agency_id, data_year, offense_group)
);

CREATE TABLE IF NOT EXISTS fact_demographics (
    geo_id           VARCHAR,
    data_year        INTEGER,
    population       BIGINT,
    population_moe   BIGINT,
    basis            VARCHAR,     -- pep | acs5
    source_id        VARCHAR,
    PRIMARY KEY (geo_id, data_year, basis)
);

CREATE TABLE IF NOT EXISTS fact_finance (
    census_gov_id_12   VARCHAR,
    survey_year        INTEGER,
    item_code          VARCHAR,
    item_label         VARCHAR,
    amount_thousands   BIGINT,
    data_flag          VARCHAR,
    value_type         VARCHAR,   -- reported | imputed | alternative_source | analyst_correction
    gov_type           VARCHAR,
    unit_name          VARCHAR,
    county_name        VARCHAR,
    state_fips         VARCHAR,
    fips_place         VARCHAR,
    fiscal_year_ending VARCHAR,   -- MMDD
    is_cog_year        BOOLEAN,
    attribution_level  VARCHAR,   -- always 'government_unit'
    source_id          VARCHAR,
    PRIMARY KEY (census_gov_id_12, survey_year, item_code)
);

CREATE TABLE IF NOT EXISTS fact_reporting (
    agency_id            VARCHAR,
    data_year            INTEGER,
    participated         BOOLEAN,
    nibrs_participated   BOOLEAN,
    pe_reported          BOOLEAN,
    publishable          BOOLEAN,
    months_reported      INTEGER,
    reporting_completeness DOUBLE,
    source_id            VARCHAR,
    PRIMARY KEY (agency_id, data_year)
);

CREATE TABLE IF NOT EXISTS data_quality_log (
    check_id       VARCHAR,
    severity       VARCHAR,      -- error | warning | info
    table_name     VARCHAR,
    entity_id      VARCHAR,
    data_year      INTEGER,
    message        VARCHAR,
    observed       VARCHAR,
    expected       VARCHAR,
    release_id     VARCHAR
);

CREATE TABLE IF NOT EXISTS release_manifest (
    release_id     VARCHAR,
    built_at       VARCHAR,
    git_commit     VARCHAR,
    table_name     VARCHAR,
    row_count      BIGINT,
    note           VARCHAR
);
"""


def connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:
    settings.warehouse.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(settings.db_path), read_only=read_only)


def init_schema(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(SCHEMA_SQL)


def table_counts(con: duckdb.DuckDBPyConnection) -> dict[str, int]:
    names = [r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='main' ORDER BY table_name"
    ).fetchall()]
    return {n: con.execute(f'SELECT count(*) FROM "{n}"').fetchone()[0] for n in names}
