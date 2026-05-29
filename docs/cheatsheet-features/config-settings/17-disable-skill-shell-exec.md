# disableSkillShellExec

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
A settings.json key that blocks inline shell execution in skills and custom slash
commands (from user/project/plugin sources) — the embedded commands are replaced
with a placeholder instead of being run. The SDK key is
`disableSkillShellExecution` (the cheat sheet's `disableSkillShellExec` is the
same setting).

## Claudius today
Surfaced as a labeled field. `disableSkillShellExecution` is in the curated SDK
catalog in `app/settings/page.tsx` (the "Skills" section), rendered as a
Default / On / Off select with its verbatim SDK description, writing to the
active scope.

## Decision
ALREADY_EXISTS. Covered by `app/settings/page.tsx` ("Skills" catalog section,
`disableSkillShellExecution`). No new surface needed.
