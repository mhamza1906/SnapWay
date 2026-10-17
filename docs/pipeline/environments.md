# Pipeline environments and credentials

This page covers how `apps/pipeline/` chooses its environment file and AI
provider, which variables it reads, and how credentials are kept server-side.
For setup, see the [README](README.md). For cost and limits, see
[operations.md](operations.md).

> [!IMPORTANT]
> **Everyone on the team uses `.env.prod`.** Production runs **Claude
> (Anthropic), `claude-sonnet-5-5` at `high` effort**, for planning and mapping,
> and Gemini image models on Vertex AI for the clean-plan redraws. Start the
> service with `npm run prod`.
>
> **Switching:** set `AI_PROVIDER=vertex` in `.env.prod` to map with Gemini
> (`gemini-4-argon`) instead. The change takes effect on restart; there is no
> automatic fallback between providers.
>
> Keys live only in your local, git-ignored `apps/pipeline/.env.prod` (get the
> Anthropic key from Arjun). Never put a real key in `.env`, any `*.example`
> file, the root `.env.example`, CI secrets, chat or issues. `.env.dev` remains
> Arjun's personal development file.

## How `APP_ENV` selects the file

The npm scripts start the service through `server/start.js`. The launcher
takes `prod` or `dev` as its argument, sets `APP_ENV` from it, and changes into
`apps/pipeline/` before any settings load. It therefore works from any folder
and on Windows. `server/env.js` then runs first in the service and in every CLI
script (`build-from-plan.js`, `run-smart-map.js`, `run-access-agent.js`):

1. It reads `APP_ENV`, which must be `dev` or `prod`. **If `APP_ENV` is unset,
   it defaults to `prod`.** Any other value stops startup with
   `APP_ENV must be dev or prod`.
2. It loads two files through dotenv, in this order: `.env.<APP_ENV>`, then
   the shared `.env`. A missing file is skipped without an error.
3. Precedence, highest first:
   1. variables already set in the process environment (your shell),
   2. `.env.<APP_ENV>`,
   3. `.env`.

   Dotenv never overwrites a value that is already set.

So `APP_ENV=prod` loads `.env.prod` and `.env`, and **never reads `.env.dev`**.
`APP_ENV=dev` loads `.env.dev` and `.env`, and never reads `.env.prod`.

| Command | `APP_ENV` | Files read |
| --- | --- | --- |
| `npm start` or `npm run prod` (`node server/start.js prod`) | `prod` | `.env.prod`, `.env` |
| `npm run dev` (`node server/start.js dev`), Arjun only | `dev` | `.env.dev`, `.env` |
| `npm run build-plan`, `node server/build-from-plan.js`, `node server/run-*.js` | `prod` (default) unless `APP_ENV=dev` is set | `.env.prod`, `.env` |

The npm scripts pass `prod` or `dev` explicitly, so the script name decides the
environment, not an `APP_ENV` set in your shell.

The CLI scripts are plain `node` calls that do not go through the launcher.
They rely on the `prod` default and resolve `.env*` files and `.local/`
relative to the **current working directory**. Run them from `apps/pipeline/`.
From any other folder, the env files are not found and `.local/` is created in
the wrong place.

## The provider rule

`createProvider()` in `server/provider.js` reads `AI_PROVIDER` at service
startup, on every request that needs a model, and on every `/api/health` call:

- In prod (`APP_ENV=prod`), `AI_PROVIDER` must be `anthropic` (the default in
  `.env.prod.example`) or `vertex`. Anything else throws
  `APP_ENV=prod requires AI_PROVIDER=anthropic or vertex.` An unset value
  counts as "other", because the code default is `openai`.
- **The service checks this at startup.** Before it starts listening,
  `server/index.js` builds the provider once and makes no network call. If the
  settings are invalid, it prints
  `Pipeline provider settings are invalid for APP_ENV=<env>: <reason>` and
  exits with status 1. Examples are prod with `AI_PROVIDER=openai`, or an
  invalid `VERTEX_EFFORT` or `ANTHROPIC_EFFORT`. Missing keys are not caught
  here: `/api/health` shows them as `"configured": false`.
- The CLI scripts do not run this startup check. They report the same error
  when they first need a provider.
- In dev, `AI_PROVIDER` can be `vertex`, `anthropic`, `openai` or `gemini`.
  Any other value throws
  `AI_PROVIDER must be vertex, anthropic, openai, or gemini.`

`.env.prod.example` sets `AI_PROVIDER=anthropic` (Claude Sonnet 5.5, high
effort) and keeps the Vertex variables for images and for switching back.
`.env.dev.example` also sets `AI_PROVIDER=anthropic`.

**There is no automatic fallback.** No adapter switches to another provider or
model when a request fails, is refused or is cut off. The request fails, and the
map is unchanged. This follows the architecture plan's rule that the provider,
model or vector space is never switched silently after a failed request.

## Variables

All variables are server-only. The defaults below are the values in the code,
used when a variable is unset.

### Shared (`.env`, both environments)

Copying `.env.example` to `.env` is optional, because these defaults match it.
Never put a key in `.env`: both environments read it.

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | Port the service listens on. It always binds to `127.0.0.1`. The Angular proxy targets `127.0.0.1:5175`, so if you change this, change the proxy too. | `5175` |
| `PIPELINE_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the service, in addition to `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>`, which are always allowed. If set to an empty value, only the service's own origins are allowed. | `http://localhost:4200,http://127.0.0.1:4200` |

### Anthropic (`.env.prod` default, and `.env.dev`)

| Variable | Meaning | Default |
| --- | --- | --- |
| `AI_PROVIDER` | `anthropic` (prod default) or `vertex` | `openai` in code, which prod rejects |
| `ANTHROPIC_API_KEY` | Claude API key, sent as `x-api-key` to `api.anthropic.com` | none |
| `ANTHROPIC_MODEL` | Claude model ID | `claude-sonnet-5-5` |
| `ANTHROPIC_EFFORT` | Effort level: `low`, `medium`, `high`, `xhigh` or `max`. Any other value throws an error. | `high` |

### Vertex AI (`.env.prod`: images always, mapping when `AI_PROVIDER=vertex`)

| Variable | Meaning | Default |
| --- | --- | --- |
| `VERTEX_API_KEY` | Google Cloud API key, sent as the `x-goog-api-key` header | none |
| `VERTEX_PROJECT` | Google Cloud project ID used in the endpoint path | none |
| `VERTEX_LOCATION` | Vertex location. `global` uses `aiplatform.googleapis.com`; any other value uses `<location>-aiplatform.googleapis.com` | `global` |
| `VERTEX_MODEL` | Gemini model ID | `gemini-4-argon` |
| `VERTEX_EFFORT` | Gemini thinking level: `low`, `medium` or `high` (sent as `LOW`, `MEDIUM` or `HIGH`). Any other value throws `VERTEX_EFFORT must be low, medium, or high.` | `high` |

The provider counts as configured only when **both** `VERTEX_API_KEY` and
`VERTEX_PROJECT` are set. Until then, AI requests fail with a message naming
both variables.

These things cannot be verified from the code and have not been checked against
a live project here:

- which Google Cloud API key types and restrictions Vertex accepts this way,
- whether `gemini-4-argon` is available in your project and location.

`VERTEX_IMAGE_MODEL` (default `gemini-nano-banana-2.1`) and `VERTEX_IMAGE_SIZE`
(default `2K`) select the clean-plan image model; see
[clean-plans.md](clean-plans.md).

### Optional dev-only adapters

These adapters remain in `server/provider.js` and are kept on purpose. Prod
rejects them, and neither example file sets them.

| Variable | Meaning | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI Responses API key (`AI_PROVIDER=openai`) | none |
| `OPENAI_MODEL` | OpenAI model ID | `gpt-6.1-sol` |
| `GEMINI_API_KEY` | Gemini Developer API key (`AI_PROVIDER=gemini`); this is not Vertex AI | none |
| `GEMINI_MODEL` | Gemini Developer API model ID | `gemini-3.8-flash` |

The `gemini` adapter is legacy and implements only part of the pipeline. It
supports single-image extraction, and `server/pipelines/design.js` has a
separate Gemini path for design suggestions. It does not implement the
inventory and tool-loop calls that map jobs and doorway checks use.

## Git protection

The root `.gitignore` ignores `.env` and `.env.*`, and re-includes
`!.env.example` and `!.env.*.example`. In `apps/pipeline/`, that means:

- **Ignored:** `.env`, `.env.prod` and `.env.dev`.
- **Tracked:** `.env.example`, `.env.prod.example` and `.env.dev.example`.
  These contain only placeholders. Never put a real value in them.

`apps/pipeline/.gitignore` also ignores the following runtime data:

- `.local/`: caches, map-job state and saved projects,
- `output/`: backups written by `PUT /api/building`,
- `node_modules/`,
- `public/buildings/waterloo-e2.json`: a large regression fixture from the
  original project that you copy in locally.

To check before committing, run this from the repository root. It should print
an ignore rule for each path:

```sh
git check-ignore -v apps/pipeline/.env apps/pipeline/.env.prod apps/pipeline/.env.dev apps/pipeline/.local/ apps/pipeline/output/
```

## Checking which provider is live, at no cost

`GET /api/health` builds the provider from the current settings and returns it.
It makes no network call to the provider and never includes a key:

```sh
curl -s http://127.0.0.1:5175/api/health
```

| Field | Meaning |
| --- | --- |
| `ok` | Always `true` when the request succeeds |
| `environment` | `dev` or `prod` |
| `provider` | `Vertex AI`, `Anthropic`, `OpenAI` or `Gemini` |
| `configured` | Whether the required credential variables are present. This is a presence check only; it does not prove the key, model access or quota. |
| `model` | Exact model ID that requests will use |
| `effort` | Effort level, included only for Vertex AI and Anthropic |

A teammate should see `"environment":"prod"`, `"provider":"Anthropic"`,
`"model":"claude-sonnet-5-5"`, `"effort":"high"`, `"configured":true` and
`imageModel.configured: true` before starting any job. If `"configured"` is
`false`, fill in `ANTHROPIC_API_KEY` (or the Vertex variables when
`AI_PROVIDER=vertex`) in `.env.prod` and restart. If the service exits at
startup with
`Pipeline provider settings are invalid for APP_ENV=prod: APP_ENV=prod requires AI_PROVIDER=anthropic or vertex.`,
fix `AI_PROVIDER` in `.env.prod`. Also check whether your shell exports
`AI_PROVIDER`, because shell variables take precedence over the files.

## Switching between dev and prod

1. Stop the service with Ctrl+C. The files are read only at startup, so edits
   to any `.env*` file also need a restart.
2. Start it again with `npm run prod`, or `npm run dev` for Arjun only.
3. Call `/api/health` and confirm the environment, provider, model and effort.

The npm script name sets `APP_ENV`, overriding any `APP_ENV` in your shell.
Other shell variables still override both files. If you have exported
`AI_PROVIDER` or a `*_MODEL` or `*_EFFORT` variable, unset it, or it will win.
The CLI scripts read `APP_ENV` from the shell (default `prod`), so Arjun runs
them in dev with `APP_ENV=dev node server/build-from-plan.js ...`.

Cached responses are not reused across providers. The response cache keys
include the provider, exact model and effort (see
[operations.md](operations.md)). A switch therefore makes fresh calls instead of
reusing the other provider's results.

## Security notes

- **Keys stay on the server.** Only server modules read the key variables, and
  only to build provider request headers. Upstream error bodies and request
  headers are not passed back to clients.
- **Nothing reaches the browser.** The service has no `VITE_` variables and no
  public configuration endpoint. `/api/health` returns no key values. Never
  copy a provider key into Angular `environment` files, Capacitor
  configuration, the root `.env.example` (Django), CI variables for web builds,
  or anything under `apps/web/`.
- **Loopback only.** The service binds to `127.0.0.1` and has no
  authentication. Do not change the host or tunnel the port.
- **Origin allow-list.** A browser request whose `Origin` header is not in the
  allowed set gets HTTP 403 (`Only local app requests are accepted.`). Requests
  with no `Origin` header, such as curl, CLI scripts and other local
  processes, are accepted. The allow-list protects against other websites in
  your browser, not against other software on your machine. The service sends
  no CORS headers, so Angular must reach it through the dev-server proxy.
- **Untrusted plan content.** Prompts tell the model to treat text inside
  images and tool results as data, never as instructions. Model output is
  validated against strict schemas, and only declared local function tools can
  run.
- **If a key leaks**, revoke it with the provider right away. Removing it from
  a file is not enough once it has been shared or committed.
