# Auto-memory storage location

**Source:** Claude Code cheat sheet — Memory & Files
**Status:** ALREADY_EXISTS

## What it is
Auto-memory files are stored under `~/.claude/projects/<encoded-project-path>/memory/`, where the project path is encoded by replacing every non-alphanumeric character with `-`.

## Claudius today
Implemented and shown in the UI. `lib/server/auto-memory.ts` computes the directory via `autoMemoryDir` → `join(homedir(), ".claude", "projects", encodeProjectDir(projectCwd), "memory")`, with `encodeProjectDir` mirroring Claude Code's encoding exactly. The resolved directory path is displayed in the "Auto-memory" panel header on the Memory page (`{dir ?? "—"}` in `AutoMemorySection`, `app/[workspaceId]/memory/page.tsx`) and returned by `app/api/memory/auto/route.ts`.

## Decision
ALREADY_EXISTS. The storage location is both correctly resolved server-side (`autoMemoryDir` / `encodeProjectDir`) and surfaced as the displayed directory path on `/memory`. No new surface needed.
