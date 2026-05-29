/**
 * Extract `file_path` values from any `Read` tool_use blocks inside an SDK
 * assistant message.
 *
 * Why: when the SDK auto-compacts the conversation (`compact_boundary`
 * message), it strips the prior `Read` tool calls from the CLI's
 * readFileState cache — so a subsequent `Edit` fails with "file not read
 * yet" even though the model believes (correctly) that it has read the
 * file. B2.3's re-seed path walks every Read path the model has performed
 * this session and re-feeds them through `query.seedReadState(path, mtime)`
 * after each compact boundary. The Session owns the set + fs.stat + the
 * SDK call; this helper owns the message-shape sniffing so the loop hook
 * stays trivial.
 *
 * Defensive against schema drift — unknown shapes return `[]` rather than
 * throwing. The empty array is intentional: callers iterate it as "no
 * paths to add", which is the safe behaviour when a message changes shape
 * across SDK versions.
 *
 * Only `SDKAssistantMessage` carries `tool_use` blocks the model emitted;
 * user-replay, system, and result messages always return `[]`.
 */
export function extractReadPaths(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const m = message as Record<string, unknown>;
  if (m.type !== "assistant") return [];

  // SDKAssistantMessage wraps the Anthropic API message; the content blocks
  // live at `.message.content`, not `.content` directly.
  const wrapped = m.message as { content?: unknown } | undefined;
  const content = wrapped?.content;
  if (!Array.isArray(content)) return [];

  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;
    // The Read tool's wire name has been stable since Claude Code's first
    // public SDK; pin to the exact string rather than a case-insensitive
    // match so a hypothetical future rename surfaces here as a test
    // failure rather than a silent miss.
    if (b.name !== "Read") continue;
    const input = b.input as { file_path?: unknown } | undefined;
    const path = input?.file_path;
    if (typeof path !== "string" || path.length === 0) continue;
    out.push(path);
  }
  return out;
}
