import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  deleteRule,
  isValidRuleFilename,
  listRules,
  readRule,
  rulesDir,
  writeRule,
} from "@/lib/server/rules";
import { PathInjectionError } from "@/lib/server/safe-path";

/**
 * Pins the plain-text rule-file CRUD (Memory & Files cheat-sheet items 05/06).
 * Rule files are raw markdown under `<cwd>/.claude/rules/*.md` (project) and
 * `~/.claude/rules/*.md` (user) — no frontmatter, no type, no MEMORY.md index.
 */
describe("rules CRUD", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "rules-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("isValidRuleFilename", () => {
    test("accepts a bare *.md filename", () => {
      expect(isValidRuleFilename("style.md")).toBe(true);
      expect(isValidRuleFilename("a-b_c.1.md")).toBe(true);
    });
    test("rejects traversal, slashes, wrong ext, empty, null byte", () => {
      expect(isValidRuleFilename("../x.md")).toBe(false);
      expect(isValidRuleFilename("a/b.md")).toBe(false);
      expect(isValidRuleFilename("x.txt")).toBe(false);
      expect(isValidRuleFilename("")).toBe(false);
      expect(isValidRuleFilename("x\0.md")).toBe(false);
    });
  });

  describe("rulesDir", () => {
    test("user scope resolves under homedir/.claude/rules", () => {
      expect(rulesDir("user")).toBe(join(homedir(), ".claude", "rules"));
    });
    test("project scope resolves under <cwd>/.claude/rules", () => {
      expect(rulesDir("project", cwd)).toBe(join(cwd, ".claude", "rules"));
    });
    test("project scope with missing cwd throws PathInjectionError", () => {
      expect(() => rulesDir("project")).toThrow(PathInjectionError);
      expect(() => rulesDir("project", null)).toThrow(PathInjectionError);
    });
    test("project scope with relative or empty cwd throws PathInjectionError", () => {
      expect(() => rulesDir("project", "relative/path")).toThrow(PathInjectionError);
      expect(() => rulesDir("project", "")).toThrow(PathInjectionError);
    });
  });

  describe("write / read / list / delete roundtrip", () => {
    test("create stores the exact body (no frontmatter added)", async () => {
      const bodyText = "# Style\n\nUse tabs.\n";
      const w = await writeRule("project", "style.md", bodyText, cwd);
      expect(w.ok).toBe(true);

      const back = await readRule("project", "style.md", cwd);
      expect(back).toBe(bodyText);

      const list = await listRules("project", cwd);
      expect(list.map((f) => f.name)).toContain("style.md");

      const del = await deleteRule("project", "style.md", cwd);
      expect(del.ok).toBe(true);

      expect(await readRule("project", "style.md", cwd)).toBeNull();

      const del2 = await deleteRule("project", "style.md", cwd);
      expect(del2).toEqual({ ok: false, status: 404, error: "not found" });
    });

    test("listRules returns [] when the dir does not exist", async () => {
      expect(await listRules("project", cwd)).toEqual([]);
    });
  });

  describe("create vs overwrite semantics", () => {
    test("creating twice returns 409", async () => {
      const first = await writeRule("project", "dup.md", "one", cwd);
      expect(first.ok).toBe(true);
      const second = await writeRule("project", "dup.md", "two", cwd);
      expect(second).toEqual({ ok: false, status: 409, error: "file already exists" });
      // The original body is untouched.
      expect(await readRule("project", "dup.md", cwd)).toBe("one");
    });

    test("overwrite replaces the content of an existing file", async () => {
      await writeRule("project", "edit.md", "before", cwd);
      const up = await writeRule("project", "edit.md", "after", cwd, true);
      expect(up.ok).toBe(true);
      expect(await readRule("project", "edit.md", cwd)).toBe("after");
    });

    test("overwrite of a missing file returns 404 (never creates)", async () => {
      const up = await writeRule("project", "ghost.md", "body", cwd, true);
      expect(up).toEqual({ ok: false, status: 404, error: "not found" });
      // Nothing was written.
      expect(await listRules("project", cwd)).toEqual([]);
    });
  });

  describe("path traversal is rejected", () => {
    test("writeRule with a traversal name is a 400 and writes nothing outside", async () => {
      const r = await writeRule("project", "../escape.md", "x", cwd);
      expect(r).toMatchObject({ ok: false, status: 400 });
      // The parent of cwd must not have gained an escape.md.
      const parent = cwd.slice(0, cwd.lastIndexOf(sep));
      expect(readdirSync(parent)).not.toContain("escape.md");
    });

    test("readRule with a traversal name returns null", async () => {
      expect(await readRule("project", "../../etc/passwd", cwd)).toBeNull();
      expect(await readRule("project", "/etc/passwd", cwd)).toBeNull();
    });

    test("deleteRule with a traversal name is a 400", async () => {
      const r = await deleteRule("project", "../escape.md", cwd);
      expect(r).toMatchObject({ ok: false, status: 400 });
    });
  });
});
