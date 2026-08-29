"""Vercel serverless entry point for the analytical API.

This file exposes ``handler``, a plain ``BaseHTTPRequestHandler``, and drives the FastAPI
application through a small ASGI bridge of its own. That is a deliberate choice over
exposing ``app`` and letting Vercel's launcher do the bridging.

Vercel's launcher has three branches. The ``app`` branches — WSGI and ASGI — both import
werkzeug, which is not declared anywhere the deployment installs from. When it is absent the
launcher prints "using Asynchronous Server Gateway Interface (ASGI)" and then dies at handler
init: FUNCTION_INVOCATION_FAILED, no traceback, because the failure is inside the launcher,
before the application is reached and outside every error handler the application defines.
Several deployments were spent reading that silence. The ``handler`` branch imports nothing
but the standard library, so this file depends only on what it declares.

The bridge also means a broken deployment can explain itself. If the application cannot be
imported — a missing dependency, a missing database — ``handler`` still runs, because it
needs nothing but the standard library, and returns the reason as JSON.

The rest is about the difference between a laptop and a read-only filesystem:

* The serving database is the compacted, API-only file built by
  ``scripts/build_deploy_db.py`` — 47 MB against the full warehouse's 164 MB.
* ``NLEDP_DB_PATH`` is set before ``nledp.config`` is imported, since ``Settings`` resolves
  the path once at class-definition time.
* ``HOME`` is assigned, not defaulted: the runtime sets it to a path under /home that does
  not exist and is not writable, so a default would never apply and DuckDB would try to put
  its extension directory there.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

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


def _run_asgi(scope: dict, body: bytes) -> tuple[int, list[tuple[bytes, bytes]], bytes]:
    """Drive one request through the ASGI application and collect the response.

    Deliberately minimal: one request, one response, no streaming and no lifespan. The
    serverless invocation model is a single request per call, and the application's lifespan
    only closes DuckDB connections, which must not happen between requests on a warm
    container.
    """
    status = 500
    headers: list[tuple[bytes, bytes]] = []
    chunks: list[bytes] = []
    received = False

    async def receive() -> dict:
        nonlocal received
        if received:
            return {"type": "http.disconnect"}
        received = True
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: dict) -> None:
        nonlocal status, headers
        if message["type"] == "http.response.start":
            status = message["status"]
            headers = [(bytes(k), bytes(v)) for k, v in message.get("headers", [])]
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b"") or b"")

    asyncio.run(_app(scope, receive, send))
    return status, headers, b"".join(chunks)


class handler(BaseHTTPRequestHandler):  # noqa: N801 - Vercel looks for this exact name
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        """The platform already logs the request line; this would duplicate every one."""

    def _serve(self, method: str) -> None:
        if _app is None:
            payload = json.dumps(_startup_report(), indent=2).encode()
            self._write(500, [(b"content-type", b"application/json"),
                              (b"cache-control", b"no-store")], payload)
            return

        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        split = urlsplit(self.path)
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.1"},
            "http_version": "1.1",
            "method": method,
            "scheme": self.headers.get("x-forwarded-proto", "https"),
            "path": split.path,
            "raw_path": split.path.encode(),
            "query_string": split.query.encode(),
            "root_path": "",
            "headers": [(k.lower().encode(), v.encode()) for k, v in self.headers.items()],
            "client": (self.headers.get("x-forwarded-for", ""), 0),
            "server": (self.headers.get("host", "lambda"), 443),
        }
        try:
            status, headers, payload = _run_asgi(scope, body)
        except Exception:
            # The application's own handlers cover errors inside a request. This covers the
            # bridge itself, so a bug here is still readable rather than an empty 500.
            payload = json.dumps({
                "error": "the request failed in the ASGI bridge",
                "traceback": traceback.format_exc(),
            }, indent=2).encode()
            status, headers = 500, [(b"content-type", b"application/json")]
        self._write(status, headers, payload)

    def _write(self, status: int, headers: list[tuple[bytes, bytes]], body: bytes) -> None:
        self.send_response(status)
        for key, value in headers:
            if key.lower() not in (b"content-length", b"transfer-encoding", b"connection"):
                self.send_header(key.decode("latin-1"), value.decode("latin-1"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's interface
        self._serve("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._serve("POST")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._serve("OPTIONS")
