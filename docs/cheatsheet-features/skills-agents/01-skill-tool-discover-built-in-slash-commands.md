# Skill tool — discover built-in slash commands

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
The Skill tool lets Claude discover and invoke installed skills (which surface as slash commands). In the CLI this is how built-in and bundled slash commands become visible and runnable.

## Claudius today
Slash-command discovery is fully surfaced. The composer's `components/chat/SlashCommandPicker.tsx` merges the curated registry (`lib/shared/slash-commands.ts`) with what the live SDK reports via `supportedCommands()` (fetched through `app/api/sessions/[id]/commands/route.ts` and `lib/client/useSdkCommands.ts`). Skill-provided commands are tagged with a `skill` source/category. `components/overlays/SkillsOverlay.tsx` also lists every skill, agent, and slash command the active session reports.

## Decision
ALREADY_EXISTS. Covered by the slash-command picker (`components/chat/SlashCommandPicker.tsx` + `lib/shared/slash-commands.ts`), the SDK command bridge (`app/api/sessions/[id]/commands/route.ts`), and the awareness overlay (`components/overlays/SkillsOverlay.tsx`). Discovery happens both statically (registry) and live (SDK `supportedCommands()`).
