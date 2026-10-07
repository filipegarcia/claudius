/**
 * Vitest setup file — strip the repo-locating env vars git exports to hooks.
 *
 * The pre-commit hook (`.githooks/pre-commit`) runs `vitest related` from
 * inside `git commit`, which exports `GIT_INDEX_FILE=.git/index` (a RELATIVE
 * path) to the hook. Tests that build scratch repos inherit it into every
 * `git` they spawn, so the scratch repo's commands read/write an index other
 * than their own — `git worktree add` then fails because `.git` inside the
 * new worktree is a file, and `fork-worktrees-server.test.ts` sees
 * `createForkWorktree` return null. It only reproduced at commit time
 * (any commit staging `lib/server/db.ts`, which pulls that test in via the
 * tmp-home helper), never in a plain `bun run test`.
 *
 * The same leak is a data-safety hazard: with GIT_DIR / GIT_WORK_TREE /
 * an absolute GIT_INDEX_FILE, a scratch-repo `git add` lands in the commit
 * that's being made. No unit test should ever operate on the outer repo, so
 * drop these for every test process.
 */
for (const name of [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]) {
  delete process.env[name];
}
