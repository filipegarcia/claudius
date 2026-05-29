# /doctor

**Source:** Claude Code cheat sheet — Slash Commands — Special
**Status:** ALREADY_EXISTS

## What it is
`/doctor` diagnoses the installation — runtime, SDK, auth, git, filesystem
permissions — and reports each check as ok / warn / fail.

## Claudius today
Full dedicated page at `app/doctor/page.tsx` backed by `app/api/doctor/route.ts`.
The API gathers runtime info (node/platform/arch), the SDK version, and a list of
`Check` rows (filesystem access/writability, etc.); the page renders them with
ok/warn/fail icons and a Refresh button. The slash dispatcher in
`app/[workspaceId]/page.tsx` routes `/doctor` (native handler) to
`router.push("/doctor")`.

## Decision
ALREADY_EXISTS. Covered by the `/doctor` page (`app/doctor/page.tsx`) and its
backing route (`app/api/doctor/route.ts`), reachable from the `/doctor` slash
command and the global nav. No new surface needed.
