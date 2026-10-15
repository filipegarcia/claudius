import { describe, expect, test } from "vitest";
import { stringListSettingValue } from "@/lib/shared/string-list-setting";

/**
 * CC 2.1.299 parity — "Fixed a settings file being ignored when
 * enabledMcpjsonServers or disabledMcpjsonServers held a single server name
 * as a plain string". The catalog's `string[]` field shows a plain string as
 * a one-item list instead of blank.
 */
describe("stringListSettingValue", () => {
  test("a plain string is a one-item list", () => {
    expect(stringListSettingValue("filesystem")).toEqual(["filesystem"]);
  });

  test("arrays pass through", () => {
    expect(stringListSettingValue(["a", "b"])).toEqual(["a", "b"]);
    expect(stringListSettingValue([])).toEqual([]);
  });

  test("blank strings and non-list values read as empty", () => {
    for (const v of [undefined, null, "", "   ", 3, true, { a: 1 }]) {
      expect(stringListSettingValue(v)).toEqual([]);
    }
  });
});
