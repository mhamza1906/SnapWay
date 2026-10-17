# Vertex AI backend and operational testing

Subagent 1, 2026-10-17. Everything below was measured on this machine unless it says
"documented". Raw results are in `runs/ops/*.json`; the request ledger is
`runs/ops/vertex_ledger.json`.

## 0. Configuration guide

1. Use a Google Cloud project with the Vertex AI API enabled and billing on (here
   `project-7f487f13-1ed3-42d7-a46`; check with
   `gcloud services list --enabled --project <project> --filter=config.name:aiplatform.googleapis.com`).
   Your account needs permission to call Vertex AI prediction in that project (for
   example the Vertex AI User role).
2. Create Application Default Credentials once: `gcloud auth application-default login`.
   Optionally attribute quota to the project:
   `gcloud auth application-default set-quota-project <project>` (silences the
   "without a quota project" warning; not done on this machine).
3. In `apps/place-match/.env` (git-ignored, non-secret values):
   `VERTEX_PROJECT=<project>` and `VERTEX_LOCATION=us` (`global` and `eu` are also
   documented for `gemini-embedding-2`; only `us` was tested). No API key is used.
4. Smoke test before any large run (sends 0 requests, then a few):
   `uv run placematch embed --manifest <manifest.json> --backend vertex --limit 0 --dry-run`,
   then `--limit 5` and check `api_requests`, `retries` and `failed`.
5. Large runs: `uv run placematch embed ... --limit 1000` repeatedly (resumable; each vector
   is cached immediately), then `uv run placematch run --backend vertex --limit 0 ...`.
   Never raise quotas automatically; costs are estimates from the public price list.

Run metadata (`results.json` → `backend_config`) records provider `vertex-ai`, project,
location, endpoint host, model, dimensions and preprocessing; credentials are never logged.

## 1. What the bench-v1 Google backend actually used

`backends/gemini.py` calls `genai.Client(api_key=GEMINI_API_KEY)` with no `vertexai` flag.
In google-genai 2.31 (`google/genai/_api_client.py`, `BaseApiClient.__init__`), a client
without `vertexai=True` (and without `GOOGLE_GENAI_USE_VERTEXAI` / `GOOGLE_GENAI_USE_ENTERPRISE`
in the environment, which are unset here and are not in `.env`) takes the `else` branch:
`base_url = "https://generativelanguage.googleapis.com/"`, `api_version = "v1beta"`, key sent
as the `x-goog-api-key` header. Constructing a client with a placeholder key (nothing sent)
confirms `vertexai=None`, base URL `https://generativelanguage.googleapis.com/`.

So bench-v1 used the **Gemini Developer API**, not Vertex AI. `GeminiBackend.config()` now
says `provider: "gemini-developer-api"`, `endpoint_host: "generativelanguage.googleapis.com"`,
`api_version: "v1beta"`. Its key `gemini:gemini-embedding-2:d3072:max1024:jpg90` and its cache
directory are unchanged: the cache namespace is the hash of the frozen bench-v1 config dict
(`legacy_cache_config`, still labelled `google-gemini-api` inside the hash input), which
still hashes to `bc4700b7cd1d` (tested). The MegaLoc cache namespace (`a68fdfd71df3`) is
also unchanged. Old results keep their old `backend_config` label.

## 2. Verified Vertex AI facts (checked 2026-10-17)

| Fact | Value | Source |
| --- | --- | --- |
| Model | `gemini-embedding-2`, launch stage GA, released 2026-04-22 (`gemini-embedding-2-preview` is a separate preview model, 2026-03-10) | model page |
| Locations | `global`, `us` (multi-region), `eu` (multi-region) | model page, "Supported regions" |
| Input limit | 8,192 tokens; an image counts as 258 tokens | multimodal page, API limits |
| Images | max 6 per request; PNG, JPEG, WebP, BMP, HEIC, HEIF, AVIF; max 16384 x 16384 px; no file-size limit for inline data | both pages |
| Output | 3072 dims by default; smaller via `output_dimensionality` (MRL); non-default sizes are already L2-normalised | both pages |
| Task type | `task_type` not supported for this model; task instructions go in the text prompt (none sent for images) | multimodal page |
| SDK | `genai.Client(vertexai=True, project=..., location=...)`, `client.models.embed_content(model="gemini-embedding-2", contents=[content])`; REST `...:embedContent` | multimodal page; google-genai 2.31 routes `gemini-*` to `:embedContent` and refuses more than one content per call |
| Auth | Application Default Credentials (`gcloud auth application-default login`) | multimodal page |
| Quotas | global quotas shared by all locations (regional quotas seen in the console belong to the preview model) | multimodal page, "Quotas" |
| Consumption | Standard pay-as-you-go and batch supported; Provisioned Throughput not supported | model page |
| Price | Input image USD 0.45 per 1M tokens online, 0.225 batch; output not charged. Table row is labelled "Gemini Embedding 2 (Unified Multimodal, Preview)" while the model page says GA; we use that row | pricing page, "MultiModal Embeddings" |

URLs (the cloud.google.com addresses now redirect to `docs.cloud.google.com/gemini-enterprise-agent-platform/...`
and `cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing`):

- https://cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-multimodal-embeddings (page "Last updated 2026-10-15 UTC")
- https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2 (page "Last updated 2026-10-16 UTC")
- https://cloud.google.com/vertex-ai/generative-ai/pricing

Estimated cost per image: 258 tokens x 0.45 / 1e6 = **USD 0.000116** (an estimate from the
price list, not a bill). The measured `usageMetadata.promptTokenCount` was exactly 258 for
every image sent (1,290 tokens for the 5 smoke images).

## 3. The backend (`get_backend("vertex")`, `placematch/backends/vertex.py`)

- Project `VERTEX_PROJECT`, location `VERTEX_LOCATION` from the environment or the ignored
  `.env` (`VERTEX_LOCATION=us` appended; non-secret). `us` was chosen because it is a
  documented location for the model and the documentation's own example; it keeps data at
  rest in the US multi-region. Quota is global either way. Locations other than
  `global`/`us`/`eu` are refused. No fallback to another provider, model or location.
- Auth: `google.auth.default(scopes=[cloud-platform])` (ADC, `authorized_user`; the
  hackathon `VERTEX_API_KEY` is not used). The ADC file has no quota project; google-auth
  warns about that, and requests still succeeded against the explicit project.
- Destination host: taken from the SDK's own configured `base_url` (a throwaway client with
  anonymous credentials, nothing sent): `aiplatform.us.rep.googleapis.com`, API `v1beta1`.
  The real client is checked against it before any request, and an httpx event hook records
  the host of every HTTP attempt: all 112 went to `aiplatform.us.rep.googleapis.com`.
  Hooks record host and status only (no headers, bodies or credentials).
- Key: `vertex:gemini-embedding-2@us:d3072:max1024:jpg90`; cache directory
  `data/cache/vertex_gemini-embedding-2_us_d3072_max1024_jpg90-1a723cafdb4f`, hashing
  provider, project, location, model, dims, method, endpoint host and preprocessing.
- Preprocessing identical to the Developer API backend (EXIF-upright RGB, longest side
  <= 1024 Lanczos, never upscaled, JPEG q90 4:4:4). The docs need nothing different
  (JPEG accepted, 258 tokens regardless of size). One image per request.
- `config()` records provider `vertex-ai`, project, location, model, dims, preprocessing,
  endpoint host, API version, auth type, hosts contacted and the per-image price. The
  `embedContent` response has only `embedding` and `usageMetadata` (`promptTokenCount`,
  `totalTokenCount`, `trafficType`, `promptTokensDetails`); it carries no model version,
  so `model_version` is `null`.
- Stats: `api_requests` (logical) vs `RunStats.http_attempts` (every attempt incl.
  retries), retries, cache hits, `usage` (summed token counts per modality, HTTP status and
  host counts), `cost_estimate` (from measured tokens when every response had usage, else
  258 x n; with source URL and date), `latency_s`, `peak_rss_mb`, `hardware`, `cold_start`;
  `QueryResult.timings_s` = quality / embed (this run only, 0 for cache hits) / search /
  verify / total.
- `retrieval.estimate()` adds `cost_usd`, `pricing_source`, `pricing_checked_utc`,
  `cost_basis` (+ `unreadable` if any). `retrieval.embed_only()` is the resumable batch.

## 4. Smoke test (5 images) and Vertex vs Developer API

Dry runs first every time. Smoke test (`python -m placematch.ops.vertex_smoke`,
`runs/ops/vertex_smoke.json`): 5 logical requests, 5 HTTP attempts, all HTTP 200, 0
retries, 0 failures: project selection, API enablement, IAM permission and quota all OK.

Comparison (`python -m placematch.ops.vertex_compare`, `runs/ops/vertex_vs_devapi.json`):
110 bench-v1 images (stratified: 5 references + 10 queries per scene, office/SFB have no
references in bench-v1), read-only; the Developer API vectors were read from the bench-v1
cache with SQLite in read-only mode, **0 Developer API requests**.

| Measure (110 images; 80 queries x 30 references) | Value |
| --- | --- |
| Per-image cosine Vertex vs Developer API | min 0.99999988, median 1.0, max 1.00000012 |
| Bitwise-identical float32 vectors | **110 / 110** |
| Top-1 agreement | 80 / 80 (1.0) |
| Top-5 overlap | 1.0 |
| Spearman / Kendall per query (all 30 refs) | 1.0 / 1.0 (min 1.0) |
| Max abs difference of query-reference cosines | 0.0 |
| Top-1 location correct on this small gallery (60 queries with a reference) | 0.883 both |

Interpretation: for this model and preprocessing the two providers returned the same
vectors bit for bit on all 110 images. The backends remain separate (keys, caches,
indexes, thresholds keyed by backend key); this measurement does not by itself make
bench-v1 Developer API thresholds valid for the Vertex key: that is a head-agent decision.

## 5. Vertex requests used

| Step | Logical requests | HTTP attempts |
| --- | --- | --- |
| Smoke test | 5 | 5 |
| Compare A: budget-limited partial batch | 40 | 40 |
| Compare B: worker killed with SIGKILL | 14 (counted as attempts) | 14 |
| Compare C: resume | 53 | 53 |
| Invalid inputs, cache check, cold/warm | 0 | 0 |
| **Total** | **112 of 300** | **112** |

Estimated cost: 112 x 258 tokens x USD 0.45 / 1M = about USD 0.013 (estimate).

## 6. Operations

Hardware: Apple M3, 16 GB, macOS 27, MPS. Concurrent workload during all measurements
(from `ps` snapshots stored in each JSON): iCloud sync daemons (`cloudd` 66-144% CPU,
`fileproviderd` 66-87%, `bird` 42-53%), Subagent 2's dataset jobs
(`placematch.datasets.mapfree fetch`, `placematch.datasets.cloc images`), seven `node`
processes at ~85% CPU each during the smoke test, and 1-minute load averages of 245-626. All
timings are therefore pessimistic and noisy; treat them as orders of magnitude.

### Cache reuse and invalidation (`runs/ops/cache.json`, 0 requests)

- Two repeat Vertex retrieval runs on the 110-image subset: 0 requests, 0 HTTP attempts,
  110/110 cache hits each (budget 0, so any request would have been refused).
- MegaLoc against a fresh scratch cache: run 1 computed 110 images (embed 42.2 s,
  amortised p50 0.21 s/image incl. model load); run 2: 110/110 hits, embed 0.05 s.
- Every vector-changing setting gets its own key and cache directory, so nothing is
  reused across them (dry-run estimates only): Vertex jpeg 85, max side 768, dims 768,
  location eu each show 0/110 cached; Vertex, Developer API and MegaLoc caches are all
  distinct (the Developer API and MegaLoc bench-v1 caches still serve 110/110).
- Content keying: a byte-identical copy under a new name is a hit; a one-pixel edit is a miss.

### Interrupted runs resume (`runs/ops/resume.json`)

Start: 5 of 110 cached (smoke). A: `embed_only(budget=40)` sent exactly 40, 65 left.
B: a worker subprocess was SIGKILLed after 12 new vectors were stored; it had sent 14 HTTP
attempts, so 2 in-flight requests were lost (their responses never reached the cache).
C: the resume estimate said 53 uncached, the resume sent exactly 53, and 0 of them were
for images cached before C. Total 107 logical requests for 105 images: the 2 extra are
exactly the 2 in flight at the kill; no stored vector was ever requested again.

### Invalid and unsupported files (`runs/ops/invalid_inputs.json`)

Fixtures in `runs/ops/fixtures/invalid/`. Each produced a message naming the file, and the
run continued with the valid images (MegaLoc and Vertex: 3 references + 1 valid query
ranked; Vertex sent 0 requests because invalid files fail before sending and valid ones
were cached):

| Input | Message (after the path) |
| --- | --- |
| truncated JPEG | `truncated/corrupt image data (24764 bytes): image file is truncated (45 bytes not processed)` |
| JPEG header + junk | `corrupt JPEG (2052 bytes): UnidentifiedImageError: ...` |
| empty `.jpg` | `empty file (0 bytes)` |
| text renamed `.jpg` | `not an image: file starts with text (33 bytes, suffix '.jpg')` |
| real HEIC (`sips`), no plugin | ingest skips it with a warning naming it; loading it directly: `HEIC/HEIF image but no HEIF decoder is installed (pillow-heif); convert to JPEG` |
| missing file | `file not found` / `unreadable: FileNotFoundError` |
| empty / random / truncated / text `.mp4` | `InvalidVideo: <path>: empty file` or `ffprobe cannot read it: moov atom not found ... Invalid data found when processing input` |

Verification of a corrupt pair returns `status="error"` with the message (never raises).
Caveat: `estimate()` counts undecodable-but-non-empty files as uncached requests (4 here)
although none is sent.

### Rotated and variable-frame-rate video (`runs/ops/video.json`)

8 videos (4 rotations x mp4/mov) x 2 extraction rates = 16 cases: H.264 with B-frames, 12 well-separated real 7-Scenes frames shown for
uneven durations (0.033-1.3 s), exact PTS on a 1/90000 time base, coded rotated and
tagged with display rotation 0/90/180/270 (mp4 and mov), extracted at 1 and 4 fps. In all
16 cases: every extracted `timestamp_s` equals the true PTS from `ffprobe -show_frames`
and the designed time (max error 0.0 ms), the selected frames are exactly the first of
each `1/fps` bin, `frame_id` is the presentation index, the image is the source frame shown
at that time and upright (640x480 from 480x640 coded), and `rotation_ccw_deg`/`orientation`
are 90/8, 180/3, 270/6. (A first generator attempt via the concat demuxer silently snapped
times to 1/25 s; the extractor matched those true PTS exactly too, which is why the check
compares against ffprobe's PTS as well as the design.)

### Memory over 1,000 verification pairs (`runs/ops/verify_memory.json`)

1,000 real pairs (500 queries x 2 references of the same scene from another sequence or
folder; 1,387 distinct 7-Scenes/CLoC images), production path `verify_run` (its feature
cache is cleared above 512 images), sampled every 5 s: 496 verified, 504 inconclusive,
0 errors, wall 2,016 s.

| Memory | 10-30% of pairs (median) | 70-95% of pairs (median) | max |
| --- | --- | --- | --- |
| MPS driver allocated | 1,111 MB | 1,129 MB | 1,142 MB |
| MPS current allocated | 41 MB | 5 MB | 213 MB |
| Process RSS (`ps`) | 259 MB | 146 MB | 667 MB (peak RSS 909 MB) |

Verdict: **no leak-like growth in RSS or tensor memory**. MPS driver memory is flat to
within about +30 MB (+2.9%) over 1,000 pairs (1,101 MB after 30 pairs, 1,133 MB after 969),
dropping to ~90 MB whenever `empty_cache()` had just run. RSS swings between ~40 MB and
~670 MB because macOS compressed/paged the process under the heavy concurrent load, so RSS
is noisy here rather than a growth signal. One pair took 291 s (pairs 786-787, during a
system-wide stall); median 1.18 s/pair, p95 3.42 s.

### Cold start vs warm (`runs/ops/cold_warm.json`)

| Component | Cold | Warm / steady state |
| --- | --- | --- |
| MegaLoc (fresh process, scratch cache, batch 8, MPS) | import torch 3.8 s; model load incl. sha256 check 8.2 s; first batch 3.9 s excl. load (12.2 s incl.) | second batch 2.4 s; steady 0.32 s/image p50 (0.33 p95), incl. decode/preprocess/cache write; peak RSS 1.99 GB |
| Vertex AI (5 sequential requests) | ADC load 5.6 s (google-auth also queries gcloud); first request 2.86 s (includes the OAuth token fetch, which is not an httpx attempt; its HTTP attempt took at most 1.63 s) | 0.86 s/request p50, 0.96 s max (requests 2-5); with concurrency 4 the resume phase sent 53 requests in about 15 s |
| Verification (SuperPoint MPS + LightGlue CPU) | import torch+verify 4.4 s; first pair 8.7 s incl. model load | pairs 2-50: 1.20 s p50; pairs 51-1,000: 1.18 s p50, 3.43 s p95 |

Cached Vertex retrieval on 110 images (no requests): embed step 0.05-0.06 s, total
1.1-1.7 s (`runs/ops/cache.json`).

## 7. Commands

```bash
uv run python -m placematch.ops.vertex_smoke --dry-run   # then without --dry-run
uv run python -m placematch.ops.vertex_compare --dry-run # then without
uv run python -m placematch.ops.cache_check
uv run python -m placematch.ops.invalid_inputs
uv run python -m placematch.ops.video_check
uv run python -m placematch.ops.verify_memory --pairs 1000
uv run python -m placematch.ops.cold_warm
uv run pytest tests/test_ops_*.py                         # offline versions
```

## 8. Not done / limits

- No multi-region comparison (`global`, `eu`): not needed for the decision and would cost
  requests; `us` only.
- Billing was not checked in the Cloud console; all costs are price-list estimates.
- Batch (asynchronous) Vertex embedding was not used or tested.
- The ADC credentials have no quota project; if a quota error appears, set one with
  `gcloud auth application-default set-quota-project <project>` (not done here).
- HEIC input needs a HEIF decoder; none was added (`uv add pillow-heif` would be needed).
