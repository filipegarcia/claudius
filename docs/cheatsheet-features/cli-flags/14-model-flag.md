# --model

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--model <id>` selects the model for the session.

## Claudius today
Model selection exists at three levels: per-session via the chat ModelPicker (`components/panels/widgets/ModelPicker.tsx`) backed by `app/api/sessions/[id]/model/route.ts` (and `session.setModel`); as a workspace default in `components/workspaces/WorkspaceForm.tsx`; and as a global settings.json value in the Settings page (`app/settings/page.tsx`, "Model & UI" section).

## Decision
Already covered comprehensively. The chat-level ModelPicker is the live equivalent of `--model`, and workspace defaults + settings.json cover the persistent forms. No new UI needed.
