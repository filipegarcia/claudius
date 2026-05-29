# Cancel input/generation (Ctrl+C)

**Source:** Claude Code cheat sheet — Keyboard Shortcuts (General / Mode / Input / Prefixes)
**Status:** ALREADY_EXISTS

## What it is
In the terminal, Ctrl+C cancels an in-flight generation (and on an empty prompt, signals quit). It is the primary "stop what you're doing" control.

## Claudius today
The capability is the interrupt button in the chat composer. While a turn is in
flight `PromptInput` (`components/chat/PromptInput.tsx`) swaps the Send button for
a red Square "Interrupt" button (`data-testid="prompt-interrupt"`) wired to
`session.interrupt`. That posts to `app/api/sessions/[id]/interrupt/route.ts`,
which aborts the SDK turn.

## Decision
ALREADY_EXISTS. The "cancel generation" capability lives in the composer's
interrupt button (`components/chat/PromptInput.tsx`) backed by
`app/api/sessions/[id]/interrupt/route.ts`. The literal Ctrl+C chord is a
terminal control with no browser meaning (Ctrl+C is copy in a browser), but the
function it triggers has a clear, working surface.
