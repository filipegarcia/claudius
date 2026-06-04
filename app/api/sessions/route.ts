import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { getWorkspace, listWorkspaces, type Workspace } from "@/lib/server/workspaces-store";
import { info as sessionFileInfo } from "@/lib/server/sessions-store";
import { setPromptDraft } from "@/lib/server/prompt-drafts-db";
import type { CreateSessionRequest } from "@/lib/shared/events";
import { mergeSessionDefaults } from "@/lib/shared/session-defaults";

/**
 * Defensive ceiling on the seed-draft size — matches the prompt-draft PUT
 * route. Right-click selections in Electron can be unbounded (whole page),
 * so we trim rather than reject.
 */
const MAX_INITIAL_DRAFT_TEXT = 200_000;

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: CreateSessionRequest = {};
  try {
    body = (await req.json()) as CreateSessionRequest;
  } catch {
    body = {};
  }
  // Default cwd resolution order:
  //   1. explicit body.cwd
  //   2. when resuming: the session's *original* cwd from its JSONL on disk
  //      (must come before the workspace fallback — otherwise the SDK looks
  //      in the wrong project dir, can't find the session, and silently
  //      starts a fresh conversation under a new id)
  //   3. active workspace from cookie / hint
  //   4. process.cwd() (legacy fallback, kept so headless callers still work)
  let cwd = body.cwd;
  let originWs: Workspace | null = null;
  if (!cwd && body.resume) {
    try {
      const info = await sessionFileInfo(body.resume);
      if (info?.cwd) cwd = info.cwd;
    } catch {
      // fall through to workspace resolution
    }
  }
  if (!cwd) {
    const ws = await resolveActiveWorkspace().catch(() => null);
    if (ws) {
      cwd = ws.rootPath;
      originWs = ws;
    }
  } else {
    // Explicit cwd — find the workspace whose rootPath matches so its
    // defaults still apply.
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    originWs = all.find((w) => w.rootPath === cwd) ?? null;
  }

  // Merge: workspace defaults *under* explicit body fields. Spec rule:
  //   effective = { ...workspace.defaults, ...request }
  const defaults = originWs?.defaults ?? {};
  const {
    model,
    permissionMode,
    agent,
    maxBudgetUsd,
    taskBudgetTokens,
    maxTurns,
    fallbackModel,
    sandboxEnabled,
    enable1mContext,
    persistSession,
    additionalDirectories,
    systemPromptAppend,
    planModeInstructions,
  } = mergeSessionDefaults(body, defaults);

  // Surface the underlying error to the renderer. Without this, an
  // unhandled throw in Session construction / start (DB, SDK spawn,
  // account-profile provisioning, …) bubbles to Next as a bare 500 with
  // no body — the toast shows "create session failed: 500" and the
  // packaged build's child-process stderr goes to /dev/null when launched
  // from Finder. Returning `{ error, name }` makes the cause visible
  // in-app and to anyone curling the endpoint directly.
  let session;
  try {
    session = await sessionManager.create({
      cwd,
      model,
      agent,
      maxBudgetUsd,
      taskBudgetTokens,
      maxTurns,
      fallbackModel,
      sandboxEnabled,
      enable1mContext,
      persistSession,
      additionalDirectories,
      systemPromptAppend,
      planModeInstructions,
      permissionMode,
      resume: body.resume,
      resumeSessionAt: body.resumeSessionAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "Error";
    console.error("[api/sessions] sessionManager.create failed:", err);
    return NextResponse.json({ error: message, name }, { status: 500 });
  }

  // If sessionManager returned an existing in-memory session via resume
  // idempotency, its mode is whatever it was last set to — possibly stale
  // relative to a freshly-changed workspace default. Reconcile so the
  // session honours the current effective `permissionMode` regardless of
  // when the underlying SDK process was originally spawned.
  if (permissionMode && session.getPermissionMode() !== permissionMode) {
    await session.setPermissionMode(permissionMode);
  }

  // Seed the composer draft, if requested. Written here (BEFORE the
  // response is returned) so the renderer's per-session draft GET reads
  // our text back — there's no in-memory race because by the time the
  // renderer learns about this session, the row already exists. Used by
  // the Electron right-click "Start New Chat With Selection" path.
  if (typeof body.initialDraftText === "string" && body.initialDraftText.length > 0) {
    const trimmed =
      body.initialDraftText.length > MAX_INITIAL_DRAFT_TEXT
        ? body.initialDraftText.slice(0, MAX_INITIAL_DRAFT_TEXT)
        : body.initialDraftText;
    try {
      await setPromptDraft(session.cwd, session.id, trimmed, []);
    } catch (err) {
      // Best-effort — log so a misconfigured DB is debuggable, but don't
      // fail the session-create. Composer will come up empty if this
      // fails, same fail-safe as a normal draft-write error.
      console.error("[api/sessions] initialDraftText write failed:", err);
    }
  }

  return NextResponse.json({
    id: session.id,
    cwd: session.cwd,
    model: session.model,
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  let filter: ((cwd: string) => boolean) | null = null;
  if (workspaceId) {
    const ws = await getWorkspace(workspaceId).catch(() => null);
    if (ws) filter = (cwd) => cwd === ws.rootPath;
  }
  const list = sessionManager
    .list()
    .map((s) => ({
      id: s.id,
      cwd: s.cwd,
      model: s.model,
      title: s.title ?? null,
      // Coarse "is the agent doing something right now?" signal so the
      // SessionTabs strip can paint the dot for non-active tabs whose SSE
      // isn't bound to this client. See Session.getStatus().
      status: s.getStatus(),
    }))
    .filter((s) => (filter ? filter(s.cwd) : true));
  return NextResponse.json(list);
}
