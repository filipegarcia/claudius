# Newline insertion (Backslash+Enter)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
A composer chord to insert a literal newline instead of submitting — in the CLI,
`\` followed by Enter (Shift+Enter on some terminals).

## Claudius today
In `components/chat/PromptInput.tsx`, plain Enter submits and Shift+Enter inserts a
newline (`onKeyDown`: outside a list, `if (e.shiftKey) return;` lets the browser
insert the newline; otherwise it `preventDefault`s and calls `submit()`). The
placeholder copy advertises it ("Shift+Enter for newline"). The composer also does
list-aware Enter continuation (markdown bullets/numbered lists).

## Decision
ALREADY_EXISTS. Newline-without-submit is Shift+Enter in
`components/chat/PromptInput.tsx`, the standard web-composer convention. The
specific `\`+Enter terminal chord isn't replicated because Shift+Enter is the
idiomatic browser equivalent and is already documented in the placeholder.
