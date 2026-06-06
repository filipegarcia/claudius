import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type { SendBashRequest, SendBashResponse } from "@/lib/shared/events";

export const runtime = "nodejs";

/**
 * `!`-mode bash execution endpoint (Claude Code parity).
 *
 *   - The command runs on the session's PERSISTENT bash (see `bash-mode.ts`),
 *     anchored at `session.cwd`. `cd`/`export` etc. survive across `!`
 *     invocations within the same session — same feel as Claude Code's
 *     internal Bash tool runtime.
 *   - Result is broadcast to the chat as a synthetic user-turn (the renderer
 *     detects the `<bash-input>` wrapper and renders a BashIO row) AND queued
 *     onto the bash-block channel so the model sees it as committed
 *     conversation context on the NEXT real user prompt.
 *   - The model is NOT invoked by this endpoint — matches Claude Code's
 *     `shouldQuery: false` behaviour from the leaked `processBashCommand`.
 *
 * SECURITY NOTES
 *
 *   - This is an arbitrary-command sink, same threat surface as the
 *     /git console's `execShellCommand` endpoint. Claudius's threat model
 *     is "local-only, single user already has shell access". Multi-tenant
 *     hosting would have to gate this route behind auth + isolation.
 *   - `sudoPassword` is one-shot: piped to `sudo -S` over stdin, never
 *     logged, never broadcast, never persisted in the JSONL, never
 *     included in the `<bash-input>` block the model receives. We DO NOT
 *     `console.log(body)` here for that reason — only `body.command`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  let body: SendBashRequest;
  try {
    body = (await req.json()) as SendBashRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const command = typeof body?.command === "string" ? body.command : "";
  if (!command.trim()) {
    return NextResponse.json({ error: "command required" }, { status: 400 });
  }
  // Reject embedded NULs — they'd terminate our wrapper before the
  // sentinel marker and hang the call. Cheap defense at the boundary.
  if (command.includes("\x00")) {
    return NextResponse.json({ error: "command contains NUL" }, { status: 400 });
  }
  const sudoPassword =
    typeof body.sudoPassword === "string" && body.sudoPassword.length > 0
      ? body.sudoPassword
      : undefined;
  const uuid = body.uuid ?? randomUUID();

  const result = await session.runBashCommand({ command, sudoPassword, uuid });

  const res: SendBashResponse = {
    ok: true,
    uuid: result.uuid,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
  return NextResponse.json(res);
}
