import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listIndexedSessions, upsertSession } from "@/lib/server/sessions-db";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Pin down the DB persistence path that `Session.setModel` relies on for
 * the model picker.
 *
 * The picker calls `Session.setModel(value)`, which:
 *   1. forwards the change to the SDK via `query.setModel`,
 *   2. mutates `this.model`,
 *   3. **persists by calling `upsertSession({ id, cwd, model })`** so the
 *      pick survives reap → resume. Without step 3 the picker felt lossy:
 *      every closed tab reset the model to whatever the constructor seeded.
 *
 * Step 3 is the only part testable without an SDK process. The
 * `sessions.model` column has been around since migration 002, and
 * `upsertSession` uses `COALESCE(excluded.model, sessions.model)` in the
 * ON CONFLICT clause — so undefined doesn't clobber a previous pick. Both
 * behaviors are pinned here.
 */

let tmp: TmpHome;
const CWD = "/tmp/fake-claudius-model-picker";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

describe("model picker DB persistence", () => {
  test("upsert writes the model on first insert", async () => {
    await upsertSession({
      id: "sess-1",
      cwd: CWD,
      model: "claude-opus-4-7",
    });

    const rows = await listIndexedSessions(CWD);
    const row = rows.find((r) => r.id === "sess-1");
    expect(row).toBeDefined();
    expect(row?.model).toBe("claude-opus-4-7");
  });

  test("subsequent upsert with a new model overwrites the previous pick", async () => {
    // Seed: session created with one model.
    await upsertSession({
      id: "sess-2",
      cwd: CWD,
      model: "claude-sonnet-4-6",
    });

    // User picks a different model in the picker. Same id, new model.
    await upsertSession({
      id: "sess-2",
      cwd: CWD,
      model: "claude-opus-4-7",
    });

    const rows = await listIndexedSessions(CWD);
    const row = rows.find((r) => r.id === "sess-2");
    expect(row?.model).toBe("claude-opus-4-7");
  });

  test("upsert with undefined model preserves the previous pick (COALESCE)", async () => {
    // Seed.
    await upsertSession({
      id: "sess-3",
      cwd: CWD,
      model: "claude-opus-4-7",
    });

    // Internal flow: `Session.start()` upserts on every boot with the
    // model the constructor was given. If the user previously picked a
    // model that's now stored on the row, we don't want the boot upsert
    // to wipe it just because the constructor wasn't passed a model.
    await upsertSession({
      id: "sess-3",
      cwd: CWD,
      model: undefined,
    });

    const rows = await listIndexedSessions(CWD);
    const row = rows.find((r) => r.id === "sess-3");
    expect(
      row?.model,
      "undefined model must not clobber a previously persisted pick",
    ).toBe("claude-opus-4-7");
  });

  test("title is INSERT-only — re-upserting doesn't overwrite a custom title", async () => {
    // Why this test lives here: `Session.setModel` passes `title: this.title`
    // through to `upsertSession`. We need to be sure that doesn't accidentally
    // rewrite a user-renamed title when the in-memory title field is stale
    // or undefined.

    await upsertSession({
      id: "sess-4",
      cwd: CWD,
      title: "Original",
    });
    await upsertSession({
      id: "sess-4",
      cwd: CWD,
      model: "claude-opus-4-7",
      title: undefined,
    });

    const rows = await listIndexedSessions(CWD);
    const row = rows.find((r) => r.id === "sess-4");
    expect(row?.title).toBe("Original");
    expect(row?.model).toBe("claude-opus-4-7");
  });
});
