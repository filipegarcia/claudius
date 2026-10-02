/**
 * Shared shapes for linking a cross-session peer message back to the session
 * that sent it. The server resolves the sender (`lib/server/peer-source.ts`,
 * `GET /api/sessions/peer-source`); this module decides where a click goes.
 */

/** `GET /api/sessions/peer-source` payload for a resolved sender. */
export type PeerSourceInfo = {
  /** The sender's session id (Claude Code session id = Claudius session id). */
  sessionId: string;
  /** The sender's working directory, when known. */
  cwd: string | null;
  /** Registry display name, when the sender is still registered. */
  name: string | null;
  /** True while the sending process is still running. */
  live: boolean;
  /** True when THIS Claudius server is the one running the sender session. */
  hostedHere: boolean;
  /** Claudius workspace whose root is the sender's cwd, if any. */
  workspaceId: string | null;
};

export type PeerSourceResponse = { source: PeerSourceInfo | null };

/** Leading body characters sent as the transcript-fallback key. */
export const PEER_SNIPPET_MAX = 200;

/** Fields of a peer message the resolver keys on. */
export type PeerLookup = {
  /** Kernel-verified pid of the sending CLI process (`origin.verifiedPeerPid`). */
  pid?: number;
  /** Sender address, e.g. `uds:/tmp/cc-socks/123.sock` (`origin.from`). */
  from: string;
  /** Per-message id the sender also records in its transcript (`origin.msg_id`). */
  msgId?: string;
  /** Decoded message body; only its first `PEER_SNIPPET_MAX` chars are sent. */
  body?: string;
  /** Message timestamp, ms epoch. */
  at?: number;
};

/**
 * Whether the server has anything to resolve the sender with. Queued
 * (mid-turn) deliveries carry no pid/msg_id, but their `uds:` address and
 * body still work.
 */
export function canLookUpPeer(p: PeerLookup): boolean {
  return p.pid != null || !!p.msgId || p.from.startsWith("uds:") || !!p.body?.trim();
}

export function peerSourceQuery(p: PeerLookup): string {
  const qs = new URLSearchParams({ from: p.from });
  if (p.pid != null) qs.set("pid", String(p.pid));
  if (p.msgId) qs.set("msgId", p.msgId);
  // Slice by code point: a split surrogate pair would URL-encode as U+FFFD
  // and never match the sender's text. (The server's own UTF-16 cap is
  // harmless — any prefix of a prefix still matches.)
  const snippet = p.body ? Array.from(p.body.trim()).slice(0, PEER_SNIPPET_MAX).join("") : "";
  if (snippet) qs.set("snippet", snippet);
  if (p.at != null) qs.set("at", String(p.at));
  return qs.toString();
}

export type PeerSourceTarget =
  /** Open (or resume) the sender in the chat surface of its workspace. */
  | { kind: "chat"; sessionId: string; workspaceId: string }
  /** Open the read-only transcript viewer. */
  | { kind: "transcript"; href: string };

/**
 * Where "open sender session" should take the user.
 *
 * - Sender is running in THIS server, or has exited → the chat surface of
 *   its workspace (resuming an exited session is safe).
 * - Sender is still running in some OTHER process (a terminal `claude`,
 *   another Claudius instance) → the read-only transcript. Resuming it here
 *   would put two writers on the same JSONL.
 * - Sender's cwd isn't a Claudius workspace → also the transcript, under the
 *   current workspace; the chat surface is scoped to a workspace root.
 */
export function peerSourceTarget(
  src: PeerSourceInfo,
  currentWorkspaceId: string | null,
): PeerSourceTarget | null {
  const runningElsewhere = src.live && !src.hostedHere;
  if (src.workspaceId && !runningElsewhere) {
    return { kind: "chat", sessionId: src.sessionId, workspaceId: src.workspaceId };
  }
  const ws = src.workspaceId ?? currentWorkspaceId;
  if (!ws) return null;
  const dir = src.cwd ? `?dir=${encodeURIComponent(src.cwd)}` : "";
  return {
    kind: "transcript",
    href: `/${encodeURIComponent(ws)}/sessions/${encodeURIComponent(src.sessionId)}${dir}`,
  };
}
