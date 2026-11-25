import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  REWIND_CLIENT_TIMEOUT_MS,
  REWIND_ROUTE_TIMEOUT_MS,
  TIMED_OUT,
  rewindTimeoutMessage,
  withTimeout,
} from "@/lib/shared/rewind-timeout";

/**
 * CC 2.1.332 — "[VSCode] Fixed Rewind staying on 'Checking code changes…'
 * while Claude's process hung at its start".
 *
 * The rewind route awaited `query.rewindFiles` with no limit, so a CLI process
 * that exists but never answers left "Restore files" spinning forever. The
 * route now answers 504 after `REWIND_ROUTE_TIMEOUT_MS`; the button aborts its
 * fetch after the longer `REWIND_CLIENT_TIMEOUT_MS` (Playwright covers that
 * half: tests/e2e/cc-parity-2.1.332-rewind-timeout.spec.ts).
 */

type FakeSession = { query: { rewindFiles: (id: string, opts?: { dryRun?: boolean }) => Promise<unknown> } };

const mockManager = {
  restartIfDead: vi.fn<(id: string) => Promise<{ ok: true; session: FakeSession; restarted: boolean }>>(),
};

vi.mock("@/lib/server/session-manager", () => ({
  sessionManager: mockManager,
  deadSessionResponse: () => ({ error: "dead", status: 503 }),
}));

const { POST } = await import("@/app/api/sessions/[id]/rewind/route");

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/sessions/s/rewind", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: "s" }) },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mockManager.restartIfDead.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  test("passes the value through when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  test("passes a rejection through when it settles in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });

  test("gives TIMED_OUT once the limit passes first", async () => {
    const pending = withTimeout(new Promise<number>(() => {}), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(TIMED_OUT);
  });
});

describe("rewind route on a process that never answers", () => {
  test("a hung dry run answers 504 with a retry hint", async () => {
    mockManager.restartIfDead.mockResolvedValue({
      ok: true,
      session: { query: { rewindFiles: () => new Promise(() => {}) } },
      restarted: false,
    });

    const res = post({ userMessageId: "u1", dryRun: true });
    await vi.advanceTimersByTimeAsync(REWIND_ROUTE_TIMEOUT_MS);
    const out = await res;

    expect(out.status).toBe(504);
    expect(((await out.json()) as { error: string }).error).toBe(rewindTimeoutMessage(true));
  });

  test("a hung real restore doesn't claim it failed: it may still be applied", async () => {
    mockManager.restartIfDead.mockResolvedValue({
      ok: true,
      session: { query: { rewindFiles: () => new Promise(() => {}) } },
      restarted: false,
    });

    const res = post({ userMessageId: "u1", dryRun: false });
    await vi.advanceTimersByTimeAsync(REWIND_ROUTE_TIMEOUT_MS);
    const out = await res;

    expect(out.status).toBe(504);
    const { error } = (await out.json()) as { error: string };
    expect(error).toBe(rewindTimeoutMessage(false));
    expect(error).toMatch(/may still be applied/);
  });

  test("an answer just inside the limit is returned as usual", async () => {
    mockManager.restartIfDead.mockResolvedValue({
      ok: true,
      session: {
        query: {
          rewindFiles: () =>
            new Promise((r) => setTimeout(() => r({ canRewind: true }), REWIND_ROUTE_TIMEOUT_MS - 1)),
        },
      },
      restarted: false,
    });

    const res = post({ userMessageId: "u1", dryRun: true });
    await vi.advanceTimersByTimeAsync(REWIND_ROUTE_TIMEOUT_MS);
    const out = await res;

    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ result: { canRewind: true } });
  });

  test("the button's backstop outlasts the route's own limit", () => {
    expect(REWIND_CLIENT_TIMEOUT_MS).toBeGreaterThan(REWIND_ROUTE_TIMEOUT_MS);
  });
});
