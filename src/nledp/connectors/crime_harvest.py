"""Agency-level crime harvest from the CDE summarized endpoint.

There is no bulk agency-level file the platform can parse with confidence -- the RETA
master is a 7,385-character fixed-width record whose layout would have to be
reverse-engineered, and a misread column silently produces plausible wrong numbers. The
API is authoritative, documented by its own response shape, and fast enough: measured at
about 27 requests/second, the full national harvest is roughly 25 minutes.

Responses are stored raw and gzipped, one NDJSON line per (ori, offense), so the raw layer
still holds exactly what the server returned. The job is resumable: a state whose file
already exists is skipped.
"""
from __future__ import annotations

import asyncio
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import httpx

from ..config import settings

OFFENSE_GROUPS = ["violent-crime", "property-crime"]
OFFENSE_DETAIL = [
    "homicide", "rape", "robbery", "aggravated-assault",
    "burglary", "larceny", "motor-vehicle-theft", "arson",
]


async def _fetch_one(client: httpx.AsyncClient, sem: asyncio.Semaphore, ori: str,
                     offense: str, from_year: int, to_year: int) -> dict:
    url = f"{settings.cde_origin}/summarized/agency/{ori}/{offense}"
    params = {"from": f"01-{from_year}", "to": f"12-{to_year}", "type": "counts"}
    async with sem:
        for attempt in range(3):
            try:
                r = await client.get(url, params=params)
                if r.status_code == 429:
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                return {
                    "ori": ori, "offense": offense, "http_status": r.status_code,
                    "url": str(r.url),
                    "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "body": r.json() if r.status_code == 200 else None,
                }
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    return {"ori": ori, "offense": offense, "http_status": None,
                            "url": url, "error": str(e), "body": None}
                await asyncio.sleep(2 * (attempt + 1))
    return {"ori": ori, "offense": offense, "http_status": None, "url": url, "body": None}


async def _harvest_state(state: str, oris: list[str], dest: Path, from_year: int,
                         to_year: int, offenses: list[str], concurrency: int) -> dict:
    out = dest / f"crime_{state}.ndjson.gz"
    if out.exists():
        return {"state": state, "path": str(out), "bytes": out.stat().st_size,
                "calls": 0, "from_cache": True}
    sem = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(max_connections=concurrency * 2,
                          max_keepalive_connections=concurrency)
    async with httpx.AsyncClient(timeout=60, limits=limits,
                                 headers={"User-Agent": "nledp/0.1"}) as client:
        tasks = [_fetch_one(client, sem, ori, off, from_year, to_year)
                 for ori in oris for off in offenses]
        results = await asyncio.gather(*tasks)
    tmp = out.with_suffix(".part")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        for rec in results:
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
    tmp.replace(out)
    ok = sum(1 for r in results if r.get("http_status") == 200)
    return {"state": state, "path": str(out), "bytes": out.stat().st_size,
            "calls": len(results), "ok": ok, "from_cache": False}


def harvest(agency_directory: Path, dest: Path, from_year: int = 2016,
            to_year: int = 2025, offenses: list[str] | None = None,
            concurrency: int = 16, states: list[str] | None = None) -> list[dict]:
    dest.mkdir(parents=True, exist_ok=True)
    agencies = json.loads(agency_directory.read_text())
    by_state: dict[str, list[str]] = {}
    for a in agencies:
        by_state.setdefault(a.get("state_abbr") or "??", []).append(a["ori"])

    offenses = offenses or OFFENSE_GROUPS
    targets = sorted(states or by_state.keys())
    manifest: list[dict] = []
    for st in targets:
        oris = sorted(set(by_state.get(st, [])))
        if not oris:
            continue
        rec = asyncio.run(_harvest_state(st, oris, dest, from_year, to_year,
                                         offenses, concurrency))
        rec["agencies"] = len(oris)
        manifest.append(rec)
        yield_line = (f"  {st}: {len(oris):>5,} agencies  "
                      f"{rec['bytes'] / 1e6:>6.1f} MB"
                      f"{'  (cached)' if rec.get('from_cache') else ''}")
        print(yield_line, flush=True)
    return manifest


# --- Reduction: monthly response -> annual agency-year counts ---------------------------

def reduce_response(body: dict | None) -> dict[str, dict[int, float]]:
    """Return {series_name: {year: annual_total}} from a summarized response.

    The response nests offenses.actuals[series][MM-YYYY]. The agency's own series is the
    one that is not the state or national comparison series; the caller decides which key
    it wants. Months are summed, which is exact for annual totals given monthly inputs.
    """
    if not body:
        return {}
    offenses = body.get("offenses") or {}
    actuals = offenses.get("actuals") or {}
    out: dict[str, dict[int, float]] = {}
    for series, points in actuals.items():
        if not isinstance(points, dict):
            continue
        annual: dict[int, float] = {}
        for key, val in points.items():
            if val is None or "-" not in key:
                continue
            try:
                year = int(key.split("-", 1)[1])
                annual[year] = annual.get(year, 0.0) + float(val)
            except (ValueError, TypeError):
                continue
        out[series] = annual
    return out


def months_present(body: dict | None, series: str) -> dict[int, int]:
    """Count non-null months per year, so completeness is measured, not assumed."""
    if not body:
        return {}
    points = ((body.get("offenses") or {}).get("actuals") or {}).get(series) or {}
    counts: dict[int, int] = {}
    for key, val in points.items():
        if val is None or "-" not in key:
            continue
        year = int(key.split("-", 1)[1])
        counts[year] = counts.get(year, 0) + 1
    return counts
