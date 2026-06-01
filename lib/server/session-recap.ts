/**
 * "Where were we?" recap generator — Claudius's port of the Claude Code TUI's
 * away-summary feature.
 *
 * # The TL;DR
 *
 * When the user returns to a session after stepping away (≥5 minutes of tab
 * blur), or hits a `/recap` button, the client POSTs to
 * `/api/sessions/[id]/recap`, which calls `Session.requestRecap()`, which calls
 * `generateRecap()` here. We then broadcast a `session_recap` SSE event back to
 * every subscriber so all open tabs paint the banner.
 *
 * # Why this is a separate module
 *
 * The TUI gets cache-cheap recaps by reusing the SDK's `CacheSafeParams` — the
 * previous turn's payload, replayed exactly so the prompt cache stays warm.
 * That state is SDK-internal; an external host like Claudius has no way to
 * observe it. To avoid blowing up cost on every recap we deliberately do NOT
 * use `resume` (which would re-feed the entire conversation as input). Instead,
 * we extract a bounded transcript tail from the in-memory broadcast buffer
 * (which we already maintain for SSE replay) and send it as a single one-shot
 * prompt with a small `maxTurns` and a `canUseTool` deny-list.
 *
 * Fidelity trade-off: the model only sees the last few turns, not the full
 * conversation. For a 40-word recap that's fine — the TUI's prompt itself
 * tells the model to lead with "the overall goal and current task, then the
 * one next action", and a tail of ~10 turns captures that for any normal
 * session shape. Long-running multi-phase work might lose context from earlier
 * phases; that's an acceptable cost ceiling for what's meant to be a free,
 * always-on convenience.
 *
 * # Why no tools
 *
 * Even though `maxTurns: 1` already prevents tool chains, the deny-everything
 * `canUseTool` is belt-and-braces: a misbehaving model that decides to call a
 * tool on its single turn would otherwise stall the off-band query and burn
 * tokens. The TUI literally errors `"Away summary cannot use tools"` in the
 * same spot; we mirror that contract.
 *
 * # Known leak: AI-title sidecar
 *
 * Even with `persistSession: false`, the SDK still writes a ~118-byte
 * `ai-title` sidecar file into `~/.claude/projects/<encoded-cwd>/`. The file
 * contains only `{type:"ai-title", aiTitle:"…", sessionId:"…"}` — no
 * conversation content. Verified empirically by `scripts/smoke-recap.mjs`.
 *
 * Claudius's session rail (`/api/sessions/all`) is driven by per-workspace
 * `.claudius.db` rows, not raw JSONL scans, so these sidecars don't appear
 * there (the recap path never calls `upsertSession`). The SDK's own
 * `listSessions` does see them; anyone surfacing that list raw would get
 * "ghost" entries with no messages. Acceptable cost: setting
 * `CLAUDE_CONFIG_DIR=/tmp` would suppress the leak but loses ambient auth
 * from `~/.claude/auth`, and the alternative (full env reconstruction with
 * injected auth) carries credential-handling risk that isn't worth ~118
 * bytes per recap.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent } from "@/lib/shared/events";

/**
 * The verbatim TUI prompt for the away-summary — extracted from the Claude
 * Code binary so behavior matches what users have seen elsewhere. Keep this
 * STABLE: tweaking the wording changes recap voice across the entire user
 * base, so prefer a fresh setting/key over editing this string.
 */
export const RECAP_INSTRUCTION =
  "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

/**
 * Hard cap on the transcript tail we paste into the recap prompt. ~4KB is
 * roughly the last 6-10 user/assistant text turns for a normal session shape
 * — generous enough to ground a "where were we" summary, tight enough that the
 * one-shot prompt stays cheap on any model (we're paying full input cost on
 * every recap because the SDK's prompt cache isn't reusable from outside the
 * session's main query).
 */
const TAIL_CHAR_BUDGET = 4_000;

/**
 * Minimum gap between successive recap firings on the same session, in ms.
 * Server-side dedupe guard against multi-tab double-fire: when N tabs each
 * regain focus after a long blur they all POST to `/recap` within
 * milliseconds, and without this gate every one of them would spawn a query.
 * 60s is short enough that a deliberate `/recap` from the user is never
 * blocked in practice (they wouldn't fire two within a minute), and long
 * enough that the multi-tab race is reliably collapsed.
 */
export const RECAP_DEDUPE_WINDOW_MS = 60_000;

/**
 * Extract a compact tail of user/assistant text from the session broadcast
 * buffer, for use as the prompt body of the recap query. Walks the buffer
 * back-to-front, collecting text blocks until the character budget is hit,
 * then reverses the result so the model sees the messages in their original
 * order.
 *
 * Why server-side and not from disk: the broadcast buffer is the in-memory
 * source of truth for the session's recent history (it's what every SSE
 * subscriber replays from on attach). Reading the JSONL would duplicate the
 * work, add filesystem latency, and miss not-yet-flushed messages on a busy
 * session.
 */
export function extractTranscriptTail(
  buffer: ReadonlyArray<ServerEvent>,
): { text: string; turnCount: number } {
  const lines: string[] = [];
  let charBudget = TAIL_CHAR_BUDGET;
  let turnCount = 0;

  for (let i = buffer.length - 1; i >= 0 && charBudget > 0; i--) {
    const ev = buffer[i];
    if (ev.type !== "sdk") continue;
    const msg = ev.message;
    if (msg.type === "user") {
      const text = extractUserText(msg);
      if (!text) continue;
      const line = `USER: ${truncate(text, charBudget)}`;
      lines.push(line);
      charBudget -= line.length;
      turnCount++;
    } else if (msg.type === "assistant") {
      const text = extractAssistantText(msg);
      if (!text) continue;
      const line = `ASSISTANT: ${truncate(text, charBudget)}`;
      lines.push(line);
      charBudget -= line.length;
      turnCount++;
    }
  }

  // Buffer walked back-to-front; flip so the model reads chronologically.
  lines.reverse();
  return { text: lines.join("\n\n"), turnCount };
}

function extractUserText(msg: SDKUserMessage): string {
  // Skip synthetic / tool-result wrapper messages — only the user's actual
  // prose grounds the recap. The SDK marks tool results via
  // `parent_tool_use_id`, and pure-synthetic system pings via `isSynthetic`.
  if (msg.parent_tool_use_id) return "";
  if (msg.isSynthetic) return "";
  const content = msg.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join(" ").trim();
}

function extractAssistantText(msg: SDKAssistantMessage): string {
  // Skip subagent (Task) messages — they fire under a `parent_tool_use_id`
  // and are noise for a top-level recap.
  if (msg.parent_tool_use_id) return "";
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join(" ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Tail truncation rather than head: the start of an assistant message tends
  // to carry the topic sentence, which is what the recap needs most.
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

export type GenerateRecapInput = {
  /** Working directory for the off-band query — match the session's cwd. */
  cwd: string;
  /** Compact tail of the recent conversation (from `extractTranscriptTail`). */
  transcriptTail: string;
  /** Override model for the recap; falls back to the session's primary model. */
  model?: string;
  /**
   * Account-switcher env override — same shape the main query is using. The
   * SDK contract: when set, `env` REPLACES the subprocess env wholesale, so
   * we MUST forward whatever the parent session received (otherwise the
   * recap authenticates with the wrong / no credential). Omitted when the
   * session is running on ambient `process.env`. Matches the SDK's own
   * `Options.env` shape (`string | undefined` per key, not `string`).
   */
  env?: { [envVar: string]: string | undefined };
  /**
   * AbortSignal so the caller (`Session.requestRecap`) can cancel a slow
   * recap when the session is closed or the user fires a new turn.
   */
  signal?: AbortSignal;
};

export type GenerateRecapResult =
  | { ok: true; text: string }
  | { ok: false; reason: "empty_response" | "aborted" | "failed"; message?: string };

/**
 * Fire the off-band recap query and return its final text. Single-shot,
 * tool-less, non-persistent. Designed to be cheap and disposable: failures
 * never leak into the main session — callers translate the failure into a
 * `session_recap_error` SSE event so the banner just doesn't appear.
 */
export async function generateRecap(
  input: GenerateRecapInput,
): Promise<GenerateRecapResult> {
  // Deny every tool call. The SDK's typical contract is one PermissionResult
  // per request; `deny` with a message gives the model a reason if it tries.
  const denyAllTools: CanUseTool = async () => {
    const r: PermissionResult = {
      behavior: "deny",
      message: "Recap mode cannot use tools.",
    };
    return r;
  };

  // Prefix the verbatim TUI instruction onto a tagged transcript snippet so
  // the model has explicit framing for what it's looking at. Keeping the tail
  // inside a fenced "recent transcript" block (rather than free prose) makes
  // it harder for the model to mistake the snippet for fresh instructions.
  const prompt =
    `${RECAP_INSTRUCTION}\n\n` +
    `<recent_transcript>\n${input.transcriptTail}\n</recent_transcript>`;

  const options: Options = {
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    // Forward account-switcher env so the recap authenticates with the same
    // credential as the parent session. See GenerateRecapInput.env doc.
    ...(input.env ? { env: input.env } : {}),
    // Crucial: don't pollute the on-disk JSONL with this side-query. Without
    // this the recap would end up resumed on the next `claude --resume <id>`.
    persistSession: false,
    // Belt + braces with `canUseTool` — even if the model tries a tool, the
    // turn closes after one model response.
    maxTurns: 1,
    canUseTool: denyAllTools,
    // No system-prompt customization — the SDK default keeps the model
    // unencumbered. The recap instruction is in the user prompt.
    permissionMode: "default",
    ...(input.signal ? { abortController: signalToController(input.signal) } : {}),
  };

  try {
    const q = query({ prompt, options });
    let finalText = "";
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type !== "assistant") continue;
      if (msg.parent_tool_use_id) continue;
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        const block = b as { type?: string; text?: unknown };
        if (block.type === "text" && typeof block.text === "string") {
          finalText += block.text;
        }
      }
    }
    const cleaned = collapseWhitespace(finalText).trim();
    if (!cleaned) {
      return { ok: false, reason: "empty_response" };
    }
    return { ok: true, text: cleaned };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") {
      return { ok: false, reason: "aborted" };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "failed", message };
  }
}

/**
 * Adapter so the caller can pass a stand-alone AbortSignal without owning the
 * controller. The SDK takes an `abortController`; we wire a forwarded signal
 * through a fresh controller so abort propagates either direction.
 */
function signalToController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort(signal.reason);
  else {
    signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl;
}

function collapseWhitespace(s: string): string {
  // Belt-and-braces against the model emitting hard wraps or surplus blank
  // lines — the banner is a one-liner so a double newline would push it out
  // of frame.
  return s.replace(/\s+/g, " ");
}
