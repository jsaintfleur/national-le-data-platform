"""Vercel serverless entry point for the analytical API.

Vercel's launcher scans this module's scope for ``app`` and bridges it as ASGI. That scan
happens before any Python runs, so the binding at the bottom must stay at column zero: a
definition nested in a ``try`` or an ``if`` is invisible to it and the build fails with "the
pattern api/index.py doesn't match any Serverless Functions inside the api directory" while
the file sits in the repository under the right name.

The rest is about the difference between a laptop and a read-only Lambda filesystem:

* The serving database is the compacted, API-only file built by
  ``scripts/build_deploy_db.py`` — 47 MB against the full warehouse's 164 MB.
* ``NLEDP_DB_PATH`` is set before ``nledp.config`` is imported, since ``Settings`` resolves
  the path once at class-definition time.
* ``HOME`` is assigned, not defaulted: the runtime sets it to a path under /home that does
  not exist and is not writable, so a default would never apply and DuckDB would try to put
  its extension directory there.

This module also prints two things to stdout at import: a line of environment facts, and the
result of opening the database. Both are here because a long run of deployments failed with
FUNCTION_INVOCATION_FAILED and an empty traceback — failures outside the application, which
no error handler inside it could see. Standard output does reach the platform log, so these
lines are the difference between a diagnosis and a guess. They cost one line each.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

os.environ.setdefault("NLEDP_DB_PATH", str(ROOT / "data" / "deploy" / "nledp-api.duckdb"))
os.environ["HOME"] = "/tmp"
os.environ["NLEDP_SERVERLESS"] = "1"
Path("/tmp/duckdb-temp").mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(ROOT / "src"))

_app: Any = None
_startup_error: str | None = None
try:
    from nledp.api.main import app as _app
except Exception:
    _startup_error = traceback.format_exc()


def _boot_line() -> str:
    """One line of environment facts, printed at import.

    Several deployments failed with FUNCTION_INVOCATION_FAILED and an empty traceback,
    because the failures were inside the launcher rather than the application and nothing
    the application could install would catch them. Standard output from this module does
    reach the platform log — the launcher's own "using ..." line proves it — so the facts
    go there unconditionally, and a future failure of this kind is readable on the first
    deployment rather than the sixth.
    """
    facts: dict[str, Any] = {"python": sys.version.split()[0], "cwd": os.getcwd()}
    for name in ("duckdb", "fastapi", "pydantic", "yaml", "werkzeug"):
        try:
            __import__(name)
            facts[name] = "ok"
        except Exception as exc:  # noqa: BLE001
            facts[name] = type(exc).__name__
    db = Path(os.environ["NLEDP_DB_PATH"])
    facts["db"] = db.stat().st_size if db.exists() else "MISSING"
    facts["app"] = "imported" if _startup_error is None else "FAILED"
    return "nledp-boot " + json.dumps(facts, separators=(",", ":"))


try:
    print(_boot_line(), flush=True)
except Exception:  # noqa: BLE001 - diagnostics must never be the reason a deploy fails
    traceback.print_exc()


def _startup_report() -> dict[str, Any]:
    """What a reader needs to tell a missing dependency from a missing database."""
    modules: dict[str, str] = {}
    for name in ("duckdb", "fastapi", "pydantic", "yaml", "werkzeug"):
        try:
            __import__(name)
            modules[name] = "importable"
        except Exception as exc:  # noqa: BLE001
            modules[name] = f"{type(exc).__name__}: {exc}"
    db_path = Path(os.environ["NLEDP_DB_PATH"])
    return {
        "ok": False,
        "error": "the API failed to start",
        "traceback": _startup_error,
        "python": sys.version,
        "cwd": os.getcwd(),
        "root": str(ROOT),
        "modules": modules,
        "database_path": str(db_path),
        "database_present": db_path.exists(),
        "database_bytes": db_path.stat().st_size if db_path.exists() else None,
        "root_contents": sorted(p.name for p in ROOT.iterdir())[:60],
    }


def _diagnostic_app(detail: dict[str, Any]):
    """An ASGI app that reports why the real one could not start."""
    body = json.dumps(detail, indent=2).encode()

    async def diagnostic(scope, receive, send):
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": 500,
                    "headers": [(b"content-type", b"application/json"),
                                (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})

    return diagnostic

def _probe_database() -> None:
    """Open the database at import and say so, on stdout.

    Every failure so far has happened on the first request and left nothing behind: both of
    the launcher's branches die the same way, and the one thing they both do that importing
    does not is open the database. Doing it here, with a line before and a line after, turns
    "the request failed" into either a timing or a traceback. The connection is kept, so on
    a warm container this is also the connection the first request would have opened.
    """
    import time
    for label, cfg in (("with-config", None), ("no-config", {})):
        start = time.monotonic()
        print(f"nledp-db {label} opening", flush=True)
        try:
            from nledp.api import db as _db
            if cfg is None:
                c = _db.conn()
            else:
                import duckdb
                c = duckdb.connect(os.environ["NLEDP_DB_PATH"], read_only=True, config=cfg)
            n = c.execute("SELECT count(*) FROM release_manifest").fetchone()[0]
            print(f"nledp-db {label} ok rows={n} "
                  f"{(time.monotonic() - start) * 1000:.0f}ms", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            print(f"nledp-db {label} FAILED {type(exc).__name__}: {exc} "
                  f"{(time.monotonic() - start) * 1000:.0f}ms", flush=True)


if _startup_error is None:
    try:
        _probe_database()
    except Exception:  # noqa: BLE001 - a probe must never be why a deploy fails
        traceback.print_exc()


# One top-level binding. Vercel scans module scope for it before any Python runs; a
# definition nested in a try or an if is invisible to that scan and the build fails with
# "the pattern api/index.py doesn't match any Serverless Functions inside the api directory".
app = _app if _startup_error is None else _diagnostic_app(_startup_report())
