"""Vercel serverless entry point for the analytical API.

Vercel's Python runtime discovers an ASGI ``app`` in this module and serves it. Everything
this file does before importing that app is about the difference between a laptop and a
read-only Lambda filesystem:

* The serving database is the compacted, API-only file built by
  ``scripts/build_deploy_db.py`` — 47 MB against the full warehouse's 164 MB, because the
  fact tables the analytics build needs are not the tables the API reads.
* ``NLEDP_DB_PATH`` is set before ``nledp.config`` is imported, since ``Settings`` resolves
  the path once at class-definition time.
* DuckDB is opened read-only, so it never tries to create a write-ahead log next to a file
  it cannot write to.

Static assets are not served here. Vercel's CDN serves the built application directly and
routes only ``/api/*`` to this function, which is both faster and one less thing to keep in
sync than the local single-origin setup.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

os.environ.setdefault("NLEDP_DB_PATH", str(ROOT / "data" / "deploy" / "nledp-api.duckdb"))
# DuckDB writes temporary spill files during large sorts. Lambda's only writable path is
# /tmp; without this a sort that exceeds memory fails on an unwritable directory.
os.environ.setdefault("HOME", "/tmp")

import sys  # noqa: E402

sys.path.insert(0, str(ROOT / "src"))

from nledp.api.main import app  # noqa: E402,F401

# /api/health lives in nledp.api.main so it is registered before the SPA catch-all and is
# identical in development and production. Nothing else is added here on purpose: the
# deployed API and the local one must be the same application.
