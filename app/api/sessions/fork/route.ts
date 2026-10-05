import { NextResponse } from "next/server";
import { fork } from "@/lib/server/sessions-store";
import { createForkWorktree } from "@/lib/server/fork-worktrees";
import { resolveTrustedCwd } from "@/lib/server/trusted-cwd";

export const runtime = "nodejs";

type Body = {
  sessionId: string;
  upToMessageId?: string;
  title?: string;
  dir?: string;
  /**
   * CC 2.1.221 (DEC3) — when true (the `/fork` slash path), give the fork its
   * own git worktree off `cwd`'s repo. The rewind-fork path omits it and stays
   * on the shared checkout.
   */
  worktree?: boolean;
  /** Source session's working directory (needed to locate the repo). */
  cwd?: string;
};

export async function POST(req: Request) {
  const body = (await req.json()) as Body;
  if (!body?.sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  try {
    const result = await fork(body.sessionId, {
      upToMessageId: body.upToMessageId,
      title: body.title,
      dir: body.dir,
    });
    // DEC3: optionally carve off a worktree for the new fork. Best-effort —
    // a failure (non-git source, untrusted cwd, git error) leaves the fork on
    // the shared checkout rather than failing the fork.
    let worktree = null;
    if (body.worktree && typeof body.cwd === "string") {
      const sourceCwd = await resolveTrustedCwd(body.cwd).catch(() => null);
      if (sourceCwd) {
        worktree = await createForkWorktree(sourceCwd, result.sessionId).catch(() => null);
      }
    }
    return NextResponse.json({ ...result, worktree });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
