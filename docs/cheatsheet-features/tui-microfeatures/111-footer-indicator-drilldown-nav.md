# Footer-Indicator Drill-Down Keyboard Navigation

**Source:** Claude Code TUI — keybindings-vim-voice
**Status:** MISSING

## What it is
A dedicated `Footer` keybinding context turns the status line into an interactive launcher: Up/Ctrl+P walks up the indicator stack, Down/Ctrl+N walks down, Left/Right cycle within an indicator, Enter fires `footer:openSelected`, and Escape clears the selection. The leaked block in `src/keybindings/defaultBindings.ts` spells the contract out verbatim: `// Footer indicator navigation (tasks, teams, diff, loop)` followed by `context: 'Footer'` mapping `up`/`ctrl+p` → `footer:up`, `down`/`ctrl+n` → `footer:down`, `right` → `footer:next`, `left` → `footer:previous`, `enter` → `footer:openSelected`, `escape` → `footer:clearSelection`.

## Claudius today
Not surfaced in Claudius. The status row in `components/chat/StatusLine.tsx` renders the equivalent indicators (workspace, session, worktree, model deprecation, main-agent, cost, fast mode, context %, compact, clear, notify, share, verbose, mode), but every chip is a stand-alone `<button>` driven by mouse click — there is no Footer focus context, no `footer:*` action namespace, no Up/Down stack walker, and no Left/Right cycle within a chip. The web shortcut registry in `lib/client/shortcuts.ts` covers tab switching and workspace cycling, and `lib/server/keybindings.ts` only reads/writes `~/.claude/keybindings.json` for the CLI; neither defines an interactive footer focus model.

## Decision
MISSING. The leak in `src/keybindings/defaultBindings.ts` describes a stateful selection model (selected indicator index + sub-index, `openSelected` and `clearSelection` actions) that has no counterpart in `components/chat/StatusLine.tsx`. Closing the gap would mean adding a focus-ring state to `StatusLine`, a `useKeydownBinding` listener gated on a "footer focus" mode (perhaps entered via a chord like the existing `useKeydownBinding.ts` pattern), and per-chip `next`/`previous` handlers for the ones that have inner state to cycle (verbose level, permission mode, session picker, notify menu). A lighter alternative — adding a `tabIndex` chain plus `Enter` activation to the existing chips — would match the spirit of the leak (keyboard-drivable footer) without inventing a new selection mode.
