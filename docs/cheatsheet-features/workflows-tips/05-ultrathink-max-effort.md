# ultrathink — max effort for turn

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Typing "ultrathink" requests maximum reasoning effort for a single turn — a one-shot bump to the highest thinking budget the model supports.

## Claudius today
The browser equivalent is the effort selector in `components/panels/widgets/ModelPicker.tsx`, which renders chips for every level the active model advertises (`low`/`medium`/`high`/`xhigh`/`max` plus adaptive `Auto`). Selecting **Max** posts to `app/api/sessions/[id]/effort/route.ts` and, per the picker's own note, "Applies on the next turn." The xhigh-capable "Dynamic Workflows" (ultracode) toggle lives in the same picker, backed by `app/api/sessions/[id]/ultracode/route.ts`.

## Decision
Already covered. There is no separate "ultrathink" keyword in the slash registry; its browser equivalent is choosing the Max effort chip (per-turn) in `ModelPicker`. That control already exists and applies on the next turn.
