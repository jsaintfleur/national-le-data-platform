"""Layer 4: analytics tables.

Rates are computed here and only here. A dashboard component never divides one number by
another -- the join that aligns a numerator with a denominator of the same observation year,
excludes agency types for which a resident denominator is a category error, and refuses a
link the resolution layer did not accept, is a piece of logic that has to be tested, and it
cannot be tested if it lives in a chart.
"""
from __future__ import annotations

ANALYTICS_SQL_BASE = """
DROP TABLE IF EXISTS analytics_agency_geography;
CREATE TABLE analytics_agency_geography AS
SELECT
    a.agency_id,
    a.agency_name,
    a.agency_type,
    a.agency_type_source,
    a.state_abbr,
    a.county_name,
    a.latitude,
    a.longitude,
    a.rate_denominator_eligible,
    a.is_dormant,
    a.is_covered_by_parent,
    x.target_id            AS geo_id,
    x.target_name          AS geo_name,
    x.match_method,
    x.match_score,
    x.review_status        AS geo_review_status,
    g.geo_level,
    g.geoid,
    g.urbanicity_band,
    g.is_independent_city,
    g.is_consolidated,
    g.classfp
FROM dim_agency a
LEFT JOIN agency_crosswalk x
       ON x.canonical_agency_id = a.agency_id
      AND x.target_domain = 'geography'
      AND x.source = 'nledp-resolution'
LEFT JOIN dim_geography g ON g.geo_id = x.target_id;

-- Population served, with all three bases side by side and the divergence made explicit.
DROP TABLE IF EXISTS analytics_agency_population;
CREATE TABLE analytics_agency_population AS
WITH pep AS (
    SELECT geo_id, data_year, population FROM fact_demographics WHERE basis='pep'
),
balance AS (
    SELECT replace(geo_id, '#balance', '') AS geo_id, data_year, population
    FROM fact_demographics WHERE basis='pep_county_balance'
),
acs AS (
    SELECT geo_id, data_year, population, population_moe
    FROM fact_demographics WHERE basis='acs5'
)
SELECT
    ag.agency_id,
    t.data_year,
    ag.geo_id,
    pep.population                                   AS population_pep,
    acs.population                                   AS population_acs5,
    acs.population_moe                               AS population_acs5_moe,
    fs.fbi_population                                AS population_fbi_reported,
    -- PEP publishes place population only for INCORPORATED places (SUMLEV 162). An agency
    -- that resolves to a Census Designated Place -- common for tribal police and for
    -- unincorporated communities -- has no PEP value, so ACS carries the denominator there
    -- and the basis is recorded per row rather than assumed for the whole table.
    bal.population                                   AS population_county_balance,
    CASE WHEN ag.geo_review_status = 'accepted' AND ag.rate_denominator_eligible
         THEN CASE
              -- A sheriff patrols the unincorporated balance, not the whole county.
              WHEN ag.agency_type IN ('county_sheriff','county_police')
                   AND bal.population > 0
                   AND bal.population < pep.population THEN bal.population
              ELSE coalesce(pep.population, acs.population)
              END
         END                                         AS denominator,
    CASE WHEN ag.agency_type IN ('county_sheriff','county_police') AND bal.population > 0
              THEN 'pep_county_balance'
         WHEN pep.population IS NOT NULL THEN 'pep'
         WHEN acs.population IS NOT NULL THEN 'acs5'
         ELSE NULL END                               AS denominator_basis,
    CASE
      WHEN pep.population IS NULL OR fs.fbi_population IS NULL OR fs.fbi_population = 0
        THEN NULL
      ELSE abs(pep.population - fs.fbi_population) * 1.0 / fs.fbi_population
    END                                              AS fbi_pep_divergence
FROM analytics_agency_geography ag
CROSS JOIN (SELECT DISTINCT data_year FROM dim_time WHERE data_year BETWEEN 2020 AND 2025) t
LEFT JOIN pep ON pep.geo_id = ag.geo_id AND pep.data_year = t.data_year
LEFT JOIN acs ON acs.geo_id = ag.geo_id AND acs.data_year = t.data_year
LEFT JOIN balance bal ON bal.geo_id = ag.geo_id AND bal.data_year = t.data_year
LEFT JOIN fact_staffing fs ON fs.agency_id = ag.agency_id AND fs.data_year = t.data_year
WHERE ag.geo_id IS NOT NULL;

-- Agency-year profile. Rates appear ONLY where numerator and denominator share a year, the
-- geography link was accepted, and the agency type admits a resident denominator.
DROP TABLE IF EXISTS analytics_agency_year_base;
CREATE TABLE analytics_agency_year_base AS
WITH v AS (
    SELECT agency_id, data_year, offenses, clearances, months_reported, value_type
    FROM fact_crime WHERE offense_group='violent-crime'
),
p AS (
    SELECT agency_id, data_year, offenses, clearances, months_reported, value_type
    FROM fact_crime WHERE offense_group='property-crime'
)
SELECT
    ag.agency_id, ag.agency_name, ag.agency_type, ag.state_abbr, ag.geo_id, ag.geo_name,
    ag.geo_level, ag.urbanicity_band, ag.geo_review_status, ag.rate_denominator_eligible,
    ay.data_year,
    pop.denominator                                   AS population,
    pop.denominator_basis,
    pop.population_pep                                AS population_geography_total,
    s.sworn_officers, s.civilian_personnel, s.total_personnel,
    v.offenses                                        AS violent_crime_offenses,
    v.clearances                                      AS violent_crime_clearances,
    v.months_reported                                 AS violent_months_reported,
    v.value_type                                      AS violent_value_type,
    p.offenses                                        AS property_crime_offenses,
    p.months_reported                                 AS property_months_reported,
    p.value_type                                      AS property_value_type,
    CASE WHEN pop.denominator > 0 AND s.sworn_officers IS NOT NULL
         THEN s.sworn_officers * 1000.0 / pop.denominator END        AS officers_per_1k,
    -- A handful of agency-years carry a NEGATIVE offense total, because the FBI's monthly
    -- series includes revisions that net below zero. Those are preserved in fact_crime as
    -- what the source published, and excluded here, because a negative rate is not a
    -- meaningful number to put on a page.
    CASE WHEN pop.denominator > 0 AND v.offenses >= 0 AND v.months_reported = 12
         THEN v.offenses * 100000.0 / pop.denominator END            AS violent_crime_rate,
    CASE WHEN pop.denominator > 0 AND p.offenses >= 0 AND p.months_reported = 12
         THEN p.offenses * 100000.0 / pop.denominator END            AS property_crime_rate,
    CASE WHEN s.total_personnel > 0
         THEN s.civilian_personnel * 1.0 / s.total_personnel END     AS civilian_share,
    r.participated, r.nibrs_participated, r.pe_reported
FROM (SELECT DISTINCT agency_id, data_year FROM (
        SELECT agency_id, data_year FROM fact_staffing
        UNION SELECT agency_id, data_year FROM fact_crime
     )) ay
JOIN analytics_agency_geography ag ON ag.agency_id = ay.agency_id
LEFT JOIN analytics_agency_population pop
       ON pop.agency_id = ay.agency_id AND pop.data_year = ay.data_year
LEFT JOIN fact_staffing s ON s.agency_id = ay.agency_id AND s.data_year = ay.data_year
LEFT JOIN v ON v.agency_id = ay.agency_id AND v.data_year = ay.data_year
LEFT JOIN p ON p.agency_id = ay.agency_id AND p.data_year = ay.data_year
LEFT JOIN fact_reporting r ON r.agency_id = ay.agency_id AND r.data_year = ay.data_year;
"""

ANALYTICS_SQL_DERIVED = """
-- Peer cohorts. The definition is stored WITH the cohort so the product can always show it.
DROP TABLE IF EXISTS analytics_peer_cohort;
CREATE TABLE analytics_peer_cohort AS
SELECT
    agency_id,
    data_year,
    agency_type,
    state_abbr,
    urbanicity_band,
    CASE
      WHEN population IS NULL          THEN NULL
      WHEN population <  10000         THEN '<10K'
      WHEN population <  25000         THEN '10K-25K'
      WHEN population <  50000         THEN '25K-50K'
      WHEN population < 100000         THEN '50K-100K'
      WHEN population < 250000         THEN '100K-250K'
      WHEN population < 500000         THEN '250K-500K'
      WHEN population < 1000000        THEN '500K-1M'
      ELSE '1M+'
    END AS population_band,
    agency_type || ' | ' ||
      coalesce(CASE
        WHEN population IS NULL   THEN NULL
        WHEN population <  10000  THEN '<10K'
        WHEN population <  25000  THEN '10K-25K'
        WHEN population <  50000  THEN '25K-50K'
        WHEN population < 100000  THEN '50K-100K'
        WHEN population < 250000  THEN '100K-250K'
        WHEN population < 500000  THEN '250K-500K'
        WHEN population < 1000000 THEN '500K-1M'
        ELSE '1M+' END, 'unknown') || ' | ' ||
      coalesce(urbanicity_band, 'unknown') AS cohort_id,
    officers_per_1k, violent_crime_rate, property_crime_rate, population
FROM analytics_agency_year
WHERE rate_denominator_eligible AND geo_review_status = 'accepted'
  AND rate_allowed;

DROP TABLE IF EXISTS analytics_peer_benchmarks;
CREATE TABLE analytics_peer_benchmarks AS
SELECT
    cohort_id, data_year,
    count(*)                                                       AS cohort_size,
    median(officers_per_1k)                                        AS officers_per_1k_median,
    quantile_cont(officers_per_1k, 0.25)                           AS officers_per_1k_p25,
    quantile_cont(officers_per_1k, 0.75)                           AS officers_per_1k_p75,
    median(violent_crime_rate)                                     AS violent_rate_median,
    quantile_cont(violent_crime_rate, 0.25)                        AS violent_rate_p25,
    quantile_cont(violent_crime_rate, 0.75)                        AS violent_rate_p75
FROM analytics_peer_cohort
GROUP BY 1, 2
HAVING count(*) >= 5;   -- a cohort of four is not a benchmark

DROP TABLE IF EXISTS analytics_state_year;
CREATE TABLE analytics_state_year AS
SELECT
    state_abbr,
    data_year,
    count(DISTINCT agency_id)                                      AS agencies,
    count(DISTINCT CASE WHEN participated THEN agency_id END)      AS agencies_participating,
    sum(sworn_officers)                                            AS sworn_officers,
    sum(civilian_personnel)                                        AS civilian_personnel,
    sum(CASE WHEN violent_months_reported = 12 THEN violent_crime_offenses END)
                                                                   AS violent_offenses_full_year,
    sum(CASE WHEN violent_months_reported = 12 THEN population END)
                                                                   AS population_full_year_reporters,
    CASE WHEN sum(CASE WHEN violent_months_reported = 12 THEN population END) > 0
         THEN sum(CASE WHEN violent_months_reported = 12 THEN violent_crime_offenses END)
              * 100000.0
              / sum(CASE WHEN violent_months_reported = 12 THEN population END) END
                                                                   AS violent_crime_rate
FROM analytics_agency_year
GROUP BY 1, 2;

-- Provenance, compacted. The API needs to answer "where did this agency's numbers come
-- from", which is a question about SOURCES, not about individual observations: 51,246
-- agency-source pairs carry the same answer as 1.2 million fact rows. Precomputing it here
-- means the serving database never has to contain the fact tables at all, which is the
-- difference between a deployable artifact and a 160 MB one.
DROP TABLE IF EXISTS analytics_provenance;
CREATE TABLE analytics_provenance AS
SELECT 'staffing' AS measure, agency_id, source_id,
       min(data_year) AS first_year, max(data_year) AS last_year, count(*) AS observations
FROM fact_staffing GROUP BY 1,2,3
UNION ALL
SELECT 'crime', agency_id, source_id,
       min(data_year), max(data_year), count(*)
FROM fact_crime GROUP BY 1,2,3;

DROP TABLE IF EXISTS analytics_source_usage;
CREATE TABLE analytics_source_usage AS
SELECT source_id, sum(n) AS observations FROM (
    SELECT source_id, count(*) AS n FROM fact_crime        GROUP BY 1 UNION ALL
    SELECT source_id, count(*)      FROM fact_staffing     GROUP BY 1 UNION ALL
    SELECT source_id, count(*)      FROM fact_demographics GROUP BY 1 UNION ALL
    SELECT source_id, count(*)      FROM fact_finance      GROUP BY 1 UNION ALL
    SELECT source_id, count(*)      FROM fact_reporting    GROUP BY 1
) GROUP BY 1;

DROP TABLE IF EXISTS analytics_reporting_coverage;
CREATE TABLE analytics_reporting_coverage AS
SELECT
    ay.state_abbr,
    ay.data_year,
    count(*)                                                            AS agency_years,
    sum(CASE WHEN ay.violent_months_reported = 12 THEN 1 ELSE 0 END)    AS full_year_reporters,
    sum(CASE WHEN ay.violent_months_reported BETWEEN 1 AND 11 THEN 1 ELSE 0 END)
                                                                        AS partial_reporters,
    sum(CASE WHEN ay.violent_months_reported IS NULL THEN 1 ELSE 0 END) AS non_reporters,
    sum(ay.population)                                                  AS population_total,
    sum(CASE WHEN ay.violent_months_reported = 12 THEN ay.population END)
                                                                        AS population_covered,
    CASE WHEN sum(ay.population) > 0
         THEN sum(CASE WHEN ay.violent_months_reported = 12 THEN ay.population END) * 1.0
              / sum(ay.population) END                                  AS population_coverage
FROM analytics_agency_year ay
GROUP BY 1, 2;
"""


def build_analytics(con) -> dict[str, int]:
    """Build the analytics layer.

    The order matters. The base SQL produces raw joined values; the policy pass decides what
    may be published from them; the cohort and benchmark tables are then built from the
    policy-approved view. A rate the policy withholds never reaches a peer median.
    """
    con.execute(ANALYTICS_SQL_BASE)
    from .policy_pass import apply_policy
    apply_policy(con)
    con.execute(ANALYTICS_SQL_DERIVED)
    names = ["analytics_agency_geography", "analytics_agency_population",
             "analytics_agency_year", "analytics_peer_cohort",
             "analytics_peer_benchmarks", "analytics_state_year",
             "analytics_reporting_coverage", "analytics_provenance",
             "analytics_source_usage"]
    return {n: con.execute(f"SELECT count(*) FROM {n}").fetchone()[0] for n in names}
