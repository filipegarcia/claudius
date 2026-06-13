import { NextResponse } from "next/server";
import { installRoot } from "@/lib/server/updater/root";
import { readUpdaterFile } from "@/lib/server/updater/settings";
import { isDirty, isGitCheckout } from "@/lib/server/updater/git";
import {
  createWorkspace,
  listWorkspaces,
  setActiveId,
} from "@/lib/server/workspaces-store";
import { writeActiveCookie } from "@/lib/server/active-workspace";

export const runtime = "nodejs";

/**
 * Compose a conflict-resolution prompt and prepare a workspace at the
 * Claudius install root, so the client can drop the user into a fresh
 * chat with the prompt pre-loaded — but never auto-sent.
 *
 * Returns `{ workspaceId, prompt }`; the client stores the prompt in
 * sessionStorage and navigates to `/<workspaceId>?new=1&prefill=1`. The
 * chat page picks the draft up via the same `?prefill=1` pathway the
 * customizations auto-fix flow uses (see SyncFromBasePanel.onAutoFix and
 * `app/[workspaceId]/page.tsx` lines 375-410). This avoids racing the
 * server-side `sessionManager.create` against the client's session-resume
 * lookup, and the auto-send timer that `?prompt=` would trigger.
 */
export async function POST() {
  const root = installRoot();
  if (!(await isGitCheckout(root))) {
    return NextResponse.json(
      { error: "install root is not a git checkout" },
      { status: 400 },
    );
  }

  const file = await readUpdaterFile();
  const conflicts = file.state.conflicts;
  const recovery = file.state.recovery;
  const dirty = await isDirty(root).catch(() => true);

  // Find an existing workspace pointing at the install root; create one if
  // the user hasn't opened the install dir before. Reusing avoids piling
  // up duplicate "Claudius (install)" entries on repeated recovery clicks.
  let workspace = (await listWorkspaces()).find((w) => w.rootPath === root);
  if (!workspace) {
    workspace = await createWorkspace({
      name: "Claudius (install)",
      rootPath: root,
      // Bypass permissions: the agent is running against a known-safe
      // directory (the user's own Claudius checkout) and the prompt
      // explicitly tells it not to push, delete .claudius/, etc.
      defaults: { permissionMode: "bypassPermissions" },
    });
  }
  await setActiveId(workspace.id);
  await writeActiveCookie(workspace.id);

  // Two recovery shapes share this route and the same prefill plumbing:
  //   - conflicts: a stash-pop / merge left markers in the tree.
  //   - recovery:  the git step landed but `bun install` / `bun run build`
  //                failed (e.g. a native module couldn't compile).
  // Conflicts take priority when both are somehow set (markers block
  // install/build anyway).
  const prompt =
    !conflicts && recovery
      ? buildBuildFailurePrompt({
          root,
          phase: recovery.phase,
          fromSha: recovery.fromSha,
          toSha: recovery.toSha,
          detail: recovery.detail,
        })
      : buildResolutionPrompt({
          root,
          dirty,
          fromSha: conflicts?.fromSha,
          toSha: conflicts?.toSha,
          detail: conflicts?.detail,
        });

  return NextResponse.json({ workspaceId: workspace.id, prompt });
}

function buildBuildFailurePrompt(input: {
  root: string;
  phase: "install" | "build";
  fromSha?: string;
  toSha?: string;
  detail?: string;
}): string {
  const head = input.fromSha
    ? `\nBefore the apply: HEAD was at \`${input.fromSha.slice(0, 7)}\`.`
    : "";
  const tip = input.toSha
    ? `\nAfter the pull: HEAD is now at \`${input.toSha.slice(0, 7)}\` (upstream) — the new code is already checked out.`
    : "";
  const detail = input.detail
    ? `\nThe failing command reported:\n\n\`\`\`\n${input.detail}\n\`\`\`\n`
    : "";
  const cmd = input.phase === "install" ? "`bun install`" : "`bun run build`";

  return `The Claudius self-updater pulled new commits from upstream successfully, but then ${cmd} failed, so the update never finished. Please get the tree building again so I can restart into the new version.

Install root: \`${input.root}\`${head}${tip}${detail}

Context worth knowing:
- This is a git checkout running as a daemon (\`bin/claudiusd\`), not the packaged Electron app.
- \`better-sqlite3\` is a native module and is **patched** (see \`patches/\`), so a plain \`bun install\` recompiles it from source via \`node-gyp\`. That compile needs a working toolchain (a \`node\` on PATH, \`python3\`, and the Xcode command-line tools on macOS). A common cause of \`node-gyp ... exited with code 7\` is one of those missing from the daemon's environment.

Step-by-step, please:

1. Run the failing command yourself and read the real error — start with ${cmd}. If it's the native ${input.phase === "build" ? "build" : "module"}, check: is \`node\` on PATH? \`python3 --version\`? \`xcode-select -p\`?
2. Diagnose the root cause from the actual output, not a guess. If a prebuilt binary for \`better-sqlite3\` already exists at \`node_modules/better-sqlite3/build/Release/better_sqlite3.node\` and the version didn't change, you may be able to finish with \`bun install --ignore-scripts\` and avoid the recompile entirely.
3. Fix it, then prove the tree is healthy: run \`bun install\` (or \`bun install --ignore-scripts\` if appropriate) **and** \`bun run build\` to completion.
4. Report exactly what was wrong and what you changed.

Hard rules:
- DO NOT \`git reset --hard\` or roll back the pulled commits — the goal is to make the NEW code build, not to revert it.
- DO NOT push anywhere.
- DO NOT touch \`.claudius/\` or delete \`.next/\` (the running server is still serving the old build from it).

Once \`bun run build\` passes, I'll restart Claudius from the /updater page.`;
}

function buildResolutionPrompt(input: {
  root: string;
  dirty: boolean;
  fromSha?: string;
  toSha?: string;
  detail?: string;
}): string {
  const head = input.fromSha
    ? `\nBefore the apply: HEAD was at \`${input.fromSha.slice(0, 7)}\`.`
    : "";
  const tip = input.toSha
    ? `\nAfter the pull: HEAD is now at \`${input.toSha.slice(0, 7)}\` (upstream).`
    : "";
  const detail = input.detail ? `\nGit reported:\n\n\`\`\`\n${input.detail}\n\`\`\`\n` : "";
  const treeNote = input.dirty
    ? "The working tree still has merge markers from the stash pop."
    : "The working tree is clean — but the updater never finished install/build/restart for this update.";

  return `The Claudius self-updater pulled new commits from upstream, then tried to reapply my stashed local edits and hit conflicts. Please walk me through resolving this so the update can finish.

Install root: \`${input.root}\`${head}${tip}${detail}
${treeNote}

Step-by-step, please:

1. Run \`git status\` and show me which files have conflict markers.
2. For each conflicted file, open it, read both sides of every \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` block, and propose a resolution. Defaults when in doubt:
   - **Upstream wins** for dependency bumps (\`package.json\`, \`bun.lockb\`), bug fixes, security patches.
   - **Local wins** for visible UI/behavior customizations the user clearly added on purpose.
   - **Merge both** when the two sides are touching different facets of the same file (e.g. two new menu items).
3. After each file resolves, \`git add\` it.
4. When the whole tree is clean (\`git status\` shows no unmerged paths), commit with a short message like \`merge: reconcile local customizations with upstream\`.
5. Once that commit lands and \`git stash list\` shows the leftover \`claudius-updater-stash\` entry, drop it: \`git stash drop\`.
6. Finally run \`bun install\` and then \`bun run build\` to make sure the merged tree actually builds. Report the outcome.

Hard rules:
- DO NOT \`git reset --hard\` or otherwise discard my edits without explicitly asking me first.
- DO NOT push anywhere.
- DO NOT touch \`.claudius/\` or remove \`.next/\`.

Once it all passes, I'll restart Claudius from the /updater page.`;
}
