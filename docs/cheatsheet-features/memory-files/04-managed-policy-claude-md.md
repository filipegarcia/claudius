# Managed policy CLAUDE.md

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** UI_WORTHY

## What it is
An org-wide, highest-precedence memory file installed by IT/MDM at `/etc/claude-code/CLAUDE.md` (macOS/Linux). It sits above the user/project/local layers in the CLAUDE.md resolution order and is typically read-only to the end user.

## Claudius today
Not modeled. `lib/server/claudemd.ts` defines exactly four scopes — `user`, `project`, `project-claude`, `local` — and `pathFor`/`resolveHierarchy` have no managed-policy entry. The Memory page's "Resolved" view (`ResolvedView` in `app/[workspaceId]/memory/page.tsx`) already renders the precedence hierarchy with per-scope provenance and a `totalChars` total, but the managed layer is simply absent.

## Decision
UI_WORTHY (low). The Memory page already models the CLAUDE.md precedence hierarchy in its "Resolved" view; managed policy is the missing top-precedence layer of that exact model. Add it as a **read-only row** at the top of the existing resolved hierarchy (new `ClaudeMdScope: "managed"` → `/etc/claude-code/CLAUDE.md`, read-only, shown only when the file exists). Backend is a small extension of `lib/server/claudemd.ts` (`pathFor` + `resolveHierarchy` + a read-only guard in `writeScope`) and `app/api/claudemd/route.ts`. No new SideNav tile — it lives in the existing `/memory` resolved view. Low effort; mostly a UI/read-path addition with a write guard.
