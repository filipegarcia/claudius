# `.githooks/`

Git hooks for Claudius. Installed by the `prepare` script in `package.json`
which sets `git config core.hooksPath .githooks`. They run for every
contributor by default — no opt-in step.

## Files

| File              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `_runtime.sh`     | PATH recovery + runner selection. Sourced by every hook. **Not a hook.** |
| `pre-commit`      | Secret scan (gitleaks) + lint + related unit tests for staged JS/TS.    |
| `pre-push`        | Whole-tree `tsc --noEmit` + `eslint`.                                    |

## Security scanning

Two layers, split by speed:

- **Secrets — `pre-commit`.** If [`gitleaks`](https://github.com/gitleaks/gitleaks)
  is installed it scans the staged diff for committed credentials (the same
  class GitHub's default secret scanning catches), in milliseconds. If gitleaks
  isn't installed the hook prints a one-line install hint and continues — it's
  **not** mandatory, so contributors aren't forced to install it, but
  `brew install gitleaks` gets you the full gate. Bypass a false positive with
  an inline `# gitleaks:allow` comment or a `.gitleaksignore` entry.

- **CodeQL — on demand, `bun run security`.** Runs GitHub's actual CodeQL
  engine + query suite locally (`scripts/codeql-local.mjs`), giving true parity
  with the Security-tab alerts the `codeql.yml` workflow produces. It takes a
  few minutes (and a one-time ~500 MB CLI download) but needs **no build** —
  JS/TS analysis is source-based. It is deliberately **not** in a hook:
  minutes-per-push would just get bypassed, and CI already runs it on every PR.
  Run it before opening a PR if you want the alerts before the scan does.

## Adding a new hook

**Every hook MUST start with**:

```sh
#!/bin/sh
set -eu

. "$(dirname "$0")/_runtime.sh"

# … the rest of your hook, using $RUN / $RUN_DIRECT …
```

`_runtime.sh` exists because git GUIs (Claudius's own commit panel, Tower,
Fork, GitHub Desktop) launch hooks with a stripped PATH that doesn't
include `~/.bun/bin` or `/opt/homebrew/bin`. Without it, `command -v bun`
returns false, the hook falls through to `npm`, and on machines without
npm installed (everyone on this project) `xargs` dies with the cryptic
`npm: No such file or directory`. Sourcing the runtime walks the standard
bun + Node-version-manager install locations and prepends the first hit
to `PATH`, then sets:

* `$RUN`        — `bun run` (or `npm run` as fallback)
* `$RUN_DIRECT` — `bunx` (or `npx --no-install` as fallback)

If neither bun nor npx is reachable, the runtime exits with a clear error
pointing at https://bun.com — don't try to defeat that, install bun.

## Backstop

`tests/unit/githooks.test.ts` asserts every file in this directory (except
the runtime + this README) sources `_runtime.sh`. Forgetting the source
line trips the unit suite, not a contributor's GUI weeks later.

## Skipping (don't)

`CLAUDIUS_SKIP_PREPUSH=1` bypasses the pre-push gate for a single push.
There is no skip for pre-commit by design — the lint + related-tests run
takes seconds and catches the class of error CI would catch ten minutes
later. If you genuinely need to commit through a broken hook, use
`git commit --no-verify`, but the failing hook is almost always telling
you something real.
