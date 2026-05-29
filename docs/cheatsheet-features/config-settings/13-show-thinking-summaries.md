# showThinkingSummaries

**Source:** Claude Code cheat sheet — Config & Env — Config Files & Key Settings
**Status:** ALREADY_EXISTS

## What it is
An opt-in settings.json key that requests API-side thinking summaries and shows
them in the conversation and the transcript view. Set explicitly to override the
install default.

## Claudius today
Surfaced as a labeled field. `showThinkingSummaries` is in the curated SDK
catalog in `app/settings/page.tsx` (the "Thinking & effort" section), rendered as
a Default / On / Off select with its verbatim SDK description. Writes to whichever
scope (user/project/local) is active.

## Decision
ALREADY_EXISTS. Covered by `app/settings/page.tsx` ("Thinking & effort" catalog
section). No new surface needed.
