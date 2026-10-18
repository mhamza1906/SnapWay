# Pipeline environment and credentials

The pipeline and Django now share **one ignored `local/.env`**, using the root
[`.env.example`](../../.env.example). The [team synchronization guide](../environment-sync.md)
is authoritative for schema versions, external private updates, allowed local
exceptions and deployment validation. Provider-specific templates and files have
been retired; the file under `docs/initial/` remains historical evidence.

## Loading and precedence

`server/env.js` resolves `local/.env` relative to its own source location, so the
file does not depend on the working directory. Already exported process variables
win. Production supplies process variables from its protected server environment;
no private file is packaged with the code.

`server/start.js` still changes into `apps/pipeline/` for runtime `.local/` and
`output/` paths. Plain CLI scripts should run from that directory because those
runtime paths remain relative, even though the env file now resolves independently.

Until `python scripts/env_contract.py migrate` has consolidated them, the older
per-app files still fill in values `local/.env` does not set (never overriding
it): `apps/pipeline/.env.<APP_ENV>` and `apps/pipeline/.env` for the pipeline,
`local/env/api.env` for Django development. `scripts/bootstrap.py` refuses to run
while those legacy files exist, so migrate before bootstrapping.

| Command | Provider policy | Private local file |
|---|---|---|
| `npm start` / `npm run prod` | `APP_ENV=prod`: Claude (`AI_PROVIDER=anthropic`) or Vertex | repository `local/.env` |
| `npm run dev` | `APP_ENV=dev`, explicitly selected authorized provider | the same file |
| Plain `node server/...` | process/file `APP_ENV`, default prod | the same file |

The npm launcher argument overrides the file's `APP_ENV`. Dev policy does not
implicitly select Claude: `AI_PROVIDER` must be selected deliberately. Do not
change the shared team's provider/model defaults merely to run a personal test;
use documented process overrides and clear them afterward. Cache keys include
provider/model/effort, so switching can incur fresh paid calls.

## Provider configuration

The root template lists every maintained setting; it contains empty placeholders,
not real credentials. It documents Vertex project/location/model/effort, optional
OpenAI/Gemini/Anthropic adapters, pipeline port/origins and disabled Vectorizer.
The demo policy still requires empty Vectorizer credentials and live=false in the
template. Every vectorizer.ai request (the `/api/vectorization/live` route and the
`scripts/vectorize-plans.js` tool) goes through one counter in
`server/vectorizer.js`: refused when `APP_ENV=prod`, and capped at
`VECTORIZER_MAX_CALLS` (default 50) requests, counted in `.local/vectorizer/usage.json`.

Prod accepts `AI_PROVIDER=anthropic` (Claude Sonnet 5.5 at high effort) or
`AI_PROVIDER=vertex` (Gemini on Vertex AI) and refuses anything else at startup;
dev accepts the existing explicit adapters.
There is no automatic fallback after a provider failure. `APP_ENV` describes this
provider policy, not the Django settings profile or which env file to read.

## Synchronize and verify

From the repository root, run `python scripts/env_contract.py migrate` once for an
old checkout, or `python scripts/env_contract.py init` for a fresh checkout.
Obtain private values through the external team channel, then run
`python scripts/env_contract.py check`. A schema check does not prove keys are
current; compare a freshly distributed reference as described in the sync guide.

Restart the service after updating file values or clearing stale shell overrides.
The free `GET http://127.0.0.1:5175/api/health` reports environment, provider,
configured, model and optional effort; it returns no credentials. Configured=true
checks local presence, not a successful provider request. Use explicit manual
acceptance for any paid inference; setup and CI must not initiate it.

## Security notes

Keys stay in backend processes and never reach Angular, Capacitor or browser
bundles. Never commit a private file or fill a public template with a real value.
The current local service binds to loopback and is unauthenticated; its Origin
allow-list is not authentication, so do not tunnel or expose it. The selected
[deployment plan](../deployment-update-plan.md) requires a narrow authenticated
internal compute boundary before hosting it. A leaked key must be revoked through
its provider; editing the file alone does not revoke it.
