# Voice push-to-talk (/voice)

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Hold a key (space) to record voice and dictate your prompt instead of typing.

## Claudius today
`lib/client/useVoice.ts` wraps the browser Web Speech API (`SpeechRecognition`/`webkitSpeechRecognition`) with `start`/`stop`/`listening`/`supported`. `components/chat/PromptInput.tsx` imports and wires `useVoice` so dictated transcripts flow straight into the composer. The `/voice` command is also registered in `lib/shared/slash-commands.ts`.

## Decision
Already covered. Voice dictation is implemented natively in the browser via `useVoice` and surfaced in `PromptInput`. No new UI needed.
