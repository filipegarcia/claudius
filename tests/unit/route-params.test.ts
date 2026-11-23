import { describe, expect, test } from "vitest";
import {
  customizationIdFromPathname,
  pathSegment,
  workspaceIdFromPathname,
} from "@/lib/shared/route-params";

/**
 * N03a — the `useParams()` / `use(params)` readers parse the pathname
 * instead (rust/parity/server-components.md § 3, row 7).
 */
describe("pathSegment", () => {
  test("picks the segment at the param's position", () => {
    expect(pathSegment("/wks_0123456789ab", 0)).toBe("wks_0123456789ab");
    expect(pathSegment("/wks_0123456789ab/sessions/abc-123", 0)).toBe("wks_0123456789ab");
    expect(pathSegment("/wks_0123456789ab/sessions/abc-123", 2)).toBe("abc-123");
    expect(pathSegment("/customize/cust_0123456789ab/chat", 1)).toBe("cust_0123456789ab");
  });

  test("null when the segment is missing or empty", () => {
    expect(pathSegment("/", 0)).toBeNull();
    expect(pathSegment("/wks_0123456789ab", 1)).toBeNull();
    expect(pathSegment("", 0)).toBeNull();
    expect(pathSegment(null, 0)).toBeNull();
    expect(pathSegment(undefined, 0)).toBeNull();
  });

  test("the canonical encoded form useParams() reports", () => {
    // The browser leaves `:` `@` `,` raw in a path; Next's router tree holds
    // encodeURIComponent of the decoded value.
    expect(pathSegment("/a:b@c,d", 0)).toBe("a%3Ab%40c%2Cd");
    expect(pathSegment("/a%20b", 0)).toBe("a%20b");
    expect(pathSegment("/caf%C3%A9", 0)).toBe("caf%C3%A9");
    expect(pathSegment("/x%2Fy/z", 0)).toBe("x%2Fy");
    // Malformed escapes stay as they are (Next's canonicalizeURLPart).
    expect(pathSegment("/bad%E0", 0)).toBe("bad%E0");
  });
});

describe("workspaceIdFromPathname", () => {
  test("a /<wks_id> path, at any depth", () => {
    expect(workspaceIdFromPathname("/wks_0123456789ab")).toBe("wks_0123456789ab");
    expect(workspaceIdFromPathname("/wks_0123456789ab/")).toBe("wks_0123456789ab");
    expect(workspaceIdFromPathname("/wks_0123456789ab/dev/chat")).toBe("wks_0123456789ab");
  });

  test("null off a workspace route or for another id shape", () => {
    expect(workspaceIdFromPathname("/customize/cust_0123456789ab/chat")).toBeNull();
    expect(workspaceIdFromPathname("/settings")).toBeNull();
    expect(workspaceIdFromPathname("/")).toBeNull();
    expect(workspaceIdFromPathname("/wks_0123456789abc")).toBeNull();
    expect(workspaceIdFromPathname("/wks_0123456789AB")).toBeNull();
    expect(workspaceIdFromPathname("/x/wks_0123456789ab")).toBeNull();
    expect(workspaceIdFromPathname(null)).toBeNull();
  });
});

describe("customizationIdFromPathname", () => {
  test("the detail page and its chat", () => {
    expect(customizationIdFromPathname("/customize/cust_0123456789ab")).toBe("cust_0123456789ab");
    expect(customizationIdFromPathname("/customize/cust_0123456789ab/chat")).toBe("cust_0123456789ab");
    expect(customizationIdFromPathname("/customize/CUST_AB12")).toBe("CUST_AB12");
  });

  test("null for the list, settings and other routes", () => {
    expect(customizationIdFromPathname("/customize")).toBeNull();
    expect(customizationIdFromPathname("/customize/settings")).toBeNull();
    expect(customizationIdFromPathname("/wks_0123456789ab")).toBeNull();
    expect(customizationIdFromPathname(undefined)).toBeNull();
  });
});
