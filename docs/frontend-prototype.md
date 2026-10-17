# Frontend prototype

Work in progress on `feature/frontend-prototype`. This is the one shared feature
record for the frontend prototype; personal execution history is in ignored
`local/ACTIONS.md`.

## Approved scope and design

The requester authorized a complete interactive frontend prototype with Local
Storage-backed services, simulated AI/device/navigation responses, staged Figma
synchronization and commits. The backend and its eventual API contracts remain
owned by their existing workstreams. The [architecture baseline](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
still governs feature boundaries and the separate visitor build.

Three journeys drive the implementation: mapping targets and contributions;
manual/AI-assisted map editing and reference collection; review/publication and
visitor wayfinding. Views use a quiet cartographic workspace: warm paper canvas,
white tools, charcoal text, orange actions and blue route overlays. Typography is
a compact sans-serif scale, with map objects and routes providing the distinctive
visual focus. Desktop editing uses a persistent navigation rail and inspector;
visitor guidance uses a responsive map and bottom instruction panel.

```text
Contributor: Overview → Targets → Target detail → Draft editor → Review
                                      ↓              ↓            ↓
                                  Publications   References    Publish
Visitor:     Building/floor → Destination → Capture → Route → Arrival
Operations:  Activity · Demo role · Settings · Data export/reset
```

Prototype models in [prototype.models.ts](../apps/web/src/app/core/prototype.models.ts)
are internal view models, not a backend schema proposal. No additional runtime
dependency is planned. Detailed usage, replacement seams, coverage and evidence
will be completed as each workflow lands.
