# CI documentation exclusions

Owner: Eric. Updated October 16, 2026. Commit: pending.

GitHub Actions ignores documentation when choosing backend, PostgreSQL and web
jobs. This follows the [architecture's affected-target strategy](initial/Indoor_Navigation_Architecture_and_Dependencies_EN.md#selected-fast-cicd-strategy).

- All content under `docs/`, `doc/` or `documentation/` directories is excluded.
- Markdown/MDX, reStructuredText, AsciiDoc, PDF, Word, OpenDocument and Rich Text
  files are excluded by extension anywhere in the repository.
- Conventional README, LICENSE/LICENCE, NOTICE, COPYING, AUTHORS, CHANGELOG,
  CHANGES, HISTORY and CONTRIBUTING files are excluded, including `.txt` versions.
- Plain-text runtime/configuration inputs, such as `requirements.txt`, remain
  code inputs. SQL/JSON contracts and workflow/script/infrastructure changes still trigger
  their consuming jobs. Mixed documentation/code changes run the relevant jobs.
- Git diffs disable rename detection so moving code into a documentation path
  still checks the removed code path.

The workflow no longer invokes `scripts/check_docs.py`. Frontend formatting also
ignores documentation, including during mixed code/document changes. Local
bootstrap and `scripts/dev.py check` retain their existing document inventory
check; those commands are separate from GitHub Actions.

The lightweight change-classification and aggregate `required` jobs still run
for documentation-only changes, with component jobs skipped. This keeps a result
available for branch protection: [GitHub documents that workflow-level path skips can leave required checks pending](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#using-filters-to-target-specific-paths-for-pull-request-or-push-events).
Manual runs retain the existing full tracked-input classification.
Main pushes compare against the most recent successful main push run, rather
than only the immediately preceding commit, so failed/canceled changes remain
in the next check set. If that baseline cannot be retrieved, all inputs run.

Native production packaging and deployment are documented separately in
[Vultr deployment](deployment.md). Production promotion is disabled until the
server is prepared and its explicit Actions variable is enabled. Main runs are
not automatically canceled during a possible migration or promotion.

Files: [workflow](../.github/workflows/ci.yml),
[change classifier](../scripts/ci_changes.py),
[frontend formatter exclusions](../apps/web/.prettierignore),
[development guide](development.md), [feature record](ci.md).
Personal action history remains in ignored `local/ACTIONS.md`.

The [acceptance merge-readiness repairs](audits/2026-10-17-merge-readiness.md)
resolve the three-output classifier integration and source-format failures.
Backend CI now validates the public env template and the immutable Figma audit
manifest; its maintained replay tool remains linted while the exact archived
source is hash-verified. No real provider calls enter the shared CI path.

Validation: 14 local documentation/mixed/code classification cases passed;
GitHub output, rename handling, workflow YAML/job conditions, Ruff lint/format
and diff whitespace checks passed. Remote CI has not been run by this change.
