import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * Auth-presence probe. The test spawns a fresh dev server under an isolated
 * `HOME=tempdir` (see `playwright.config.ts`), and the SDK in turn spawns
 * the `claude` CLI as a subprocess inheriting that HOME. Two creds paths
 * actually reach a subprocess in that setup:
 *   - `ANTHROPIC_API_KEY` env (inherited by the spawn chain)
 *   - `~/.claude/.credentials.json` in the REAL homedir (the CLI reads from
 *     the user's home regardless of HOME on darwin in some builds)
 *
 * macOS-keychain auth (the `Claude Code-credentials` Generic Password the
 * CLI writes when you log in via the TUI) is bound to the user's keychain
 * session and is NOT visible to a subprocess that's been re-HOME'd into a
 * tempdir, so we don't probe it here — the test would skip-then-fail with
 * "Not logged in" if we did.
 */
function hasAnthropicAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (existsSync(join(homedir(), ".claude", ".credentials.json"))) return true;
  return false;
}

/**
 * Regression coverage for the reported "messages render out of order, and a
 * different bubble gets pinned each refresh" bug.
 *
 * Scenario: build a session with several real turns (so the buffer in memory
 * holds historical assistants alongside live ones — the same shape that
 * surfaced the bug), then reload the page multiple times. Each reload should
 * paint the exact same uuid-ordered transcript and pin the same last user
 * bubble. If the bug regresses, refreshes start producing different orderings
 * and the assertion fails.
 *
 * Hits the real Anthropic agent because the bug is in the cross-path
 * interaction between `Session.start()` disk replay, the SSE replay window,
 * the `session_snapshot` rehydration, and the client's defensive sort —
 * mocked specs can't exercise that.
 */
test.describe("transcript order stability across refreshes", () => {
  test("repeated refreshes produce the same uuid sequence and pinned user bubble", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !hasAnthropicAuth(),
      "needs Anthropic credentials (env / .credentials.json / macOS keychain `Claude Code-credentials`) — this test drives the live agent",
    );
    test.setTimeout(360_000); // three real turns, then five reloads

    await page.goto("/");
    await page.waitForURL(SESSION_RE, { timeout: 30_000 });
    const sessionId = page.url().match(SESSION_RE)![1];

    // Bypass permissions so a tool-using prompt doesn't gate on a modal.
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok()).toBeTruthy();

    const textarea = page.getByTestId("prompt-input");
    const send = page.getByTestId("prompt-send");

    // Three short turns. Three is enough to populate `latestUserPromptSnapshot`
    // distinctly across turns, exercise the tail-window slicing, and force
    // the chronological sort to discriminate among multiple real prompts.
    // Each prompt asks the agent to echo a distinct token so we can verify
    // the turn actually ran (not just that the send button reappeared, which
    // would also be true if the SDK silently no-op'd on auth failure).
    const prompts: Array<{ text: string; expectInReply: string }> = [
      {
        text: "Reply with the single word: alpha. Nothing else.",
        expectInReply: "alpha",
      },
      {
        text: "Reply with the single word: beta. Nothing else.",
        expectInReply: "beta",
      },
      {
        text: "Reply with the single word: gamma. Nothing else.",
        expectInReply: "gamma",
      },
    ];
    for (const { text, expectInReply } of prompts) {
      await expect(textarea).toBeEnabled({ timeout: 30_000 });
      await textarea.fill(text);
      await send.click();
      // Wait for the assistant reply to actually contain the expected token —
      // the strongest signal that the live agent ran end-to-end. Without this
      // an auth failure that silently no-ops would still satisfy a button-
      // visibility check, and the test would falsely pass.
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const assistants = Array.from(
                document.querySelectorAll<HTMLElement>(
                  '[data-message-uuid][data-message-role="assistant"]',
                ),
              );
              return assistants.map((n) => n.innerText).join("\n");
            }),
          {
            message: `expected an assistant reply containing "${expectInReply}"`,
            timeout: 120_000,
            intervals: [500, 1000, 2000],
          },
        )
        .toContain(expectInReply);
      await expect(send).toBeVisible({ timeout: 120_000 });
    }

    // Snapshot the transcript: ordered list of `{role, uuid}` from the DOM,
    // plus the uuid of the user bubble currently pinned (sticky position
    // applies `top: 0` only to the bubble the chronological pin selects).
    async function snapshot(p: Page): Promise<{
      sequence: Array<{ role: string; uuid: string }>;
      pinnedUserUuid: string | null;
    }> {
      // Wait for the transcript to settle: send button visible (turn done)
      // AND at least one user + one assistant bubble in the DOM.
      await expect(p.getByTestId("prompt-send")).toBeVisible({ timeout: 60_000 });
      await p.waitForFunction(
        () => {
          const users = document.querySelectorAll(
            '[data-message-uuid][data-message-role="user"]',
          ).length;
          const assistants = document.querySelectorAll(
            '[data-message-uuid][data-message-role="assistant"]',
          ).length;
          return users >= 3 && assistants >= 3;
        },
        { timeout: 60_000 },
      );
      return await p.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>("[data-message-uuid]"),
        );
        const sequence = nodes.map((n) => ({
          role: n.getAttribute("data-message-role") ?? "",
          uuid: n.getAttribute("data-message-uuid") ?? "",
        }));
        // Pinned = first user bubble whose computed position is sticky AND
        // whose class list includes the sticky-class marker. The sticky
        // bubble is the one the chronological-pin walk landed on.
        const pinnedNode = nodes.find(
          (n) =>
            n.getAttribute("data-message-role") === "user" &&
            n.className.includes("sticky"),
        );
        return {
          sequence,
          pinnedUserUuid: pinnedNode?.getAttribute("data-message-uuid") ?? null,
        };
      });
    }

    const baseline = await snapshot(page);
    expect(baseline.sequence.length).toBeGreaterThanOrEqual(6);
    expect(baseline.pinnedUserUuid, "a user bubble should be pinned").toBeTruthy();

    // The transcript should already be chronological: each user bubble
    // followed by its assistant reply. With three prompts the user/assistant
    // bubbles should interleave U,A,U,A,U,A (skipping any system pills which
    // aren't tagged with data-message-role).
    const baselineRoles = baseline.sequence.map((s) => s.role);
    const interleaved: string[] = [];
    for (let i = 0; i < 3; i++) {
      interleaved.push("user");
      interleaved.push("assistant");
    }
    expect(baselineRoles.slice(0, interleaved.length)).toEqual(interleaved);

    // Five reloads. Each one tears down the page entirely; the server's
    // in-memory session keeps the buffer alive, so the bug (a buffer that
    // drifts non-chronological under refresh-induced races) would surface
    // here as different sequences across passes.
    const REFRESH_PASSES = 5;
    for (let pass = 1; pass <= REFRESH_PASSES; pass++) {
      await page.goto(`/?session=${sessionId}`);
      const snap = await snapshot(page);
      expect(
        snap.sequence,
        `refresh pass #${pass}: uuid sequence must match the baseline`,
      ).toEqual(baseline.sequence);
      expect(
        snap.pinnedUserUuid,
        `refresh pass #${pass}: pinned user bubble must match the baseline (was ${baseline.pinnedUserUuid}, got ${snap.pinnedUserUuid})`,
      ).toBe(baseline.pinnedUserUuid);
    }
  });
});
