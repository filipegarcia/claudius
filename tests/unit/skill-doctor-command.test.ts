import { describe, expect, test } from "vitest";
import { SLASH_COMMANDS, findSlashCommand } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.261 parity — "Added `/skill-doctor` to show which loaded skills go
 * unused and what they cost in context, so you can prune them." Claudius
 * reuses the existing `/context` overlay's plumbing (ContextOverlay.tsx now
 * renders a per-skill cost breakdown from the SDK's getContextUsage()
 * response) rather than a new screen — this only covers the registry entry
 * and lookup; ChatSurface.tsx's `runNative` dispatch to the shared overlay
 * is covered by tests/e2e/cc-parity-2.1.261-skill-doctor.spec.ts.
 */
describe("/skill-doctor slash command", () => {
  test("is registered as a native, memory-category command", () => {
    const cmd = SLASH_COMMANDS.find((c) => c.id === "skill-doctor");
    expect(cmd).toBeDefined();
    expect(cmd?.handler).toBe("native");
    expect(cmd?.category).toBe("memory");
    expect(cmd?.name).toBe("skill-doctor");
  });

  test("findSlashCommand resolves it by exact name", () => {
    const cmd = findSlashCommand("skill-doctor");
    expect(cmd?.id).toBe("skill-doctor");
  });

  test("id is unique within the registry", () => {
    const ids = SLASH_COMMANDS.map((c) => c.id);
    expect(ids.filter((id) => id === "skill-doctor")).toHaveLength(1);
  });
});
