import { describe, expect, test, afterEach, vi } from "vitest";
import { readableSessionLabel, tabLabelFor } from "@/components/chat/SessionTabs";
import type { SessionInfo } from "@/lib/client/types";

/**
 * Unit tests for `readableSessionLabel` — the CC 2.1.196 parity feature that
 * replaces the UUID-prefix fallback in the tab strip with a human-readable
 * date label ("Today at 2:15 PM", "Jun 30 at 2:15 PM", etc.).
 *
 * The function uses toLocaleTimeString/toLocaleDateString with the browser's
 * locale. In Vitest (Node), these resolve to the default locale (usually
 * en-US). Tests assert the structural invariants ("Today at", includes the
 * year) rather than the exact formatted string so they stay locale-agnostic.
 */
describe("readableSessionLabel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("same-day timestamp → 'Today at HH:MM ...'", () => {
    // Fix 'now' to 2025-06-30T14:00:00 UTC
    const now = new Date("2025-06-30T14:00:00Z").getTime();
    vi.useFakeTimers({ now });

    // A timestamp 30 minutes in the past (same day)
    const createdAt = new Date("2025-06-30T13:30:00Z").getTime();
    const label = readableSessionLabel(createdAt);

    expect(label).toMatch(/^Today at /);
  });

  test("same year, different day → 'Mon DD at HH:MM ...' (no year)", () => {
    const now = new Date("2025-06-30T10:00:00Z").getTime();
    vi.useFakeTimers({ now });

    // A timestamp from yesterday (different day, same year)
    const createdAt = new Date("2025-06-29T09:15:00Z").getTime();
    const label = readableSessionLabel(createdAt);

    // Should NOT start with "Today"
    expect(label).not.toMatch(/^Today/);
    // Should NOT contain the year (same-year format omits it)
    expect(label).not.toMatch(/2025/);
    // Should contain " at "
    expect(label).toContain(" at ");
  });

  test("different year → label includes the year", () => {
    const now = new Date("2025-06-30T10:00:00Z").getTime();
    vi.useFakeTimers({ now });

    // A timestamp from a past year
    const createdAt = new Date("2024-01-15T08:00:00Z").getTime();
    const label = readableSessionLabel(createdAt);

    expect(label).toContain("2024");
    expect(label).toContain(" at ");
  });
});

describe("tabLabelFor with createdAt fallback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("uses createdAt readable label when no title", () => {
    const now = new Date("2025-06-30T12:00:00Z").getTime();
    vi.useFakeTimers({ now });

    const createdAt = new Date("2025-06-30T11:45:00Z").getTime();
    const sessions: SessionInfo[] = [
      { id: "abc12345-def0", createdAt },
    ];
    const label = tabLabelFor("abc12345-def0", sessions);
    expect(label).toMatch(/^Today at /);
  });

  test("still falls back to id slice when no title and no createdAt", () => {
    const sessions: SessionInfo[] = [{ id: "abc12345-def0" }];
    const label = tabLabelFor("abc12345-def0", sessions);
    expect(label).toBe("abc12345");
  });

  test("explicit title wins over createdAt", () => {
    const now = new Date("2025-06-30T12:00:00Z").getTime();
    vi.useFakeTimers({ now });

    const sessions: SessionInfo[] = [
      { id: "abc12345-def0", title: "My project chat", createdAt: now - 1000 },
    ];
    const label = tabLabelFor("abc12345-def0", sessions);
    expect(label).toBe("My project chat");
  });

  test("titleOverride wins over everything", () => {
    const now = new Date("2025-06-30T12:00:00Z").getTime();
    vi.useFakeTimers({ now });

    const sessions: SessionInfo[] = [
      { id: "abc12345-def0", title: "Stored title", createdAt: now - 1000 },
    ];
    const label = tabLabelFor("abc12345-def0", sessions, "Override title");
    expect(label).toBe("Override title");
  });
});
