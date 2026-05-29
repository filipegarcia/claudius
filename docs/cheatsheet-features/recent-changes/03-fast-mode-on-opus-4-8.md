# Fast mode on Opus 4.8

**Source:** Claude Code cheat sheet — Recent Changes
**Status:** IMPLEMENTED

**Implemented:** "Fast mode" toggle mirrors the ultracode pattern — `app/api/sessions/[id]/fast/route.ts` POSTs `{ enabled }` to `session.setFast()` → `query.applyFlagSettings({ fastMode })` (`lib/server/session.ts`). Plumbed through `useSession` (`lib/client/use-session.ts` / `lib/client/types.ts`: `fastMode` + `setFast`), `BackgroundTasksPanel.tsx` → `SessionCard.tsx` (amber "fast" badge), and surfaced as an amber Zap toggle in `ModelPicker.tsx`, gated on `activeModel.supportsFastMode`. Wired in `app/[workspaceId]/page.tsx`.

## What it is
Toggle "fast mode" on Opus 4.8 — runs the model at accelerated rates
(cheat-sheet bindings: Option+O / `/fast`).

## Claudius today
Partial. `/fast` is a registered slash command in
`lib/shared/slash-commands.ts` (id `fast`, handler `"sdk"`), so a user can type
`/fast on|off` and it forwards to the SDK. `components/panels/widgets/ModelPicker.tsx`
already reads `supportsFastMode` from the SDK's `ModelInfo` and badges
fast-capable models with a "fast" chip. But there is no dedicated toggle
control for fast mode the way there is for ultracode/effort — no
`onToggleFast` prop, no `/api/sessions/[id]/fast` route, and no
`session.setFast()`. Today fast mode is reachable only as a forwarded slash
command, with no persistent on/off state shown in the rail.

## Decision
UI_WORTHY. Add a "Fast mode" toggle in `ModelPicker.tsx` directly parallel to
the existing "Dynamic Workflows" (ultracode) toggle — gate it on
`activeModel?.supportsFastMode`, render the same switch UI, and surface an
on/off badge on the SessionCard. Backend is a thin mirror of the ultracode
route: a new `app/api/sessions/[id]/fast/route.ts` calling
`session.setFast(enabled)` → `query.applyFlagSettings({ fastMode })` (same
pattern as `setUltracode`/`setEffort`). Plumb `fastMode` + `onChangeFast`
through `BackgroundTasksPanel` → `SessionCard` like the ultracode props. Small
effort — it reuses the exact toggle + API + plumbing pattern that ultracode and
effort already established; the only unknown is the precise SDK flag name
(`fastMode` vs. similar), which should be confirmed against the SDK's
`applyFlagSettings` signature.
