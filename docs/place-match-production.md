# Place matching in production (proposal; nothing provisioned)

Proposal for hosting the photo-localization engine (`apps/place-match`) in Google Cloud
project `project-7f487f13-1ed3-42d7-a46` (or another project Arjun names). **No resource,
API, quota or billing change has been made.** Every price below is a planning estimate
from public list prices as remembered on 2026-10-17; check the live pricing pages before
deciding. Measured numbers come from `apps/place-match/REPORT-v2.md` (Apple M3).

## Target shape

```text
iPhone ──HTTPS──► SnapWay API (Vultr, Django)  /api/navigation/localize/
                    auth: visitor NavigationSession or signed-in user; throttle; no frame storage
                    └──HTTPS + service identity──► placematch engine (Cloud Run)
                                                   MegaLoc in-process; Vertex AI via workload identity
                                                   reference indexes from Cloud Storage
```

The phone never holds Google credentials or a shared token: it authenticates to SnapWay
(allauth sessions for contributors, scoped `NavigationSession` capabilities for visitors),
and only the API calls the engine.

## Engine hosting options

| Option | Expected latency per frame | Cost per 1,000 frames (estimate) | Notes |
| --- | --- | --- | --- |
| Cloud Run, CPU only (4 vCPU, 8 GiB) | ~1–3 s MegaLoc (estimate; M3 GPU measured 0.32 s) | ≈ USD 0.10–0.30 compute while busy | Simplest; cold start loads ~0.9 GB weights (~8 s measured locally). Keep 1 min instance during tests. |
| Cloud Run with NVIDIA L4 GPU | ~0.05–0.15 s MegaLoc (estimate) | ≈ USD 0.02–0.05 while busy; idle GPU instances cost far more | Needs GPU quota in the region; min instances to avoid GPU cold starts; best for sustained traffic. |
| Vertex AI custom endpoint (MegaLoc container) | similar to GPU option | Billed per node-hour even when idle | More ML-ops features (model versions, traffic split); most expensive for low, bursty demo traffic. |

Vertex AI `gemini-embedding-2` is used only as fallback/second opinion: ~0.86 s per
request measured, about USD 0.000116 per image (≈ USD 0.12 per 1,000) from
`REPORT-v2.md`. Geometric verification (SuperPoint + LightGlue) adds ~1.2 s/frame on the
M3 and is GPU-friendly.

**Recommendation for the first deployment:** Cloud Run CPU with `min-instances=0` for
demos (accepting cold starts), revisit L4 GPU if measured phone traffic needs < 0.5 s.

## Data

- Reference photos and per-backend indexes (`vectors.npy`, `index.txt`, `meta.json`) in a
  private Cloud Storage bucket, one prefix per reference set and backend key; loaded at
  startup and pinned by object generation.
- MegaLoc weights either baked into the image (simplest, reproducible) or pulled from the
  same bucket by checksum (`WEIGHTS_SHA256`).
- Thresholds file (`current.json`) versioned with the image; `thresholds_id` (content
  hash) is returned with every decision.

## Credentials and auth

- Engine service account with `roles/aiplatform.user` only, via Cloud Run's attached
  identity (workload identity, no key files).
- SnapWay API → engine: Cloud Run IAM (`roles/run.invoker`) with Google-signed ID tokens,
  replacing `PLACEMATCH_ENGINE_TOKEN`; ingress restricted to the API.
- Visitors: `NavigationSession` capabilities (already in the schema) instead of
  `PLACEMATCH_DEV_TOKEN`, which stays DEBUG-only. TLS everywhere; DRF scoped throttles
  plus a per-session cap.

## Data handling

- Frames are processed in memory/temp files and discarded; logs contain ids, timings,
  outcomes and backend keys only (no images, EXIF or tokens).
- If retention is later approved (e.g. to populate `navigation.Capture` /
  `LocalizationResult` for audit), store frames in a separate bucket with a short TTL
  lifecycle rule (e.g. 7 days), document it in the privacy notice, and add deletion on
  request.

## Operations

- Cloud Monitoring: request rate, p50/p95 latency per stage (`timings_ms`), outcome
  mix, fallback rate, Vertex request count/cost, cold starts, 5xx.
- Rollback by pinning image digest, model key (`megaloc:5fe0dd6:322x322`), thresholds
  hash and reference-set generation together; never mix vectors across backend keys.
- Budget alert on the project; Vertex request cap per day in the engine config.

## What Arjun must approve or enable first

1. Billing account linkage and a budget/alert for the project.
2. APIs: Cloud Run, Artifact Registry, Cloud Storage, Vertex AI (already used locally),
   Cloud Build (if building in the cloud).
3. Region choice and, for the GPU option, an L4 quota request (do not raise quotas
   without approval).
4. Service accounts and IAM bindings listed above.
5. Retention decision for frames (default: none).
6. The licence review for shipping MegaLoc/DINOv2 weights (§6 of the brief) applies to
   on-device use; server hosting still needs the upstream licence terms recorded.

Nothing is to be created or deployed without Arjun's explicit approval in chat.
