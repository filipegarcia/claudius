# ANTHROPIC_CUSTOM_MODEL_OPTION

**Source:** Claude Code cheat sheet — Config & Env — Environment Variables
**Status:** ALREADY_EXISTS

## What it is
Adds a custom entry to the `/model` picker — useful for proxy/gateway deployments that expose a non-standard model id alias the SDK's built-in list doesn't know about.

## Claudius today
Custom model ids are already enterable. The workspace default Model field accepts any model id alias (`components/workspaces/WorkspaceForm.tsx`; the fallback-model field at line 64 is explicitly "plain text … accepts any model id alias"), the Settings → Model & UI `model` field is a free-text input (`app/settings/page.tsx`, line 347), and `app/api/models/route.ts` falls back to a static alias list when no live session advertises models. The picker honors whatever id is typed.

## Decision
ALREADY_EXISTS. The purpose of this env var — letting a custom/proxy model id flow into the picker — is already met by the free-text model fields in the workspace form and Settings, plus the alias-based `/api/models` fallback. No new surface needed.
