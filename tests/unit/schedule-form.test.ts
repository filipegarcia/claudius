import { describe, expect, test } from "vitest";
import { isScheduleFormDirty, type ScheduleFormFields } from "@/lib/shared/schedule-form";

const DEFAULTS: ScheduleFormFields = {
  name: "",
  cron: "*/5 * * * *",
  prompt: "",
  cwd: "",
  model: "",
};

/**
 * CC 2.1.273 (H10) — "Discard unsaved changes?" fires only when the form
 * actually has unsaved input.
 */
describe("isScheduleFormDirty (H10)", () => {
  test("a fresh new-job form (all defaults) is not dirty", () => {
    expect(isScheduleFormDirty({ ...DEFAULTS }, DEFAULTS)).toBe(false);
  });

  test("typing a name or prompt makes it dirty", () => {
    expect(isScheduleFormDirty({ ...DEFAULTS, name: "Nightly" }, DEFAULTS)).toBe(true);
    expect(isScheduleFormDirty({ ...DEFAULTS, prompt: "run tests" }, DEFAULTS)).toBe(true);
  });

  test("changing the cron from the default makes it dirty", () => {
    expect(isScheduleFormDirty({ ...DEFAULTS, cron: "0 9 * * *" }, DEFAULTS)).toBe(true);
  });

  test("an edit form equal to its initial job is not dirty", () => {
    const initial: ScheduleFormFields = { name: "Job", cron: "0 * * * *", prompt: "p", cwd: "/x", model: "opus" };
    expect(isScheduleFormDirty({ ...initial }, initial)).toBe(false);
    expect(isScheduleFormDirty({ ...initial, model: "sonnet" }, initial)).toBe(true);
  });
});
