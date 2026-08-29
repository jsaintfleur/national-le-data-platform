# National Law Enforcement Data & Intelligence Platform

A public-interest data platform that consolidates authoritative federal data about
law-enforcement agencies in the United States into one traceable, analytically defensible
system. The analytical unit is the **agency, jurisdiction, county, city and state** — never
an officer, suspect, victim, witness or resident.

**Phase 1 (data foundation) is built and running.** The pipeline ingests thirteen federal
sources, reconciles 19,902 agency identities, resolves them to Census geography, and
produces a validated, versioned warehouse. Phase 2 (the web application) is next.

```
19,902  agencies with a reconciled identity
72,055  geographies (place, county subdivision, county, state)
320,190 agency-year crime observations, 2016–2025
183,391 agency-year staffing observations, 2016–2025
316,276 population observations across three denominator bases
125,816 government-unit finance observations, FY2022–FY2024
     0  validation errors · 32 tests passing
```

---

## What it answers

How many agencies operate in the United States, and where. What jurisdictions they serve and
how large they are. How staffing has changed. What local crime trends look like, and how much
confidence a given comparison deserves. Which agencies participate in federal reporting
programs and where the gaps are. What a jurisdiction's government spends on police
protection — and, just as importantly, what that figure does and does not mean.

Start with [`docs/blueprint.md`](docs/blueprint.md). It is the architectural argument, and
every number in it was produced by this pipeline.

---

## What it will not do

It does not fabricate. If real data is unavailable the platform shows missing data, with a
reason. No agency coordinate, crime rate, staffing figure, budget or historical observation
is ever invented, interpolated or back-filled.

It does not rank incomparable jurisdictions. Peer cohorts and percentiles are offered
instead, with the cohort definition always visible.

It does not publish a per-agency spending figure. Federal expenditure data is collected from
*governments* — cities, counties, states — not from police departments, and no crosswalk
from a Census government ID to an FBI ORI exists anywhere. Any per-agency number would be an
estimate the platform made up. Six metrics are formally defined as prohibited in
[`registry/metrics.yaml`](registry/metrics.yaml), each with its reason.

It does not expose personal information: no home addresses, personal contact details, officer
schedules or locations, victim or witness identities, suspect tracking, personnel records,
licence-plate or facial-recognition data. This is a schema-level commitment — no table has a
person grain, and the NIBRS victim, offender and arrestee segments are deliberately not
ingested.

---

## Quick start

```bash
git clone <repo> && cd national-le-data-platform
pip install -e ".[dev]"

cp .env.example .env          # then paste your two free API keys
#   https://api.data.gov/signup/                    -> FBI_CDE_API_KEY
#   https://api.census.gov/data/key_signup.html     -> CENSUS_API_KEY

nledp ingest --crime          # ~30 min: 90 MB of sources + a 39,250-call crime harvest
nledp build                   # ~4 min: stage, resolve, load, validate, analyze, release
nledp status                  # row counts and the active release
pytest                        # 32 tests
```

The API keys are optional for most of the pipeline. The FBI's Crime Data Explorer is read
from its unkeyed origin by default (the keyed `api.data.gov` gateway is configured as a
fallback and is rate-limited per key). The Census key **is** required: keyless requests now
return HTTP 302 to a "Missing Key" page rather than an error.

### Ask it something

```bash
nledp query "
  SELECT data_year, population, sworn_officers,
         round(officers_per_1k, 2) AS per_1k,
         violent_crime_offenses, round(violent_crime_rate) AS rate_100k,
         violent_months_reported AS months
  FROM analytics_agency_year
  WHERE agency_id = 'MDBPD0000' ORDER BY data_year"
```

```
 2020 │ 583,295 │ 2,465 │ 4.23 │ 9,398 │ 1,611 │ 12
 2021 │ 576,503 │ 2,360 │ 4.09 │ 4,987 │       │  7   ← 7 months reported, no rate published
 2022 │ 570,475 │ 2,360 │ 4.14 │ 9,753 │ 1,710 │ 12
 2023 │ 567,952 │ 2,047 │ 3.60 │ 9,578 │ 1,686 │ 12
 2024 │ 570,053 │ 1,986 │ 3.48 │ 9,161 │ 1,607 │ 12
 2025 │ 569,997 │ 2,051 │ 3.60 │ 7,602 │ 1,334 │ 12
```

2021 is the design working. Baltimore reported seven months that year, so the count is shown
and the rate is withheld. Dividing anyway would have published a 39% one-year drop in violent
crime that did not happen.

---

## Architecture

Five layers with hard boundaries. Raw bytes are never edited; parsers hold no business logic;
canonical tables have one grain each and every row names its source; **every rate is computed
in the analytics layer and nowhere else**; the application reads only analytics tables.

That last rule is the load-bearing one. A rate is a join — it must align a numerator with a
denominator of the same observation year, exclude agency types for which a resident
denominator is a category error, and refuse a geography link that was never accepted. That is
testable logic, and it cannot be tested if it lives inside a chart component.

```
data/raw/          source bytes, unchanged, SHA-256 per artifact
src/nledp/
  connectors/      one module per source family; parsers only
  canonical/       dim_* and fact_* builders
  resolution/      agency -> geography, geography -> government
  analytics/       rates, peer cohorts, benchmarks, coverage
  quality/         23 validation checks -> data_quality_log
registry/
  sources.yaml     13 sources + 4 deferred, every URL verified by live request
  metrics.yaml     17 metrics + 6 prohibited, each with comparison/ranking permissions
data/releases/     one manifest per build: source hashes, row counts, validation, git commit
```

---

## Three findings that shaped the build

**ORI is not one identifier — it is three.** The CDE API emits a NIBRS ORI9 that may carry an
alphanumeric tail (`DE0029Z0X`); the SRS-era master files key on ORI7; and the bridge between
them is `legacy_ori[:7]`, *not* `ori[:7]`. Deriving from the wrong one silently drops
agencies from every staffing series. ORI7 is also not unique — fourteen ORI9s share
`CA01999` — so an ambiguous ORI7 is refused and logged rather than attributed to whichever
agency was read first.

**`pe-2025.zip` is a zero-filled shell.** It downloads cleanly, 26,288 records, every
employment count 0. A loader that trusts it replaces the national police workforce with zero.
The loader asserts a non-zero annual total and rejects the file.

**Sheriffs need a different denominator.** A sheriff normally patrols only the unincorporated
balance of a county. Dividing by the full county population understates the rate by three to
ten times in urbanized counties. The platform computes the balance — Los Angeles County goes
from 9,748,868 to 969,505 residents, and LASD's officers-per-1,000 goes from a meaningless
0.91 to 9.12. It remains wrong where a sheriff polices cities under contract, which is
flagged rather than corrected, because those contracts are not in any federal source.

---

## Documentation

| | |
|---|---|
| [`docs/blueprint.md`](docs/blueprint.md) | The full technical blueprint — architecture, data model, resolution strategy, metric framework, roadmap, risks |
| [`docs/architecture.md`](docs/architecture.md) | Layer boundaries and module map |
| [`docs/data-model.md`](docs/data-model.md) | Table-by-table schema and grain |
| [`docs/data-sources.md`](docs/data-sources.md) | The source matrix, generated from the registry |
| [`docs/methodology.md`](docs/methodology.md) | Denominators, classification, resolution, and what each metric does not mean |
| [`docs/privacy.md`](docs/privacy.md) | What is included, what is excluded, and why |
| [`docs/testing.md`](docs/testing.md) | Test strategy and the validation register |
| [`docs/deployment.md`](docs/deployment.md) | Running the pipeline and cutting a release |

---

## Data sources

All federal, all public domain. FBI Crime Data Explorer (agency directory, NIBRS agency
dimension, Police Employee master files, summarized crime). Bureau of Justice Statistics
(CSLLEA 2018 aggregate tables). U.S. Census Bureau (Gazetteer 2025, Population Estimates
vintage 2025, ACS 5-year 2024, 2020 urban areas, Annual Survey of State and Local Government
Finances FY2022–FY2024, Government Units Listing 2025).

Every source in [`registry/sources.yaml`](registry/sources.yaml) carries its publisher,
access method, coverage years, licence, primary identifier, known limitations, and the HTTP
status observed when it was last verified.

---

## Licence

Code: MIT. Data: all ingested sources are U.S. Government works in the public domain.
Attribution to the originating agency is requested wherever figures are republished.
