# /code-review with optional fix flag

**Source:** Claude Code cheat sheet — Skills & Agents
**Status:** ALREADY_EXISTS

## What it is
A skill that reviews the current diff for bugs and cleanups; the optional `--fix` flag applies the findings to the working tree.

## Claudius today
`/code-review` is a skill, distinct from the registry's `/review` (PR review). It surfaces dynamically: the picker's `mergeSuggestions` (`lib/shared/slash-commands.ts`) folds in whatever the SDK reports via `supportedCommands()` (fetched in `app/api/sessions/[id]/commands/route.ts` / `lib/client/useSdkCommands.ts`), so installed skill commands like `/code-review` appear with their SDK-provided description/argument hint and `handler: "sdk"`. The picker forwards the command and any flags (`--fix`, `--comment`) as free-text arguments straight to the SDK. Sibling review skills (`simplify`, `security-review`, `ultrareview`) are additionally hard-coded in the static registry.

## Decision
ALREADY_EXISTS. Surfaced via the SDK dynamic-merge path in `components/chat/SlashCommandPicker.tsx` (`mergeSuggestions` over `supportedCommands()`), backed by `app/api/sessions/[id]/commands/route.ts`. The `--fix`/`--comment` flags ride through as arguments — the skill owns its own behavior, so no separate UI is warranted.
