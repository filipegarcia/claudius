/**
 * CC 2.1.280 (FIX) — subagent `tool_result` content arrives wrapped in an
 * internal provenance frame the harness adds so the parent model can't be
 * tricked by a forged "message from the user" inside a subagent's report:
 *
 *   [Subagent hand-back] The text below is the final report of a subagent
 *   this session delegated to. … The report follows:
 *     <report, every line indented two spaces>
 *
 * That preamble is plumbing — Claude Code strips it before showing the report
 * to the user, and Claudius renders the raw `result.content` in TaskBlock's
 * "Returned to parent" view, so the preamble leaks. This unwraps it for
 * display only (the engine still sees the framed text): drop the preamble line
 * and dedent the report. Anything that isn't a hand-back frame passes through
 * untouched.
 */
const HANDBACK_PREFIX = "[Subagent hand-back]";
const REPORT_MARKER = "The report follows:";

export function stripSubagentHandBackFrame(content: string): string {
  const handbackIdx = content.indexOf(HANDBACK_PREFIX);
  if (handbackIdx < 0) return content;
  const markerIdx = content.indexOf(REPORT_MARKER, handbackIdx);
  if (markerIdx < 0) return content;

  // Any notes the harness placed *above* the frame are kept (rare); the
  // frame line itself (prefix … marker) is dropped.
  const before = content.slice(0, handbackIdx).trimEnd();

  // The report is everything after the marker, with its leading newline and
  // the harness's uniform indent removed.
  let report = content.slice(markerIdx + REPORT_MARKER.length).replace(/^\r?\n/, "");
  const lines = report.split("\n");
  const indent = lines
    .filter((l) => l.trim().length > 0)
    .reduce((min, l) => Math.min(min, l.match(/^ */)?.[0].length ?? 0), Infinity);
  const strip = Number.isFinite(indent) ? indent : 0;
  report = (strip > 0 ? lines.map((l) => l.slice(strip)).join("\n") : report).trimEnd();

  return before ? `${before}\n\n${report}` : report;
}
