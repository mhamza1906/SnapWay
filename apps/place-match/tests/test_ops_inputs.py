"""Invalid/unsupported files give clear errors naming the file and never crash a run."""

from __future__ import annotations

import io
import shutil
import warnings
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from placematch.backends.base import RequestBudget
from placematch.backends.gemini import GeminiBackend
from placematch.frames import (
    IMAGE_EXTS,
    InvalidImage,
    InvalidVideo,
    extract_video,
    ingest_images,
    load_upright,
)
from placematch.retrieval import run_retrieval
from placematch.schemas import Manifest, ManifestEntry
from placematch.verify import verify_pair


class FakeClient:
    def __init__(self):
        self.calls = 0
        self.models = SimpleNamespace(embed_content=self.embed_content)

    def embed_content(self, *, model, contents, config):
        self.calls += 1
        n = len(contents[0].parts[0].inline_data.data)
        vec = np.random.default_rng(n).normal(size=config.output_dimensionality)
        return SimpleNamespace(embeddings=[SimpleNamespace(values=vec.tolist())])


@pytest.fixture
def files(tmp_path):
    good = tmp_path / "good.png"
    Image.fromarray(np.random.default_rng(0).integers(0, 255, (40, 60, 3), np.uint8)).save(good)
    buf = io.BytesIO()
    Image.open(good).save(buf, format="JPEG")
    jpg = buf.getvalue()
    f = {
        "good": good,
        "corrupt": tmp_path / "corrupt.jpg",
        "empty": tmp_path / "empty.jpg",
        "text": tmp_path / "text.jpg",
        "heic": tmp_path / "photo.heic",
        "missing": tmp_path / "missing.jpg",
    }
    f["corrupt"].write_bytes(jpg[: len(jpg) // 2])
    f["empty"].write_bytes(b"")
    f["text"].write_text("hello, not an image\n")
    f["heic"].write_bytes(b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64)  # HEIF header only
    return f


@pytest.mark.parametrize(
    "name, reason",
    [
        ("corrupt", "truncated"),
        ("empty", "empty file"),
        ("text", "not an image"),
        ("heic", "HEIF"),
        ("missing", "not found"),
    ],
)
def test_loader_messages_name_the_file(files, name, reason):
    with pytest.raises(InvalidImage) as e:
        load_upright(files[name])
    assert str(files[name]) in str(e.value) and reason in str(e.value)


def test_ingest_warns_about_skipped_heic(files):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        entries = ingest_images(files["good"].parent, "query")
    if ".heic" not in IMAGE_EXTS:  # no HEIF plugin: skipped, with a warning naming the file
        assert "photo.heic" not in {e.frame_id for e in entries}
        assert any("photo.heic" in str(x.message) for x in w)


def test_run_survives_bad_files_and_sends_nothing_for_them(files, tmp_path):
    entries = [
        ManifestEntry(image_id="ref", path=str(files["good"]), role="reference", dataset="x",
                      scene_id="s"),
    ] + [
        ManifestEntry(image_id=k, path=str(p), role="query", dataset="x", scene_id="s")
        for k, p in files.items()
    ]  # fmt: skip
    m = Manifest(name="bad", entries=entries)
    mp = tmp_path / "m.json"
    mp.write_text(m.model_dump_json())
    fc = FakeClient()
    b = GeminiBackend(dims=128, cache_root=tmp_path / "c", client=fc, base_delay_s=0)
    run = run_retrieval(m, mp, b, budget=RequestBudget(10), out_dir=tmp_path / "out")
    assert fc.calls == 1 == run.stats.api_requests  # only the one valid image was sent
    failed = run.settings["failed_images"]
    for k in ("corrupt", "empty", "text", "heic", "missing"):
        assert any(str(files[k]) in f for f in failed), k
    assert run.stats.failed == 5
    by = {q.query_id: q for q in run.queries}
    assert by["good"].candidates and not by["corrupt"].candidates


def test_verify_pair_reports_error_not_crash(files):
    r = verify_pair(files["corrupt"], files["good"])
    assert r.status == "error" and str(files["corrupt"]) in r.message


@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="ffprobe not installed")
def test_unreadable_videos(tmp_path):
    empty = tmp_path / "empty.mp4"
    empty.write_bytes(b"")
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(np.random.default_rng(0).bytes(5000))
    for v in (empty, junk, tmp_path / "missing.mp4"):
        with pytest.raises(InvalidVideo) as e:
            extract_video(v, tmp_path / "frames")
        assert str(v) in str(e.value)
