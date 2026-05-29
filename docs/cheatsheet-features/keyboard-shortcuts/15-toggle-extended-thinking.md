# Toggle extended thinking (Option+T)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Option+T toggles extended thinking — the model's reasoning depth before it answers.

## Claudius today
Thinking depth maps to the reasoning-effort control. `ModelPicker`
(`components/panels/widgets/ModelPicker.tsx`) renders an "Effort" section with an
"Auto" (adaptive thinking) chip plus Low/Medium/High/Very High/Max chips, gated on
the model's `supportsEffort` / `supportsAdaptiveThinking` flags. Selecting calls
`session.setEffort` (`app/api/sessions/[id]/effort` plumbing). The current level
shows as the `EffortPill` on `SessionCard`. Rendered thinking blocks appear in the
transcript via `components/chat/ThinkingBlock.tsx`.

## Decision
ALREADY_EXISTS. Extended thinking is exposed as reasoning effort, including the
adaptive "Auto" chip, in `components/panels/widgets/ModelPicker.tsx` with the
`EffortPill` indicator on `SessionCard`. This is a richer surface than a single
on/off toggle, and thinking output is rendered in-chat by `ThinkingBlock`.
