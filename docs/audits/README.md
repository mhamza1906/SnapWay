# Development audits

These records compare a named implementation and observed evidence with the
preserved requirements. Each report identifies its source commits, test scope,
confirmed gaps, hypotheses and remaining acceptance work; a passing offline suite
does not replace real-fixture acceptance.

| Date | Scope | Result |
| --- | --- | --- |
| 2026-10-17 | [Map-authoring models, pipeline and IA-1 real-photo trial](2026-10-17-map-authoring-pipeline.md) | IA-1 failed; required raster stage and integrated authoring loop remain incomplete |

The earlier [main smoke check](../main-workflow-smoke-check.md) applies only to
main `71f24ab`. The current [pipeline feature record](../map-authoring-pipeline.md)
links implementation and operating instructions. Screenshots and a selected run
summary are versioned with the report; credentials, response caches and private
development history remain in ignored local directories.
