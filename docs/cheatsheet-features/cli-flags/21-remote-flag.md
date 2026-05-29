# --remote

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** NOT_APPLICABLE

## What it is
`--remote` runs the session as a hosted web session on claude.ai instead of locally.

## Claudius today
Claudius is itself a local web UI over the Agent SDK; it does not proxy to or embed claude.ai-hosted sessions. There is no surface that hands a session off to claude.ai, and the existing remote-agent feature (`app/[workspaceId]/schedule/`) is Claudius's own cron/routine runner, not claude.ai hosting.

## Decision
Not applicable. `--remote` delegates execution to Anthropic's hosted claude.ai runtime — a different execution backend, not a UI control. Surfacing it would mean re-hosting sessions off the local machine, which is outside Claudius's local-first architecture and would require deep account/transport plumbing that the SDK does not expose to this web layer. No browser surface; if ever pursued it is **deferred — needs backend** and a product decision, not a triage UI gap.
