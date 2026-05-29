# Clear input buffer (Ctrl+U)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
Ctrl+U is the readline "kill to start of line" — it clears the input buffer from
the cursor back to the beginning of the line.

## Claudius today
The composer is a native `<textarea>` (`components/chat/PromptInput.tsx`). Native
text-editing chords (select-all + delete, Cmd+Backspace, etc.) are provided by the
browser and OS; Claudius does not — and should not — reimplement readline line-kill
semantics on top of a textarea.

## Decision
NOT_APPLICABLE. Line-buffer editing is a terminal/readline control. The browser
textarea already gives the user platform-native ways to clear input, so there is no
distinct surface to build.
