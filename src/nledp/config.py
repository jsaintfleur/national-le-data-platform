"""Central configuration. All paths and credentials resolve through here."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader. Real secrets never enter the repo; see .env.example."""
    for name in (".env.local", ".env"):
        for base in (Path.cwd(), Path(__file__).resolve().parents[3], Path.home() / "nledp"):
            p = base / name
            if p.is_file():
                for line in p.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    raw: Path = field(default_factory=lambda: ROOT / "data" / "raw")
    staging: Path = field(default_factory=lambda: ROOT / "data" / "staging")
    warehouse: Path = field(default_factory=lambda: ROOT / "data" / "warehouse")
    releases: Path = field(default_factory=lambda: ROOT / "data" / "releases")
    registry: Path = field(default_factory=lambda: ROOT / "registry")
    # NLEDP_DB_PATH lets a serving process read a different database from the one the
    # pipeline builds. In production that is the compacted, API-only file produced by
    # scripts/build_deploy_db.py; locally it is unset and the full warehouse serves.
    db_path: Path = field(default_factory=lambda: Path(
        os.environ.get("NLEDP_DB_PATH")
        or ROOT / "data" / "warehouse" / "nledp.duckdb"))

    # --- Sources -------------------------------------------------------------
    # The unkeyed origin is the CDE web app's own backend. It serves the identical
    # routes with no key and no advertised rate limit. The keyed api.data.gov
    # gateway is kept as a documented fallback; see docs/data-sources.md.
    cde_origin: str = os.environ.get("NLEDP_CDE_ORIGIN", "https://cde.ucr.cjis.gov/LATEST")
    cde_keyed_origin: str = "https://api.usa.gov/crime/fbi/cde"
    census_api: str = "https://api.census.gov/data"
    census_files: str = "https://www2.census.gov"

    @property
    def fbi_key(self) -> str | None:
        return os.environ.get("FBI_CDE_API_KEY") or None

    @property
    def census_key(self) -> str | None:
        return os.environ.get("CENSUS_API_KEY") or None

    def ensure_dirs(self) -> None:
        for p in (self.raw, self.staging, self.warehouse, self.releases):
            p.mkdir(parents=True, exist_ok=True)


settings = Settings()

# --- Vintages pinned by the Phase 0 source audit (docs/data-sources.md) ------
# Changing these is a deliberate act with a documented reason, never a default.
VINTAGES = {
    "cde_agency_directory": "live",       # continuously updated
    "pe_master_last_good": 2024,          # pe-2025.zip ships zero-filled; see audit
    "pe_api_last": 2025,
    "crime_last_complete_year": 2025,     # 2026 is fractional; hard cutoff
    "gazetteer": 2025,
    "pep_vintage": 2025,
    "acs5": 2024,
    "finance_annual": 2024,
    "finance_last_census_year": 2022,
    "urban_areas": 2020,
    "gus": 2025,
}

STATES = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA",
    "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM",
    "NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
    "WV","WI","WY",
]
TERRITORIES = ["AS", "GU", "MP", "PR", "VI"]

# New England states where the general-purpose local government — and therefore the
# police jurisdiction — is the county subdivision (town), not the Census place.
NEW_ENGLAND = {"CT", "MA", "ME", "NH", "RI", "VT"}
