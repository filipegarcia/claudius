# /output-style command deprecated — redirects to /config

**Source:** Claude Code TUI — plugins-output-styles
**Status:** UNVERIFIED

## What it is
The legacy `/output-style` slash command is now a deprecation stub. The leak in `commands/output-style/output-style.tsx` carries the message `"/output-style has been deprecated. Use /config to change your output style, or set it in your settings file. Changes take effect on the next session."` — picking an output style now lives inside the `/config` UI rather than as its own interactive command, and the change only takes effect on the next session. `binary_grep_count: 0` means the string is not in the shipped binary's plain strings, so this is leak-only (could not confirm in stripped output).

## Claudius today
Not surfaced in Claudius. The slash registry in `lib/shared/slash-commands.ts` has no `output-style` entry — neither as a live command nor as a deprecation stub that prints a redirect to `/config`. The substitute destination already exists: `lib/shared/slash-commands.ts` line 112 declares `{ id: "settings", name: "settings", aliases: ["config"], description: "Open the settings editor.", category: "ui", handler: "native" }`, and `app/settings/page.tsx` line 449 renders an `<Field label="Output style">` `<select>` over `OUTPUT_STYLES = ["default", "explanatory", "concise", "developer"]` (line 31) bound to `draft.outputStyle` (line 452), with the persisted key `"outputStyle"` listed on line 726. So a user who types `/output-style` today gets no feedback at all — the command falls through the picker without matching and is forwarded to the SDK; there is no native stub that nudges them toward `/config` the way the TUI does.

## Decision
UNVERIFIED — leak-only, but trivially actionable on the Claudius side. The redirect target is already in place (`/config` opens `app/settings/page.tsx` with the Output style field), so the minimum gap-closer is a `handler: "native"` entry in `lib/shared/slash-commands.ts` for `output-style` whose native handler prints the exact deprecation line as a system message and (optionally) routes the user to `/settings` like `/config` does. Worth doing only once the broader output-styles surface lands (see `134-output-styles-keep-coding-instructions.md` and `135-output-styles-user-project-dirs.md`) — until output-style markdown files are actually loaded, the four hard-coded names in `OUTPUT_STYLES` make the deprecation stub mostly a cosmetic affordance.
