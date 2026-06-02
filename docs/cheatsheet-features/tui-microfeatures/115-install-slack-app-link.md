# /install-slack-app — Open Slack Marketplace Listing

**Source:** Claude Code TUI — commands
**Status:** MISSING

## What it is
`/install-slack-app` opens the Claude Slack app's marketplace listing in the user's default browser and bumps a saved counter so the upsell can suppress itself after the first click. The binary keeps the handler in `commands/install-slack-app/install-slack-app.ts`, with `const SLACK_APP_URL = 'https://slack.com/marketplace/A08SF47R6P4-claude'`, a `saveGlobalConfig(current => ({ ...current, slackAppInstallCount: (current.slackAppInstallCount ?? 0) + 1, }))` increment, and a final `const success = await openBrowser(SLACK_APP_URL)` — so the entire command is a config-bump plus a shell-out to the OS browser.

## Claudius today
Not surfaced in Claudius. The slash-command catalog at `lib/shared/slash-commands.ts:135` registers `{ id: "install-slack-app", ..., handler: "external" }`, so the entry appears in the slash picker but the dispatcher in `app/[workspaceId]/page.tsx:1050` short-circuits every `handler === "external"` command with a `/${cmd.name} is terminal/hosted only` toast — no browser open, no counter. There is no Claudius equivalent of `slackAppInstallCount` in `lib/server/settings.ts` or the global config, and no "Install Slack app" affordance anywhere in `app/settings/page.tsx`. The natural location for an in-app version is a one-liner action on the `/settings` page (or a small banner next to the existing "Link target" / desktop-app row) that opens the marketplace URL via the same `openExternalUrl` path used for other outbound links, optionally backed by a `slackAppInstallCount`-style counter in `lib/server/settings.ts` so the upsell can dismiss itself after the first click.

## Decision
MISSING. Only the slash-command label is registered (`lib/shared/slash-commands.ts:135`); the actual handler from `commands/install-slack-app/install-slack-app.ts` is not ported, and selecting `/install-slack-app` in Claudius just produces the generic external-command toast. A follow-up could wire a tiny "Install Slack app" row under `/settings` that opens `https://slack.com/marketplace/A08SF47R6P4-claude` and increments a `slackAppInstallCount` saved through `lib/server/settings.ts`, so the upsell mirrors the TUI's once-and-done behavior without needing the wizard scaffolding that `/install-github-app` requires.
