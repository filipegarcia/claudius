import { NextResponse } from "next/server";
import { getWorkspace, listWorkspaces } from "@/lib/server/workspaces-store";
import { configFileChecks, listConfigFileProblems } from "@/lib/server/config-file-problems";

export const runtime = "nodejs";

/**
 * CC 2.1.327 parity — the broken agent/skill file and keybindings.json part
 * of `GET /api/doctor`, on its own so the /status overlay can show a problem
 * count without paying for the full doctor run (which also runs a prompt
 * audit over every workspace and shells out to `git`).
 *
 * /status calls it without arguments so its count covers the same set of
 * workspaces /doctor lists. `?workspaceId=` narrows the project scope to
 * that workspace (plus the user scope). The id is only a lookup key into the workspace store — the
 * directory read is the store's `rootPath`, never a path from the request.
 * Without it, every workspace is checked, exactly like /doctor.
 */
export async function GET(req: Request) {
  const workspaceId = new URL(req.url).searchParams.get("workspaceId");
  let workspaces: Awaited<ReturnType<typeof listWorkspaces>> = [];
  try {
    if (workspaceId) {
      const ws = await getWorkspace(workspaceId);
      workspaces = ws ? [ws] : [];
    } else {
      workspaces = await listWorkspaces();
    }
  } catch {
    // best-effort — still report the user scope and keybindings.json.
  }
  const problems = await listConfigFileProblems(workspaces);
  return NextResponse.json({ problems, checks: configFileChecks(problems) });
}
