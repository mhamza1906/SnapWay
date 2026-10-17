"""Read selected members of a remote ZIP archive with HTTP range requests.

Large dataset archives (7-Scenes scene zips are 1-6 GB, each holding nested
``seq-XX.zip`` files) only need a few hundred frames for a small benchmark. This module
opens the archive's central directory over HTTP and fetches only the byte ranges of the
members that are actually extracted, so the download is a small fraction of the archive.

Nested archives are supported when the inner zip is *stored* (not deflated) in the outer
one: the inner zip is then exposed as a seekable byte window of the outer file.

Nothing read through this module is executed; members are only written to disk.
"""

from __future__ import annotations

import io
import struct
import zipfile
from collections import OrderedDict
from pathlib import Path

import httpx

BLOCK = 1 << 20  # 1 MiB read blocks


class HttpRangeFile(io.RawIOBase):
    """A read-only, seekable file over an HTTP(S) URL that supports byte ranges."""

    def __init__(
        self,
        url: str,
        *,
        block_size: int = BLOCK,
        max_blocks: int = 64,
        client: httpx.Client | None = None,
        timeout: float = 60.0,
    ) -> None:
        super().__init__()
        self.url = url
        self.block_size = block_size
        self.max_blocks = max_blocks
        self._client = client or httpx.Client(follow_redirects=True, timeout=timeout)
        self._own_client = client is None
        self._blocks: OrderedDict[int, bytes] = OrderedDict()
        self._pos = 0
        self.bytes_fetched = 0
        r = self._get(0, 0)
        content_range = r.headers.get("content-range", "")
        if r.status_code != 206 or "/" not in content_range:
            raise OSError(f"server does not support range requests for {url}")
        self.size = int(content_range.rsplit("/", 1)[1])

    def _get(self, start: int, end: int) -> httpx.Response:
        last: Exception | None = None
        for _ in range(4):
            try:
                r = self._client.get(self.url, headers={"Range": f"bytes={start}-{end}"})
                r.raise_for_status()
                self.bytes_fetched += len(r.content)
                return r
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:  # retry transient
                last = exc
        raise OSError(f"range request {start}-{end} failed for {self.url}: {last}")

    # io.RawIOBase API -----------------------------------------------------------------
    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            self._pos = offset
        elif whence == io.SEEK_CUR:
            self._pos += offset
        elif whence == io.SEEK_END:
            self._pos = self.size + offset
        else:
            raise ValueError(whence)
        return self._pos

    def _block(self, idx: int) -> bytes:
        if idx in self._blocks:
            self._blocks.move_to_end(idx)
            return self._blocks[idx]
        start = idx * self.block_size
        end = min(self.size, start + self.block_size) - 1
        data = self._get(start, end).content
        self._blocks[idx] = data
        if len(self._blocks) > self.max_blocks:
            self._blocks.popitem(last=False)
        return data

    def read_range(self, start: int, length: int) -> bytes:
        """Fetch ``length`` bytes at ``start``; large reads bypass the block cache."""
        if length <= 0 or start >= self.size:
            return b""
        length = min(length, self.size - start)
        if length > 4 * self.block_size:
            return self._get(start, start + length - 1).content
        out = bytearray()
        pos = start
        while pos < start + length:
            idx, off = divmod(pos, self.block_size)
            blk = self._block(idx)
            take = min(len(blk) - off, start + length - pos)
            out += blk[off : off + take]
            pos += take
        return bytes(out)

    def readinto(self, b) -> int:  # type: ignore[override]
        data = self.read_range(self._pos, len(b))
        n = len(data)
        b[:n] = data
        self._pos += n
        return n

    def close(self) -> None:
        if self._own_client:
            self._client.close()
        super().close()


class WindowFile(io.RawIOBase):
    """A seekable read-only window ``[start, start+length)`` of another seekable file."""

    def __init__(self, base: io.RawIOBase, start: int, length: int) -> None:
        super().__init__()
        self.base, self.start, self.length = base, start, length
        self._pos = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self.length}[whence]
        self._pos = base + offset
        return self._pos

    def readinto(self, b) -> int:  # type: ignore[override]
        n = max(0, min(len(b), self.length - self._pos))
        if n == 0:
            return 0
        if isinstance(self.base, HttpRangeFile):
            data = self.base.read_range(self.start + self._pos, n)
        else:
            self.base.seek(self.start + self._pos)
            data = self.base.read(n)
        b[: len(data)] = data
        self._pos += len(data)
        return len(data)


def member_data_offset(raw: io.RawIOBase, info: zipfile.ZipInfo) -> int:
    """Absolute offset of a member's data, parsed from its local file header."""
    if isinstance(raw, HttpRangeFile):
        header = raw.read_range(info.header_offset, 30)
    else:
        raw.seek(info.header_offset)
        header = raw.read(30)
    sig, *_rest = struct.unpack("<IHHHHHIIIHH", header)
    if sig != 0x04034B50:
        raise zipfile.BadZipFile(f"bad local header for {info.filename}")
    name_len, extra_len = struct.unpack("<HH", header[26:30])
    return info.header_offset + 30 + name_len + extra_len


def open_nested(raw: io.RawIOBase, outer: zipfile.ZipFile, name: str) -> zipfile.ZipFile:
    """Open a zip stored (uncompressed) inside ``outer`` without downloading all of it."""
    info = outer.getinfo(name)
    if info.compress_type != zipfile.ZIP_STORED:
        raise zipfile.BadZipFile(f"{name} is compressed inside the outer zip; cannot window it")
    start = member_data_offset(raw, info)
    return zipfile.ZipFile(io.BufferedReader(WindowFile(raw, start, info.file_size), BLOCK))


def extract_member(zf: zipfile.ZipFile, name: str, dest: Path) -> Path:
    """Extract one member to ``dest`` (a file path) atomically; skip if already complete."""
    info = zf.getinfo(name)
    if dest.is_file() and dest.stat().st_size == info.file_size:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with zf.open(info) as src, tmp.open("wb") as out:
        while chunk := src.read(BLOCK):
            out.write(chunk)
    tmp.replace(dest)
    return dest


def stream_member(raw: HttpRangeFile, info: zipfile.ZipInfo, chunk: int = BLOCK):
    """Yield the *decompressed* bytes of one member with a single streaming range GET.

    Used for nested zips that are deflated inside the outer archive (no random access is
    possible inside a deflate stream, so the whole member must be streamed once).
    """
    import zlib

    start = member_data_offset(raw, info)
    end = start + info.compress_size - 1
    if info.compress_type == zipfile.ZIP_STORED:
        dec = None
    elif info.compress_type == zipfile.ZIP_DEFLATED:
        dec = zlib.decompressobj(-15)
    else:
        raise zipfile.BadZipFile(f"unsupported compression {info.compress_type}")
    headers = {"Range": f"bytes={start}-{end}"}
    with raw._client.stream("GET", raw.url, headers=headers) as r:
        r.raise_for_status()
        for part in r.iter_bytes(chunk):
            raw.bytes_fetched += len(part)
            out = dec.decompress(part) if dec else part
            if out:
                yield out
    if dec is not None:
        tail = dec.flush()
        if tail:
            yield tail


class _ByteQueue:
    def __init__(self, chunks) -> None:
        self._it = iter(chunks)
        self._buf = bytearray()
        self._off = 0

    def read(self, n: int) -> bytes:
        while len(self._buf) - self._off < n:
            try:
                nxt = next(self._it)
            except StopIteration:
                break
            if self._off:
                del self._buf[: self._off]
                self._off = 0
            self._buf += nxt
        out = bytes(self._buf[self._off : self._off + n])
        self._off += len(out)
        return out


def iter_stream_zip(chunks, want):
    """Parse a zip from a forward-only byte stream using local file headers.

    ``want(name) -> bool`` selects members; yields ``(name, data, crc_ok)`` for selected
    members only. Stops at the central directory. Archives that use data descriptors
    (general-purpose flag bit 3) are rejected because sizes are unknown up front.
    """
    import zlib

    q = _ByteQueue(chunks)
    while True:
        header = q.read(30)
        if len(header) < 4:
            return
        sig = struct.unpack("<I", header[:4])[0]
        if sig != 0x04034B50:  # central directory or end record
            return
        (_, _ver, flags, comp, _t, _d, crc, csize, _usize, nlen, elen) = struct.unpack(
            "<IHHHHHIIIHH", header
        )
        if flags & 0x08:
            raise zipfile.BadZipFile("streamed zip uses data descriptors; unsupported")
        name = q.read(nlen).decode("utf-8", "replace")
        q.read(elen)
        payload = q.read(csize)
        if len(payload) < csize:
            raise zipfile.BadZipFile(f"truncated member {name}")
        if not want(name):
            continue
        if comp == zipfile.ZIP_DEFLATED:
            payload = zlib.decompress(payload, -15)
        elif comp != zipfile.ZIP_STORED:
            raise zipfile.BadZipFile(f"unsupported compression {comp} for {name}")
        yield name, payload, (zlib.crc32(payload) & 0xFFFFFFFF) == crc


def read_member_direct(raw: HttpRangeFile, info: zipfile.ZipInfo) -> bytes:
    """Read one member with two range requests (local header + data), CRC-checked.

    Lets several threads read members of one remote archive with their own
    ``HttpRangeFile`` objects after the central directory was parsed once elsewhere.
    """
    import zlib

    start = member_data_offset(raw, info)
    data = raw.read_range(start, info.compress_size)
    if info.compress_type == zipfile.ZIP_DEFLATED:
        data = zlib.decompress(data, -15)
    elif info.compress_type != zipfile.ZIP_STORED:
        raise zipfile.BadZipFile(f"unsupported compression {info.compress_type}")
    if len(data) != info.file_size or (zlib.crc32(data) & 0xFFFFFFFF) != info.CRC:
        raise zipfile.BadZipFile(f"size/CRC mismatch for {info.filename}")
    return data


def write_atomic(dest: Path, data: bytes) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return dest
