"""Bulk loading into DuckDB.

executemany() is row-at-a-time and becomes the bottleneck at tens of thousands of rows.
Materializing an Arrow table and letting DuckDB scan it is one to two orders of magnitude
faster and keeps types explicit.
"""
from __future__ import annotations

import duckdb
import pyarrow as pa


def bulk_insert(con: duckdb.DuckDBPyConnection, table: str, rows: list[tuple],
                replace: bool = True) -> int:
    if replace:
        con.execute(f'DELETE FROM "{table}"')
    if not rows:
        return 0
    cols = [r[0] for r in con.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema='main' AND table_name=? ORDER BY ordinal_position",
        [table]).fetchall()]
    if len(cols) != len(rows[0]):
        raise ValueError(f"{table}: {len(cols)} columns but rows have {len(rows[0])} values")
    arrays = [pa.array([r[i] for r in rows]) for i in range(len(cols))]
    tbl = pa.Table.from_arrays(arrays, names=cols)  # noqa: F841 - scanned by DuckDB below
    con.register("_bulk_tbl", tbl)
    try:
        con.execute(f'INSERT INTO "{table}" SELECT * FROM _bulk_tbl')
    finally:
        con.unregister("_bulk_tbl")
    return len(rows)
