# 'ultraplan' prose keyword auto-launches cloud planning session

**Source:** Claude Code TUI — input keyword nudge
**Status:** PARTIAL

## What it is
Including the word `ultraplan` anywhere in a prompt (not just as `/ultraplan <prompt>`) trips a TUI banner announcing that the turn will run as a remote ultraplan session in Claude Code on the web, and emits a `tengu_ultraplan_keyword` telemetry event. The binary strings spell out the contract: `Usage: /ultraplan \<prompt\>, or include "ultraplan" anywhere ... ultraplan-active ... This prompt will launch an ultraplan session in Claude Code on the web ... tengu_ultraplan_keyword`.

## Claudius today
The slash command itself is registered — `lib/shared/slash-commands.ts` line 174 has `{ id: "ultraplan", name: "ultraplan", description: "Browser-based plan, then execute.", category: "skill", handler: "sdk", argsHint: "<prompt>" }` — so users can run `/ultraplan ...` and it dispatches through the SDK skill handler. What is *not* wired is the prose-keyword detector: nothing in `components/chat/PromptInput.tsx` or the banner family (`PlanModeBanner.tsx`, `RecapBanner.tsx`, `GoalBanner.tsx`, etc.) scans the typed prompt for the bare word "ultraplan", shows an "ultraplan-active" / "will launch in Claude Code on the web" banner, or fires a corresponding telemetry event.

## Decision
PARTIAL. The `/ultraplan` slash command is already a first-class skill in `lib/shared/slash-commands.ts`, but the TUI's softer affordance — type the word "ultraplan" mid-sentence and get a banner plus a remote-launch nudge — is not surfaced. Worth adding as a lightweight detector in `components/chat/PromptInput.tsx` that, when the composer text matches `/\bultraplan\b/i` without the leading slash, renders an "ultraplan-active" banner alongside the existing chat banners and routes the submission through the same skill handler the slash command uses.
