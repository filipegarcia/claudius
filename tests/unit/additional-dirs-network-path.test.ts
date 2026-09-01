/**
 * CC 2.1.257 parity — "Changed --add-dir, /add-dir, and additionalDirectories
 * to refuse network paths (UNC shares, /net/<host> automounts) with a
 * message before touching them; on Windows use a mapped drive letter."
 *
 * `/api/settings/additional-dirs` is Claudius's one write path for
 * `/add-dir` (`ChatSurface.tsx`'s native "add-dir" slash-command handler
 * posts here). Before this change it wrote whatever path it was given
 * straight into `permissions.additionalDirectories` with no validation at
 * all. The rejection must happen before `resolveTrustedCwd`/`readSettings`
 * ever runs, so these tests deliberately omit a real `cwd` — if the route
 * tried to resolve it first, these would fail with "unknown cwd" instead
 * of the network-path message, which would be the wrong order.
 */
import { describe, expect, test } from "vitest";
import { POST } from "@/app/api/settings/additional-dirs/route";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/settings/additional-dirs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/settings/additional-dirs — network path rejection", () => {
  test("rejects a UNC share path", async () => {
    const res = await POST(makeReq({ scope: "project", add: ["\\\\fileserver\\share\\project"] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/network path/i);
    expect(json.error).toContain("\\\\fileserver\\share\\project");
  });

  test("rejects a /net/<host> automount path", async () => {
    const res = await POST(makeReq({ scope: "project", add: ["/net/build-host/exports/repo"] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/network path/i);
  });

  test("rejects when only one of several paths is a network path, naming just that one", async () => {
    const res = await POST(
      makeReq({ scope: "project", add: ["/Users/dev/repo", "/net/build-host/exports/repo"] }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    // Proves the guard is per-path (not "any add[] triggers rejection of
    // the whole request with a generic message") and that an ordinary
    // absolute local path is never mistaken for a network path.
    expect(json.error).toContain("/net/build-host/exports/repo");
    expect(json.error).not.toContain("/Users/dev/repo");
  });
});
