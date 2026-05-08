import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  type ForkSessionResult,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type SessionListItem = SDKSessionInfo;

export async function list(opts: { dir?: string; limit?: number; includeWorktrees?: boolean } = {}): Promise<SessionListItem[]> {
  return await listSessions({
    dir: opts.dir,
    limit: opts.limit ?? 200,
    includeWorktrees: opts.includeWorktrees ?? true,
  });
}

export async function info(sessionId: string, dir?: string): Promise<SDKSessionInfo | undefined> {
  return await getSessionInfo(sessionId, { dir });
}

export async function messages(
  sessionId: string,
  dir?: string,
  includeSystem = true,
): Promise<SessionMessage[]> {
  return await getSessionMessages(sessionId, { dir, includeSystemMessages: includeSystem });
}

export async function rename(sessionId: string, title: string, dir?: string): Promise<void> {
  await renameSession(sessionId, title, { dir });
}

export async function fork(
  sessionId: string,
  opts: { upToMessageId?: string; title?: string; dir?: string } = {},
): Promise<ForkSessionResult> {
  return await forkSession(sessionId, opts);
}

export async function remove(sessionId: string, dir?: string): Promise<void> {
  await deleteSession(sessionId, { dir });
}

/** Plain-text export of a session, used by /api/sessions/export/:id. */
export async function exportPlainText(sessionId: string, dir?: string): Promise<string> {
  const all = await getSessionMessages(sessionId, { dir, includeSystemMessages: false });
  const out: string[] = [];
  for (const m of all) {
    if (m.type === "user") {
      const content = (m.message as { content?: unknown }).content;
      out.push("# User\n\n" + stringifyContent(content) + "\n");
    } else if (m.type === "assistant") {
      const content = (m.message as { content?: unknown }).content;
      out.push("# Claude\n\n" + stringifyContent(content) + "\n");
    } else if (m.type === "system") {
      out.push(`---\n[system]\n`);
    }
  }
  return out.join("\n");
}

export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "thinking" && typeof c.thinking === "string") parts.push(`[thinking]\n${c.thinking}`);
    else if (c.type === "tool_use") parts.push(`[tool_use ${String(c.name)}]\n${JSON.stringify(c.input ?? {}, null, 2)}`);
    else if (c.type === "tool_result") {
      const inner = c.content;
      let text = "";
      if (typeof inner === "string") text = inner;
      else if (Array.isArray(inner)) text = (inner as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
      parts.push(`[tool_result]\n${text}`);
    }
  }
  return parts.join("\n\n");
}
