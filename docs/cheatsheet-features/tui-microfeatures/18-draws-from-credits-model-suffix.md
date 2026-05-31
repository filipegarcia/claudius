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
The model picker (`components/panels/widgets/ModelPicker.tsx`) renders a fast
chip on `supportsFastMode` rows and a dedicated Fast-mode toggle (lines 342–346,
473–522), and `components/panels/widgets/SessionCard.tsx` shows a `FastBadge`
when fast mode is on (line 265). The workspace defaults form
(`components/workspaces/WorkspaceForm.tsx` lines 556–567) surfaces 1M context
with a `Sonnet 4/4.5 only; significantly higher cost.` hint — the closest
equivalent today. What's missing is the explicit `Draws from usage credits`
copy on the fast-mode toggle, on the per-model rows in `ModelPicker`, and on
the confirmation surface (`SessionCard` / `StatusLine`) when the user flips
fast mode on or selects a 1M-context model.

## Decision
PARTIAL. Claudius already badges fast / 1M-context capable models and warns
about cost on the workspace 1M toggle, but the precise `Draws from usage
credits` line never reaches the model-switch confirmation or the per-model
rows. Worth adding a small subdued sublabel under the Fast-mode toggle and
1M-context model entries in `components/panels/widgets/ModelPicker.tsx`, and a
matching one-shot toast/sublabel near `components/chat/StatusLine.tsx` when
fast mode flips on, so the credit-burn signal is as loud as in the TUI.
