"""Release identity and the build manifest.

Every build produces a release_id and a manifest recording source versions, row counts,
validation results, build timestamp and git commit. The application exposes its active
release, so a number on a screen can always be traced back to the bytes it came from.
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from .config import settings


def new_release_id(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    prefix = f"release_{now:%Y_%m_%d}"
    existing = sorted(settings.releases.glob(f"{prefix}_*.json"))
    seq = len(existing) + 1
    return f"{prefix}_{seq:03d}"


def git_commit() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=settings.root,
            capture_output=True, text=True, timeout=10).stdout.strip() or "uncommitted"
    except Exception:  # noqa: BLE001
        return "unavailable"


def write_release(con, release_id: str, validation: dict, notes: str = "") -> Path:
    from .warehouse import table_counts

    counts = table_counts(con)
    raw_manifest_path = settings.raw / "manifest.json"
    raw_manifest = json.loads(raw_manifest_path.read_text()) if raw_manifest_path.exists() else []

    sources = {}
    for r in raw_manifest:
        s = sources.setdefault(r["source_id"], {"artifacts": 0, "bytes": 0, "sha256": []})
        s["artifacts"] += 1
        s["bytes"] += r.get("bytes") or 0
        if r.get("sha256"):
            s["sha256"].append({"artifact": r["artifact"], "sha256": r["sha256"]})

    manifest = {
        "release_id": release_id,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "git_commit": git_commit(),
        "notes": notes,
        "row_counts": counts,
        "source_versions": sources,
        "validation": validation,
    }
    out = settings.releases / f"{release_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(manifest, indent=2, sort_keys=True))

    con.execute("DELETE FROM release_manifest WHERE release_id = ?", [release_id])
    con.executemany(
        "INSERT INTO release_manifest VALUES (?,?,?,?,?,?)",
        [(release_id, manifest["built_at"], manifest["git_commit"], t, c, None)
         for t, c in counts.items()])
    return out
