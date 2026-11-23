import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listSkills, writeSkill } from "@/lib/server/skills";
import { visualizeHiddenNameUnicode } from "@/lib/shared/invisible-unicode";
import { ENGINE_NAME_RULE_MESSAGE, isEngineOfferableName, isEngineShownName } from "@/lib/shared/skill-names";

/**
 * CC 2.1.321 parity — "Fixed skill and command names holding a Bamum letter
 * that some fonts draw as blank: they are now refused".
 *
 * The engine's name rule gained exactly one code point, U+16910 BAMUM LETTER
 * PHASE-D NGKEURI. The rest of the Bamum blocks stay valid letters. Inputs
 * are code-point escapes so nothing blank-looking sits in this file.
 */
const BAMUM_BLANK = "\u{16910}";

describe("Bamum U+16910 in skill / command names", () => {
  test("is refused by both the offer and the shown-name rule", () => {
    for (const bad of [`deploy${BAMUM_BLANK}`, `${BAMUM_BLANK}deploy`, `de${BAMUM_BLANK}ploy`, `plugin:${BAMUM_BLANK}x`]) {
      expect(isEngineOfferableName(bad), JSON.stringify(bad)).toBe(false);
      expect(isEngineShownName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("neighbouring Bamum letters stay allowed, as in the engine", () => {
    for (const ok of ["\u{1690F}", "\u{16911}", "\u{A6A0}\u{A6A1}", "\u{16800}"]) {
      expect(isEngineOfferableName(ok), JSON.stringify(ok)).toBe(true);
    }
  });

  test("is rendered as a visible token so a 'not offered' name is legible", () => {
    expect(visualizeHiddenNameUnicode(`a${BAMUM_BLANK}`).visualized).toBe("a\u{2039}U+16910\u{203A}");
  });
});

describe("Skills page write and list paths", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "claudius-bamum-skill-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("writeSkill refuses to create a folder whose name holds U+16910", async () => {
    await expect(writeSkill("project", cwd, `deploy${BAMUM_BLANK}`, "---\nname: deploy\n---\n")).rejects.toThrow(
      ENGINE_NAME_RULE_MESSAGE,
    );
  });

  test("listSkills flags an existing U+16910 folder as not offered", async () => {
    const folder = `ship${BAMUM_BLANK}`;
    mkdirSync(join(cwd, ".claude", "skills", folder), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", folder, "SKILL.md"), "---\nname: ship\ndescription: d\n---\n");
    const listed = await listSkills("project", cwd);
    const row = listed.find((s) => s.name === folder);
    expect(row).toBeDefined();
    expect(row?.notOffered).toBeTruthy();
  });
});
