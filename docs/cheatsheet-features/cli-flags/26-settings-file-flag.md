# --settings <file>

**Source:** Claude Code cheat sheet — CLI & Flags
**Status:** ALREADY_EXISTS

## What it is
`--settings <file>` loads Claude Code settings from a specified JSON file for the session.

## Claudius today
The Settings page (`app/settings/page.tsx`) is a full editor over the User / Project / Local settings.json files — form fields plus a Raw JSON mode — backed by `lib/server/settings.ts` and `app/api/settings/...`. The Backup section (`components/settings/BackupSection.tsx`) plus `app/api/settings/import` / `export` allow loading/saving settings as a JSON bundle.

## Decision
Already covered. The browser equivalent of "load settings from a file" is the Settings editor (including Raw JSON) over the standard scopes, plus settings import/export. Pointing the CLI at an arbitrary alternate file path is a launch-time flag with no per-page UI value beyond what the editor + import already provide. No new UI needed.
