import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addAccount,
  getProfileById,
  setActiveAccount,
  deleteAccount,
} from "@/lib/server/accounts-store";

/**
 * Regression coverage for SESSION ACCOUNT PINNING.
 *
 * The bug: `Session.start()` resolved its credential with an unconditional
 * `getActiveProfile()`. That's right for a new session and wrong for a
 * resumed one. Sessions are reaped after an idle window (60min), and
 * clicking back into a reaped tab fires a wake `POST /api/sessions {resume}`
 * which runs `start()` again. If the user switched accounts in between, the
 * resumed conversation silently continued under the NEW credential — same
 * transcript, different identity, different bill.
 *
 * It was invisible in the UI because each profile's `CLAUDE_CONFIG_DIR`
 * mirror symlinks `projects/` back to the real `~/.claude/projects`, so
 * resume finds the JSONL under either account. The only outward tell was
 * the agent's own injected context (user email, per-profile memory dir)
 * flipping mid-thread.
 *
 * The fix is `Session.resolveAccountProfile()`: persist the resolved profile
 * id into the session's state bag on first resolve, and prefer it on every
 * later start. These tests pin the resolution *policy* directly — the
 * Session class itself can't be instantiated in a unit context (its
 * constructor path spawns an SDK query), so we exercise the same
 * accounts-store primitives the policy is built on, plus a faithful
 * reimplementation of the precedence rules.
 */

/**
 * The precedence `Session.resolveAccountProfile()` implements. Kept in
 * lock-step with the real method; if that changes, this must too.
 *
 *   1. Pinned profile, when it still exists.
 *   2. Active profile otherwise (fresh session, or pin points at a
 *      since-deleted account) — and re-pin to it.
 */
async function resolve(
  state: { accountProfileId?: string },
  active: { id: string; label: string } | null,
): Promise<{ id: string; label: string; repinned: boolean } | null> {
  if (state.accountProfileId) {
    const pinned = await getProfileById(state.accountProfileId);
    if (pinned) return { id: pinned.id, label: pinned.label, repinned: false };
  }
  if (!active) return null;
  state.accountProfileId = active.id;
  return { id: active.id, label: active.label, repinned: true };
}

describe("session account pinning", () => {
  let tmp: string;
  let a: string;
  let b: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "claudius-pin-"));
    process.env.CLAUDIUS_ACCOUNTS_DIR = tmp;
    const addedA = await addAccount({ label: "Filipe", kind: "api-key", secret: "sk-ant-aaaa" });
    a = addedA.profile.id;
    const addedB = await addAccount({
      label: "Engineering",
      kind: "api-key",
      secret: "sk-ant-bbbb",
    });
    b = addedB.profile.id;
    await setActiveAccount(a);
  });

  afterEach(() => {
    delete process.env.CLAUDIUS_ACCOUNTS_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a fresh session adopts the active profile and records the pin", async () => {
    const state: { accountProfileId?: string } = {};
    const got = await resolve(state, { id: a, label: "Filipe" });

    expect(got?.id).toBe(a);
    expect(got?.repinned).toBe(true);
    // The pin must be durable — this is what the next start() reads.
    expect(state.accountProfileId).toBe(a);
  });

  test("resuming after an account switch keeps the ORIGINAL account", async () => {
    // Session started on A and recorded the pin.
    const state: { accountProfileId?: string } = {};
    await resolve(state, { id: a, label: "Filipe" });
    expect(state.accountProfileId).toBe(a);

    // User switches the global default to B, session gets reaped, comes back.
    await setActiveAccount(b);
    const afterResume = await resolve(state, { id: b, label: "Engineering" });

    // The core assertion: the resumed session is still on A, NOT the new
    // active B. Pre-fix this returned B and the thread changed identity.
    expect(afterResume?.id).toBe(a);
    expect(afterResume?.label).toBe("Filipe");
    expect(afterResume?.repinned).toBe(false);
  });

  test("the pin survives repeated resumes, not just the first", async () => {
    const state: { accountProfileId?: string } = {};
    await resolve(state, { id: a, label: "Filipe" });
    await setActiveAccount(b);

    for (let i = 0; i < 3; i++) {
      const got = await resolve(state, { id: b, label: "Engineering" });
      expect(got?.id).toBe(a);
    }
    expect(state.accountProfileId).toBe(a);
  });

  test("a pin pointing at a deleted account falls back to active and re-pins", async () => {
    const state: { accountProfileId?: string } = { accountProfileId: a };
    await deleteAccount(a);
    await setActiveAccount(b);

    const got = await resolve(state, { id: b, label: "Engineering" });

    // Must not throw or strand the session on a dead id.
    expect(got?.id).toBe(b);
    expect(got?.repinned).toBe(true);
    // Re-pinned, so we stop chasing the dead id on every future start.
    expect(state.accountProfileId).toBe(b);
  });

  test("no configured accounts resolves to null (ambient env, pre-switcher behavior)", async () => {
    const state: { accountProfileId?: string } = {};
    const got = await resolve(state, null);
    expect(got).toBeNull();
    expect(state.accountProfileId).toBeUndefined();
  });

  test("moving to the active account rewrites the pin (the escape hatch)", async () => {
    const state: { accountProfileId?: string } = {};
    await resolve(state, { id: a, label: "Filipe" });
    await setActiveAccount(b);

    // `Session.moveToActiveAccount()` — unconditionally adopt the active id.
    state.accountProfileId = b;

    const got = await resolve(state, { id: b, label: "Engineering" });
    expect(got?.id).toBe(b);
    // And it stays moved; the old pin does not resurrect.
    expect(state.accountProfileId).toBe(b);
  });
});
