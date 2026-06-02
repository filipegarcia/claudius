import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/server/workspaces-store";
import { rebaseCurrentOnto, checkoutAndRebaseOnto } from "@/lib/server/git";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  /** The branch to rebase ONTO (the new base). */
  onto?: unknown;
  /**
   * Optional: switch to this branch *first*, then rebase it onto `onto`.
   * Powers IntelliJ's "Checkout and Rebase onto X" action.
   */
  checkoutBranch?: unknown;
};

/**
 * Rebase the current branch (or `checkoutBranch`, after switching) onto
 * `onto`. Same three-outcome shape as the merge endpoint, but the conflict
 * branch carries rebase-flavoured resolution verbs (`git rebase --continue`,
 * `git rebase --abort`) — the client must NOT reuse the merge prompt.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ws = await getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Body;
  if (typeof body.onto !== "string" || !body.onto.trim()) {
    return NextResponse.json({ error: "onto (string) required" }, { status: 400 });
  }
  let result;
  if (body.checkoutBranch != null) {
    if (typeof body.checkoutBranch !== "string" || !body.checkoutBranch.trim()) {
      return NextResponse.json(
        { error: "checkoutBranch must be a non-empty string" },
        { status: 400 },
      );
    }
    result = await checkoutAndRebaseOnto(ws.rootPath, body.checkoutBranch, body.onto);
  } else {
    result = await rebaseCurrentOnto(ws.rootPath, body.onto);
  }
  if (result.ok) return NextResponse.json(result);
  if (result.kind === "conflicts") {
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result, { status: 400 });
}
