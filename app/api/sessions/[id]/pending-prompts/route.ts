import { NextResponse } from "next/server";
import { sessionManager } from "@/lib/server/session-manager";
import type {
  AskUserQuestionEvent,
  PermissionRequestEvent,
} from "@/lib/shared/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns interactive prompts that the agent is currently blocked on for
 * this session — questions awaiting an answer and permission requests
 * awaiting a decision. Powers the client's "fetch on mount / after replay"
 * recovery path so reloading a tab while the agent is mid-question still
 * shows the modal.
 *
 * The Session class's subscribe() also re-emits these on attach, but in
 * dev-mode HMR an existing in-memory Session can stay bound to the
 * pre-edit prototype, so a method-side fix doesn't reach it. This route
 * reads the underlying *fields* directly, which exist on every instance
 * regardless of class identity.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = sessionManager.get(id);
  if (!session) return NextResponse.json({ error: "session not found" }, { status: 404 });

  // Field access — TypeScript would block the private modifier, but at
  // runtime these are plain instance properties set in the constructor.
  const internals = session as unknown as {
    pendingAskQuestions?: Map<
      string,
      { requestId: string; toolUseId: string; questions: AskUserQuestionEvent["questions"] }
    >;
    pendingPermissions?: Map<string, { requestId: string; meta: PermissionRequestEvent }>;
  };

  const asks: AskUserQuestionEvent[] = [];
  if (internals.pendingAskQuestions) {
    for (const p of internals.pendingAskQuestions.values()) {
      asks.push({
        type: "ask_user_question",
        requestId: p.requestId,
        toolUseId: p.toolUseId,
        questions: p.questions,
      });
    }
  }

  const permissions: PermissionRequestEvent[] = [];
  if (internals.pendingPermissions) {
    for (const p of internals.pendingPermissions.values()) {
      permissions.push(p.meta);
    }
  }

  return NextResponse.json({ asks, permissions });
}
