# Vision boundary

This package is reserved for provider adapters and typed authoring proposals.
The `ai` extra contains the selected Google Gen AI and OpenAI SDKs; `ai-backup`
contains the conditional Anthropic SDK. No credentials or model calls are used
by initialization, tests or application startup.

Model identifiers, request modes, call ceilings and output validation remain
governed by the initial integration plan. Provider access and map fidelity are
unverified. Later adapters must preserve source/base-revision provenance and
call authorized backend services before changing a draft. No automatic
publication or fallback is implemented.
