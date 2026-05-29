# Policy fragments (managed-settings.d/)

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** NOT_APPLICABLE

## What it is
Drop-in enterprise policy fragments in a `managed-settings.d/` directory (under a
system managed-settings location). An administrator deploys them; they take the
highest precedence and lock down what users may change (allowed MCP servers,
strict-plugin-only customization, etc.).

## Claudius today
No surface. The Settings catalog in `app/settings/page.tsx` deliberately omits
managed/enterprise-only keys (`allowManaged*Only`, `strictKnownMarketplaces`,
`strictPluginOnlyCustomization`, …) — see the catalog comment around line 660.
Claudius only reads/writes the user/project/local `settings.json` files, never
the system-deployed managed policy.

## Decision
NOT_APPLICABLE. These are admin-deployed, system-directory, read-only-by-design
policy fragments. A normal user running Claudius cannot (and should not) edit
them from the browser, and the existing settings UI intentionally excludes the
managed key family. No appropriate user surface.
