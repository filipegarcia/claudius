import { describe, expect, test } from "vitest";
import { classifyInformationalLevel } from "@/lib/shared/system-informational";

describe("classifyInformationalLevel (CC 2.1.217 — B2)", () => {
  test("hides transcript-only 'info' level", () => {
    expect(classifyInformationalLevel("info")).toEqual({ hidden: true });
  });

  test("renders notice/suggestion/warning and carries the level for toning", () => {
    expect(classifyInformationalLevel("notice")).toEqual({ hidden: false, infoLevel: "notice" });
    expect(classifyInformationalLevel("suggestion")).toEqual({
      hidden: false,
      infoLevel: "suggestion",
    });
    expect(classifyInformationalLevel("warning")).toEqual({ hidden: false, infoLevel: "warning" });
  });

  test("an unknown or absent level renders with no special tone", () => {
    expect(classifyInformationalLevel(undefined)).toEqual({ hidden: false });
    expect(classifyInformationalLevel("future-level")).toEqual({ hidden: false });
  });
});
