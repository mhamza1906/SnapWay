# Frontend design collaboration

Status (2026-10-16): private skills ready; Figma connection and minimum editable-layer
test passed. Product page development has not started.
The [approved architecture](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md)
continues to govern Angular 21.2, shared controls and separate contributor/visitor builds.

## Private development references

Two open-source skills are downloaded under ignored `local/skills/`:
Anthropic `frontend-design` (Apache-2.0) and Angular's `angular-developer`
from v21.2.25 (MIT, matching the installed framework).
The contributor's [usage notes](../local/skills/README.md),
[source/hash inventory](../local/skills/sources.json),
[visual skill](../local/skills/frontend-design/SKILL.md),
[Angular skill and references](../local/skills/angular-developer/SKILL.md),
and [action history](../local/ACTIONS.md) are private local files, unavailable in
other clones until those members prepare their own environment.
This setup adds no application dependency or page implementation.

## Figma workflow and verification

The official Figma extension is installed and authenticated. The account identity
check succeeded, and a new draft was created in the account's sole available team.

[Open the verified test frame](https://www.figma.com/design/vkk6Jfcj6oFwSr3bdRxh0v?node-id=2-2)
in **SnapWay — Connection Smoke Test**.

Setup: open the [official Figma extension](https://chatgpt.com/plugins/plugin_connector_68df038e0ba48191908c8434991bbac2)
using the same ChatGPT account/workspace, select **Install plugin**, and complete
the Figma account connection when prompted. Authentication may be requested on
first use. After installation, open a new conversation in this project and invoke
`@Figma` to continue this document's minimum test; see the
[official plugin installation guide](https://learn.chatgpt.com/docs/plugins).

Figma's [code-to-canvas workflow](https://developers.figma.com/docs/figma-mcp-server/code-to-canvas/)
imports a running local interface as editable design layers. Team members can
review and edit the frames; a subsequent agent task reads the selected frame and
applies the changes to Angular. This is an explicit round trip, not an automatic
bidirectional file watcher. Captured layers are not automatically library components;
native components/variables need the supported
[canvas-writing workflow](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/).

The connection test imported the then-current initialization interface from an ignored copy of
the built web app, served on loopback only. Its source remains
[the workspace](../apps/web/src/app/features/workspace/workspace.ts),
[app shell](../apps/web/src/app/app.html), and
[styles](../apps/web/src/styles.scss), at initialization commit
[`e79a65b`](https://github.com/mhamza1906/SnapWay/commit/e79a65b9f7b7f64227d06bb0a7536566ead31d38).

- Readback: 45 descendants, comprising 20 native text nodes and 25 frames;
  no image-filled nodes or complete-UI raster.
- Editing: changed the button label to `Figma link OK`, confirmed persistence
  in a separate call, and restored `Check connection`.
- Fonts: Segoe UI from the Windows rendering was unavailable to Figma. The test
  draft uses Inter (already first in the app's CSS font stack); all missing-font
  flags cleared. This is a documented typography difference, not pixel parity.
- Visual check: the resulting draft has readable text and no observed clipping
  or overlap. The temporary preview service was stopped after verification.

Private evidence: [read/write results](../local/figma-smoke/result.json),
[verified screenshot](../local/figma-smoke/verified.png), and the
[capture-only HTML copy](../local/figma-smoke/site/index.html).
The capture script exists only in that ignored copy. Shared components, Code
Connect, automatic synchronization, and Figma-to-source implementation were not
part of this minimum test; no application source or dependency was changed.

This document summarizes the setup entries in the private action history; the
links above identify the local files created by this preparation.

The subsequent [interactive frontend prototype](frontend-prototype.md) now owns
product pages, its own Figma file, component synchronization and test evidence.
The connection-test file remains a historical setup check.
