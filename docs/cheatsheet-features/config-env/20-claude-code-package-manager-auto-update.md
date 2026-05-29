# CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Controls whether Claude Code auto-upgrades itself via the host package manager (npm/brew/etc.).

## Claudius today
Claudius is not installed as a Claude Code npm package and does not use a package-manager auto-upgrade path. Its self-update is a git-checkout pull + rebuild (`lib/server/updater/*`, surfaced at `/updater` and Settings → Self-update). The npm/brew auto-update behavior this env var governs simply does not exist in the Claudius runtime.

## Decision
NOT_APPLICABLE. This flag targets Claude Code's package-manager self-upgrade, which Claudius does not perform — Claudius updates via git checkout (already controllable at `/updater`). There is no package-manager update path here to gate, so no browser surface applies.
