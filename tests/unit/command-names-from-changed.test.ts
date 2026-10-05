import { describe, expect, test } from "vitest";
import { commandNamesFromChanged } from "@/lib/shared/slash-commands";

describe("commandNamesFromChanged (CC 2.1.216 — B8)", () => {
  test("pulls the names out of a commands_changed payload", () => {
    expect(
      commandNamesFromChanged([{ name: "/clear" }, { name: "/compact" }, { name: "/skill-x" }]),
    ).toEqual(["/clear", "/compact", "/skill-x"]);
  });

  test("drops entries without a non-empty string name", () => {
    expect(
      commandNamesFromChanged([
        { name: "/ok" },
        { name: "" },
        { name: undefined },
        { name: 42 as unknown as string },
        {},
      ]),
    ).toEqual(["/ok"]);
  });

  test("absent / empty input → empty array", () => {
    expect(commandNamesFromChanged(undefined)).toEqual([]);
    expect(commandNamesFromChanged([])).toEqual([]);
  });
});
