# File mention with autocomplete (@)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
Typing `@` in the prompt starts a file mention with path autocomplete, inserting a
reference to a workspace file.

## Claudius today
`components/chat/PromptInput.tsx` detects an active `@token` at the caret
(`refreshPickerState`'s `(^|\s)@([^\s@]*)$` match) and opens `AtMentionPicker`
(`components/chat/AtMentionPicker.tsx`), which autocompletes paths relative to the
session `cwd`. Selecting inserts `@<rel> ` via `insertAtMention`. Dropped non-image
files are also converted to `@path` tokens by `ingestFiles`.

## Decision
ALREADY_EXISTS. The `@` mention with path autocomplete is fully implemented in
`components/chat/PromptInput.tsx` and `components/chat/AtMentionPicker.tsx`,
scoped to the session working directory.
