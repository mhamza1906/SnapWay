# Development audits

These records compare a named implementation and observed evidence with the
preserved requirements. Each report identifies its source commits, test scope,
confirmed gaps, hypotheses and remaining acceptance work; a passing offline suite
does not replace real-fixture acceptance.

| Date | Scope | Result |
| --- | --- | --- |
| 2026-10-17 | [Latest main sync and environment/function/refactoring gaps](2026-10-17-main-sync-gaps.md) | main OAuth/membership and Web/API deployment confirmed; merged branch still has CI compatibility/lint failures, missing IA-4 fixture and unintegrated product/navigation workflows |
| 2026-10-17 | [Figma native vectorization of the GPT-optimized IA raster](2026-10-17-figma-vectorization.md) | Pure SVG preserves substantially more input linework; semantic navigation data remains absent; public Figma vectorize API not found, VTracer / commercial API proposed for comparison |
| 2026-10-17 | [Map-authoring models, pipeline and IA-1 real-photo trial](2026-10-17-map-authoring-pipeline.md) | IA-1 failed; required raster stage and integrated authoring loop remain incomplete |
| 2026-10-17 | [ChatGPT web chain and supplied SVG/HTML artifacts](2026-10-17-chatgpt-web-floorplan.md) | Useful staged visual proof; v2 embeds hotspots/labels in the Logo SVG and fails interaction acceptance; [redesign proposed](../pipeline/redesign-proposal.md) |
| 2026-10-17 | [Gemini 4 vectorization on frozen web raster](2026-10-17-gemini-vector-pilot.md) | Member-reviewed stage closed: whole-image result unsatisfactory, crop benefit requires more tests; GPT 6.1 sol / Opus 5.5 promoted for matched quality/time/cost comparison; no winner selected |
| 2026-10-17 | [Original photo → GPT Image 2.5 → GPT 6.1 sol, crops and matched Gemini comparison](2026-10-17-gpt-fullchain-pilot.md) | Real API chain exercised; metadata preserved in SQLite; image cleanup partial, all vector conditions unaccepted; ten calls, approximately USD 0.752 before Vertex credits |

The earlier [main smoke check](../main-workflow-smoke-check.md) applies only to
main `71f24ab`. The current [pipeline feature record](../map-authoring-pipeline.md)
links implementation and operating instructions. Screenshots and a selected run
summary are versioned with the report; credentials, response caches and private
development history remain in ignored local directories.
