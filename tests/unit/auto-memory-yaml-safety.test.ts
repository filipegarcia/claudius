import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseMemoryFrontmatter,
  readMemoryFile,
  writeMemoryFile,
  yamlScalar,
} from "@/lib/server/auto-memory";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.214 (G5) — memory frontmatter values must be YAML-safe. Previously
 * `description: ${v}` was emitted raw: a value with ` #` was truncated at the
 * inline comment and a newline could inject frontmatter keys.
 */
describe("yamlScalar (G5)", () => {
  test("leaves a plain safe value unquoted", () => {
    expect(yamlScalar("Some notes")).toBe("Some notes");
    expect(yamlScalar("notes-about-x")).toBe("notes-about-x");
  });

  test("quotes values with YAML-significant characters", () => {
    expect(yamlScalar("has # hash")).toBe('"has # hash"');
    expect(yamlScalar("a: colon")).toBe('"a: colon"');
    expect(yamlScalar("line1\nname: injected")).toBe('"line1\\nname: injected"');
    expect(yamlScalar(' leading space')).toBe('" leading space"');
    expect(yamlScalar("")).toBe('""');
  });
});

describe("memory frontmatter write/parse roundtrip (G5)", () => {
  let tmp: TmpHome;
  const cwd = "/tmp/g5-project";
  beforeEach(() => {
    tmp = makeTempHome();
  });
  afterEach(() => {
    tmp.restore();
  });

  test("a description with ' #' is not truncated", async () => {
    const description = "Use flag #ff0000 for errors # and warnings";
    const res = await writeMemoryFile(cwd, {
      filename: "colors.md",
      type: "reference",
      name: "Colors",
      description,
      body: "body",
    });
    expect(res.ok).toBe(true);
    const parsed = parseMemoryFrontmatter((await readMemoryFile(cwd, "colors.md"))!);
    expect(parsed?.description).toBe(description);
  });

  test("a newline in the description can't inject frontmatter keys", async () => {
    const description = "real desc\ntype: feedback\nname: hijacked";
    await writeMemoryFile(cwd, {
      filename: "evil.md",
      type: "user",
      name: "Evil",
      description,
      body: "body",
    });
    const parsed = parseMemoryFrontmatter((await readMemoryFile(cwd, "evil.md"))!);
    // The injected keys stay inside the description value; identity is intact.
    expect(parsed?.description).toBe(description);
    expect(parsed?.name).toBe("Evil");
    expect(parsed?.type).toBe("user");
  });
});
