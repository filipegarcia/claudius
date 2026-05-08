import { Session } from "./session";
import type { CreateSessionRequest } from "@/lib/shared/events";

class SessionManager {
  private sessions = new Map<string, Session>();

  async create(opts: CreateSessionRequest = {}): Promise<Session> {
    // Idempotent resume: if the caller is resuming an id we already have
    // alive, return the existing Session rather than spawning a second SDK
    // query against the same JSONL (which would corrupt the transcript on
    // disk and orphan the prior subscribers).
    if (opts.resume) {
      const existing = this.sessions.get(opts.resume);
      if (existing) return existing;
    }
    const session = new Session(opts);
    this.sessions.set(session.id, session);
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
    await session.end();
    this.sessions.delete(id);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __claudiusSessionManager: SessionManager | undefined;
}

// Singleton across hot reloads in dev.
export const sessionManager: SessionManager =
  globalThis.__claudiusSessionManager ?? (globalThis.__claudiusSessionManager = new SessionManager());
