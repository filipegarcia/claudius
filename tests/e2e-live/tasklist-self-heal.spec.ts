import { test, expect } from "@playwright/test";

const SESSION_RE = /[?&]session=([0-9a-f-]{36})/i;

/**
 * Live regression for the `TaskList` rail self-heal — the bug observed in
 * session `a31d05a5` (advisor-feature work, June 7 2026) where the user
 * saw the rail show `(0) No tasks yet` while the SDK's task store still
 * held a populated list, asked "mark them all done", the model truthfully
 * reported success, and the rail stayed empty.
 *
 * Root cause (see `lib/shared/parse-tasklist-result.ts` header and
 * `lib/server/session.ts` `captureSnapshotState`):
 *
 *   - `clearTodos()` (manual button, "completed" auto-clear, or staleness
 *     auto-clear) nulls `latestTodosSnapshot` while the SDK's own task
 *     store still has live items.
 *   - The `TaskUpdate` observer is gated on `&& this.latestTodosSnapshot`,
 *     so every subsequent TaskUpdate is silently dropped — the rail can
 *     never repopulate from TaskUpdate traffic.
 *   - Nothing observed `TaskList` tool_results, so the rail had no path
 *     back from the SDK's source of truth.
 *
 * Fix: register TaskList tool_use_ids in `pendingTaskLists`; on the
 * matching tool_result, parse the SDK's authoritative list and rebuild
 * `latestTodosSnapshot`. The `todosRebuiltFromTaskListThisTurn` flag
 * suppresses the all-completed auto-clear for one turn so the rebuilt
 * list actually survives long enough to be visible.
 *
 * This e2e exercises the full path: create 20 tasks via TaskCreate, force
 * a desync by clicking Clear, then ask the model to mark them all
 * completed and verify the rail rebuilds and stays populated through turn
 * end.
 *
 * IMPORTANT: drives the real Anthropic API; needs an API key (or
 * ~/.claude/.credentials.json), network, and a couple of cents per run.
 * 20 TaskCreate + 1 TaskList + 20 TaskUpdate is ~41 tool calls across two
 * turns — give the model plenty of headroom (5 min total).
 */
test.describe("TaskList rail self-heal — 20 tasks, desync, mark all done", () => {
  test("create 20 → clear rail → ask to mark all done → rail rebuilds to 20/20 and survives turn end", async ({
    page,
    baseURL,
  }) => {
    test.skip(
      !process.env.ANTHROPIC_API_KEY,
      "needs ANTHROPIC_API_KEY (or ~/.claude/.credentials.json on a logged-in machine) — this test drives the live Anthropic agent",
    );
    test.setTimeout(300_000); // 5 min — two heavy multi-tool turns.

    // 1. Open the chat and capture the session id.
    await page.goto("/");
    await page.waitForURL(SESSION_RE, { timeout: 30_000 });
    const sessionId = page.url().match(SESSION_RE)![1];

    // 2. Wait for the composer to be ready.
    const textarea = page.getByTestId("prompt-input");
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 30_000 });

    // 3. Bypass permissions so the SDK's TaskCreate / TaskUpdate / TaskList
    //    tools don't pop a permission prompt for each call (20 prompts
    //    would be untestable).
    const modeRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/mode`,
      { data: { mode: "bypassPermissions" } },
    );
    expect(modeRes.ok(), "switching to bypassPermissions should succeed").toBeTruthy();

    // 4. Ask the agent to create exactly 20 tasks via TaskCreate. The
    //    prompt is intentionally narrow — one tool family, no chatter —
    //    so the test doesn't depend on incidental tokens.
    const createPrompt = [
      "Use the TaskCreate tool RIGHT NOW to create exactly 20 tasks, one TaskCreate call per task.",
      "Each task's subject should be 'Task N' where N is the task number (1 through 20).",
      "Each task's activeForm should be the same as its subject.",
      "Do NOT use TodoWrite. Do NOT use any other tool. Do NOT write any other text in your reply.",
      "After the 20th TaskCreate call, stop.",
    ].join("\n");
    await textarea.fill(createPrompt);
    await page.getByTestId("prompt-send").click();

    // 5. Wait for the chat banner to surface a 20-item todo list. The
    //    banner reads `<done>/<total>` — we want 0/20 (everything pending).
    //    Use a generous timeout for the create burst.
    const progress = page.getByTestId("todos-banner-progress");
    await expect(progress).toBeVisible({ timeout: 120_000 });
    await expect(progress).toHaveText("0/20", { timeout: 90_000 });

    // 6. Wait for the agent to finish the create turn.
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 90_000 });
    // Sanity: 20 pending items in the banner list.
    await expect(page.getByTestId("todos-banner-item-pending")).toHaveCount(20);

    // 7. FORCE THE DESYNC — POST to the clear-todos route. This is the
    //    same code path the user's "Clear" button takes (and the same
    //    server-side state mutation the `"completed"` / `"stale"` auto-
    //    clears produce): `latestTodosSnapshot = null`, `todosClearedAt`
    //    persisted to session_state, `session_snapshot { todos: [] }`
    //    broadcast. The SDK's own task store is NOT touched — that's the
    //    desync we're testing the heal for.
    const clearRes = await page.request.post(
      `${baseURL}/api/sessions/${sessionId}/clear-todos`,
    );
    expect(clearRes.ok(), "clear-todos POST should succeed").toBeTruthy();

    // 8. Banner disappears once `latestTodos` is empty (TodosBanner early-
    //    returns on `todos.length === 0`). This confirms the desync is
    //    in effect: rail thinks there's nothing, SDK still has 20.
    await expect(progress).not.toBeVisible({ timeout: 15_000 });

    // 9. Ask the agent to refresh from TaskList and mark all completed.
    //    Forcing TaskList first is what exercises the fix — without it
    //    the model could go straight to TaskUpdate × 20, but the gated
    //    observer would drop every update and the rail would stay empty.
    //    With TaskList in the loop, the result observer rebuilds
    //    `latestTodosSnapshot` from the SDK's authoritative list and
    //    each subsequent TaskUpdate then lands normally.
    const completePrompt = [
      "The 20 tasks you created earlier still exist on the server (the local display was cleared by the user but the underlying tasks are intact).",
      "First call TaskList to retrieve the current list of tasks with their ids.",
      "Then, for each task in the TaskList result, call TaskUpdate with that task's id and status='completed'.",
      "Do NOT create new tasks. Do NOT use TodoWrite. Do NOT write any other text in your reply.",
      "After every task is marked completed, stop.",
    ].join("\n");
    await textarea.fill(completePrompt);
    await page.getByTestId("prompt-send").click();

    // 10. The TaskList tool_result arrives mid-turn → the server's
    //     captureSnapshotState rebuilds the snapshot from the parsed
    //     list, broadcasts a `session_snapshot`, and the client repaints.
    //     The banner reappears. (At this exact instant the items are
    //     still [pending] from the SDK's side — the TaskUpdate burst
    //     starts immediately after.)
    await expect(progress).toBeVisible({ timeout: 120_000 });

    // 11. The TaskUpdate burst flips every item to completed; banner
    //     should reach 20/20.
    await expect(progress).toHaveText("20/20", { timeout: 120_000 });
    await expect(page.getByTestId("todos-banner-item-completed")).toHaveCount(20);
    await expect(page.getByTestId("todos-banner-item-pending")).toHaveCount(0);

    // 12. Wait for the turn to fully end (Send button reappears in place
    //     of the Interrupt). This is the moment `maybeAutoSyncTodosOnTurnEnd`
    //     fires server-side. Without the suppression flag the all-completed
    //     auto-clear would now wipe the rail back to (0) — same screenshot
    //     the user reported, fix inert.
    await expect(page.getByTestId("prompt-send")).toBeVisible({ timeout: 60_000 });

    // 13. THE KEY POST-FIX ASSERTION — the banner must STILL show 20/20
    //     after turn end. The `todosRebuiltFromTaskListThisTurn` flag set
    //     by the TaskList result handler suppressed the all-completed
    //     auto-clear for this one turn so the user actually sees the
    //     rebuilt list. Without the flag, this assertion fails because
    //     `clearTodos("completed")` would have fired in
    //     maybeAutoSyncTodosOnTurnEnd and broadcast `todos: []`.
    await expect(progress).toBeVisible();
    await expect(progress).toHaveText("20/20");
    await expect(page.getByTestId("todos-banner-item-completed")).toHaveCount(20);
  });
});
