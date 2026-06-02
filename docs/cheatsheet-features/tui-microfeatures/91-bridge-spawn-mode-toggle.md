# Bridge Spawn-Mode Toggle (single/worktree/same-dir)

**Source:** Claude Code TUI — bridge-remote
**Status:** NOT_APPLICABLE

## What it is
The Remote Control bridge surfaces three spawn modes for inbound web sessions — `single-session` (one job, exit on done), `worktree` (each new session gets an isolated git worktree), and `same-dir` (all share cwd) — and renders the active mode inline alongside a `Capacity: 1/4` slot count. `bridge/bridgeUI.ts` spells out the hint: `const modeHint = spawnMode === 'worktree' ? 'New sessions will be created in an isolated worktree' : 'New sessions will be created in the current directory'`. Pressing `w` at runtime hot-rotates between `worktree` and `same-dir` without restarting the bridge.

## Claudius today
Not surfaced in Claudius. The natural locus would be the same `external`-tagged platform commands in `lib/shared/slash-commands.ts` — `remote-control` (line 145), `teleport` (line 144), `remote-env` (line 146) — which Claudius already classifies as awareness-only because they delegate to claude.ai's hosted bridge rather than the locally-launched SDK. Claudius does have first-class worktree plumbing (`lib/server/worktrees.ts`, `lib/client/worktree.ts`, `components/overlays/WorktreesOverlay.tsx`, `app/api/worktrees/route.ts`), but those manage the user's own checkouts from the UI — there is no inbound-session dispatcher choosing between `single-session` / `worktree` / `same-dir` because Claudius spawns SDK sessions per workspace click rather than from a remote queue.

## Decision
Not applicable. The spawn-mode toggle and its `w` hotkey in `bridge/bridgeUI.ts` are a claude.ai-hosted bridge concern — it lives in the same `--remote` / `remote-control` / `teleport` family that Claudius already classifies as `external` (see the prior notes at `docs/cheatsheet-features/cli-flags/21-remote-flag.md`, `docs/cheatsheet-features/workflows-tips/26-web-session.md`, and the sibling bridge entry `docs/cheatsheet-features/tui-microfeatures/85-bridge-environment-resume.md`). Claudius is a local-first wrapper over the Agent SDK with no remote spawn queue to triage, so there is no Claudius surface for this toggle. Deferred — would need the hosted bridge transport, not a UI gap.
