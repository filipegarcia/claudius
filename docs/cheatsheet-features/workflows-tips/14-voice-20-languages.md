# Voice 20 languages

**Source:** Claude Code cheat sheet — Workflows & Tips
**Status:** ALREADY_EXISTS

## What it is
Voice dictation supports many languages, transcribing speech in the user's spoken language.

## Claudius today
`lib/client/useVoice.ts` sets `rec.lang = navigator.language || "en-US"`, so dictation follows the browser's locale automatically. The underlying Web Speech API handles whatever languages the host browser/OS provides. This is the same surface as feature 13 (push-to-talk), wired into `components/chat/PromptInput.tsx`.

## Decision
Already covered. Multi-language dictation is inherited from the browser's Web Speech API via `useVoice`, which keys off `navigator.language`. No separate UI or language picker is required for the core capability. No new UI needed.
