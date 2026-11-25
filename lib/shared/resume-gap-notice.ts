/**
 * CC 2.1.329 — "Fixed the line about earlier messages on resume blaming a
 * damaged file when the file was intact". The engine's sentence (`fOi()` in
 * the 2.1.332 bundle), with its optional dated lead ("Messages in this
 * session from before <time>").
 */
const TAIL = " weren't loaded. Claude won't see them, so repeat anything it still needs.";

export function resumeGapNotice(lead = "Earlier messages in this session"): string {
  return `${lead}${TAIL}`;
}

/**
 * CC 2.1.332 — "Added a notice in VS Code and Desktop's Code tab when a
 * resumed session's earlier messages weren't loaded". The engine now sends SDK
 * hosts the same line as a `system`/`informational` message on the first
 * prompt after such a resume. True for that message, in either wording, so a
 * session that already shows its own resume-gap row can drop the second copy.
 */
export function isEngineResumeGapNotice(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; subtype?: unknown; content?: unknown };
  return (
    m.type === "system" &&
    m.subtype === "informational" &&
    typeof m.content === "string" &&
    m.content.endsWith(TAIL) &&
    (m.content.startsWith("Earlier messages in this session") ||
      m.content.startsWith("Messages in this session from before "))
  );
}
