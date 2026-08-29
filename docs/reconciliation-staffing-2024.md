# Staffing Reconciliation — 2024

*Generated 2026-08-29T17:47:55+00:00 by `scripts/reconcile_staffing.py`. Regenerate rather than hand-edit.*

## The question

The platform reports **736,598 sworn officers** for 2024. The FBI's own national figure for the same year is **772,732**. A number that differs from the federal headline by tens of thousands cannot go on a homepage until the difference is a ledger rather than a discrepancy.

The answer is that the two numbers describe different universes, and every record separating them is accounted for below. Nothing was adjusted to make them agree.

## Ledger

| | Records | Sworn | Civilians |
|---|---:|---:|---:|
| **FBI Police Employee master file, 2024** | 26,136 | 772,777 | 362,993 |
| — Federal agencies (outside the platform's universe) | 142 | −21,806 | −27,036 |
| — Ambiguous ORI7 (refused, not misattributed) | 200 | −8,036 | −3,894 |
| — ORI7 with no agency in the directory | 6,260 | −6,298 | −1,425 |
| &nbsp;&nbsp;of which: unique ORI7 | 19,497 | 731,720 | 329,216 |
| &nbsp;&nbsp;of which: contested ORI7 resolved by primary + name | 37 | 4,917 | 1,422 |
| **Loaded into `fact_staffing`** | 19,534 | **736,637** | 330,638 |
| — Duplicate agency-years collapsed | −191 | −39 | |
| **Platform national total, 2024** | 19,343 | **736,598** | 330,624 |

Residual after the three exclusions: **0**. The ledger closes.

The FBI's published national sworn figure (772,732) and the master file total (772,777) differ by 45 — the API is refreshed more often than the bulk file, so a late agency revision appears in one before the other. Both are the FBI's own numbers.

## The three exclusions

### 1. Federal agencies

21,806 sworn officers across 142 records. Federal agencies submit to the Police Employee collection, and the FBI's national total includes them. This platform's universe is **state, local, tribal and territorial** — the same scope as BJS's agency census, which excludes federal agencies and treats them as a separate collection. This is the largest single component of the difference and it is a scope decision, not a data problem.

| ORI7 | Agency | Sworn |
|---|---|---:|
| `DCFBIWA` | FEDERAL BUREAU OF INVEST | 14,177 |
| `DCVA000` | UNITED STATES DEPARTMENT | 4,944 |
| `DCUSA01` | UNITED STATES ARMY | 689 |
| `VACIA00` | CIA Security Protective | 460 |
| `DC00131` | U.S. DEPARTMENT OF HEALT | 451 |
| `DCTIX00` | United States Treasury I | 261 |

### Contested ORI7 resolved

4,917 sworn officers across 37 records sit on an ORI7 shared by several agencies but were attributed to one of them, because that agency is both the primary ORI for the block (its ORI9 ends in 00) and a clear name match to the record, beating every rival candidate by a wide margin. Boston Police Department is the case that forced this rule: it shares ORI7 MA01301 with Suffolk University Police, and refusing the whole block left a major city department with no staffing series at all.

| ORI7 | Agency | Sworn |
|---|---|---:|
| `MA01301` | BOSTON | 2,129 |
| `AL04701` | HUNTSVILLE | 437 |
| `ID00101` | BOISE | 330 |
| `CO03004` | LAKEWOOD | 278 |
| `NC09203` | CARY | 198 |
| `TX16501` | MIDLAND | 168 |

### 2. Ambiguous ORI7

8,036 sworn officers across 200 records, spanning 77 ORI7 values that each map to more than one ORI9. Fourteen distinct agencies share `CA01999`. A PE record keyed on an ambiguous ORI7 cannot be attributed to one agency, and attributing it to whichever agency was read first would place one department's officers inside another's profile. The platform refuses these and logs them rather than guessing.

| ORI7 | Agency | Sworn |
|---|---|---:|
| `CA03499` | HP: SACRAMENTO COUNTY | 6,837 |
| `IL04501` | AURORA | 324 |
| `CA01001` | COALINGA STATE HOSPITAL | 225 |
| `CO00701` | BOULDER | 176 |
| `CA04001` | ATASCADERO STATE HOSPITA | 139 |
| `SC00401` | ANDERSON | 96 |

### 3. ORI7 with no agency in the directory

6,298 sworn officers across 6,260 records. The PE master file carries a larger, partly historical universe than the live agency directory: dormant agencies, reorganized agencies, and sub-unit ORIs that never appear as an ORI9. Most are tiny; the distribution is dominated by a small number of state-police county sub-units that report staffing at a county-level ORI7 with no corresponding directory entry.

| ORI7 | Agency | Sworn |
|---|---|---:|
| `NY301SG` | SP: ALBANY COUNTY | 5,148 |
| `NCDMV00` | DIVISION OF MOTOR VEHICL | 142 |
| `MS02505` | BUREAU OF NARCOTICS, JAC | 113 |
| `MTMFG00` | MT FISH, WILDLIFE & PARK | 111 |
| `PAPSP34` | STATE POLICE, GREENSBURG | 108 |
| `PAPSP91` | STATE POLICE, PITTSBURGH | 70 |

## Composition of the published figure

| Agency type | Agencies | Sworn | Civilians |
|---|---:|---:|---:|
| `municipal_police` | 11,643 | 410,681 | 115,013 |
| `county_sheriff` | 2,978 | 182,618 | 148,691 |
| `state_police` | 892 | 47,124 | 28,835 |
| `county_police` | 45 | 20,693 | 5,894 |
| `university_police` | 1,209 | 20,529 | 12,514 |
| `special_jurisdiction` | 392 | 18,391 | 4,420 |
| `state_special_jurisdiction` | 817 | 14,410 | 9,144 |
| `park_or_conservation_police` | 596 | 8,962 | 1,842 |
| `port_or_airport_police` | 97 | 4,404 | 983 |
| `marshal_or_constable` | 345 | 3,533 | 844 |
| `tribal_police` | 239 | 3,185 | 1,544 |
| `transit_police` | 90 | 2,068 | 900 |

- **state_or_dc**: 19,339 agencies, 724,868 sworn
- **territory**: 4 agencies, 11,730 sworn

## Verdict

**736,598 is valid for the platform's stated universe and must never be presented as a count of all U.S. law-enforcement officers.**

The headline label is therefore:

> **Sworn officers**  
> 736,598  
> 2024 · state, local, tribal and territorial agencies with a resolved identity  
> Excludes federal agencies (21,806 sworn) and 6,460 records whose agency identity could not be resolved

Two consequences for the product. The exclusion counts are published beside the figure, not buried in a methodology page — a reader who wants the federal-inclusive number can compute it from what is on screen. And the unresolved bucket is a standing work item on the Data Quality page rather than a rounding error: it is small in officers but it is the visible edge of the identifier problem the whole resolution layer exists to manage.

