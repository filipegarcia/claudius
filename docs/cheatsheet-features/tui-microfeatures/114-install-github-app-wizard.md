# /install-github-app — GitHub Actions Setup Wizard

**Source:** Claude Code TUI — commands
**Status:** MISSING

## What it is
`/install-github-app` opens a multi-step wizard that probes the local `gh` CLI / auth state, picks a repo, installs the Claude GitHub App, manages the `ANTHROPIC_API_KEY` (or OAuth) secret, then writes the `claude` + `claude-review` workflow files — handling existing-workflow collisions and warning steps along the way. The binary keeps the step machine in `commands/install-github-app/install-github-app.tsx` and announces the entry with `logEvent('tengu_install_github_app_started', {});`, so the wizard is a first-class command in the TUI rather than a shell-out.

## Claudius today
Not surfaced in Claudius. The slash-command catalog at `lib/shared/slash-commands.ts:134` registers `{ id: "install-github-app", ..., handler: "external" }`, so the entry shows up in `components/chat/SlashCommandPicker.tsx` with the muted "external" pill (line 26) — but nothing else is wired. Selecting it forwards the literal text to the SDK; there is no Claudius UI that calls `gh`, installs the app, or writes workflow files. The natural location for an in-app equivalent would be a `/settings` sub-page (e.g. a "GitHub Actions" panel beside the "Link target" / spell-check settings in `app/settings/page.tsx`) backed by a `lib/server/github-app.ts` helper that shells out via the same pattern `scripts/sdk-update/orchestrate.ts` already uses to drive `gh` (auth check around line 250, repo discovery around line 1138).

## Decision
MISSING. Only the slash-command label is registered (`lib/shared/slash-commands.ts:134`); the actual wizard from `commands/install-github-app/install-github-app.tsx` is not ported. A follow-up could mirror the TUI's step machine as a multi-step modal under `app/settings/` — gh-auth probe, repo picker, App install link, secret upsert (`ANTHROPIC_API_KEY` vs OAuth), workflow-file writer with collision detection — reusing the `gh` shell-out conventions already established in `scripts/sdk-update/orchestrate.ts` and gated on a `tengu_install_github_app_started`-style telemetry event for parity.
