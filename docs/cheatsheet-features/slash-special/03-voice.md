# /voice

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/voice` toggles push-to-talk voice dictation so the user can speak a prompt
instead of typing it.

## Claudius today
Implemented in the browser, not just forwarded. `lib/client/useVoice.ts` wraps the
Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`), feature-detects
support, and streams interim + final transcripts back to the caller. The composer
`components/chat/PromptInput.tsx` consumes it: a mic button (around lines 358–990)
starts/stops dictation, swaps the `Mic`/`MicOff` icon, and shows a "Stop
dictation / Voice dictation" tooltip while the transcript flows into the prompt
field.

## Decision
ALREADY_EXISTS. Although the registry (`lib/shared/slash-commands.ts`) tags
`voice` as `handler: "external"`, the actual dictation capability is fully built in
the browser via `useVoice` and the PromptInput mic toggle — that is the working
surface. No new UI is needed.
