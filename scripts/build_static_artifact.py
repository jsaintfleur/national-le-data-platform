#!/usr/bin/env python3
"""Assemble the self-contained build: the whole platform as one HTML file.

This exists because the served deployment needs two permissions the sandbox does not have,
and a data platform nobody can open is not finished. It is the same application — the same
components, the same design system, the same policy-decided rows — with the API replaced by
an embedded dataset.

What goes in, and the size each costs against a 16 MB budget:

    application JS and CSS      ~2.1 MB   inlined; MapLibre is most of it
    national dataset            ~6.4 MB   30 MB of JSON, gzipped and base64-encoded
    state boundaries            ~0.3 MB   Census 2025 cartographic file
    IBM Plex, latin subset      ~0.3 MB   the weights the design system actually uses

The dataset is inflated in the browser by DecompressionStream, which is why the whole
national series fits rather than a sample of it.

The output is a fragment — no doctype, html, head or body — because the artifact host wraps
it in a page skeleton at publish time.

    npm --prefix web run build:static      # then
    python scripts/build_static_artifact.py
"""
from __future__ import annotations

import argparse
import base64
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "web" / "dist-static"
BUNDLE_B64 = ROOT / "web" / "static-bundle.b64"
STATES_GEO = ROOT / "web" / "public" / "geo" / "states.geojson"
FONT_DIR = ROOT / "web" / "public" / "fonts"

# The weights the design system uses. Shipping all fourteen files would cost 0.4 MB for
# variants nothing references.
FONTS = [
    ("IBM Plex Sans", 400, "IBMPlexSans-400-latin.woff2"),
    ("IBM Plex Sans", 500, "IBMPlexSans-500-latin.woff2"),
    ("IBM Plex Sans", 600, "IBMPlexSans-600-latin.woff2"),
    ("IBM Plex Mono", 400, "IBMPlexMono-400-latin.woff2"),
    ("IBM Plex Mono", 500, "IBMPlexMono-500-latin.woff2"),
]


def inline_fonts() -> str:
    faces = []
    for family, weight, filename in FONTS:
        path = FONT_DIR / filename
        if not path.exists():
            continue
        data = base64.b64encode(path.read_bytes()).decode()
        faces.append(
            f"@font-face{{font-family:'{family}';font-style:normal;font-weight:{weight};"
            f"font-display:swap;src:url(data:font/woff2;base64,{data}) format('woff2')}}"
        )
    return "\n".join(faces)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT / "artifact" / "platform.html")
    args = ap.parse_args()

    index = DIST / "index.html"
    if not index.exists():
        raise SystemExit(f"missing {index}; run `npm --prefix web run build:static` first")
    if not BUNDLE_B64.exists():
        raise SystemExit(f"missing {BUNDLE_B64}; run scripts/export_static_bundle.py first")

    html = index.read_text()

    # Inline every emitted asset the built page references.
    css_parts: list[str] = []
    js_parts: list[str] = []
    for href in re.findall(r'<link[^>]+href="([^"]+\.css)"', html):
        css_parts.append((DIST / href.lstrip("/")).read_text())
    for src in re.findall(r'<script[^>]+src="([^"]+\.js)"', html):
        js_parts.append((DIST / src.lstrip("/")).read_text())
    if not js_parts:
        raise SystemExit("no script emitted; the static build must produce a single chunk")

    css = "\n".join(css_parts)
    # The font @font-face rules from the served build point at /fonts; replace them wholesale
    # with data-URI faces so the page carries its own typography.
    css = re.sub(r"@font-face\s*\{[^}]*\}", "", css)
    css = inline_fonts() + "\n" + css

    dataset = BUNDLE_B64.read_text().strip()
    worker = (ROOT / "web" / "dist-static" / "maplibre-worker.js")
    if not worker.exists():
        raise SystemExit(f"missing {worker}; the static build must bundle MapLibre's worker")
    worker_src = worker.read_text()
    states = json.dumps(json.loads(STATES_GEO.read_text()), separators=(",", ":"))

    parts = [
        "<title>National Law Enforcement Data</title>",
        f"<style>{css}</style>",
        '<div id="root"></div>',
        # Data rides in non-executing script tags: the browser will not parse them as code,
        # and the app reads them by id.
        f'<script type="application/json" id="nledp-geo-states">{states}</script>',
        f'<script type="text/plain" id="nledp-data">{dataset}</script>',
        f'<script type="text/plain" id="nledp-map-worker">{worker_src}</script>',
        f"<script type=\"module\">{''.join(js_parts)}</script>",
    ]
    out = "\n".join(parts)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(out)

    size = len(out.encode())
    print(f"{args.out}  {size / 1e6:.2f} MB")
    print(f"  application   {sum(len(p) for p in js_parts) / 1e6:>6.2f} MB")
    print(f"  styles+fonts  {len(css) / 1e6:>6.2f} MB")
    print(f"  dataset       {len(dataset) / 1e6:>6.2f} MB  (30 MB of JSON, gzipped)")
    print(f"  state geometry{len(states) / 1e6:>7.2f} MB")
    print(f"  map worker    {len(worker_src) / 1e6:>6.2f} MB")
    if size > 16_000_000:
        raise SystemExit(f"\n{size / 1e6:.1f} MB exceeds the 16 MB artifact limit")
    print(f"\n  {(16_000_000 - size) / 1e6:.2f} MB under the 16 MB limit")


if __name__ == "__main__":
    main()
