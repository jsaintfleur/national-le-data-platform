"""The analytical policy engine.

Every question of the form "may this be shown?" is answered here and nowhere else:

    Can this rate be displayed?
    Can these agencies be compared?
    Does this observation have sufficient coverage?
    Is this denominator valid?
    Can a percentile be shown?

The rules live in one module because they are the product's integrity, and integrity that is
scattered across React components erodes one convenient exception at a time. The analytics
SQL, the API and the interface all read their vocabularies and thresholds from here.

Nothing in this module hides a number. A rate that cannot be computed is reported as a
withheld rate with a reason, never as a blank; an implausible rate is shown with a warning,
never capped, winsorized or smoothed.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

# ======================================================================================
# Denominators
# ======================================================================================


def _val(x) -> str | None:
    """Normalize an Enum member or a raw string to its value.

    str(SomeStrEnum.MEMBER) is "SomeStrEnum.MEMBER" on Python 3.11, not "MEMBER". Comparing
    with str() silently fails open, which here would mean publishing a rate the policy is
    supposed to withhold. Every comparison in this module goes through this function.
    """
    if x is None:
        return None
    return x.value if isinstance(x, Enum) else str(x)


class DenominatorType(str, Enum):
    MUNICIPAL_POPULATION = "municipal_population"
    COUNTY_POPULATION = "county_population"
    UNINCORPORATED_POPULATION = "unincorporated_population"
    CONTRACT_SERVICE_POPULATION = "contract_service_population"
    CAMPUS_POPULATION = "campus_population"
    TRANSIT_POPULATION = "transit_population"
    STATEWIDE_POPULATION = "statewide_population"
    UNKNOWN = "unknown"
    NOT_APPLICABLE = "not_applicable"


class Confidence(str, Enum):
    HIGH = "HIGH"
    MODERATE = "MODERATE"
    LIMITED = "LIMITED"
    NOT_COMPARABLE = "NOT_COMPARABLE"


# Agency types whose served population is transient and nested inside another agency's
# jurisdiction. A resident denominator here is a category error, not a weak estimate.
TRANSIENT_POPULATION_TYPES = {
    "university_police": DenominatorType.CAMPUS_POPULATION,
    "transit_police": DenominatorType.TRANSIT_POPULATION,
    "port_or_airport_police": DenominatorType.UNKNOWN,
    "park_or_conservation_police": DenominatorType.UNKNOWN,
    "special_jurisdiction": DenominatorType.UNKNOWN,
    "state_special_jurisdiction": DenominatorType.UNKNOWN,
    "marshal_or_constable": DenominatorType.UNKNOWN,
    "federal": DenominatorType.NOT_APPLICABLE,
}

# Statewide agencies overlap every local agency in the state, so the same residents already
# sit in every local denominator. Excluded for a different reason than the group above.
OVERLAPPING_JURISDICTION_TYPES = {"state_police"}

COUNTY_TYPES = {"county_sheriff", "county_police"}
MUNICIPAL_TYPES = {"municipal_police"}

DENOMINATOR_NOTES = {
    DenominatorType.MUNICIPAL_POPULATION:
        "Resident population of the municipality the agency polices.",
    DenominatorType.UNINCORPORATED_POPULATION:
        "County population minus the population of every incorporated place within it. A "
        "sheriff normally patrols only this balance, because the incorporated cities inside "
        "the county run their own departments. Contract-policing responsibilities may extend "
        "beyond this population.",
    DenominatorType.COUNTY_POPULATION:
        "Full county resident population. Used where the unincorporated balance is not "
        "smaller than the county total, which is the signature of a consolidated "
        "city-county government.",
    DenominatorType.CAMPUS_POPULATION:
        "No resident denominator applies. A campus police department serves a largely "
        "non-resident daytime population nested inside a municipal agency's jurisdiction.",
    DenominatorType.TRANSIT_POPULATION:
        "No resident denominator applies. A transit agency's jurisdiction is a linear "
        "network crossing many places and counties, and no Census geography corresponds to it.",
    DenominatorType.STATEWIDE_POPULATION:
        "A statewide agency's jurisdiction overlaps every local agency in the state, so a "
        "per-resident rate would count the same residents in several denominators at once.",
    DenominatorType.UNKNOWN:
        "The population this agency serves is not established by any federal source.",
    DenominatorType.NOT_APPLICABLE:
        "A per-resident rate is not a meaningful measure for this agency type.",
}

# Above this, a balance-denominated sheriff rate is shown WITH a methodology warning.
# It is never capped, hidden or replaced. Configurable: raising it hides real signal,
# lowering it warns on ordinary rural sheriffs.
SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K = 8.0
IMPLAUSIBLE_VIOLENT_RATE_PER_100K = 10_000.0


# Denominator TYPE is a structural property of the agency and its jurisdiction. It does not
# change from year to year because a population estimate happens to be missing: Baltimore's
# denominator is a municipal population in 2016 exactly as it is in 2024, and the reason
# there is no 2016 rate is that the estimates series starts in 2020, not that the department
# suddenly became incomparable. Keeping the two ideas separate is what lets the interface
# say the true thing in each case.
def denominator_type_for(agency_type: str, basis: str | None,
                         geo_level: str | None = None) -> DenominatorType:
    """Classify what a rate's denominator represents for this agency."""
    if agency_type in OVERLAPPING_JURISDICTION_TYPES:
        return DenominatorType.STATEWIDE_POPULATION
    if agency_type in TRANSIENT_POPULATION_TYPES:
        return TRANSIENT_POPULATION_TYPES[agency_type]
    if agency_type in COUNTY_TYPES:
        return (DenominatorType.UNINCORPORATED_POPULATION if basis == "pep_county_balance"
                else DenominatorType.COUNTY_POPULATION)
    if basis in ("pep", "acs5") or geo_level in ("place", "cousub"):
        return DenominatorType.MUNICIPAL_POPULATION
    if geo_level == "county":
        return DenominatorType.COUNTY_POPULATION
    return DenominatorType.UNKNOWN


def structurally_not_comparable(dtype: DenominatorType) -> bool:
    """True when no resident denominator can ever apply, whatever the year."""
    return dtype in (
        DenominatorType.STATEWIDE_POPULATION, DenominatorType.CAMPUS_POPULATION,
        DenominatorType.TRANSIT_POPULATION, DenominatorType.NOT_APPLICABLE,
        DenominatorType.UNKNOWN,
    )


def denominator_confidence(dtype: DenominatorType, basis: str | None,
                           geo_review_status: str | None,
                           officers_per_1k: float | None = None,
                           has_value: bool = True) -> Confidence:
    if structurally_not_comparable(dtype):
        return Confidence.NOT_COMPARABLE
    if not has_value:
        # The denominator type is valid; this particular year has no estimate.
        return Confidence.LIMITED
    if geo_review_status != "accepted":
        return Confidence.LIMITED
    if dtype == DenominatorType.UNINCORPORATED_POPULATION:
        # Defensible by construction, but contract policing means one denominator can never
        # be exactly right for a sheriff.
        if officers_per_1k is not None and officers_per_1k > SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K:
            return Confidence.LIMITED
        return Confidence.MODERATE
    if dtype == DenominatorType.COUNTY_POPULATION:
        return Confidence.MODERATE
    if basis == "acs5":
        # A 60-month period estimate standing in for a single named year.
        return Confidence.MODERATE
    return Confidence.HIGH


# ======================================================================================
# Reporting coverage
# ======================================================================================


class CoverageStatus(str, Enum):
    COMPLETE = "COMPLETE"
    PARTIAL = "PARTIAL"
    NONE = "NONE"
    UNKNOWN = "UNKNOWN"


REQUIRED_MONTHS_FOR_RATE = 12


def coverage_status(months_reported: int | None) -> CoverageStatus:
    if months_reported is None:
        return CoverageStatus.UNKNOWN
    if months_reported <= 0:
        return CoverageStatus.NONE
    if months_reported >= REQUIRED_MONTHS_FOR_RATE:
        return CoverageStatus.COMPLETE
    return CoverageStatus.PARTIAL


def rate_allowed(months_reported: int | None, denominator: float | None,
                 dconfidence: Confidence | str | None, offenses: int | None = None) -> bool:
    """A count may be shown on partial reporting. An annual RATE may not.

    The platform does not annualize a partial-year count, because no source methodology
    supports the assumption that the unreported months resemble the reported ones.
    """
    if coverage_status(months_reported) is not CoverageStatus.COMPLETE:
        return False
    if not denominator or denominator <= 0:
        return False
    if _val(dconfidence) == Confidence.NOT_COMPARABLE.value:
        return False
    if offenses is not None and offenses < 0:
        return False
    return True


WITHHOLDING_REASONS = {
    "partial_year": "Insufficient annual reporting coverage",
    "no_reporting": "Not reported",
    "no_denominator": "No population estimate for this year",
    "not_comparable": "Not comparable using a standard resident denominator",
    "negative_source_value": "Source value is negative after revisions",
}


def rate_withheld_reason(months_reported: int | None, denominator: float | None,
                         dconfidence: Confidence | str | None,
                         offenses: int | None = None,
                         dtype: DenominatorType | str | None = None) -> str | None:
    """Name the single most specific reason a rate is not published.

    Precedence matters. "Not comparable" is reserved for agencies where no resident
    denominator can ever apply; it must not be used for a municipal department that simply
    has no population estimate for an early year, which is a coverage gap and reads very
    differently to a user.
    """
    if rate_allowed(months_reported, denominator, dconfidence, offenses):
        return None
    status = coverage_status(months_reported)
    if dtype is not None:
        structural = structurally_not_comparable(
            dtype if isinstance(dtype, DenominatorType) else DenominatorType(_val(dtype)))
    else:
        structural = _val(dconfidence) == Confidence.NOT_COMPARABLE.value
    if structural:
        return WITHHOLDING_REASONS["not_comparable"]
    if status is CoverageStatus.NONE or status is CoverageStatus.UNKNOWN:
        return WITHHOLDING_REASONS["no_reporting"]
    if status is CoverageStatus.PARTIAL:
        return WITHHOLDING_REASONS["partial_year"]
    if offenses is not None and offenses < 0:
        return WITHHOLDING_REASONS["negative_source_value"]
    return WITHHOLDING_REASONS["no_denominator"]


# ======================================================================================
# Comparability
# ======================================================================================


@dataclass
class ComparabilityIssue:
    severity: str            # "warning" | "blocking"
    code: str
    message: str


def comparability(agencies: list[dict], metric_id: str, year: int) -> list[ComparabilityIssue]:
    """Check whether a set of agencies can be compared on a metric, and explain any problem.

    This never blocks the whole analysis. A user who wants to look at a state police force
    beside a city department is asking a reasonable question; the platform's job is to say
    what the numbers do and do not share, not to refuse the screen.
    """
    issues: list[ComparabilityIssue] = []
    if len(agencies) < 2:
        return issues

    types = {a.get("agency_type") for a in agencies}
    dtypes = {a.get("denominator_type") for a in agencies if a.get("denominator_type")}
    confidences = {_val(a.get("denominator_confidence")) for a in agencies}

    if OVERLAPPING_JURISDICTION_TYPES & types and types - OVERLAPPING_JURISDICTION_TYPES:
        issues.append(ComparabilityIssue(
            "warning", "statewide_vs_local",
            "Statewide police agencies are included alongside local agencies. A statewide "
            "agency's jurisdiction overlaps every local agency in its state, so per-resident "
            "rates are not on a common basis. Counts remain comparable."))

    if len(dtypes) > 1:
        issues.append(ComparabilityIssue(
            "warning", "mixed_denominators",
            "These agencies use different population denominators: "
            + ", ".join(sorted(d.replace("_", " ") for d in dtypes))
            + ". Rates measure different populations and are not directly comparable."))

    if Confidence.NOT_COMPARABLE.value in confidences:
        issues.append(ComparabilityIssue(
            "warning", "not_comparable_member",
            "At least one agency has no valid resident denominator, so it contributes counts "
            "but no rate to this comparison."))

    if len(types) > 1 and not (OVERLAPPING_JURISDICTION_TYPES & types):
        issues.append(ComparabilityIssue(
            "warning", "mixed_agency_types",
            "Agency types differ (" + ", ".join(sorted(t.replace("_", " ") for t in types))
            + "). Departments of different types serve different functions and populations."))

    coverages = [a.get("months_reported") for a in agencies if a.get("months_reported") is not None]
    if coverages and min(coverages) < REQUIRED_MONTHS_FOR_RATE:
        issues.append(ComparabilityIssue(
            "warning", "incomplete_coverage",
            f"At least one agency reported fewer than {REQUIRED_MONTHS_FOR_RATE} months in "
            f"{year}. Its counts are shown; its rate is withheld."))

    return issues


# ======================================================================================
# Peer cohorts and percentiles
# ======================================================================================

MIN_COHORT_SIZE = 5

POPULATION_BANDS = [
    (0, 10_000, "<10K"), (10_000, 25_000, "10K-25K"), (25_000, 50_000, "25K-50K"),
    (50_000, 100_000, "50K-100K"), (100_000, 250_000, "100K-250K"),
    (250_000, 500_000, "250K-500K"), (500_000, 1_000_000, "500K-1M"),
    (1_000_000, None, "1M+"),
]


def population_band(population: float | None) -> str | None:
    if population is None:
        return None
    for lo, hi, label in POPULATION_BANDS:
        if population >= lo and (hi is None or population < hi):
            return label
    return None


def percentile_allowed(metric_id: str, cohort_size: int | None,
                       dconfidence: Confidence | str | None) -> bool:
    """A percentile is a position in a distribution, not a grade. It is shown only when the
    distribution is real and the agency belongs in it."""
    if not cohort_size or cohort_size < MIN_COHORT_SIZE:
        return False
    if _val(dconfidence) == Confidence.NOT_COMPARABLE.value:
        return False
    return True


def peer_definition(agency_type: str | None, band: str | None,
                    urbanicity: str | None, year: int) -> str:
    parts = []
    if agency_type:
        parts.append(f"{agency_type.replace('_', ' ')} agencies")
    if band:
        parts.append(f"population served {band}")
    if urbanicity:
        parts.append(urbanicity.lower())
    parts.append(f"complete reporting in {year}")
    return "; ".join(parts)


# ======================================================================================
# Presentation vocabulary shared with the interface
# ======================================================================================

DATA_STATE = {
    "loading": "Loading",
    "ok": "Available",
    "missing": "Not available",
    "not_reported": "Not reported",
    "partial": "Insufficient annual reporting coverage",
    "not_comparable": "Not comparable using a standard resident denominator",
    "methodology_warning": "Shown with a methodology warning",
    "error": "Could not be loaded",
}


def methodology_warning(agency_type: str, dtype: DenominatorType | str,
                        officers_per_1k: float | None) -> str | None:
    """The warning that accompanies a value the platform shows but does not vouch for."""
    if (agency_type in COUNTY_TYPES
            and _val(dtype) == DenominatorType.UNINCORPORATED_POPULATION.value):
        if officers_per_1k is not None and officers_per_1k > SHERIFF_PLAUSIBILITY_OFFICERS_PER_1K:
            return (
                f"This rate is unusually high because the denominator counts only the "
                f"unincorporated balance of the county. Sheriffs' offices frequently police "
                f"incorporated cities under contract, and those residents are not in this "
                f"denominator. The value is shown as computed and has not been adjusted."
            )
        return (
            "Denominator is the unincorporated balance of the county. Contract-policing "
            "responsibilities may extend beyond this population."
        )
    return None
