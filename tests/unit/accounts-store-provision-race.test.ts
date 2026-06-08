import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addAccount, buildEnvForProfile } from "@/lib/server/accounts-store";

/**
 * Regression coverage for the .credentials.json atomic-write race.
 *
 * The bug: `provisionProfileConfigDir` used `${credsPath}.${process.pid}.tmp`
 * as the temp filename. Two concurrent `buildEnvForProfile(sameProfile)`
 * calls within the same Node process — the common case when the user
 * starts multiple sessions back-to-back (or when the updater's "Resolve
 * with Claude Code" path spawns a session while the chat composer is
 * mid-init) — collide on the same tmp path:
 *
 *   1. Call A writeFile(tmp)   — tmp now contains A's content
 *   2. Call B writeFile(tmp)   — overwrites with B's content
 *   3. Call A rename(tmp, …)   — succeeds, tmp is now gone
 *   4. Call B rename(tmp, …)   — throws `ENOENT: no such file or directory,
 *                                rename '<tmp>' → '<credsPath>'`
 *
 * The user-visible symptom was a red bar in /chat:
 *   `create session failed: Error: ENOENT … rename
 *    '/.../profiles/acc_…/.credentials.json.51725.tmp' →
 *    '/.../profiles/acc_…/.credentials.json'`
 *
 * Fix: include `crypto.randomBytes(6).toString("hex")` in the tmp name so
 * every call gets a unique source for `rename`. The final `credentials.json`
 * is content-deterministic from the profile, so a last-writer-wins rename
 * is fine — we just can't have one of the writers throw partway.
 */

describe("accounts-store: concurrent buildEnvForProfile must not race the credentials.json rename", () => {
  let tmp: string;

  beforeEach(() => {
    // Isolate every test to its own tmp accounts dir — the production code
    // honors CLAUDIUS_ACCOUNTS_DIR so we don't touch ~/.claude/.claudius
    // (the user's real credentials live there).
    tmp = mkdtempSync(join(tmpdir(), "claudius-accounts-race-"));
    process.env.CLAUDIUS_ACCOUNTS_DIR = tmp;
    // The credential blob writer reads ~/.claude/ to mirror plugins/etc.
    // Point that at an empty tmp dir too so we don't depend on the host
    // user having (or not having) a real ~/.claude/. The mirror is best-
    // effort; pointing it at the same tmp dir is fine (entries scoped
    // under tmp/ get listed but symlink writes are harmless dups).
  });

  afterEach(() => {
    delete process.env.CLAUDIUS_ACCOUNTS_DIR;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test(
    "20 concurrent buildEnvForProfile calls all succeed and leave a readable credentials.json",
    async () => {
      // Add an OAuth-token profile — the kind that triggers the
      // credentials.json write path (api-key profiles delete instead).
      const { profile } = await addAccount({
        label: "race-test",
        kind: "oauth-token",
        secret: "sk-ant-oat01-AAAA-test-token-not-real",
      });

      // 20 is well above the typical pre-fix collision threshold; the
      // original ${pid}.tmp scheme fails reliably at 2.
      const RACE_COUNT = 20;
      const results = await Promise.allSettled(
        Array.from({ length: RACE_COUNT }, () => buildEnvForProfile(profile)),
      );

      const rejections = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));

      expect(
        rejections,
        `no rejections expected, got:\n${rejections.join("\n")}`,
      ).toEqual([]);

      // Every successful call returns an env whose CLAUDE_CONFIG_DIR
      // points at the per-profile dir. Spot-check the first one.
      const first = results[0];
      if (first.status !== "fulfilled") throw new Error("unreachable");
      const dir = first.value.CLAUDE_CONFIG_DIR;
      expect(typeof dir).toBe("string");
      expect(dir).toContain(profile.id);

      // The final credentials.json must exist, be readable, and contain
      // the OAuth blob — proof that the last-writer-wins rename actually
      // landed valid content rather than e.g. an empty tmp leftover.
      const credsPath = join(dir!, ".credentials.json");
      const raw = await fs.readFile(credsPath, "utf8");
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      expect(parsed.claudeAiOauth?.accessToken).toBe(
        "sk-ant-oat01-AAAA-test-token-not-real",
      );

      // No tmp files left behind. A failed rename used to leak the tmp
      // (which held the raw token under 0600); the fix now unlinks on
      // failure. Glob-check the profile dir.
      const entries = await fs.readdir(dir!);
      const leakedTmps = entries.filter((n) => n.endsWith(".tmp"));
      expect(leakedTmps).toEqual([]);
    },
    20_000,
  );
});
