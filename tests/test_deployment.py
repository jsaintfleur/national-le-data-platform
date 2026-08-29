"""The deployment contract.

A deployment is a claim: that the artifact in the repository is the one the API reads, that
it contains everything the API queries and nothing it does not, and that the function bundle
carries only what the function imports. Each of those is checkable, so each is checked here
rather than left to a runbook.

These tests are why `ALLOWED_TABLES` can be both the security boundary and the deployment
manifest: if the two ever diverge, this file fails before a release does.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

import pytest

from nledp.api.db import ALLOWED_TABLES
from nledp.config import settings

ROOT = settings.root
DEPLOY_DB = ROOT / "data" / "deploy" / "nledp-api.duckdb"
VERCEL = ROOT / "vercel.json"
REQUIREMENTS = ROOT / "requirements.txt"
ENTRY = ROOT / "api" / "index.py"
API_MAIN = ROOT / "src" / "nledp" / "api" / "main.py"

# GitHub refuses a file over 100 MB and warns over 50 MB. Vercel's serverless bundle is
# 250 MB uncompressed, of which duckdb and fastapi take roughly 55 MB.
GITHUB_HARD_LIMIT = 100 * 1024 * 1024
GITHUB_WARN_LIMIT = 50 * 1024 * 1024


# ======================================================================================
# The serving database
# ======================================================================================


@pytest.mark.skipif(not DEPLOY_DB.exists(),
                    reason="no serving database; run scripts/build_deploy_db.py")
class TestServingDatabase:
    @staticmethod
    @pytest.fixture(scope="class")
    def con():
        import duckdb
        c = duckdb.connect(str(DEPLOY_DB), read_only=True)
        yield c
        c.close()

    def test_it_fits_in_a_git_repository(self):
        size = DEPLOY_DB.stat().st_size
        assert size < GITHUB_HARD_LIMIT, (
            f"{size / 1e6:.0f} MB exceeds GitHub's 100 MB per-file limit and cannot be "
            "committed. Reduce ALLOWED_TABLES or move to Git LFS.")
        if size > GITHUB_WARN_LIMIT:
            pytest.warns  # documented, not failed: GitHub accepts it with a warning

    def test_it_contains_exactly_the_served_surface(self, con):
        """Not a subset and not a superset. A missing table breaks an endpoint in production
        and nowhere else; an extra one is dead weight in a size-constrained bundle."""
        present = {r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
        ).fetchall()}
        assert present == ALLOWED_TABLES, {
            "missing_from_database": sorted(ALLOWED_TABLES - present),
            "not_served_but_shipped": sorted(present - ALLOWED_TABLES),
        }

    def test_the_fact_tables_are_absent(self, con):
        """1.2 million fact rows are compacted into analytics_provenance and the analytics
        columns. If one reappears the artifact has silently tripled."""
        present = {r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
        ).fetchall()}
        assert not {t for t in present if t.startswith("fact_")}

    def test_it_carries_a_release(self, con):
        row = con.execute(
            "SELECT release_id, git_commit FROM release_manifest ORDER BY built_at DESC LIMIT 1"
        ).fetchone()
        assert row and row[0].startswith("release_")
        assert row[1] and row[1] != "uncommitted", (
            "the serving database was built from an uncommitted tree, so the figures it "
            "serves cannot be traced to a commit")

    def test_it_has_no_validation_errors(self, con):
        errors = con.execute(
            "SELECT count(*) FROM data_quality_log WHERE severity='error'").fetchone()[0]
        assert errors == 0, "a release with validation errors must not be deployed"

    def test_the_regression_fixtures_survived_compaction(self, con):
        """The five permanent fixtures, checked against the artifact that actually serves."""
        baltimore_2021 = con.execute("""
            SELECT months_reported, violent_crime_offenses, violent_crime_rate, rate_allowed
            FROM analytics_agency_year WHERE agency_id='MDBPD0000' AND data_year=2021
        """).fetchone()
        assert baltimore_2021 == (7, 4987, None, False)

        lasd = con.execute("""
            SELECT denominator_type, denominator_value < population_geography_total
            FROM analytics_agency_year
            WHERE agency_id='CA0190000' AND data_year=2024
        """).fetchone()
        assert lasd == ("unincorporated_population", True)

        orange = con.execute("""
            SELECT officers_per_1k > 8, denominator_confidence, methodology_warning IS NOT NULL
            FROM analytics_agency_year WHERE agency_id='CA0300000' AND data_year=2024
        """).fetchone()
        assert orange == (True, "LIMITED", True)

        state_police = con.execute("""
            SELECT count(*) FROM analytics_agency_year
            WHERE agency_id='PAPSP0000' AND (violent_crime_rate IS NOT NULL
                                             OR officers_per_1k IS NOT NULL)
        """).fetchone()[0]
        assert state_police == 0

        ambiguous = con.execute(
            "SELECT count(*) FROM dim_agency WHERE ori7='CA01999'").fetchone()[0]
        assert ambiguous > 1

    def test_provenance_replaces_the_fact_tables_completely(self, con):
        """Every agency with an observation must still be able to say where it came from."""
        orphans = con.execute("""
            SELECT count(*) FROM (
                SELECT DISTINCT agency_id FROM analytics_agency_year
                WHERE sworn_officers IS NOT NULL OR violent_crime_offenses IS NOT NULL
            ) y
            WHERE NOT EXISTS (
                SELECT 1 FROM analytics_provenance p WHERE p.agency_id = y.agency_id)
        """).fetchone()[0]
        assert orphans == 0

    def test_every_provenance_source_exists_in_the_source_registry(self, con):
        missing = con.execute("""
            SELECT DISTINCT p.source_id FROM analytics_provenance p
            LEFT JOIN dim_source s ON s.source_id = p.source_id
            WHERE s.source_id IS NULL
        """).fetchall()
        assert missing == []


# ======================================================================================
# The Vercel configuration
# ======================================================================================


class TestVercelConfig:
    @staticmethod
    @pytest.fixture(scope="class")
    def cfg():
        return json.loads(VERCEL.read_text())

    def test_the_api_is_routed_before_the_spa_fallback(self, cfg):
        sources = [r["source"] for r in cfg["rewrites"]]
        assert sources[0].startswith("/api/"), (
            "the SPA fallback must not precede the API route, or every endpoint returns HTML")

    def test_the_spa_fallback_excludes_the_api_and_static_directories(self, cfg):
        fallback = next(r for r in cfg["rewrites"] if r["destination"] == "/index.html")
        for prefix in ("api/", "assets/", "geo/", "fonts/"):
            assert prefix in fallback["source"], (
                f"/{prefix} would be swallowed by the SPA fallback")

    def test_include_files_is_a_glob_string_not_a_list(self, cfg):
        """vercel.json's functions.includeFiles is a string. A list is rejected during config
        validation, before the build starts, so the failure arrives as a deployment with no
        build log at all — which is considerably harder to read than a build error."""
        include = cfg["functions"]["api/index.py"]["includeFiles"]
        assert isinstance(include, str), (
            "includeFiles must be a glob string; a list fails config validation")

    def test_the_function_includes_the_serving_database(self, cfg):
        include = cfg["functions"]["api/index.py"]["includeFiles"]
        assert "data/deploy/**" in include, "the function would deploy without its database"
        assert "registry/**" in include, "/api/metrics and /api/sources read the registries"
        assert "src/nledp/**" in include, "the function imports the package from src/"

    def test_static_assets_are_cached_immutably_and_the_api_is_not(self, cfg):
        by_source = {h["source"]: h["headers"] for h in cfg["headers"]}
        assets = by_source["/assets/(.*)"][0]["value"]
        assert "immutable" in assets and "max-age=31536000" in assets
        api = by_source["/api/(.*)"][0]["value"]
        assert "immutable" not in api, (
            "API responses are immutable within a release but not across releases; "
            "s-maxage plus stale-while-revalidate is the correct shape")
        assert "s-maxage" in api

    def test_the_build_produces_the_directory_it_serves(self, cfg):
        assert cfg["outputDirectory"] == "web/dist"
        assert "npm run build" in cfg["buildCommand"]


# ======================================================================================
# The function bundle
# ======================================================================================


class TestFunctionBundle:
    def test_requirements_carry_only_what_the_api_imports(self):
        """polars, pyarrow, rapidfuzz, httpx and typer build the warehouse. None of them is
        imported by the API, and each would cost tens of megabytes in a 250 MB bundle."""
        reqs = REQUIREMENTS.read_text().lower()
        for pipeline_only in ("polars", "pyarrow", "rapidfuzz", "httpx", "typer", "openpyxl"):
            assert pipeline_only not in reqs, f"{pipeline_only} is pipeline-only"
        for needed in ("duckdb", "fastapi", "pydantic", "yaml"):
            assert needed in reqs, f"{needed} is imported by the API"

    def test_no_dependency_is_carried_for_vercels_launcher(self):
        """werkzeug belongs here only if the entry point exposes ``app``.

        It is required by the launcher's WSGI and ASGI branches, not by anything in this
        repository. api/index.py exposes ``handler`` instead, whose branch is pure standard
        library, so the dependency should not be here. If a future change goes back to
        ``app``, this test and its neighbour above will disagree, which is the point.
        """
        assert "werkzeug" not in REQUIREMENTS.read_text().lower(), (
            "werkzeug is only needed by the launcher's app branches; this deployment uses "
            "the handler branch")

    def test_every_requirement_is_version_bounded(self):
        for line in REQUIREMENTS.read_text().splitlines():
            line = line.split("#")[0].strip()
            if not line:
                continue
            assert re.search(r"[<>=]", line), f"{line} is unpinned"

    def test_the_entry_point_sets_the_database_path_before_importing_config(self):
        """Settings resolves db_path once at class-definition time, so the environment has
        to be set before nledp.config is first imported."""
        tree = ast.parse(ENTRY.read_text())
        setdefault_line = None
        import_line = None
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "setdefault"
                    and any(isinstance(a, ast.Constant) and a.value == "NLEDP_DB_PATH"
                            for a in node.args)):
                setdefault_line = node.lineno
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("nledp."):
                import_line = min(import_line or node.lineno, node.lineno)
        assert setdefault_line is not None, "the entry point must set NLEDP_DB_PATH"
        assert import_line is not None
        assert setdefault_line < import_line, (
            "NLEDP_DB_PATH is set after nledp is imported; the setting will not take effect")

    def test_the_vercel_entry_point_is_bound_at_module_level(self):
        """Vercel decides what kind of function this file is by scanning its module scope
        before any Python runs, looking for ``handler``/``Handler`` first and then ``app``.

        A binding nested inside a ``try`` or an ``if`` is valid Python and invisible to that
        scan: the build fails with "the pattern api/index.py doesn't match any Serverless
        Functions inside the api directory" while the file sits in the repository under the
        right name. This asserts the binding is at column zero.
        """
        tree = ast.parse(ENTRY.read_text())
        names = set()
        for node in tree.body:  # module scope only — nested definitions do not count
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(node.name)
            elif isinstance(node, ast.Assign):
                names.update(t.id for t in node.targets if isinstance(t, ast.Name))
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                names.add(node.target.id)
            elif isinstance(node, ast.ImportFrom):
                names.update(a.asname or a.name for a in node.names)
        assert names & {"handler", "Handler", "app"}, (
            "api/index.py must bind handler or app at module level, or Vercel will not "
            "recognise it as a Serverless Function and the build fails before Python runs")

    def test_the_entry_point_uses_the_stdlib_handler_branch(self):
        """The entry point must expose ``handler``, not ``app``.

        Vercel's launcher bridges an ``app`` through werkzeug, which nothing in this
        deployment declares or installs. When it is missing the launcher prints "using ASGI"
        and dies at handler init with no traceback, because the failure is inside the
        launcher rather than the application — an expensive silence to debug. The
        ``handler`` branch imports only the standard library, so this deployment depends on
        exactly what it declares.
        """
        tree = ast.parse(ENTRY.read_text())
        classes = {n.name for n in tree.body if isinstance(n, ast.ClassDef)}
        assert "handler" in classes, "api/index.py must define a module-level handler class"

    def test_the_entry_point_adds_no_routes_of_its_own(self):
        """The deployed API and the local one must be the same application. A route defined
        only in the serverless entry point exists in production and in no test."""
        tree = ast.parse(ENTRY.read_text())
        decorated = [
            d for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
            for d in node.decorator_list
            if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute)
            and isinstance(d.func.value, ast.Name) and d.func.value.id == "app"
        ]
        assert decorated == [], "define routes in nledp.api.main, not in api/index.py"

    def test_the_health_endpoint_is_registered_before_the_spa_catch_all(self):
        """FastAPI matches routes in registration order. A catch-all declared first answers
        for /api/health with the application's HTML and a 200."""
        text = API_MAIN.read_text()
        health = text.index('@app.get("/api/health")')
        catch_all = text.index('@app.get("/{full_path:path}"')
        assert health < catch_all

    def test_the_catch_all_refuses_api_paths(self):
        text = API_MAIN.read_text()
        assert 'full_path.startswith("api/")' in text, (
            "a missing endpoint must 404, not return the application's HTML with a 200")


# ======================================================================================
# Repository hygiene
# ======================================================================================


class TestRepositoryHygiene:
    def test_no_api_key_is_committed(self):
        """The Census and api.data.gov keys live in .env, which is ignored. This asserts the
        shape rather than the values, so it keeps working when the keys are rotated."""
        gitignore = (ROOT / ".gitignore").read_text()
        assert ".env" in gitignore.split("\n")[:5], ".env must be ignored"
        assert not (ROOT / ".env").exists() or ".env" in gitignore

    def test_the_full_warehouse_is_not_committed(self):
        gitignore = (ROOT / ".gitignore").read_text()
        assert "data/warehouse/*.duckdb" in gitignore
        assert "!data/deploy/nledp-api.duckdb" in gitignore, (
            "the serving database must be explicitly un-ignored, or a deployment ships "
            "without its data")

    def test_build_outputs_are_not_committed(self):
        gitignore = (ROOT / ".gitignore").read_text()
        for path in ("web/node_modules/", "web/dist/", ".vercel/"):
            assert path in gitignore, f"{path} should not be in version control"
