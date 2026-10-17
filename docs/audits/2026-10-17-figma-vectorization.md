# IA floor 1: visual fidelity and navigation review of Figma vectorization

Date: 2026-10-17. Code baseline: `3975922`; branch: `acceptance/map-authoring-pipeline`.
This reviewed the supplied artifact/public APIs without new model calls, production writes, dependency installation or application API changes. Follows the [architecture](../initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md); proposed workflow changes remained unimplemented at this checkpoint.

## Finding

**This Figma SVG preserves the input substantially better than the previous GPT/Gemini whole-image reconstructions and merits priority as a display-background candidate. It is not ready for direct navigation import.** Dedicated tracing after raster generation/cleanup deserves further testing. Rooms, openings, traversable areas and routing still require semantic extraction, validation and review; general models need not redraw every wall or seat.

Figma processing time/credits were not measured. No measured speedup or cost advantage over GPT/Gemini is established.

## Input, structure and evidence

Actual supplied files were in `local/test-results/figma-initial-test/`, not root `test-results/`. The preserved export is [figma-vector.svg](assets/2026-10-17-figma-vectorization/figma-vector.svg). Its input is the previous real GPT Image 2.5 [optimized-floor.png](assets/2026-10-17-gpt-fullchain/optimized-floor.png), not the earlier ChatGPT-web raster.

| Check | Observed result | Meaning |
|---|---|---|
| Input/SVG dimensions | 1536 x 1024; `viewBox="0 0 1536 1024"` | No scaling/registration needed for this output comparison |
| SVG size | 440,127 bytes, approximately 430 KiB | Manageable artifact size; mobile rendering performance untested |
| Content | 1,321 paths, 44 path-fill colors | Actual vectors rather than an embedded image wrapper |
| Commands | 6,546 C, 4,227 L, 1,349 M/Z, plus H/V | More contour detail than deliberately bounded LLM outputs |
| Closure/compound paths | Every path includes closed subpaths; 14 have multiple subpaths | Paint contours are closed, not necessarily rooms; holes/overlap need treatment |
| Other elements | No `image`, `text`, `g`, `script`, `foreignObject`, `use` | Flat pure-path export |
| Exported semantics | No `id`, `data-*`, room names, door associations or graph nodes/edges | No direct Room/Door/Graph mapping; no inference about unexported Figma/plugin metadata |
| Paint | Filled paths without strokes; 196 have fill opacity | Visible ink outlines are not wall centerlines |

SVG SHA256: `c7ec1165be27096017ab4f2a5b9aac9aaf5f0f1407845bd28c0aeeed0fc6f53e`.
Input SHA256: `7b8edc60e54b1b0840cd16231666afa27f557b7166eb17c66f4f5040d76b7c45`.

![Same input and three vector outputs](assets/2026-10-17-figma-vectorization/comparison.jpg)

### Visual measurements

The [replay script](assets/2026-10-17-figma-vectorization/analyze.py) compares native pixels on white, within floor ROI `(15,140)-(1530,835)`, defining dark paint as `max(R,G,B)<96`. Precision measures candidate dark pixels within Euclidean distance 2 px of source paint; recall measures retained source paint in reverse; F1 is their harmonic mean.

| Existing output | Dark-paint IoU | Precision, 2 px | Recall, 2 px | F1, 2 px |
|---|---:|---:|---:|---:|
| Figma export | 76.27% | 99.85% | 92.59% | 96.09% |
| Prior GPT 6.1 sol whole image | 20.87% | 89.10% | 44.36% | 59.23% |
| Prior Gemini 4 whole image | 25.00% | 93.24% | 52.74% | 67.38% |

This supports closer tracing fidelity; **96.09% is neither navigation nor room-recognition accuracy**. See [metrics.json](assets/2026-10-17-figma-vectorization/metrics.json) for thresholds 80/128. LLM outputs include semantic coloring, markers and simplified procedural lines with different objectives/budgets. Dark-paint comparison cannot establish superior spatial understanding; large correct backgrounds must not conceal critical doorway errors.

The [exact overlay](assets/2026-10-17-figma-vectorization/dark-paint-overlay.png) uses black for overlap, green for source-only and purple for SVG-only, without the 2 px tolerance. Figma's source-paint coverage-distance P95 remains 7 px; tracing is not lossless.

![Detail comparison: input left, Figma right](assets/2026-10-17-figma-vectorization/details.jpg)

Manual inspection finds more complete walls, room outlines, seating orientation and stair placement than previous reconstructions. Tread gaps become curved droplet shapes, fine cyan-shaft diagonals largely vanish, some hollow columns become filled dots, dashed exterior lines disappear and seat lines locally merge. Preserved door arcs do not establish explicit openings or paired spaces. Many irrelevant exterior facade triangles remain; tracing alone does not classify building semantics.

## Navigation readiness

| Use | Verdict | Required work |
|---|---|---|
| Zoomable background with position/route overlay | Experimental candidate | Explicit frame/crop/scale and actual Web/Android rendering |
| Room clicks, names/capacity | Reusable background; interaction data missing | Semantic regions/hit areas, stable IDs and room associations |
| Wall/door/furniture/facade/stair classification | Fail | Source-backed classifications and unresolved cases; black paint is not uniformly wall |
| Room/corridor connectivity and routing | Fail | Openings, paired spaces, traversable surfaces, obstacles/clearance, graph and reviewed route truth |
| Accessibility/cross-floor navigation | Fail | Stair flights/landings/voids, lift evidence, transfers, widths/restrictions |
| Agreement with real building | Unverified | Original evidence, physical scale and manual field checks, not only generated-image agreement |

Converting all 1,321 paths to `spaces` would create rooms from wall ink, antialiasing fragments, furniture and white fills. Thresholding the raster does not solve semantics: door arcs/leaves can block routes, exterior white/transparency can look traversable, and merged ink can close narrow passages. Define interior footprint/portals explicitly, then verify no wall/exterior shortcuts and correct room entry.

Names/capacities erased before tracing cannot be recovered from this SVG. Reuse the [original-photo inventory](assets/2026-10-17-gpt-fullchain/inventory.json): BRAINSTORM / DARK MATTER / THE CAVE, capacities 24 / 24 / 210. Original crop-to-generated-image correspondence still requires landmark registration/semantic review; equal generated/SVG sizes do not prove source-to-generated geometry is preserved.

## Why dedicated tracing can look faster and better

Figma describes Vectorize as an AI raster-to-editable-vector tool with color-count, grayscale-count and black/white-threshold controls, and notes complexity affects processing time. It does not disclose the full engine/model/deployment. Do not assert Potrace, VTracer, an LLM or no AI. [Official description](https://help.figma.com/hc/en-us/articles/38031452710807-Convert-static-images-to-vector-layers).

A reasonable mechanism-level explanation is pixel color segmentation, contour extraction and curve fitting preserving local geometry, while the prior general-model trials reconstructed semantics/walls/presentation within output-token budgets. Figma emitted over ten thousand line/curve commands; the whole-map model contract allowed 24 regions and at most 160 presentation walls. Output budget/task design contributes to detail loss. A limited-color, high-contrast input also favors tracing. These are explanations, **not confirmation of Figma internals**. Open-source [VTracer](https://github.com/visioncortex/vtracer) documents a dedicated clustering/fitting approach without language-model coordinate enumeration.

Previous two-stage vector requests totaled GPT 222.783 s / USD 0.158947 and Gemini 112.083 s / USD 0.226316 before discounts, including semantics and display structure. They are not matched pure-tracing benchmarks. Figma has no timing/credit/retry log here; local render time is not conversion time, and unmeasured account usage is not USD 0. See the [full-chain report](2026-10-17-gpt-fullchain-pilot.md).

## Callable interfaces and alternatives

| Option | Automation surface | Project assessment |
|---|---|---|
| Native Figma Vectorize | No public REST/Plugin invocation found in the inspected scope | Manual tracing/export control, not unattended production dependency |
| Figma REST export | `GET /v1/images/{file_key}?ids={node_id}&format=svg`, with access | Exports existing vectors; exporting an image node can still embed a bitmap |
| Figma Plugin API | `createNodeFromSvg`, `createVector`, `vectorPaths` | Existing vector import/editing, not automatic PNG tracing |
| Vectorizer.AI | `POST https://api.vectorizer.ai/api/v1/vectorize`, image to SVG | Official server API; conditional commercial comparison, no assumed Figma engine/quality equivalence |
| VTracer | MIT local tools/code interfaces | Reproducible local baseline; no per-image supplier API charge but compute/maintenance cost, and not a hosted HTTP service |

References: [REST documentation](https://developers.figma.com/docs/rest-api/), [file export endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/), [REST OpenAPI](https://github.com/figma/rest-api-spec), [Plugin typings](https://github.com/figma/plugin-typings), [VectorPath](https://developers.figma.com/docs/plugins/api/VectorPath/).
The [snapshot index](assets/2026-10-17-figma-vectorization/api-public-surface.json) pins REST commit `7ec6254f6b8b49eb13136349ff4d83bf69bd7e72` and typings commit `d0af2ef5fbb1f9ee9c7fe20641e06f14a34e5105`. Neither contained `vectoriz`; the inspected interface lists yielded no native invocation. This describes public support, not absence of private endpoints or automatic availability through MCP.

Vectorizer.AI uses HTTPS Basic API ID/Secret, offers free watermarked `mode=test`, and lists production conversion at 1 credit/image with default `policy.retention_days=0`. Future keys remain server-side; log HTTP duration, credits, output and settings. [API documentation](https://vectorizer.ai/api/documentation).

**The commercial API uses a monthly credit subscription, not a no-subscription per-call commitment.** Entry pricing at this investigation was USD 9.99/month for 50 credits; a small trial's actual spend cannot be estimated only as USD 0.20/image. No purchase/call occurred. [Pricing](https://vectorizer.ai/pricing). VTracer's [MIT license](https://github.com/visioncortex/vtracer/blob/master/LICENSE) was checked; no installation/test occurred.

## Proposed next experiment and existing contracts

Keep original metadata extraction and image cleanup, then separate:

1. **Display asset:** dedicated tracing, preserving raw output, source hash, tool/settings and coordinates; no model requirement to redraw every seat/wall.
2. **Navigation data:** source-backed room, real-portal, stair/lift and uncertainty extraction by candidate GPT/Gemini/Opus, with pixels/ROI/vector comparison and reviewed associations. Time/cost benefits require measurement.

This proposes responsibility separation within authoring, not new services/APIs. [BuildingSchema v2](../../apps/pipeline/shared/building/schema.js) separates assets/sources, geometry, access, graph and review; [MapSchema](../../apps/pipeline/shared/map.js) has spaces/walls/doors. Test their overlay in isolation. Arbitrary SVG as editable presentation is unaccepted end to end; do not force holes/complex paths into unsupported simple polygons. Submit concrete schema/dependency/architecture changes for member review where needed.

Freeze the same optimized PNG for manual Figma, local VTracer and optional authorized commercial controls. Use marked room boundaries, real doorways and start/destination routes; measure tracing, semantics and correction separately. Trace the original crop as another control to assess cleanup cost/geometric risk. Compare total cost per **accepted** map after multiple real floors, narrow doors and crowded furniture cases, without prematurely selecting a winner.

## Review scope and replay

Shared evidence includes SVG, transparent/white renders, four-way/detail comparisons, paint overlay, structure/visual metrics and API snapshot. The [manifest](assets/2026-10-17-figma-vectorization/manifest.json) records hashes; no paid credentials/raw model responses are included.

Existing local `apps/pipeline/node_modules` and `.venv` with Pillow/NumPy/OpenCV support replay without adding team dependencies. From `apps/pipeline`, rebuild the transparent render, then run analysis from repository root:

```powershell
node --input-type=module -e "import sharp from 'sharp'; const p='../../docs/audits/assets/2026-10-17-figma-vectorization/'; await sharp(p+'figma-vector.svg').png().toFile(p+'rendered.png');"
```

```powershell
.venv/Scripts/python.exe scripts/analyze_floorplan_vectors.py
```

Checked original structure/input hash, native dimensions, threshold sensitivity, montage and three detail regions. No new routing, doorway annotation, Figma automation, mobile-performance test or model inference occurred. Navigation verdicts identify missing evidence, not measured routing outcomes.

## Follow-up: Vector Magic feasibility and permitted-use conditions

Checked 2026-10-17 at the member's request, without uploading IA assets, registering, purchasing, installing or converting. **Tracing exists, but current API onboarding and the required downstream AI/comparison permissions were not established; do not choose it as a ready automated dependency.**

| Dimension | Verified information | Consequence |
|---|---|---|
| Conversion | Web/desktop bitmap-to-SVG/EPS/PDF; desktop batching, segmentation editing and color grouping | Display candidate, without semantic graph or project speed/quality evidence |
| Online service | Manual upload/preview; subscription download and renewal until cancelled | Not a no-subscription idle-cost preference; website subscription does not establish API access |
| Desktop | Windows/Mac; USD 295 one-time, one person/two computers; trial cannot save | Not a shared server license; no supported public headless/CLI contract found; batching is not HTTP |
| Current API | No current developer signup/key/endpoints/limits/pricing found on homepage/FAQ/pricing; `/developer` could not be opened | Supplier confirmation pending; do not assert historical API termination or implement from old snippets |
| Relationship to Vectorizer.AI | Official About lists both under Cedar Lake Ventures, with a separate developer offering for the latter | Shared ownership does not make engines/subscriptions/keys/contracts interchangeable |

Sources: [pricing/features](https://vectormagic.com/pricing), [About](https://vectormagic.com/about), [desktop trial](https://vectormagic.com/desktop/download), [desktop purchase](https://vectormagic.com/desktop/purchase), [FAQ](https://vectormagic.com/support/faq). Localized online prices differ; the [Chinese-language pricing page](https://zh.vectormagic.com/pricing) showed USD 6.49/month while other locales differed. Use actual checkout/supplier quotes; USD 295 is not an API buyout.

### Published conditions affecting the proposed workflow

[Online terms](https://vectormagic.com/policies/terms), effective 2025-10-23, require prior written consent for specified AI/ML uses, including evaluation/benchmarking and third-party provision, and restrict automated access to nonpublic interfaces. Sending SVG/rendered outputs to GPT/Gemini and comparing results cannot be presumed covered by an ordinary subscription. These are integration/procurement conditions identified from text, without a SnapWay-specific supplier interpretation/agreement.

[Desktop EULA](https://vectormagic.com/policies/eula) sections 1, 2(iii), 2(iv) address single-user scope, service-bureau use and comparison/benchmarking. A desktop purchase cannot be presumed a multi-user server substitute or authorization for the planned published comparisons.

**Correction to the earlier Vectorizer.AI candidate:** its [terms](https://vectorizer.ai/policies/terms) also address AI/ML, evaluation and third-party use. An [official API](https://vectorizer.ai/api) establishes technical access, not permission for this downstream workflow. Commercial trials were conditional on appropriate authorization.

### Supplier questions if this route is resumed

Use the [support channel](https://vectormagic.com/support); no message was sent for the member:

1. Are new API customers accepted? Request current docs/test onboarding, concurrency/timeouts/limits/billing and any recommended Vectorizer.AI replacement relationship.
2. Is inference-only downstream processing of owned/authorized floor assets through OpenAI/Google permitted in writing? Are local comparisons/team reports allowed?
3. May a multi-user SnapWay server invoke, store/distribute SVG/renders and persist derived semantic geometry? Request the applicable team/commercial scope.
4. What minimum monthly charges, renewal, failure/retention fees and deletion rules apply? Is desktop headless/batch/server use separately supported/licensed?

Only then test the frozen PNG with separate visual/navigation acceptance. MIT VTracer remains a candidate independent of that vendor contract, subject to the repository's approval rule for a new dependency. This follow-up changed research conclusions only, not runtime architecture, dependencies, APIs or data.


The original `analyze.py` is frozen source evidence recorded by the asset manifest.
Use the maintained [replay tool](../../scripts/analyze_floorplan_vectors.py) for
new runs; it writes only beneath ignored `local/`. The
[integrity check](../../scripts/check_audit_evidence.py) verifies all ten original
artifacts in CI. The maintained replay reproduces the archived metrics without
modifying the original analyzer, images or manifest.
