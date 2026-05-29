# Open in editor (Ctrl+G)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
Ctrl+G opens the current composer content in the user's external `$EDITOR` for
comfortable multi-line editing, then pulls the edited text back into the prompt.

## Claudius today
There is no equivalent for the *composer buffer*. Claudius does have an IDE
deep-link feature (`lib/client/ide.ts`, `buildEditorUrl` / `pathFromToolInput`),
but that opens *files referenced in tool calls* (Edit/Read/Write `file_path`) in
VS Code / Cursor / etc. — a different feature. A browser page cannot shell out to a
local `$EDITOR` against an in-memory textarea. The composer instead offers a
drag-to-resize handle so long prompts get more room
(`components/chat/PromptInput.tsx`, `onResizeHandleDown`).

## Decision
NOT_APPLICABLE. The browser cannot launch `$EDITOR` on the composer buffer, and the
existing `ide.ts` deep-link is for tool-referenced files, not composer content. The
resizable composer already addresses the underlying "I need more room to edit"
need. A pop-out/maximize composer modal could be considered later but doesn't
clearly clear the value bar today.
