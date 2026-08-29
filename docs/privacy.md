# Privacy and Ethics

## The commitment

The analytical unit of this platform is the **agency, jurisdiction, county, city and state**.
It is never an officer, a suspect, a victim, a witness or a resident.

That is not a policy statement layered over the data. It is a property of the schema. No
table in the warehouse has a person grain. The FBI's NIBRS state archives contain
incident-, victim-, offender- and arrestee-level records, and this platform deliberately
reads exactly one member out of those archives — `agencies.csv`, the agency dimension — and
nothing else. The person-level segments are never downloaded, never staged and never parsed.

## Included

- Public agency identity: name, ORI, agency type, jurisdiction, county, state, point location
- Aggregate agency statistics: sworn and civilian personnel counts, population served
- Aggregate crime statistics: offense and clearance counts by offense group, by agency-year
- Reporting participation: whether an agency submitted, for how many months, under which program
- Public geography: Census places, county subdivisions, counties, states, urban areas
- Public population estimates: Population Estimates Program and American Community Survey
- Public finance: government-unit expenditure on police protection, from the Census Bureau

Every one of these is a published federal statistic about an institution or a place.

## Excluded

The platform will not build, and will not accept a contribution that builds:

- Home addresses, personal phone numbers or personal email addresses of any individual
- Officer names, badge numbers, schedules, assignments, shift patterns or locations
- Real-time or historical location tracking of any person
- Victim identities or any victim-level record
- Witness identities or any witness-level record
- Suspect or arrestee tracking, or any person-level criminal-history record
- Personnel records, disciplinary records or complaint records naming an individual
- Licence-plate reader data
- Facial-recognition data, biometric data or any derived identity signal
- Any feature whose purpose or predictable effect is targeting by a protected class

These exclusions hold regardless of whether the underlying data is technically public. Some
of it is: several states publish officer rosters and disciplinary databases. Aggregating
scattered public records into a single searchable national profile of an individual is a
different act from any of the disclosures that produced them, and it is not what this
platform is for.

## Why an institutional unit of analysis

Three reasons, in descending order of importance.

**It is the honest one.** The questions this platform exists to answer — how large is this
department, how has its staffing changed, what are the local crime trends, how does it
compare to similar jurisdictions, what does the jurisdiction spend — are institutional
questions. Answering them does not require a person-level record, and adding one would not
improve any of the answers.

**It avoids a category of harm the data cannot justify.** Person-level criminal-justice data
carries known, severe accuracy problems: arrest is not conviction, a charge is not a fact,
and error rates in these systems fall unevenly. A platform that surfaces such records at
individual grain distributes those errors to employers, landlords and neighbours, at scale,
with the credibility of a federal source behind them.

**It makes the data quality problem tractable.** At agency grain the platform can measure and
publish its own coverage: 94.4% of population covered by full-year reporters in 2024, 69.5%
in 2021. At person grain no equivalent measure exists, and a gap becomes indistinguishable
from an absence of events.

## Intended use

Research, journalism, policy analysis, public administration, academic work and civic
understanding. The platform is built for someone who needs to know how much confidence a
comparison deserves, not for someone who needs a number to put in a headline.

It is explicitly not built for, and its design actively frustrates: targeting individuals,
constructing profiles of people, ranking jurisdictions into league tables, or producing
per-agency spending figures that no federal source supports.

## Governance in code

Three commitments in this document are enforced by columns and tests rather than by
convention, because a policy that lives only in a document is a policy that erodes.

| Commitment | Enforcement |
|---|---|
| Spending is never attributed to an agency | `fact_finance.attribution_level` is always `government_unit`; asserted by `test_finance_is_never_attributed_to_an_agency` |
| Incomparable metrics are never ranked | `dim_metric.ranking_allowed`; asserted by `test_metric_registry_marks_spending_as_non_rankable` |
| No per-resident rate where the served population is transient | `dim_agency.rate_denominator_eligible`; asserted by `test_no_resident_rate_for_transient_population_agencies` |
| Every published figure names its source | `source_id` on every fact table, foreign-keyed to `dim_source`; asserted by two tests |

Adding a ranking, or a per-agency spending figure, would require changing the registry and
failing a test. That is deliberate.

## Reporting a concern

If you find a figure you believe is wrong, a link you believe is misattributed, or a feature
you believe crosses one of the lines above, open an issue with the agency ID, the year and
the metric. Every number in the platform traces back through `data_quality_log`, the release
manifest and a SHA-256 to the exact source bytes it came from, so a specific report can be
answered specifically.
