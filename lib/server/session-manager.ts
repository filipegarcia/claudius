import { Session } from "./session";
import type { CreateSessionRequest } from "@/lib/shared/events";

/**
 * How long a session is allowed to sit with zero SSE subscribers before
 * being reaped. Tuned to cover: page reloads (a few seconds), navigating
 * away to /git or /files and coming back (seconds), tab switching across
 * desktops, and intentional "leave it running in the background" use.
 *
 * Override at boot via CLAUDIUS_SESSION_IDLE_REAP_MS for tests / users
 * who want a tighter or looser policy.
 */
const DEFAULT_IDLE_REAP_MS = 10 * 60 * 1000;

function reapMs(): number {
  const raw = process.env.CLAUDIUS_SESSION_IDLE_REAP_MS;
  if (!raw) return DEFAULT_IDLE_REAP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 5_000) return DEFAULT_IDLE_REAP_MS;
  return n;
}

class SessionManager {
  private sessions = new Map<string, Session>();
  /** Active reap timers keyed by session id. */
  private reapTimers = new Map<string, NodeJS.Timeout>();
  /** Unsubscribe handles for the per-session subscriber-count listeners. */
  private subscriberWatchers = new Map<string, () => void>();

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

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.cancelReap(id);
    const unsub = this.subscriberWatchers.get(id);
    if (unsub) {
      unsub();
      this.subscriberWatchers.delete(id);
    }
    await session.end();
    this.sessions.delete(id);
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
