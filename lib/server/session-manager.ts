import { Session } from "./session";
import type { CreateSessionRequest } from "@/lib/shared/events";

/**
 * How long a session is allowed to sit with zero SSE subscribers before
 * being reaped. Tuned to cover: page reloads (a few seconds), navigating
 * away to /git or /files and coming back (seconds), tab switching across
 * desktops, intentional "leave it running in the background" use, AND
 * extended idle windows where the user just hasn't gotten back to a tab
 * for a while.
 *
 * Bumped 2026-05-12 from 10min → 60min after the user reported that
 * clicking a stale tab still showed an empty chat (the resume-from-disk
 * path works, but mismatched buffer / subscribe timing meant they had
 * to refresh to see history). A longer reap window doesn't fix the root
 * cause but materially reduces how often a user hits it.
 *
 * Override at boot via CLAUDIUS_SESSION_IDLE_REAP_MS for tests / users
 * who want a tighter or looser policy.
 */
const DEFAULT_IDLE_REAP_MS = 60 * 60 * 1000;

function reapMs(): number {
  const raw = process.env.CLAUDIUS_SESSION_IDLE_REAP_MS;
  if (!raw) return DEFAULT_IDLE_REAP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000) return DEFAULT_IDLE_REAP_MS;
  return n;
}

/**
 * Manages live SDK-backed Sessions. Exported (not just the singleton)
 * so unit tests can construct an isolated instance with stub sessions
 * — the singleton's `create()` would spawn a real SDK process, which
 * isn't viable in a unit context. The contract the reap logic depends
 * on (subscriber count, pending-prompt predicate, `end()`) is small
 * enough to satisfy with a hand-rolled stub; see
 * `tests/unit/session-manager.test.ts`.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Active reap timers keyed by session id. */
  private reapTimers = new Map<string, NodeJS.Timeout>();
  /** Unsubscribe handles for the per-session subscriber-count listeners. */
  private subscriberWatchers = new Map<string, () => void>();
  /**
   * Per-id count of *consecutive* auto-recovery attempts for the thinking-block
   * replay 400 (see `recoverInPlace`). Reset to zero by
   * `noteThinkingRecoverySuccess` whenever a turn completes successfully, so the
   * cap trips only on a tight re-poison loop (recover → instantly re-poison →
   * recover …) — NOT on cumulative recoveries spread across a long, productive
   * session, where each successful turn clears the budget.
   */
  private thinkingRecoveryAttempts = new Map<string, number>();

  async create(opts: CreateSessionRequest = {}): Promise<Session> {
    // Idempotent resume: if the caller is resuming an id we already have
    // alive, return the existing Session rather than spawning a second SDK
    // query against the same JSONL (which would corrupt the transcript on
    // disk and orphan the prior subscribers).
    if (opts.resume) {
      const existing = this.sessions.get(opts.resume);
      if (existing) {
        // Re-binding cancels any pending reap. The new caller will subscribe
        // shortly, but until they do count is still 0 — clearing the timer
        // here gives them the full grace window again rather than completing
        // the prior one mid-bind.
        this.cancelReap(opts.resume);
        return existing;
      }
    }
    const session = new Session(opts);
    this.sessions.set(session.id, session);

    // Wire idle reaping: when subscribers drop to 0, schedule end() after
    // the grace window. New subscribers cancel the timer.
    const unsubscribe = session.onSubscriberCountChange((count) => {
      this.handleSubscriberCount(session.id, count);
    });
    this.subscriberWatchers.set(session.id, unsubscribe);

    // Sessions are created with 0 subscribers; the client's POST → SSE
    // round-trip happens in milliseconds. Arm the initial timer so a session
    // that's created and then immediately abandoned (e.g. POST succeeds, the
    // browser tab is closed before the SSE opens) doesn't leak the SDK
    // process forever.
    this.scheduleReap(session.id);

    // Await start() so historical messages are buffered before the route
    // handler returns the id to the client. The client's SSE subscribe will
    // then replay the full transcript on bind, instead of catching only
    // events that arrive after connect.
    await session.start();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Live sessions whose working directory matches `cwd`. Used to push
   * filesystem changes (e.g. an edited `.claude/agents/*.md`) into the
   * running SDK via `reloadPlugins()` so the change takes effect without a
   * session restart.
   */
  sessionsByCwd(cwd: string): Session[] {
    return [...this.sessions.values()].filter((s) => s.cwd === cwd);
  }

  /**
   * Best-effort: ask every live session in `cwd` to reload plugins (which
   * re-reads commands/agents/skills/MCP from disk) so a just-saved
   * `.claude/agents/*.md` edit takes effect without a restart. Per-session
   * failures are swallowed — a reaped or not-yet-started session shouldn't
   * fail the caller's write. Returns the number of sessions asked to reload.
   */
  async reloadForCwd(cwd: string): Promise<number> {
    const targets = this.sessionsByCwd(cwd);
    await Promise.all(targets.map((s) => s.reloadPlugins().catch(() => undefined)));
    return targets.length;
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.cancelReap(id);
    const unsub = this.subscriberWatchers.get(id);
    // The `typeof` guard satisfies CodeQL's js/unvalidated-dynamic-method-call
    // (the function came from a Map lookup keyed by user input) and is a
    // belt-and-braces check that the watcher slot wasn't somehow overwritten
    // with a non-callable.
    if (typeof unsub === "function") {
      unsub();
      this.subscriberWatchers.delete(id);
    }
    await session.end();
    this.sessions.delete(id);
  }

  /**
   * Rebuild a session wedged by the thinking-block replay 400 (see
   * `lib/server/thinking-replay-recovery.ts`). Ends the live session and
   * recreates it under the SAME id, resumed and truncated to `resumeAt` so the
   * poisoned turn is dropped, then re-sends `replayPrompt` to re-drive it.
   * Reusing the proven resume path (`create({ resume, resumeSessionAt })`)
   * keeps the id stable, so open browser tabs keep their URL and simply
   * reconnect over SSE. Capped at 3 *consecutive* attempts (reset by
   * `noteThinkingRecoverySuccess` on any successful turn) so a turn that
   * re-poisons on replay surfaces instead of looping, while a session that
   * recovers and keeps working can recover again later. Called by
   * `Session.runThinkingReplayRecovery`.
   */
  async recoverInPlace(
    id: string,
    opts: { resumeAt: string; replayPrompt: string },
  ): Promise<{ ok: true } | { ok: false; reason: "gone" | "max_attempts" }> {
    const existing = this.sessions.get(id);
    if (!existing) return { ok: false, reason: "gone" };
    const attempts = this.thinkingRecoveryAttempts.get(id) ?? 0;
    if (attempts >= 3) return { ok: false, reason: "max_attempts" };
    this.thinkingRecoveryAttempts.set(id, attempts + 1);

    // Snapshot the create options BEFORE teardown, then end + recreate under
    // the same id resumed at the safe boundary.
    const carry = existing.getRebuildOpts();
    await this.remove(id);
    const session = await this.create({
      ...carry,
      resume: id,
      resumeSessionAt: opts.resumeAt,
    });
    // Re-drive the dropped turn. sendInput enqueues the prompt; the rebuilt
    // query consumes it once it finishes replaying the truncated history.
    session.sendInput(opts.replayPrompt);
    return { ok: true };
  }

  /**
   * Clear the consecutive-recovery budget for a session after it completes a
   * turn successfully. Called from `Session.consume()` on a `result` with
   * subtype `"success"`. This is what lets a long-lived session recover from
   * the thinking-block 400 any number of times across its life, while still
   * capping a tight recover→re-poison loop (where no successful turn ever
   * lands to reset the count). No-op if the id has no pending count.
   */
  noteThinkingRecoverySuccess(id: string): void {
    this.thinkingRecoveryAttempts.delete(id);
  }

  private handleSubscriberCount(id: string, count: number): void {
    if (count > 0) {
      this.cancelReap(id);
    } else {
      this.scheduleReap(id);
    }
  }

  private scheduleReap(id: string): void {
    this.cancelReap(id);
    const t = setTimeout(() => {
      this.reapTimers.delete(id);
      const s = this.sessions.get(id);
      // Refuse to reap if a new subscriber raced in between scheduling and
      // firing — defensive belt to the cancel/clear above.
      if (!s || s.subscriberCount() > 0) return;
      // Don't reap a session that's blocked on a user-facing prompt
      // (AskUserQuestion form, permission decision, plan approval). End()
      // would abort the SDK's `canUseTool` promise and write an errored
      // tool_result to disk — leaving the question unanswerable next time
      // the user returns. Park the session and re-arm the timer instead,
      // so we'll check again after another idle window: if the prompt is
      // eventually answered (or the user reattaches and ack-flips it via
      // SSE), the next subscriber drop kicks us back into the normal reap
      // path. `turnInFlight` alone is NOT covered here on purpose — a
      // runaway Bash without a watcher should still be reapable.
      if (s.hasPendingUserPrompts()) {
        this.scheduleReap(id);
        return;
      }
      void this.remove(id).catch(() => {});
    }, reapMs());
    // Don't keep the event loop alive solely for this timer.
    t.unref?.();
    this.reapTimers.set(id, t);
  }

  private cancelReap(id: string): void {
    const t = this.reapTimers.get(id);
    if (!t) return;
    clearTimeout(t);
    this.reapTimers.delete(id);
  }
}

declare global {
  var __claudiusSessionManager: SessionManager | undefined;
}

// Singleton across hot reloads in dev.
export const sessionManager: SessionManager =
  globalThis.__claudiusSessionManager ?? (globalThis.__claudiusSessionManager = new SessionManager());
