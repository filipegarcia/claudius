import { createReadStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { accountsDir } from "./accounts-store";
import { jsonlLines } from "./jsonl-lines";

/**
 * Resolve a cross-session peer message (`SDKMessageOrigin.kind === "peer"`)
 * back to the Claude Code session that SENT it, so the chat can link to it.
 *
 * Why not `origin.fromSession`? The CLI only stamps the envelope's
 * `from-session` attribute for desktop/IDE entrypoints (`claude-desktop`,
 * `claude-vscode`, …) via `CLAUDE_CODE_HOST_SESSION_ID`, and only in the
 * `local_<uuid>` shape. Claudius-hosted senders run as `sdk-ts`, so in
 * practice the field is never present on the messages we receive.
 *
 * What we get on the wire varies by delivery path:
 *   - Delivered while the receiver was idle: `from` (`uds:<socket path>`),
 *     `verifiedPeerPid` (kernel-verified pid of the sending CLI) and `msg_id`
 *     (a uuid the sender ALSO records as its `SendMessage` tool result,
 *     `toolUseResult.msg_id`).
 *   - Queued because the receiver was mid-turn: the CLI rebuilds `origin`
 *     from the `<cross-session-message from=… from-name=…>` envelope text, so
 *     only `from`, `name` and `body` survive — no pid, no msg_id.
 *
 * Two lookups, cheapest first:
 *   1. The CLI's live session registry, `~/.claude/sessions/<pid>.json`
 *      (`{ pid, sessionId, cwd, name, messagingSocketPath, startedAt }`),
 *      keyed by pid or, failing that, by the socket path in `from`.
 *      Cross-checked against the socket and the message time so a recycled
 *      pid can't send the user to an unrelated session. Gone once the sender
 *      exits.
 *   2. The sender's transcript: the JSONL whose `SendMessage` call produced
 *      this message — matched on `msg_id` when we have it, else on the
 *      message body. Survives the sender exiting and server restarts.
 *
 * Everything here is navigation-only. `from`/pid are sender-asserted (or
 * merely provenance), never authority — callers must not gate anything on it.
 */

export type PeerSource = {
  /** The sender's Claude Code session id (= Claudius session id). */
  sessionId: string;
  /** The directory the sender session was started in, when known. */
  cwd: string | null;
  /** Registry display name (e.g. "afrexim-99"), when the sender is still registered. */
  name: string | null;
  /** True while the sending process is still running. */
  live: boolean;
  via: "registry" | "transcript";
};

export type PeerSourceQuery = {
  pid?: number;
  /** `origin.from`, e.g. `uds:/tmp/cc-socks/123.sock`. */
  from?: string;
  msgId?: string;
  /** Leading slice of the decoded message body — the fallback transcript key. */
  snippet?: string;
  /** Message timestamp (ms epoch) — bounds the pid-recycle check and the transcript scan. */
  at?: number;
};

/**
 * Where to look. Defaults to the real `~/.claude` and Claudius's accounts
 * root; tests inject temp dirs (bun caches `os.homedir()`, so overriding
 * `HOME` isn't reliable).
 */
export type PeerSourceRoots = {
  /** The Claude config dir holding `sessions/` and `projects/`. */
  claudeDir: string;
  /** Claudius's per-account profile dirs (`<accountsDir>/profiles`). */
  profilesRoot: string;
};

function defaultRoots(): PeerSourceRoots {
  return {
    claudeDir: resolve(homedir(), ".claude"),
    profilesRoot: resolve(accountsDir(), "profiles"),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Shorter snippets match too loosely to trust ("ok", "done"). */
const MIN_SNIPPET = 16;

/**
 * Registry dirs to consult. Claudius-spawned sessions run with
 * `CLAUDE_CONFIG_DIR` pointed at a per-profile dir whose `sessions` entry is
 * normally a symlink back to `~/.claude/sessions` (see `accounts-store.ts`),
 * but when `~/.claude/sessions` didn't exist at provisioning time the CLI
 * creates a real dir there instead — so check those too.
 */
async function registryDirs(roots: PeerSourceRoots): Promise<string[]> {
  const dirs = [resolve(roots.claudeDir, "sessions")];
  const profilesRoot = resolve(roots.profilesRoot);
  let profiles: string[] = [];
  try {
    profiles = await fs.readdir(profilesRoot);
  } catch {
    return dirs;
  }
  for (const p of profiles) {
    const d = resolve(profilesRoot, p, "sessions");
    try {
      const st = await fs.lstat(d);
      if (st.isDirectory() && !st.isSymbolicLink()) dirs.push(d);
    } catch {
      // no registry under this profile
    }
  }
  return dirs;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `uds:<percent-encoded path>` → the socket path, or null for other address kinds. */
function socketPathFromAddress(from: string | undefined): string | null {
  if (!from || !from.startsWith("uds:")) return null;
  try {
    return decodeURIComponent(from.slice(4));
  } catch {
    return from.slice(4);
  }
}

type RegistryRecord = {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  name?: unknown;
  messagingSocketPath?: unknown;
  startedAt?: unknown;
};

/** Validate one registry record against the message; null when it isn't the sender. */
function acceptRecord(rec: RegistryRecord, q: PeerSourceQuery, socket: string | null): PeerSource | null {
  if (typeof rec.pid !== "number" || !Number.isSafeInteger(rec.pid)) return null;
  if (typeof rec.sessionId !== "string" || !SESSION_ID_RE.test(rec.sessionId)) return null;
  // Same pid but a different socket → not the process that sent this.
  if (socket && typeof rec.messagingSocketPath === "string" && rec.messagingSocketPath !== socket) return null;
  // Process started after the message was sent → pid was recycled.
  if (typeof q.at === "number" && typeof rec.startedAt === "number" && rec.startedAt > q.at + 5_000) return null;
  return {
    sessionId: rec.sessionId,
    cwd: typeof rec.cwd === "string" && rec.cwd ? rec.cwd : null,
    name: typeof rec.name === "string" && rec.name ? rec.name : null,
    live: pidAlive(rec.pid),
    via: "registry",
  };
}

async function readRecord(file: string): Promise<RegistryRecord | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as RegistryRecord;
  } catch {
    return null;
  }
}

async function fromRegistry(q: PeerSourceQuery, roots: PeerSourceRoots): Promise<PeerSource | null> {
  const socket = socketPathFromAddress(q.from);
  const pid = typeof q.pid === "number" && Number.isSafeInteger(q.pid) && q.pid > 0 ? q.pid : null;
  if (!pid && !socket) return null;
  const dirs = await registryDirs(roots);

  // Fast path: direct `<pid>.json` read.
  if (pid) {
    for (const base of dirs) {
      const file = resolve(base, `${pid}.json`);
      if (!file.startsWith(base + sep)) continue;
      const rec = await readRecord(file);
      if (rec && rec.pid === pid) {
        const hit = acceptRecord(rec, q, socket);
        if (hit) return hit;
      }
    }
  }
  // Queued deliveries carry no pid — match the socket across the registry.
  if (socket) {
    for (const base of dirs) {
      let names: string[];
      try {
        names = await fs.readdir(base);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!/^\d+\.json$/.test(n)) continue;
        const file = resolve(base, n);
        if (!file.startsWith(base + sep)) continue;
        const rec = await readRecord(file);
        if (!rec || rec.messagingSocketPath !== socket) continue;
        const hit = acceptRecord(rec, q, socket);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Bounds for the transcript scan so a miss can't wedge the request. */
const SCAN_SLACK_MS = 5 * 60_000;
const SCAN_BYTE_BUDGET = 512 * 1024 * 1024;
const SCAN_TIME_BUDGET_MS = 5_000;

type Candidate = { file: string; mtimeMs: number; size: number };

type TranscriptLine = {
  sessionId?: unknown;
  cwd?: unknown;
  toolUseResult?: { msg_id?: unknown };
  message?: { content?: unknown };
};

/** True when this record is the sender's `SendMessage` call for `snippet`. */
function isSendMessageFor(rec: TranscriptLine, snippet: string): boolean {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((c: { type?: unknown; name?: unknown; input?: { message?: unknown } }) => {
    if (c?.type !== "tool_use" || c.name !== "SendMessage") return false;
    const body = c.input?.message;
    return typeof body === "string" && body.trim().startsWith(snippet);
  });
}

async function findSenderInFile(
  file: string,
  match: { msgId?: string; snippet?: string },
): Promise<PeerSource | null> {
  // `jsonlLines`, not readline: readline splits a record at U+2028/U+2029
  // and the fragments fail to parse (CC 2.1.296). It destroys the stream
  // when the loop exits, including the early `return` on a match.
  const lines = jsonlLines(createReadStream(file, { encoding: "utf8" }));
  // The session's START cwd (first record) — later records track the
  // agent's shell cwd, which may be a subdirectory of the project.
  let startCwd: string | null = null;
  for await (const line of lines) {
    if (startCwd === null && line.includes('"cwd":"')) {
      try {
        const c = (JSON.parse(line) as TranscriptLine).cwd;
        if (typeof c === "string" && c) startCwd = c;
      } catch {
        // ignore
      }
    }
    const byId = match.msgId ? line.includes(match.msgId) : false;
    const byBody = !byId && match.snippet ? line.includes('"SendMessage"') : false;
    if (!byId && !byBody) continue;
    let rec: TranscriptLine;
    try {
      rec = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    // Structural matches only: the receiver's own transcript (and any
    // transcript that merely quotes the id or text) carries them elsewhere.
    const hit = byId ? rec.toolUseResult?.msg_id === match.msgId : isSendMessageFor(rec, match.snippet!);
    if (!hit) continue;
    if (typeof rec.sessionId !== "string" || !SESSION_ID_RE.test(rec.sessionId)) continue;
    const cwd = startCwd ?? (typeof rec.cwd === "string" && rec.cwd ? rec.cwd : null);
    return { sessionId: rec.sessionId, cwd, name: null, live: false, via: "transcript" };
  }
  return null;
}

async function fromTranscripts(q: PeerSourceQuery, roots: PeerSourceRoots): Promise<PeerSource | null> {
  const msgId = q.msgId && UUID_RE.test(q.msgId) ? q.msgId : undefined;
  const snippet = q.snippet?.trim();
  const usableSnippet = snippet && snippet.length >= MIN_SNIPPET ? snippet : undefined;
  if (!msgId && !usableSnippet) return null;
  // Body matching has no unique id, so require a time anchor to keep it tight.
  if (!msgId && typeof q.at !== "number") return null;

  const root = resolve(roots.claudeDir, "projects");
  const since = typeof q.at === "number" ? q.at - SCAN_SLACK_MS : 0;

  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return null;
  }
  // The sender appends its SendMessage call at/after send time, so only
  // transcripts touched since then can hold it.
  const candidates: Candidate[] = [];
  for (const d of projectDirs) {
    const dir = resolve(root, d);
    if (!dir.startsWith(root + sep)) continue;
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = resolve(dir, n);
      if (!file.startsWith(dir + sep)) continue;
      try {
        const st = await fs.stat(file);
        if (st.mtimeMs >= since) candidates.push({ file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // vanished mid-scan
      }
    }
  }
  // Oldest-touched first: the sender's file was last written closest to the
  // message time, while long-running sessions keep getting bumped forward.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const deadline = Date.now() + SCAN_TIME_BUDGET_MS;
  let bytes = 0;
  for (const c of candidates) {
    if (Date.now() > deadline || bytes > SCAN_BYTE_BUDGET) break;
    bytes += c.size;
    const hit = await findSenderInFile(c.file, { msgId, snippet: usableSnippet }).catch(() => null);
    if (hit) return hit;
  }
  return null;
}

/** query → result. Positives are stable; misses retry after a short TTL. */
const cache = new Map<string, { at: number; value: PeerSource | null }>();
const CACHE_MAX = 500;
const MISS_TTL_MS = 30_000;

function cacheKey(q: PeerSourceQuery, roots: PeerSourceRoots): string {
  return JSON.stringify([roots.claudeDir, q.msgId, q.pid, q.from, q.snippet, q.at]);
}

export async function resolvePeerSource(
  q: PeerSourceQuery,
  roots: PeerSourceRoots = defaultRoots(),
): Promise<PeerSource | null> {
  const key = cacheKey(q, roots);
  const cached = cache.get(key);
  if (cached && (cached.value || Date.now() - cached.at < MISS_TTL_MS)) return cached.value;
  const value = (await fromRegistry(q, roots)) ?? (await fromTranscripts(q, roots));
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // Cache misses and transcript hits; registry hits carry `live`, which
  // changes when the sender exits, and are cheap to redo.
  if (!value || value.via === "transcript") cache.set(key, { at: Date.now(), value });
  return value;
}
