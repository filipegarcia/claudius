# "Draws from usage credits" suffix on Fast / 1M-context models

**Source:** Claude Code TUI — model state
**Status:** PARTIAL

## What it is
When Fast mode is toggled on, or when the user picks a 1M-context Sonnet/Opus
variant, the model-switch confirmation appends a `Draws from usage credits`
suffix so the active choice's higher-rate billing is visible at a glance. The
same suffix also sits under the Opus 4.8 / Sonnet (1M context) / Opus (1M
context) entries in the model picker itself.

> Set model to <model> / and saved as your default for new sessions / for this
> session only / Fast mode ON / Draws from usage credits / Fast mode OFF

## Claudius today
The fast-mode half is wired up. `components/panels/widgets/ModelPicker.tsx`
renders a subdued amber `Draws from usage credits` sublabel under every
`supportsFastMode` row (lines 357–361) and a matching `Draws from usage
credits.` line under the Fast-mode toggle (lines 514–519).
`components/chat/StatusLine.tsx` mirrors the same confirmation as the
`status-line-fast` chip's tooltip (`Fast mode active — draws from usage
credits`, line 285) plus an inline `· credits` cue when fast mode is on (line
291). The 1M-context half is split across surfaces:
`components/workspaces/WorkspaceForm.tsx` (lines 556–567) carries a `Sonnet
4/4.5 only; significantly higher cost.` hint on the 1M toggle, and
`components/chat/LongContextCreditsPanel.tsx` is the post-hoc nudge after a
billing-error trip — but neither places the literal `Draws from usage credits`
copy under the 1M-context model rows in `ModelPicker.tsx` the way the TUI
does.

## Decision
PARTIAL. The fast-mode half now matches the TUI copy exactly on both the
picker and the status line. The remaining gap is the per-row sublabel on
1M-context Sonnet/Opus entries in `components/panels/widgets/ModelPicker.tsx`
— worth adding the same `Draws from usage credits` line under those rows so
the credit-burn signal is symmetric across the two billing modes the TUI
flags.
