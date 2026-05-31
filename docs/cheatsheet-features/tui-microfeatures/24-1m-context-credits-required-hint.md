# 1M-context credit-required hint with /model fallback path

**Source:** Claude Code TUI — error & recovery
**Status:** MISSING

## What it is
When the user asks for a 1M-context model without usage credits, the TUI prints `Extra usage is required for long context` and offers two concrete remediation routes: `run /usage-credits to turn them on, or /model to switch to standard context`. The hint pairs a precise diagnosis with both a billing-side fix (`/usage-credits`) and a same-session fallback (`/model`) so the user is never stuck.

## Claudius today
Not surfaced in Claudius. The 1M-context beta is exposed as an opt-in workspace default in `components/workspaces/WorkspaceForm.tsx` (`enable1mContext`) and applied in `lib/server/session.ts` (line 740, `betas: ["context-1m-2025-08-07"]`), but there is no error-recovery banner that detects the credits-required failure and offers the dual `/usage-credits` + `/model` remediation. The adjacent overage-disabled copy in `components/chat/SystemPill.tsx` (`OVERAGE_DISABLED_COPY`) covers rate-limit extra-usage states but not the long-context-specific hint. A natural home would be a banner in `components/chat/` that listens for the SDK's long-context-credits error and links to the 1M toggle in `WorkspaceForm.tsx` plus the model picker in `components/panels/widgets/ModelPicker.tsx`.

## Decision
MISSING. The 1M-context toggle and model picker both exist, but the credits-required diagnosis and its two-route remediation hint do not. Worth adding as a chat-level banner that fires when the SDK reports the long-context credits error, with one button to open the model picker (mirroring `/model` fallback) and one link to claude.ai/settings/usage (mirroring `/usage-credits`).
