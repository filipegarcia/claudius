import { query } from "@anthropic-ai/claude-agent-sdk";

const SYSTEM_PROMPT = `You write concise git commit messages from a unified diff.

Rules:
- Output ONLY the commit message. No preamble, no quotes, no code fences.
- Imperative mood ("add X", not "added X").
- Subject line under 72 characters.
- If the change spans multiple distinct concerns, add a short body separated from the subject by one blank line. Skip the body for trivial changes.
- Focus on what changed and why, not a file-by-file rundown.`;

const MAX_DIFF_CHARS = 200_000;

export async function generateCommitMessage(
  cwd: string,
  diff: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!diff.trim()) return { ok: false, error: "no changes to summarise" };
  const trimmed =
    diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]" : diff;
  const userPrompt = `Generate a commit message for this diff:\n\n\`\`\`diff\n${trimmed}\n\`\`\``;
  try {
    const q = query({
      prompt: userPrompt,
      options: {
        cwd,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        permissionMode: "bypassPermissions",
        maxTurns: 1,
      },
    });
    for await (const msg of q) {
      if (msg.type !== "result") continue;
      if (msg.subtype === "success") {
        return { ok: true, message: stripFences(msg.result.trim()) };
      }
      return { ok: false, error: `claude returned ${msg.subtype}` };
    }
    return { ok: false, error: "no result from claude" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripFences(s: string): string {
  // Belt-and-suspenders: strip ``` fences if the model added them anyway.
  const m = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return m ? m[1].trim() : s;
}
