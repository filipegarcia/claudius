/**
 * CC 2.1.332 — "[VSCode] Fixed the chat showing no notice when a background
 * command, agent, workflow or monitor finished while Claude was idle".
 *
 * When a background task finishes, the engine wakes the session with a
 * top-level `<task-notification>` user message. Claudius drops that wrapper
 * (it is XML the user never typed), and the matching system
 * `task_notification` only updates the task's row, which may be far up the
 * transcript. So the chat showed nothing, and Claude's reply to the
 * notification appeared with no cause.
 *
 * This reads the notice the wrapper carries for a finished task, for a pill in
 * place of the dropped bubble. Real wrapper (from a session JSONL):
 *
 *   <task-notification>
 *   <task-id>b720wy810</task-id>
 *   <tool-use-id>toolu_…</tool-use-id>
 *   <output-file>/private/tmp/…/tasks/b720wy810.output</output-file>
 *   <status>completed</status>
 *   <summary>Background command "bun run test:e2e &gt; /tmp/e2e.log" completed (exit code 0)</summary>
 *   </task-notification>
 *
 * Only a wrapper with a `<status>` is a finish: a monitor's per-event
 * notification ("Monitor event: …") carries none, and stays silent like
 * before. The summary is XML-escaped, so it is decoded.
 */
export function taskNotificationNotice(content: unknown): string | null {
  const text = wrapperText(content).trim();
  if (!/^<task-notification[\s>]/.test(text)) return null;
  const status = /<status>([^<]*)<\/status>/.exec(text)?.[1]?.trim();
  if (!status) return null;
  const summary = decodeXmlEntities(/<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? "").trim();
  return summary || `Background task ${status}`;
}

function wrapperText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content as Array<{ type?: unknown; text?: unknown }>) {
    if (b?.type === "text" && typeof b.text === "string") out += b.text;
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", amp: "&" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|#39|amp);/g, (_, name: string) => XML_ENTITIES[name] ?? _);
}
