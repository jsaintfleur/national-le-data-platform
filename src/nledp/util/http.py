"""HTTP fetching with content hashing, retry, and a partial-ZIP reader.

Every byte this platform ingests lands in data/raw/ unchanged and is recorded with a
SHA-256. Federal files are revised silently and in place (the 2022 Census finance file
was reprocessed in July 2026, four years after collection), so a hash plus a fetch
timestamp is the only reliable version identifier for most of these sources.
"""
from __future__ import annotations

import hashlib
import io
import json
import struct
import time
import zlib
from dataclasses import dataclass, asdict
from pathlib import Path

import httpx

USER_AGENT = "nledp/0.1 (public-interest research; +https://github.com/jsaintfleur)"
DEFAULT_TIMEOUT = httpx.Timeout(60.0, connect=20.0)


@dataclass
class FetchResult:
    url: str
    path: str
    bytes: int
    sha256: str
    fetched_at: str
    http_status: int
    from_cache: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def _client(**kw) -> httpx.Client:
    return httpx.Client(
        headers={"User-Agent": USER_AGENT},
        timeout=DEFAULT_TIMEOUT,
        follow_redirects=True,
        **kw,
    )


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def get_json(url: str, params: dict | None = None, retries: int = 4) -> object:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with _client() as c:
                r = c.get(url, params=params)
            if r.status_code == 429:
                wait = min(60, 2 ** attempt * 5)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001 - retried and re-raised below
            last = e
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"GET {url} failed after {retries} attempts: {last}")


def download(url: str, dest: Path, *, force: bool = False, retries: int = 3) -> FetchResult:
    """Stream a URL to disk. Skips the transfer if the file already exists."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and not force:
        return FetchResult(
            url=url, path=str(dest), bytes=dest.stat().st_size,
            sha256=sha256_file(dest), fetched_at=_now(), http_status=200, from_cache=True,
        )
    last: Exception | None = None
    for attempt in range(retries):
        try:
            tmp = dest.with_suffix(dest.suffix + ".part")
            with _client() as c, c.stream("GET", url) as r:
                r.raise_for_status()
                with tmp.open("wb") as fh:
                    for chunk in r.iter_bytes(1 << 20):
                        fh.write(chunk)
                status = r.status_code
            tmp.replace(dest)
            return FetchResult(
                url=url, path=str(dest), bytes=dest.stat().st_size,
                sha256=sha256_file(dest), fetched_at=_now(), http_status=status,
            )
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(30, 2 ** attempt * 3))
    raise RuntimeError(f"download {url} failed after {retries} attempts: {last}")


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------------------
# Partial ZIP reading over HTTP range requests.
#
# The FBI ships NIBRS as one ZIP per state per year. California 2025 is 117 MB and Texas
# is 116 MB, but the only member this platform needs from most of them is agencies.csv,
# which is a few hundred kilobytes. Pulling ~2 GB to keep ~40 MB is wasteful and slow, so
# we read the ZIP central directory via range requests and fetch only the member we want.
# --------------------------------------------------------------------------------------

_EOCD_SIG = b"PK\x05\x06"
_EOCD64_LOC_SIG = b"PK\x06\x07"
_EOCD64_SIG = b"PK\x06\x06"


class RemoteZip:
    """Read individual members of a remote ZIP without downloading the whole archive."""

    def __init__(self, url: str, *, client: httpx.Client | None = None):
        self.url = url
        self._own = client is None
        self.client = client or _client()
        self.size = self._content_length()
        self.entries = self._read_central_directory()

    def close(self) -> None:
        if self._own:
            self.client.close()

    def __enter__(self) -> "RemoteZip":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _range(self, start: int, end: int) -> bytes:
        r = self.client.get(self.url, headers={"Range": f"bytes={start}-{end}"})
        r.raise_for_status()
        return r.content

    def _content_length(self) -> int:
        # Signed S3 URLs reject HEAD (the signature is GET-scoped), so use a 1-byte GET.
        r = self.client.get(self.url, headers={"Range": "bytes=0-0"})
        r.raise_for_status()
        cr = r.headers.get("content-range", "")
        if "/" in cr:
            return int(cr.rsplit("/", 1)[1])
        raise RuntimeError(f"server did not report a size for {self.url}")

    def _read_central_directory(self) -> dict[str, tuple[int, int, int, int]]:
        tail_len = min(self.size, 1 << 16)
        tail = self._range(self.size - tail_len, self.size - 1)
        idx = tail.rfind(_EOCD_SIG)
        if idx < 0:
            raise RuntimeError("ZIP end-of-central-directory record not found")
        cd_size, cd_off = struct.unpack("<II", tail[idx + 12: idx + 20])

        if cd_off == 0xFFFFFFFF or cd_size == 0xFFFFFFFF:  # ZIP64
            loc = tail.rfind(_EOCD64_LOC_SIG)
            if loc < 0:
                raise RuntimeError("ZIP64 locator not found")
            (eocd64_off,) = struct.unpack("<Q", tail[loc + 8: loc + 16])
            head = self._range(eocd64_off, eocd64_off + 55)
            if head[:4] != _EOCD64_SIG:
                raise RuntimeError("ZIP64 EOCD signature mismatch")
            cd_size, cd_off = struct.unpack("<QQ", head[40:56])

        cd = self._range(cd_off, cd_off + cd_size - 1)
        entries: dict[str, tuple[int, int, int, int]] = {}
        p = 0
        while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
            method, = struct.unpack("<H", cd[p + 10: p + 12])
            comp_size, uncomp_size = struct.unpack("<II", cd[p + 20: p + 28])
            n, m, k = struct.unpack("<HHH", cd[p + 28: p + 34])
            local_off, = struct.unpack("<I", cd[p + 42: p + 46])
            name = cd[p + 46: p + 46 + n].decode("utf-8", "replace")
            extra = cd[p + 46 + n: p + 46 + n + m]
            if 0xFFFFFFFF in (comp_size, uncomp_size, local_off):
                comp_size, uncomp_size, local_off = _zip64_extra(
                    extra, comp_size, uncomp_size, local_off
                )
            entries[name] = (local_off, comp_size, uncomp_size, method)
            p += 46 + n + m + k
        return entries

    def read(self, name: str) -> bytes:
        """Return the decompressed bytes of one member."""
        if name not in self.entries:
            match = [k for k in self.entries if k.rsplit("/", 1)[-1].lower() == name.lower()]
            if not match:
                raise KeyError(f"{name!r} not in archive ({len(self.entries)} members)")
            name = match[0]
        local_off, comp_size, uncomp_size, method = self.entries[name]
        header = self._range(local_off, local_off + 29)
        if header[:4] != b"PK\x03\x04":
            raise RuntimeError("local file header signature mismatch")
        n, m = struct.unpack("<HH", header[26:30])
        data_off = local_off + 30 + n + m
        raw = self._range(data_off, data_off + comp_size - 1)
        if method == 0:
            return raw
        if method == 8:
            return zlib.decompress(raw, -15)
        raise RuntimeError(f"unsupported ZIP compression method {method} for {name}")


def _zip64_extra(extra: bytes, comp: int, uncomp: int, local: int) -> tuple[int, int, int]:
    p = 0
    while p + 4 <= len(extra):
        hid, hsz = struct.unpack("<HH", extra[p:p + 4])
        body = extra[p + 4: p + 4 + hsz]
        if hid == 0x0001:
            q = 0
            if uncomp == 0xFFFFFFFF and q + 8 <= len(body):
                uncomp = struct.unpack("<Q", body[q:q + 8])[0]; q += 8
            if comp == 0xFFFFFFFF and q + 8 <= len(body):
                comp = struct.unpack("<Q", body[q:q + 8])[0]; q += 8
            if local == 0xFFFFFFFF and q + 8 <= len(body):
                local = struct.unpack("<Q", body[q:q + 8])[0]
            break
        p += 4 + hsz
    return comp, uncomp, local


def write_manifest(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(records, indent=2, sort_keys=True))
