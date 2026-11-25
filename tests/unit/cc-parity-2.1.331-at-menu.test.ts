import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { atMenuKeyAction, atTokenBlocksEnter, heldEnterOutcome } from "@/components/chat/at-mention";
import { listFs, searchFs } from "@/lib/server/fs-list";

/**
 * CC 2.1.331 parity —
 *   "[VSCode] Fixed the @ menu inserting the wrong file on a quick Tab or
 *    Enter, and Enter not sending a prompt that ends in an @word with no
 *    matching file", and
 *   "[VSCode] Fixed the @ menu showing "No files found" before its first
 *    search results arrived, or when it couldn't search all files of a very
 *    large workspace, which it now says".
 */
describe("atMenuKeyAction (CC 2.1.331)", () => {
  test("while the current token's search is running, Tab/Enter is held, even over stale rows", () => {
    expect(atMenuKeyAction({ loading: true, rows: 30 })).toBe("hold");
    expect(atMenuKeyAction({ loading: true, rows: 0 })).toBe("hold");
  });

  test("with results in, a row is picked", () => {
    expect(atMenuKeyAction({ loading: false, rows: 3 })).toBe("pick");
  });

  test("with nothing to pick, the key passes on to the composer", () => {
    expect(atMenuKeyAction({ loading: false, rows: 0 })).toBe("pass");
  });
});

describe("atTokenBlocksEnter (CC 2.1.331)", () => {
  test("no @ token: Enter sends", () => {
    expect(atTokenBlocksEnter(null, null)).toBe(false);
  });

  test("an @ token whose menu has rows (or is searching) holds Enter for the pick", () => {
    expect(atTokenBlocksEnter("src/fo", null)).toBe(true);
  });

  test("an @word with no matching file lets Enter send", () => {
    expect(atTokenBlocksEnter("claude", "claude")).toBe(false);
  });

  test("an empty report for an earlier token doesn't unblock a new one", () => {
    expect(atTokenBlocksEnter("claudius", "claude")).toBe(true);
  });
});

describe("heldEnterOutcome (CC 2.1.331)", () => {
  // An Enter pressed while the search for `zzzz` was running used to be
  // swallowed outright, so the prompt didn't send until Enter was pressed again.
  test("waits while the search for the held token is still running", () => {
    expect(heldEnterOutcome({ heldFor: "zzzz", query: "zzzz", loading: true, rows: 0 })).toBe("wait");
    expect(heldEnterOutcome({ heldFor: "zzzz", query: "zzzz", loading: true, rows: 3 })).toBe("wait");
  });

  test("sends once that search answers with nothing to pick", () => {
    expect(heldEnterOutcome({ heldFor: "zzzz", query: "zzzz", loading: false, rows: 0 })).toBe("send");
  });

  test("drops it when the search found files: the rows show, nothing is inserted or sent", () => {
    expect(heldEnterOutcome({ heldFor: "src", query: "src", loading: false, rows: 2 })).toBe("drop");
  });

  test("drops it when the token changed before the search answered", () => {
    expect(heldEnterOutcome({ heldFor: "zzz", query: "zzzz", loading: true, rows: 0 })).toBe("drop");
    expect(heldEnterOutcome({ heldFor: "zzz", query: "zzzz", loading: false, rows: 0 })).toBe("drop");
  });
});

describe("searchFs reports a partial walk (CC 2.1.331)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fs-search-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("a small tree is searched in full", async () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "");
    writeFileSync(join(cwd, "README.md"), "");
    const r = await searchFs({ cwd, query: "a" });
    expect(r.truncated).toBe(false);
    expect(r.entries.map((e) => e.relPath)).toContain("src/a.ts");
  });

  test("hitting the entry cap with folders left is partial", async () => {
    for (const d of ["a", "b", "c"]) {
      mkdirSync(join(cwd, d));
      writeFileSync(join(cwd, d, "x.ts"), "");
    }
    const r = await searchFs({ cwd, walkMax: 2 });
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(2);
  });

  test("folders past the depth limit are not searched, and that's reported", async () => {
    const deep = join(cwd, "l1", "l2", "l3");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "target.ts"), "");
    const r = await searchFs({ cwd, query: "target", walkMaxDepth: 2 });
    expect(r.entries).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  test("listFs keeps returning the plain entry list", async () => {
    writeFileSync(join(cwd, "one.ts"), "");
    expect((await listFs({ cwd })).map((e) => e.relPath)).toEqual(["one.ts"]);
  });
});
