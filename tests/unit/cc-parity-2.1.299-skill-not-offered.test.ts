import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { deleteSkill, listSkills, readSkill, writeSkill } from "@/lib/server/skills";
import { visualizeHiddenNameUnicode } from "@/lib/shared/invisible-unicode";
import {
  ENGINE_NAME_RULE_MESSAGE,
  ignoredSkillMdName,
  isEngineOfferableName,
  isEngineShownName,
  skillMdName,
} from "@/lib/shared/skill-names";

/**
 * CC 2.1.299 parity — "Changed skill and command loading: one whose file or
 * folder name has hidden, direction-changing or blank-like characters, < or >,
 * is no longer offered until renamed; such a name: is ignored".
 *
 * Every non-ASCII test input is written as a code-point escape so no
 * invisible character sits literally in this file.
 */

describe("isEngineOfferableName (CC 2.1.299)", () => {
  test("accepts ordinary names in any script", () => {
    for (const ok of [
      "my-skill",
      "v1.2_beta",
      "plugin:skill",
      "\u{30EC}\u{30D3}\u{30E5}\u{30FC}", // レビュー
      "\u{6280}\u{80FD}-2", // 技能-2
      "caf\u{E9}", // café, composed
      "cafe\u{301}", // café, decomposed (macOS folder names)
      "r\u{E9}sum\u{E9}",
      "\u{43E}\u{442}\u{447}\u{451}\u{442}", // отчёт
      "\u{D55C}\u{AD6D}\u{C5B4}", // 한국어
      "\u{939}\u{93F}\u{928}\u{94D}\u{926}\u{940}", // हिन्दी
      "\u{627}\u{644}\u{639}\u{631}\u{628}\u{64A}\u{629}", // العربية
      "a" + "\u{301}".repeat(8), // eight stacked marks is still fine
      "x".repeat(256),
    ]) {
      expect(isEngineOfferableName(ok), JSON.stringify(ok)).toBe(true);
    }
  });

  test("rejects hidden, direction-changing and blank-like characters", () => {
    for (const bad of [
      "a\u{200B}b", // zero-width space
      "a\u{202E}b", // right-to-left override
      "a\u{2066}b", // left-to-right isolate
      "a\u{FEFF}b", // BOM
      "a\u{A0}b", // no-break space
      "a\u{3000}b", // ideographic space
      "deploy\u{3164}", // Hangul filler
      "a\u{115F}b", // Hangul choseong filler
      "a\u{1160}b", // Hangul jungseong filler
      "a\u{FFA0}b", // halfwidth Hangul filler
      "a\u{34F}b", // combining grapheme joiner
      "a\u{17B4}b", // Khmer inherent vowel
      "a\u{17B5}b",
      "a\u{FE0F}", // variation selector-16
      "a\u{FE00}b",
      "a\u{2800}b", // blank Braille pattern
      "a\u{FFFC}b", // object replacement character
      "a\u{2028}b",
      "a\u{0}b",
      "a\u{7F}b",
      "a\u{85}b",
      "a\u{E000}b", // private use
    ]) {
      expect(isEngineOfferableName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("rejects < and >, edge/double spaces and colon spacing", () => {
    for (const bad of ["a<b", "a>b", "<script>", " a", "a ", "a  b", "plugin: skill", "plugin :skill", ":skill", "skill:"]) {
      expect(isEngineOfferableName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isEngineOfferableName("a b")).toBe(true);
  });

  test("rejects misplaced or piled-up combining marks", () => {
    for (const bad of [
      "\u{301}abc", // starts with a combining mark
      "a-\u{301}b", // mark after punctuation
      "a" + "\u{301}".repeat(9), // run of nine marks
      "i\u{307}", // doubled dot on a soft-dotted letter
      "\u{131}\u{301}", // mark on dotless i
      "a\u{93F}", // Devanagari vowel sign on a Latin base
    ]) {
      expect(isEngineOfferableName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("caps length at 256 UTF-16 code units", () => {
    expect(isEngineOfferableName("x".repeat(257))).toBe(false);
    expect(isEngineOfferableName("")).toBe(false);
    // An astral character is two code units, as the engine counts it.
    const emoji = "\u{1F600}";
    expect(isEngineOfferableName(emoji.repeat(128))).toBe(true);
    expect(isEngineOfferableName(emoji.repeat(128) + "x")).toBe(false);
  });

  test("the shown-name rule allows colon spacing the offer rule refuses", () => {
    expect(isEngineShownName("Plugin: Skill")).toBe(true);
    expect(isEngineOfferableName("Plugin: Skill")).toBe(false);
  });
});

describe("SKILL.md name ignored by the engine (CC 2.1.299)", () => {
  test("a refused name is not shown as a second name but reported as ignored", () => {
    const bad = "review\u{FE0F}";
    expect(skillMdName({ name: bad }, "folder")).toBeNull();
    expect(ignoredSkillMdName({ name: bad })).toBe(bad);
    expect(ignoredSkillMdName({ name: "a<b" })).toBe("a<b");
    // The engine folds &lt; / &gt; back to < before checking.
    expect(ignoredSkillMdName({ name: "a&lt;b" })).toBe("a&lt;b");
  });

  test("a valid, missing or non-string name is not reported as ignored", () => {
    expect(ignoredSkillMdName({ name: "code-review" })).toBeNull();
    expect(skillMdName({ name: "code-review" }, "folder")).toBe("code-review");
    expect(ignoredSkillMdName({})).toBeNull();
    expect(ignoredSkillMdName({ name: "" })).toBeNull();
    expect(ignoredSkillMdName({ name: 42 })).toBeNull();
    expect(ignoredSkillMdName(undefined)).toBeNull();
  });
});

describe("visualizeHiddenNameUnicode (CC 2.1.299)", () => {
  test("renders every engine-refused hidden character as a visible token", () => {
    expect(visualizeHiddenNameUnicode("deploy\u{3164}")).toEqual({
      visualized: "deploy\u{2039}U+3164\u{203A}",
      count: 1,
    });
    expect(visualizeHiddenNameUnicode("a\u{FE0F}\u{A0}b").visualized).toBe(
      "a\u{2039}U+FE0F\u{203A}\u{2039}U+00A0\u{203A}b",
    );
    expect(visualizeHiddenNameUnicode("plain name").count).toBe(0);
  });
});

describe("skills on disk the engine won't offer (CC 2.1.299)", () => {
  let cwd: string;
  const skillsRoot = () => join(cwd, ".claude", "skills");
  const addSkill = (folder: string, name: string) => {
    mkdirSync(join(skillsRoot(), folder), { recursive: true });
    writeFileSync(
      join(skillsRoot(), folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: test skill\n---\n\nBody.\n`,
    );
  };
  const filler = "deploy\u{3164}";
  const selector = "ship\u{FE0F}";

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "claudius-skill-not-offered-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("listSkills flags the folders the engine refuses, and they stay readable and deletable", async () => {
    addSkill(filler, "deploy");
    addSkill(selector, "ship");
    addSkill("release-notes", "release-notes");
    addSkill("\u{30EC}\u{30D3}\u{30E5}\u{30FC}", "code-review");

    const listed = await listSkills("project", cwd);
    const flags = Object.fromEntries(listed.map((s) => [s.name, s.notOffered]));
    expect(flags).toEqual({
      [filler]: true,
      [selector]: true,
      "release-notes": false,
      "\u{30EC}\u{30D3}\u{30E5}\u{30FC}": false,
    });

    const read = await readSkill("project", cwd, filler);
    expect(read?.notOffered).toBe(true);
    expect(read?.frontmatter.name).toBe("deploy");

    expect(await deleteSkill("project", cwd, filler)).toBe(true);
    expect(existsSync(join(skillsRoot(), filler))).toBe(false);
    expect(await deleteSkill("project", cwd, selector)).toBe(true);
    expect(existsSync(join(skillsRoot(), "release-notes"))).toBe(true);
  });

  test("writeSkill refuses a name the engine won't offer, with the engine's message", async () => {
    await expect(writeSkill("project", cwd, filler, "---\nname: deploy\n---\n")).rejects.toThrow(
      `deploy\u{2039}U+3164\u{203A} is not offered: ${ENGINE_NAME_RULE_MESSAGE}`,
    );
    await expect(writeSkill("project", cwd, "\u{301}abc", "x")).rejects.toThrow(ENGINE_NAME_RULE_MESSAGE);
    expect(existsSync(join(skillsRoot(), filler))).toBe(false);

    // An existing such folder can't be saved into either…
    addSkill(selector, "ship");
    await expect(writeSkill("project", cwd, selector, "changed")).rejects.toThrow("is not offered");

    // …while ordinary names still write, and path-shaped ones still fail the folder rule.
    await writeSkill("project", cwd, "caf\u{E9}", "---\nname: cafe\n---\n");
    expect(existsSync(join(skillsRoot(), "caf\u{E9}", "SKILL.md"))).toBe(true);
    await expect(writeSkill("project", cwd, "../x", "x")).rejects.toThrow("invalid skill name");
  });
});
