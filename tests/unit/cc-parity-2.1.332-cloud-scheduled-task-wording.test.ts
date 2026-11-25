import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "@/components/chat/ToolCall";
import { findSlashCommand } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.332 — "Changed `/schedule`, permission prompts and `/loop`'s cloud
 * offer to say "cloud scheduled task" instead of "routine" or "cloud
 * schedule"; `/routines` still works".
 */
describe("cloud scheduled task wording (2.1.332)", () => {
  const row = (action: string, name = "RemoteTrigger") =>
    renderToStaticMarkup(createElement(ToolCall, { name, input: { action } }));

  test.each([
    ["list", "List cloud scheduled tasks"],
    ["get", "Get cloud scheduled task"],
    ["create", "Create cloud scheduled task"],
    ["update", "Update cloud scheduled task"],
  ])("the %s action reads %s", (action, label) => {
    const html = row(action);
    expect(html).toContain(label);
    expect(html).not.toMatch(/routine/i);
  });

  test("the Schedule tool name gets the same labels; other actions keep theirs", () => {
    expect(row("list", "Schedule")).toContain("List cloud scheduled tasks");
    expect(row("run")).toContain("Run now");
    expect(row("list_runs")).toContain("List runs");
  });

  test("/schedule no longer says routines, and /routines still finds it", () => {
    const cmd = findSlashCommand("schedule");
    expect(cmd?.description).toBe("Manage scheduled jobs.");
    expect(cmd?.description).not.toMatch(/routine/i);
    expect(findSlashCommand("routines")?.id).toBe("schedule");
  });
});
