# --output-format text/json/stream-json

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** NOT_APPLICABLE

## What it is
`--output-format text|json|stream-json` controls how headless (`-p`) runs serialize their output for scripts and pipelines.

## Claudius today
Claudius consumes the SDK's streaming message objects directly and renders them as a rich chat UI (`lib/server/session.ts` → SSE → `lib/client/use-session.ts`). It never emits text/json/stream-json to a terminal because there is no terminal — the browser is the output.

## Decision
Not applicable. Output format is meaningful only for the headless CLI (`-p`); it dictates a serialization for shell consumers. Claudius's "output format" is the chat UI itself, so there is no browser knob to add. (Transcript/export surfaces — `app/api/sessions/export`, `transcript` — already cover the "give me the conversation as data" need.)
