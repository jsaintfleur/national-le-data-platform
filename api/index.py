"""Vercel serverless entry point for the analytical API.

Vercel's Python runtime discovers an ASGI ``app`` in this module and serves it. Everything
this file does before importing that app is about the difference between a laptop and a
read-only Lambda filesystem:

* The serving database is the compacted, API-only file built by
  ``scripts/build_deploy_db.py`` — 47 MB against the full warehouse's 164 MB, because the
  fact tables the analytics build needs are not the tables the API reads.
* ``NLEDP_DB_PATH`` is set before ``nledp.config`` is imported, since ``Settings`` resolves
  the path once at class-definition time.
* ``HOME`` is forced to /tmp. It is deliberately not ``setdefault``: the runtime already
  sets HOME to a path under /home that does not exist and is not writable, so a default
  would never apply and DuckDB would try to place its extension directory there.

``app`` is bound by a single assignment at module level, and that placement is load-bearing.
Vercel decides whether this file is a Serverless Function by looking for a top-level binding
before any Python runs. An earlier version of this file defined ``app`` only inside a ``try``
and an ``if``, which is valid Python and undetectable to that scan: the deployment failed
with "the pattern api/index.py doesn't match any Serverless Functions inside the api
directory" — a build error, with the file sitting right there. Keep the assignment at column
zero.

Static assets are not served here. Vercel's CDN serves the built application directly and
routes only ``/api/*`` to this function, which is both faster and one less thing to keep in
sync than the local single-origin setup.
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

# /tmp is the only writable path in this runtime. DuckDB writes temporary spill files during
# large sorts and looks for an extension directory under HOME; both must land there.
# Assignment, not setdefault — the runtime sets HOME to an unwritable path, so a default
# would silently never take effect.
os.environ["HOME"] = "/tmp"
os.environ["NLEDP_SERVERLESS"] = "1"
Path("/tmp/duckdb-temp").mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(ROOT / "src"))


def _diagnostic_app(detail: dict[str, Any]):
    """An ASGI app that reports why the real one could not start.

    A failed import otherwise surfaces as an opaque FUNCTION_INVOCATION_FAILED with nothing
    in the logs, which is the same failure as an unlabelled number: it tells the reader
    something is there without telling them what.
    """
    body = json.dumps(detail, indent=2).encode()

    async def diagnostic(scope, receive, send):
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": 500,
                    "headers": [(b"content-type", b"application/json"),
                                (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})

    return diagnostic


_resolved: Any = None
_startup_error: str | None = None
try:
    from nledp.api.main import app as _resolved  # noqa: E402
except Exception:  # noqa: BLE001 - the whole point is to report anything
    _startup_error = traceback.format_exc()

# One top-level assignment. See the note in the module docstring before moving it.
app = _resolved if _startup_error is None else _diagnostic_app({
    "ok": False,
    "error": "the API failed to start",
    "traceback": _startup_error,
    "python": sys.version,
    "root": str(ROOT),
    "db_path": os.environ.get("NLEDP_DB_PATH"),
    "db_present": Path(os.environ["NLEDP_DB_PATH"]).exists(),
    "root_contents": sorted(p.name for p in ROOT.iterdir())[:60],
})
