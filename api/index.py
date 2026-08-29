"""Vercel serverless entry point for the analytical API.

Vercel's Python runtime discovers an ASGI ``app`` in this module and serves it. Everything
this file does before importing that app is about the difference between a laptop and a
read-only Lambda filesystem:

* The serving database is the compacted, API-only file built by
  ``scripts/build_deploy_db.py`` — 47 MB against the full warehouse's 164 MB, because the
  fact tables the analytics build needs are not the tables the API reads.
* ``NLEDP_DB_PATH`` is set before ``nledp.config`` is imported, since ``Settings`` resolves
  the path once at class-definition time.
* ``HOME`` is forced to /tmp. It is deliberately not ``setdefault``: Lambda already sets
  HOME to a path under /home that does not exist and is not writable, so a default would
  never apply and DuckDB would try to place its extension directory there.

Static assets are not served here. Vercel's CDN serves the built application directly and
routes only ``/api/*`` to this function, which is both faster and one less thing to keep in
sync than the local single-origin setup.
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

os.environ.setdefault("NLEDP_DB_PATH", str(ROOT / "data" / "deploy" / "nledp-api.duckdb"))

# /tmp is the only writable path in this runtime. DuckDB writes temporary spill files during
# large sorts and looks for an extension directory under HOME; both must land there.
# Assignment, not setdefault — the runtime sets HOME to an unwritable path, so a default
# would silently never take effect. That was the bug behind the first deployment's
# FUNCTION_INVOCATION_FAILED, which produced no traceback because it was not a Python error.
os.environ["HOME"] = "/tmp"
os.environ["NLEDP_SERVERLESS"] = "1"
Path("/tmp/duckdb-temp").mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(ROOT / "src"))

# A failed import here previously surfaced as an opaque FUNCTION_INVOCATION_FAILED with
# nothing in the logs. A data platform that cannot say why it is down is not meeting its own
# standard for honest failure, so the error becomes the response.
_import_error: str | None = None
try:
    from nledp.api.main import app  # noqa: E402,F401
except Exception:  # noqa: BLE001 - the whole point is to report anything
    _import_error = traceback.format_exc()

if _import_error is not None:
    _detail = {
        "ok": False,
        "error": "the API failed to start",
        "traceback": _import_error,
        "python": sys.version,
        "root": str(ROOT),
        "db_path": os.environ.get("NLEDP_DB_PATH"),
        "db_present": Path(os.environ["NLEDP_DB_PATH"]).exists(),
        "root_contents": sorted(p.name for p in ROOT.iterdir())[:60],
    }

    async def app(scope, receive, send):  # type: ignore[no-redef] # noqa: D103
        if scope["type"] != "http":
            return
        import json as _json
        body = _json.dumps(_detail, indent=2).encode()
        await send({"type": "http.response.start", "status": 500,
                    "headers": [(b"content-type", b"application/json"),
                                (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})

# /api/health lives in nledp.api.main so it is registered before the SPA catch-all and is
# identical in development and production. Nothing else is added here on purpose: the
# deployed API and the local one must be the same application.
