# 1M context for Opus

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Enable the large (1M-token) context window for eligible models/plans, trading higher cost for a far larger window.

## Claudius today
`components/workspaces/WorkspaceForm.tsx` exposes a "1M context window" checkbox (state `default1m`, persisted as a workspace default). The session creation path consumes that default. Note the in-form sublabel currently reads "Sonnet 4/4.5 only; significantly higher cost" — a discrepancy with the cheat-sheet's "for Opus" framing, but the toggle itself is the 1M-context surface.

## Decision
Already covered. The 1M-context toggle exists as a workspace default in `WorkspaceForm.tsx`. The only follow-up is a copy discrepancy: the form says Sonnet-only while the cheat sheet says Opus — worth reconciling the sublabel against current model eligibility, but no new UI surface is needed.
