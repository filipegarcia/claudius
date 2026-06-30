import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

import { customizationSrcDir, getCustomization } from "./customizations-store";
import { getLiveSourceDir } from "./runtime-dir";
import { computeSyncStatus, type SyncEntry, type SyncVerdict } from "./customization-sync";
import { listIndexedSessions } from "./sessions-db";

/**
 * LLM-generated "feature description" for a customization. Synthesizes two
 * signals:
 *
 *   1. The unified diff between the customization source and the live base
 *      (the WHAT — concrete code that changed).
 *   2. The user's own messages from the customization workspace's chat
 *      sessions (the WHY — the user's intent in their own words).
 *
 * We pass both to the agent SDK in a single one-shot turn (no tools, no
 * permissions UI), mirroring the commit-message generator's pattern.
 */

const SYSTEM_PROMPT = `You write concise, plain-prose descriptions of user-authored modifications to a codebase ("customizations").

You will receive two inputs:
  1. A unified diff of files the USER EDITED in their customization — already filtered to remove unrelated upstream drift, so every change you see is the user's own work.
  2. The user's own chat messages from the workspace where they made these changes — these capture WHY they wanted the change.

Rules:
- Output ONLY the description. No preamble, no quotes, no markdown headers, no code fences.
- Decide first: is this ONE cohesive feature, or SEVERAL distinct concerns?
  • One feature → 2–3 sentences describing what it does and (if clear from chat) why.
  • Multiple features → start with a single sentence saying so ("This customization bundles N changes:"), then one short sentence per feature. Stay under ~5 sentences total.
- Use the user's own words / phrasing when it captures intent well.
- Don't list files. Don't mention diffs or chat verbatim.
- If the changes are trivial or unclear, say so honestly in one sentence.`;

const MAX_DIFF_CHARS = 150_000;
const MAX_INTENT_CHARS = 50_000;
const MAX_SESSIONS = 50;

export type DescribeResult =
  | { ok: true; description: string; diffHash: string }
  | { ok: false; error: string };

/**
 * Verdicts that count as "the user's own work" — same filter as the
 * SyncFromBasePanel's "Files in this customization" list. Drops upstream
 * drift, in-sync files, and safe-to-pull-from-base entries.
 */
const USER_VERDICTS: ReadonlySet<SyncVerdict> = new Set<SyncVerdict>([
  "user-only",
  "new-user",
  "conflict",
  "deleted-user",
]);

function userEditedFiles(entries: SyncEntry[]): SyncEntry[] {
  return entries.filter((e) => USER_VERDICTS.has(e.verdict));
}

/**
 * Stable hash of the user-edited file set. Used to decide when the
 * persisted description has gone stale. Intentionally derived from the
 * user-only verdict slice so unrelated upstream changes don't flip it.
 */
export async function diffHashFor(customizationId: string): Promise<string> {
  const status = await computeSyncStatus(customizationId);
  const files = userEditedFiles(status.entries);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.verdict);
    h.update("\0");
    h.update(f.path);
    h.update("\0");
    h.update(f.customHash ?? "");
    h.update("\0");
    h.update(f.manifestHash ?? "");
    h.update("\n");
  }
  return h.digest("hex");
}

export async function describeCustomization(
  customizationId: string,
): Promise<DescribeResult> {
  const c = await getCustomization(customizationId);
  if (!c) return { ok: false, error: "customization not found" };

  const status = await computeSyncStatus(customizationId);
  const files = userEditedFiles(status.entries);
  if (files.length === 0) {
    return { ok: false, error: "no user-authored changes to describe" };
  }

  const diffText = await buildUnifiedDiff(customizationId, files);
  const intentText = await collectUserIntent(customizationId);

  const userPrompt = composePrompt(diffText, intentText);
  const cwd = customizationSrcDir(customizationId);

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
        const text = stripFences(msg.result.trim());
        if (!text) return { ok: false, error: "claude returned empty text" };
        return { ok: true, description: text, diffHash: await diffHashFor(customizationId) };
      }
      return { ok: false, error: `claude returned ${msg.subtype}` };
    }
    return { ok: false, error: "no result from claude" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function composePrompt(diff: string, intent: string): string {
  const intentBlock = intent.trim()
    ? `USER INTENT (from chat — user messages only, newest first):\n${intent}`
    : `USER INTENT (from chat): no chat history available.`;
  return `Describe the following customization.\n\nCHANGES (unified diff):\n${diff}\n\n${intentBlock}`;
}

/**
 * Build a single concatenated unified diff for every USER-edited file in
 * the customization. Uses `git diff --no-index` since git is already a hard
 * dependency of Claudius — avoids pulling in a JS diff library.
 *
 * Per-verdict file selection:
 *   user-only / conflict — diff live ↔ custom (live still holds the user's
 *     fork-point base for user-only; for conflict the diff is "what diverges
 *     from running Claudius", which is the actionable view anyway).
 *   new-user             — diff /dev/null ↔ custom (file added).
 *   deleted-user         — diff live ↔ /dev/null (file removed).
 */
async function buildUnifiedDiff(
  customizationId: string,
  files: SyncEntry[],
): Promise<string> {
  const liveRoot = getLiveSourceDir();
  const customRoot = customizationSrcDir(customizationId);
  const chunks: string[] = [];
  let total = 0;
  for (const f of files) {
    if (total >= MAX_DIFF_CHARS) {
      chunks.push("\n[diff truncated — remaining files omitted]\n");
      break;
    }
    let aPath: string;
    let bPath: string;
    if (f.verdict === "new-user") {
      aPath = "/dev/null";
      bPath = join(customRoot, f.path);
    } else if (f.verdict === "deleted-user") {
      aPath = join(liveRoot, f.path);
      bPath = "/dev/null";
    } else {
      // user-only or conflict
      aPath = join(liveRoot, f.path);
      bPath = join(customRoot, f.path);
    }
    const piece = await gitDiffNoIndex(aPath, bPath);
    if (!piece) continue;
    const remaining = MAX_DIFF_CHARS - total;
    const trimmed = piece.length > remaining ? piece.slice(0, remaining) + "\n[…]\n" : piece;
    chunks.push(trimmed);
    total += trimmed.length;
  }
  return chunks.join("\n");
}

function gitDiffNoIndex(a: string, b: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    const child = execFile(
      "git",
      ["diff", "--no-index", "--no-color", "--", a, b],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
    );
    child.stdout?.on("data", (c: string) => (out += c));
    // Git emits exit 1 when files differ — that's our success path. Treat
    // any non-zero / error as "no diff" and move on; we'd rather skip a
    // file than fail the whole description.
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 || code === 1 ? out : ""));
  });
}

/**
 * Pull the user's own chat messages from every indexed session run inside the
 * customization's mirror, newest-first. Tool results, assistant turns, and
 * synthetic user messages (e.g. injected system reminders) are dropped —
 * what we want is the human-typed intent. The cwd is the mirror src dir
 * directly (customizations are no longer backed by a workspace).
 */
async function collectUserIntent(customizationId: string): Promise<string> {
  const cwd = customizationSrcDir(customizationId);
  const sessions = await listIndexedSessions(cwd).catch(() => []);
  if (sessions.length === 0) return "";

  const chunks: string[] = [];
  let total = 0;
  for (const s of sessions.slice(0, MAX_SESSIONS)) {
    if (total >= MAX_INTENT_CHARS) break;
    const msgs = await getSessionMessages(s.id, { dir: cwd }).catch(() => []);
    const userTexts: string[] = [];
    for (const m of msgs) {
      if (m.type !== "user") continue;
      const text = extractUserText(m.message);
      if (!text) continue;
      userTexts.push(text);
    }
    if (userTexts.length === 0) continue;
    const header = `── ${s.title ?? s.id} ──\n`;
    const body = userTexts.join("\n\n");
    const piece = header + body + "\n";
    const remaining = MAX_INTENT_CHARS - total;
    const trimmed = piece.length > remaining ? piece.slice(0, remaining) + "\n[…]\n" : piece;
    chunks.push(trimmed);
    total += trimmed.length;
  }
  return chunks.join("\n");
}

/**
 * Extract human-typed text from an SDK user message. The SDK accepts both
 * string content and an array-of-blocks shape; tool_result blocks are noisy
 * and not human intent, so we drop them.
 */
function extractUserText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: string; content?: unknown };
  if (m.role && m.role !== "user") return "";
  const c = m.content;
  if (typeof c === "string") return cleanBashBlocks(cleanReminders(c.trim()));
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const b of c as Array<{ type?: string; text?: string }>) {
    if (b && b.type === "text" && typeof b.text === "string") {
      const cleaned = cleanBashBlocks(cleanReminders(b.text.trim()));
      if (cleaned) parts.push(cleaned);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Strip <system-reminder>…</system-reminder> blocks. They're injected by
 * the harness (e.g. the task-tracking nudge), aren't user intent, and would
 * waste prompt budget.
 */
function cleanReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/**
 * Strip the `!`-mode bash IO blocks (`<bash-input>`, `<bash-stdout>`,
 * `<bash-stderr>`) injected into user-turn text by `pending-bash-output`.
 * They're prior shell IO surfaced as conversation context — useful to the
 * model on the actual turn, but pollutes anything we derive from the
 * "what did the user say" channel (title summary, etc.). Pairs with
 * `cleanReminders` at every call site.
 */
function cleanBashBlocks(s: string): string {
  return s
    .replace(
      /<bash-input>[\s\S]*?<\/bash-input>\n?<bash-stdout>[\s\S]*?<\/bash-stdout>\n?<bash-stderr>[\s\S]*?<\/bash-stderr>/g,
      "",
    )
    .trim();
}

function stripFences(s: string): string {
  const m = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  return m ? m[1].trim() : s;
}
