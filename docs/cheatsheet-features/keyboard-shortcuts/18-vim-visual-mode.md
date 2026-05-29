# Vim visual mode (v) / visual-line (V)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** NOT_APPLICABLE

## What it is
When the CLI input is in vim mode, `v` enters character-wise visual selection and
`V` enters line-wise visual selection for modal editing of the prompt.

## Claudius today
The composer is a native browser `<textarea>` (`components/chat/PromptInput.tsx`)
with standard pointer + keyboard text selection. There is no modal (normal/insert/
visual) editing layer, and none is configured. The repo's CLI keybindings editor
(`app/[workspaceId]/keybindings/page.tsx`) edits Claude Code's `keybindings.json`
for the *terminal* input, not the browser composer.

## Decision
NOT_APPLICABLE. Modal vim editing is a terminal-input feature with no browser
surface. Bolting a vim emulation onto the textarea would be a large, low-value
undertaking that doesn't match the existing quality bar; native selection already
covers the everyday need.
