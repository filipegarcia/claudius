# DISABLE_PROMPT_CACHING warning

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** IMPLEMENTED
**Implemented:** `app/api/doctor/route.ts` pushes a `warn` "Prompt caching" check (id `prompt-caching`) when `process.env.DISABLE_PROMPT_CACHING` is set; renders automatically in `app/doctor/page.tsx`.

## What it is
A startup warning Claude Code prints when `DISABLE_PROMPT_CACHING` is set,
because turning off prompt caching meaningfully increases token cost and latency.
It is a heads-up that an expensive env var is in effect.

## Claudius today
Not surfaced. The CLI prints this to the terminal at startup, which has no
browser equivalent. However, Claudius already has the right home for it: the
Doctor page (`app/doctor/page.tsx`) renders a list of health "checks"
(`{ id, label, status: ok|warn|fail, detail }`), and `app/api/doctor/route.ts`
already inspects environment variables (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, …) to emit ok/warn checks.

## Decision
UI_WORTHY (low). Add one check to `app/api/doctor/route.ts`: if
`process.env.DISABLE_PROMPT_CACHING` is truthy, push a `warn` check ("Prompt
caching disabled — higher cost/latency"). It then renders for free in the Doctor
page checks list. Tiny, self-contained, matches the existing env-var-check
pattern. Low priority — purely informational.
