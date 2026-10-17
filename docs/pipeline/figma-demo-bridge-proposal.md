# Personal Figma account as a vectorization relay: hackathon assessment

**Superseded, 2026-10-17:** the member abandoned the relay/automated-plugin approach in favor of the [Vectorizer.AI adapter and prebuilt IA-4 mock](vectorizer-api-demo.md). This is historical assessment, not the execution plan. IA-1 belongs to the separate navigation demo route.

Date: 2026-10-17. Branch: `acceptance/map-authoring-pipeline`; baseline: `60e92cd`.
Status: **assessment only; no relay implemented or run**. Follows the [existing architecture](../initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md). No application API, schema, dependency, Figma file or account setting was changed.

## Recommendation at the time

**Suitable for an operator-assisted demo; a normal plugin cannot be promised as an unattended conversion service.** Supported automation covers import, export of selected vectors and return transfer; no public native Vectorize invocation was found. Personal/noncommercial use does not remove that boundary or automatically authorize crawlers/UI automation. Quality evidence comes from the [earlier SVG audit](../audits/2026-10-17-figma-vectorization.md), not a completed bridge.

| Step | Feasibility | Evidence / unknowns |
|---|---|---|
| Save Image 2.5 PNG | Existing isolated output | Reuse `optimized-floor.png` without another paid generation |
| Import into selected Design file | Supported plugin approach | Create image/image-fill node in an open file after user launch; validate dimensions/network access |
| Plugin invokes native Vectorize | No public entrypoint found | `createVector`, SVG export and a plugin's own button do not establish that capability |
| Operator runs native Vectorize | Possible demo step | Member has supplied successful output; quota, file access and response still require testing |
| Browser/desktop script clicks Vectorize | Possible experiment, unverified | Focus, selection, panel, completion and confirmation states require validation; not an official API |
| Export result as SVG | Supported API | `exportAsync({format:'SVG'})` or `SVG_STRING`; verify the selection is output, not an image-filled input |
| Return/store asset | Designable, not integrated | Existing storage/Asset concepts; local file/SQLite registration must not impersonate shared DB integration |

References: [image import](https://developers.figma.com/docs/plugins/working-with-images/), [node export](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/), [native Vectorize UI](https://help.figma.com/hc/en-us/articles/38031452710807-Convert-static-images-to-vector-layers). The earlier audit pins the public interface investigation; it found no supported arbitrary editor-menu invocation.

The session also exposed connector `upload_assets` / `download_assets`, potential operator/Codex import/export helpers that might avoid writing a whole plugin. Only tool definitions were inspected; no transfer occurred. A chat connection is not a permanent SnapWay backend credential, target access was not re-tested, and neither import/export approach supplies the missing native conversion API.

## Minimum reliable demo sequence

Use one proposed Design file, `SnapWay · Vectorize Demo`, and one `Vectorization Queue` page with per-job frames containing input/output. These names were suggestions; no file/page was created.

1. Register input hash, 1536 x 1024 dimensions, source asset, target/floor and experiment ID; reuse the existing PNG.
2. **Operator opens the file and runs `Import next image`.** Fetch restricted/local bytes, create the job frame and original-size image, attach job metadata, select input, checkpoint and close the plugin.
3. **Operator runs native Vectorize and confirms output.** Retain input for comparison; selection/new-node presence is not completion evidence.
4. **Operator selects output and runs `Submit selected vector`.** Check job/source/output identity and size, export SVG/PNG preview and upload to the restricted receiver without relying on download-folder filenames.
5. Validate/store as `unreviewed`, then load as a candidate. Rooms, openings and navigation graph still need separate annotation/review.

This requires import, operator conversion and submission, not one plugin click. Closing the importer avoids assuming simultaneous plugin/editor action availability; actual UI order needs a smoke test. Plugins operate in the current file context; a fileKey is not authorization for arbitrary remote cross-file writes.

Figma documents user-initiated plugins/actions, one running plugin/action per user and no background daemon model. An active plugin may run until closed, but not process a queue after the file closes. [Plugin introduction](https://developers.figma.com/docs/plugins/), [execution model](https://developers.figma.com/docs/plugins/how-plugins-run/).

## Networking, return transfer and existing storage

Configure precise `networkAccess.allowedDomains`, with `devAllowedDomains` for development. Test browser localhost CORS/local-network permission/HTTPS separately from desktop behavior. A local PNG file chooser can decouple import networking from native conversion. [Network requests](https://developers.figma.com/docs/plugins/making-network-requests/), [manifest permissions](https://developers.figma.com/docs/plugins/manifest/).

The backend does not need the personal Figma password/cookies. Operator owns the Figma session; the plugin gets short-lived job-scoped transfer credentials. Model/DB/R2 secrets stay server-side. App authorization and job ownership remain distinct from Figma identity; reusable plugins must not embed long-lived secrets or arbitrary database-write interfaces.

Separate binary storage from database metadata:

- Save SVG/PNG in private media storage; record key, SHA256, type, byte size, dimensions, provenance and job association.
- Existing [Django Asset](../../apps/api/maps/models.py) provides `kind=svg`, `storage_key`, `source_asset`, `provenance`. A storage key is not a blob, signed URL or credential; storing one asset does not require a production-schema rewrite.
- Retain source hash, job ID, Figma input/output association, plugin/settings versions, time and credits. Conversion may replace nodes; layer names/assumed `pluginData` inheritance are insufficient identity checks.
- Validate scripts/external references/embedded bitmaps, dimensions, limits and hashes before rendering preview. Submission is idempotent; new conversions create versions instead of overwriting accepted assets.
- Experimental [Node BuildingSchema](../../apps/pipeline/shared/building/schema.js) uses data URLs and is not the Django storage contract. Shared DB/R2 writes were not integrated; initially use `local/` files/SQLite. Nullable Asset uploader does not remove required Revision/job actor rules.

Suggested experiment state: `pending -> imported -> waiting_for_operator -> ready_to_export -> stored_unreviewed`. This is a proposed experiment state, not a new application API.

## Unattended UI boundary

A controlled browser/desktop assistant might select input, click Vectorize, wait and confirm in the operator's session, but a normal sandboxed plugin's iframe cannot use a supported host-menu-control API. UI automation is a separate controller, not a new native API capability for the plugin.

Failure modes include login/permission prompts, wrong selection, incomplete output, changed layout/language and exhausted credits. A separate PoC should process one job with observable states/timeouts and final pure-vector validation, allowing operator takeover. Fixed sleeps do not prove completion; repeated timeout clicks can duplicate charges, and old manual output must not be presented as a fresh conversion. Until reliability/allowed use are established, retain operator conversion as the primary demo path.

Figma's [AUP](https://www.figma.com/legal/aup/) conditions programmatic access and restricts account sharing/fee circumvention; no blanket hackathon exception was found. Documented Plugin import/export differs from private-endpoint scraping/replay. This assessment neither declares every personal UI assistance action forbidden nor interprets the member's demo as credential sharing or fee bypass.

## Cost and output use

Native Vectorize consumes account quota: the official table listed **2-5 Figma AI credits/image**, current through 2026-10-15. Personal-account routing does not make conversion free. Existing quota might avoid another purchase, but the account balance/billing was not checked. Measure transfer, native conversion, operator wait, credits and total duration separately rather than comparing directly to two-stage model calls. [Credit documentation](https://help.figma.com/hc/en-us/articles/33459875669015-How-Figma-AI-credits-work).

Section 2 of [Figma AI Terms](https://www.figma.com/legal/ai-terms/) treats inputs/outputs as Customer Content and preserves customer rights between the parties. This differs from the previously investigated tracing vendors' AI-use restrictions but does not give a blanket downstream-use guarantee; input rights, applicable terms and supplier conditions still matter. Figma and standalone Weave quotas/rights are not interchangeable.

## Additional candidate: Weave tooling

The connector exposed a Weave catalog, contracts, uploads, runs and polling. This was a more concrete investigation candidate than private Vectorize scraping, but connector capability does not grant a public backend credential/service license.

One read-only `weave_list_tools(search="vector")` returned **Figma account not linked to Weave**, with `https://app.weavy.ai/settings?section=profile` as the link entrypoint. No image was uploaded, model run or credits consumed. Actual account catalog, input/output format and callable vector tool remained unknown.

The official table lists Weave **Image to vector at 13 credits/run**, distinct from native Vectorize's 2-5. Do not infer equal engines, quality, pure-SVG output or shared standalone/in-Design credits. [Weave in Figma](https://help.figma.com/hc/en-us/articles/40779260614935-Use-Weave-tools-in-Figma).

Any future investigation should first link/read the actual tool contract, confirm SVG/method/pricing/terms, then test the same frozen PNG against the existing Figma vector. Catalog availability alone is not an end-to-end API replacement.

## Minimum acceptance order

1. Identical PNG reaches the intended file; dimensions/hash/job match, without another generation.
2. Operator completes native Vectorize; exporter selects actual output and returns SVG/preview.
3. Receiver persists files, SQLite metadata and measurements; reopening resumes the job and rejects duplicate/wrong-image submissions appropriately.
4. Visual quality meets the manual baseline; original information/review status remain, without navigation-connectivity claims.
5. Only then separately evaluate UI automation/Weave and propose concrete service/storage integration if needed.

This assessment performed documentation/public-capability review and one read-only Weave connection check. It did not implement a plugin, change accounts, create pages or write a database.
