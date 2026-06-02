# Bridge Environment Resume via --session-id

**Source:** Claude Code TUI — bridge-remote
**Status:** NOT_APPLICABLE

## What it is
`claude remote-control --session-id <id>` reuses an existing backend bridge environment instead of registering a fresh one. The bridge config carries a `reuseEnvironmentId` field whose contract is spelled out in `bridge/types.ts`: "backend treats registration as a reconnect to the existing environment instead of creating a new one. Used by `claude remote-control --session-id` resume. Must be a backend-format ID — client UUIDs are rejected with 400." This lets a user recover an active claude.ai-web session after the local CLI dies or restarts without losing the web URL bound to that environment.

## Claudius today
Not surfaced in Claudius. The natural locus would be the same `external`-tagged platform commands in `lib/shared/slash-commands.ts` — `remote-control` (line 145), `teleport` (line 144), `web-setup` (line 137) — which Claudius already classifies as awareness-only because they delegate to claude.ai's hosted backend rather than the locally-launched SDK. Claudius's own session resume is unrelated: it reconnects an SSE stream to a locally-resident `SessionManager` entry (`lib/server/session-manager.ts`, `lib/server/session.ts`), not to a remote bridge environment.

## Decision
Not applicable. The `reuseEnvironmentId` reconnect contract in `bridge/types.ts` is a claude.ai-hosted bridge concern — it lives in the same `--remote` / `remote-control` / `teleport` family that Claudius already classifies as `external` (see the prior notes at `docs/cheatsheet-features/cli-flags/21-remote-flag.md` and `docs/cheatsheet-features/workflows-tips/26-web-session.md`). Claudius is a local-first wrapper over the Agent SDK with no claude.ai-web environment to reconnect to, so there is no Claudius surface for this resume path. Deferred — would need the hosted bridge transport, not a UI gap.
