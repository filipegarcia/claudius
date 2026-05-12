import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  getSessionTitlesByCwd,
  setSessionTitle,
} from "@/lib/server/sessions-db";
import { openDb } from "@/lib/server/db";
import { createWorkspace } from "@/lib/server/workspaces-store";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Regression coverage for `getSessionTitlesByCwd` — the batch lookup that
 * `/api/sessions/all` uses to enrich the SDK's cross-workspace listing
 * with our Claudius-side titles.
 *
 * Bug history (2026-05-12): the user kept seeing renamed sessions show
 * their UUID prefix in the tab strip until they clicked the tab and
 * refreshed the page. Two underlying causes:
 *
 *   1. Renames go through `setSessionTitle(cwd, id, title)` — DB write
 *      keyed by the cwd we hold at rename time — AND through the SDK's
 *      `renameSession` which writes the JSONL header. The SDK call
 *      silently fails when the JSONL doesn't exist yet (a brand-new
 *      session, no first turn), so the SDK's `customTitle` field
 *      reflects only a subset of renames.
 *
 *   2. The cross-workspace listing returns session info derived from
 *      the JSONL header, which sometimes has no `cwd` at all. Without
 *      a cwd we can't pick a `.claudius.db` to query, so the early
 *      version of this enrichment dropped those sessions on the floor.
 *
 * The fixed behavior, pinned down here:
 *   - DB rows at the session's reported cwd are found in the direct path.
 *   - Sessions WITHOUT a cwd in the SDK info fall back to fanning out
 *     across every registered workspace's DB.
 *   - The legacy `~/.claude/.claudius/session-titles.json` file (older
 *     renames that predate the per-project DB) is consulted as a
 *     last-resort cross-cwd source. No write — just read for surfacing.
 *
 * Tests work against a real temp $HOME so the cwd-keyed DB layout, the
 * workspaces-store discovery, and the legacy JSON file all live where
 * production code expects them.
 */

let tmp: TmpHome;

// Two distinct cwds used as fake workspace roots. The tests open both
// DBs explicitly via `openDb` (which runs migrations) before any title
// writes so the helper can rely on the `sessions` table existing.
const CWD_A = "/tmp/fake-claudius-workspace-A";
const CWD_B = "/tmp/fake-claudius-workspace-B";

beforeEach(async () => {
  tmp = makeTempHome();
  await openDb(CWD_A);
  await openDb(CWD_B);
});

afterEach(() => {
  tmp.restore();
});

/**
 * Register a workspace so `listWorkspaces()` finds it. The fan-out
 * branch of `getSessionTitlesByCwd` walks that list, so anything NOT
 * registered is invisible to the no-cwd fallback. Goes through the
 * real `createWorkspace` rather than hand-writing the JSON so any
 * schema validation in the store stays applied — older test fixtures
 * lost an entry to a stricter validator and we want to avoid the same
 * surprise here.
 */
async function registerWorkspace(rootPath: string, name: string): Promise<void> {
  await createWorkspace({ name, rootPath });
}

async function writeLegacyJson(map: Record<string, string>): Promise<void> {
  const dir = join(tmp.home, ".claude", ".claudius");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "session-titles.json"),
    JSON.stringify({ version: 1, titles: map }, null, 2),
    "utf8",
  );
}

describe("getSessionTitlesByCwd", () => {
  test("returns titles from the DB at the session's reported cwd", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Hello A");
    await setSessionTitle(CWD_B, "sess-2", "Hello B");

    const out = await getSessionTitlesByCwd([
      { cwd: CWD_A, id: "sess-1" },
      { cwd: CWD_B, id: "sess-2" },
    ]);

    expect(out.get(`${CWD_A}:sess-1`)).toBe("Hello A");
    expect(out.get(`${CWD_B}:sess-2`)).toBe("Hello B");
  });

  test("missing rows just don't appear (caller treats absence as 'no title')", async () => {
    await setSessionTitle(CWD_A, "sess-1", "Hello A");

    const out = await getSessionTitlesByCwd([
      { cwd: CWD_A, id: "sess-1" },
      { cwd: CWD_A, id: "sess-missing" },
    ]);

    expect(out.get(`${CWD_A}:sess-1`)).toBe("Hello A");
    expect(out.has(`${CWD_A}:sess-missing`)).toBe(false);
  });

  test("titles whitespace-trim consistently with setSessionTitle", async () => {
    // setSessionTitle trims on write — verify the read path doesn't get
    // confused if a row was inserted by an older code path with padding.
    await setSessionTitle(CWD_A, "sess-1", "  padded  ");
    const out = await getSessionTitlesByCwd([{ cwd: CWD_A, id: "sess-1" }]);
    expect(out.get(`${CWD_A}:sess-1`)).toBe("padded");
  });

  test("cwd-less sessions fan out across registered workspaces (the headline bug)", async () => {
    // The reported failure mode: SDK info has no `cwd` field, so we
    // can't pick a specific DB. The fan-out path walks every workspace
    // and finds the title wherever it lives.
    await registerWorkspace(CWD_A, "ws-a");
    await registerWorkspace(CWD_B, "ws-b");
    await setSessionTitle(CWD_B, "sess-orphan", "git");

    const out = await getSessionTitlesByCwd([
      { cwd: undefined, id: "sess-orphan" },
    ]);

    // No cwd in the input → result lands under the `*:id` fallback key.
    expect(out.get("*:sess-orphan")).toBe("git");
  });

  test("cwd-less fan-out short-circuits once every id is matched", async () => {
    // Defensive: with many workspaces but only one or two cwd-less
    // sessions, we shouldn't open every workspace's DB. We can't
    // directly observe that without instrumenting openDb, so the
    // behavioral assertion is just "the right titles came back."
    await registerWorkspace(CWD_A, "ws-a");
    await registerWorkspace(CWD_B, "ws-b");
    await setSessionTitle(CWD_A, "sess-1", "from A");
    await setSessionTitle(CWD_B, "sess-2", "from B");

    const out = await getSessionTitlesByCwd([
      { cwd: undefined, id: "sess-1" },
      { cwd: undefined, id: "sess-2" },
    ]);

    expect(out.get("*:sess-1")).toBe("from A");
    expect(out.get("*:sess-2")).toBe("from B");
  });

  test("legacy JSON file fills in pairs we still don't have a title for", async () => {
    // Pre-DB renames live in ~/.claude/.claudius/session-titles.json.
    // `getSessionTitle` migrates them on first read; the listing path
    // doesn't write, so this test just verifies the SHADOW read.
    await writeLegacyJson({ "sess-legacy": "from-legacy" });

    const out = await getSessionTitlesByCwd([
      { cwd: CWD_A, id: "sess-legacy" },
    ]);

    expect(out.get(`${CWD_A}:sess-legacy`)).toBe("from-legacy");
  });

  test("legacy JSON does NOT override a DB title that's already present", async () => {
    // The DB row wins — it's the newer, intentionally-persisted source.
    await setSessionTitle(CWD_A, "sess-1", "DB wins");
    await writeLegacyJson({ "sess-1": "legacy loses" });

    const out = await getSessionTitlesByCwd([{ cwd: CWD_A, id: "sess-1" }]);

    expect(out.get(`${CWD_A}:sess-1`)).toBe("DB wins");
  });

  test("legacy JSON also fills in cwd-less sessions", async () => {
    // Combined fallback: the SDK info has no cwd, fan-out finds nothing
    // in any workspace DB, and legacy has the title.
    await registerWorkspace(CWD_A, "ws-a");
    await writeLegacyJson({ "sess-orphan": "legacy git" });

    const out = await getSessionTitlesByCwd([
      { cwd: undefined, id: "sess-orphan" },
    ]);

    expect(out.get("*:sess-orphan")).toBe("legacy git");
  });

  test("empty inputs return an empty map", async () => {
    expect((await getSessionTitlesByCwd([])).size).toBe(0);
  });

  test("missing legacy file is non-fatal (no JSON to read)", async () => {
    // Don't write the legacy file. The DB hit still works; the legacy
    // miss must just be a no-op.
    await setSessionTitle(CWD_A, "sess-1", "only db");

    const out = await getSessionTitlesByCwd([{ cwd: CWD_A, id: "sess-1" }]);

    expect(out.get(`${CWD_A}:sess-1`)).toBe("only db");
  });

  test("ids without a cwd AND without a hit anywhere just don't appear", async () => {
    // Walk the full chain (no DB row, no workspace match, no legacy
    // entry) and confirm absence — the caller's job is to fall through
    // to the id prefix.
    await registerWorkspace(CWD_A, "ws-a");
    const out = await getSessionTitlesByCwd([
      { cwd: undefined, id: "sess-unknown" },
    ]);
    expect(out.has("*:sess-unknown")).toBe(false);
    expect(out.has(`${CWD_A}:sess-unknown`)).toBe(false);
  });

  test("a NULL title in the DB is treated as 'no title'", async () => {
    // setSessionTitle with an empty string clears the title to NULL —
    // make sure the lookup doesn't surface that as a real title.
    await setSessionTitle(CWD_A, "sess-1", "named");
    await setSessionTitle(CWD_A, "sess-1", "");

    const out = await getSessionTitlesByCwd([{ cwd: CWD_A, id: "sess-1" }]);

    expect(out.has(`${CWD_A}:sess-1`)).toBe(false);
  });

  test("skips pairs with empty ids and pairs missing both cwd and id", async () => {
    // Defensive — the API enrichment passes raw SDK output and we
    // shouldn't crash on degenerate inputs.
    await setSessionTitle(CWD_A, "sess-1", "real");
    const out = await getSessionTitlesByCwd([
      { cwd: CWD_A, id: "" },
      { cwd: undefined, id: "" },
      { cwd: CWD_A, id: "sess-1" },
    ]);
    expect(out.get(`${CWD_A}:sess-1`)).toBe("real");
    expect(out.size).toBe(1);
  });
});
