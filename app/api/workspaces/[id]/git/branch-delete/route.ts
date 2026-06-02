import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { deleteLocalBranch, deleteRemoteBranch, isGitError } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  name?: unknown;
  /** True → remote ref ("origin/foo"), runs `push <remote> --delete`. */
  remote?: unknown;
  /** Local-only: upgrades `branch -d` to `branch -D`. Ignored for remote. */
  force?: unknown;
};

/**
 * Delete a branch. Two distinct flows depending on `remote`:
 *   - false (default): local `git branch -d <name>` (or `-D` with `force`).
 *   - true: `git push <remote> --delete <branch>` (parses "origin/foo").
 *
 * The client is responsible for the destructive confirm — this endpoint just
 * forwards what it's told. The "you can't delete the current branch" guard
 * is enforced by git itself; we surface its stderr verbatim.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name (string) required" }, { status: 400 });
  }
  const isRemote = body.remote === true;
  const result = isRemote
    ? await deleteRemoteBranch(ws.rootPath, body.name)
    : await deleteLocalBranch(ws.rootPath, body.name, body.force === true);
  if (isGitError(result)) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: 400 });
  }
  return NextResponse.json(result);
}
