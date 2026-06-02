# autoDreamEnabled Setting + Background Consolidation Runner

**Source:** Claude Code TUI — memory-system
**Status:** ALREADY_EXISTS

## What it is
A settings.json `autoDreamEnabled` toggle that controls a background memory-consolidation agent: "User setting (autoDreamEnabled in settings.json) overrides the GrowthBook default when explicitly set; otherwise falls through to tengu_onyx_plover." (leak: `services/autoDream/autoDream.ts`). After 24h plus 5+ touched sessions, the runner forks a subagent with the consolidation prompt to distill recent sessions into topic files and a refreshed `MEMORY.md`.

## Claudius today
The user-facing override toggle ships in Settings → Memory (`app/settings/page.tsx`, lines 494-501): `label="autoDreamEnabled"`, `checked={Boolean(draft.autoDreamEnabled)}`, with the description "Enable background memory consolidation (auto-dream). When set, overrides the server-side default." The key is in `KNOWN_KEYS` at line 732 so it round-trips through the settings.json editor rather than falling into the generic "Other" bucket. The runner itself is SDK/agent-runtime — Claudius is a wrapper and does not reimplement consolidation in `lib/server/`. The consolidation *output* surface (the rolling `MEMORY.md` index plus per-topic files maintained by `lib/server/auto-memory.ts` and viewable on `/memory` — see also `docs/cheatsheet-features/memory-files/09-auto-loads-memory-md.md` and `10-topic-files-load-on-demand.md`) is already fully browsable, so when the SDK does dream-consolidate, the resulting files appear in the existing UI.

## Decision
ALREADY_EXISTS. The override toggle is surfaced in `app/settings/page.tsx` and registered in `KNOWN_KEYS`, mirroring the `autoMemoryEnabled` pattern already shipped as ALREADY_EXISTS (`docs/cheatsheet-features/config-env/18-claude-code-disable-auto-memory.md`); the runner referenced by the leak (`services/autoDream/autoDream.ts`) is SDK-side and not Claudius's to host. One precision worth noting (does not change the verdict): the toggle writes `true | undefined` (via `b ? true : undefined`), never `false`, so flipping it off deletes the key and falls back to the GrowthBook `tengu_onyx_plover` default rather than forcing a hard off. If a forced-off state were ever wanted, the `update(...)` call would need to send literal `false` instead of `undefined`.
