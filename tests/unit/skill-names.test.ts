import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { deleteSkill, isValidSkillDirName, listSkills, readSkill } from "@/lib/server/skills";
import { skillMdName } from "@/lib/shared/skill-names";

/**
 * CC 2.1.290 parity — "Fixed skills not being found when asked for by the
 * name in SKILL.md when their folder has a different name (for example a
 * non-English name): the skill listing now shows both names."
 */

describe("skillMdName (CC 2.1.290)", () => {
  test("returns the SKILL.md name only when it differs from the folder", () => {
    expect(skillMdName({ name: "code-review" }, "レビュー")).toBe("code-review");
    expect(skillMdName({ name: "  padded  " }, "folder")).toBe("padded");
    expect(skillMdName({ name: "same" }, "same")).toBeNull();
  });

  test("treats composed and decomposed spellings as the same name", () => {
    expect(skillMdName({ name: "café" }, "café")).toBeNull();
  });

  test("ignores a missing, empty or non-string name", () => {
    expect(skillMdName({}, "x")).toBeNull();
    expect(skillMdName({ name: "" }, "x")).toBeNull();
    expect(skillMdName({ name: 42 }, "x")).toBeNull();
    expect(skillMdName({ name: ["a"] }, "x")).toBeNull();
    expect(skillMdName(undefined, "x")).toBeNull();
  });
});

describe("isValidSkillDirName (CC 2.1.290)", () => {
  test("accepts folder names in any script", () => {
    for (const ok of ["my-skill", "v1.2_beta", "レビュー", "résumé", "café", "отчёт", "技能-2"]) {
      expect(isValidSkillDirName(ok)).toBe(true);
    }
  });

  test("rejects dot-names, separators and empty names", () => {
    for (const bad of ["", ".", "..", ".hidden", "a/b", "a\\b", "../x", "a b", "a\0b"]) {
      expect(isValidSkillDirName(bad)).toBe(false);
    }
  });
});

describe("skills on disk with non-ASCII folder names (CC 2.1.290)", () => {
  let cwd: string;
  const skillsRoot = () => join(cwd, ".claude", "skills");
  const addSkill = (folder: string, name: string) => {
    mkdirSync(join(skillsRoot(), folder), { recursive: true });
    writeFileSync(
      join(skillsRoot(), folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: test skill\n---\n\nBody.\n`,
    );
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "claudius-skill-names-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("lists, reads and deletes a skill whose folder name is non-English", async () => {
    addSkill("レビュー", "code-review");
    addSkill("ascii-skill", "ascii-skill");
    mkdirSync(join(skillsRoot(), ".hidden"), { recursive: true });
    writeFileSync(join(skillsRoot(), ".hidden", "SKILL.md"), "---\nname: hidden\n---\n");

    const listed = await listSkills("project", cwd);
    expect(listed.map((s) => s.name).sort()).toEqual(["ascii-skill", "レビュー"].sort());
    const review = listed.find((s) => s.name === "レビュー")!;
    expect(skillMdName(review.frontmatter, review.name)).toBe("code-review");

    const read = await readSkill("project", cwd, "レビュー");
    expect(read?.frontmatter.name).toBe("code-review");

    expect(await deleteSkill("project", cwd, "レビュー")).toBe(true);
    expect(existsSync(join(skillsRoot(), "レビュー"))).toBe(false);
    expect(existsSync(join(skillsRoot(), "ascii-skill"))).toBe(true);
  });

  test("delete refuses names that would reach the skills directory or beyond", async () => {
    addSkill("keep", "keep");
    for (const bad of [".", "..", "", "../keep"]) {
      await expect(deleteSkill("project", cwd, bad)).rejects.toThrow();
    }
    expect(existsSync(join(skillsRoot(), "keep", "SKILL.md"))).toBe(true);
  });
});
