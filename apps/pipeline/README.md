# Map-authoring compute service

Use the root [setup](../../README.md) and [single-env synchronization guide](../../docs/environment-sync.md).
The only local private configuration is `local/.env`, using the root
[`.env.example`](../../.env.example). Do not create a pipeline `.env` or provider-specific files.

For an old checkout, run `python scripts/env_contract.py migrate` from the root,
then `python scripts/env_contract.py check`. Obtain private updates through the
team's external channel; never copy credentials into the public template.

From this directory run `npm ci`, then `npm run prod` for the team's Vertex
provider. Settings are read at startup; restart after changing them. `npm run dev`
uses the same file with a development provider policy, requiring an explicit
authorized provider selection. The service remains local and unauthenticated.

See [provider details](../../docs/pipeline/environments.md),
[workflow/API docs](../../docs/pipeline/README.md) and the selected
[private-service deployment plan](../../docs/deployment-update-plan.md).
