/**
 * CC 2.1.319 parity — "Earlier in this session" → Open: expand a finished
 * subagent's TaskBlock in the transcript and scroll to it. The rail and the
 * transcript are siblings with no shared state, so this is a window event the
 * matching `TaskBlock` (keyed by its Agent tool_use id) listens for.
 */
export const OPEN_TASK_EVENT = "claudius:open-task";

export type OpenTaskDetail = { toolUseId: string };

export function openTaskInTranscript(toolUseId: string): void {
  if (typeof window === "undefined" || !toolUseId) return;
  window.dispatchEvent(new CustomEvent<OpenTaskDetail>(OPEN_TASK_EVENT, { detail: { toolUseId } }));
}

/** The composer text "Message" drops in: the model then calls SendMessage. */
export function messageSubagentDraft(taskId: string): string {
  return `Use SendMessage to send agent ${taskId} this message: `;
}
