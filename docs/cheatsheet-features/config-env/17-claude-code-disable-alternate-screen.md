# CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** NOT_APPLICABLE

## What it is
Opts the terminal UI out of the alternate-screen buffer (the fullscreen TUI rendering mode), so Claude Code prints inline instead of taking over the terminal.

## Claudius today
This is a pure terminal-rendering flag. Claudius is a browser UI — it has no alternate-screen buffer and no TUI rendering at all, so the flag is inert here.

## Decision
NOT_APPLICABLE. Terminal-only rendering knob with zero relevance to a browser app. There is nothing to render differently and nothing to configure.
