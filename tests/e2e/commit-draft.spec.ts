import { test, expect } from "../helpers/test";

/**
 * Verify the commit-draft round-trip via the workspace API. We don't drive
 * the full /git page UI here (it requires a workspace whose rootPath is a
 * real git repo with staged changes — Playwright would fight to keep that
 * stable). Instead we exercise the persistence contract directly:
 *   - GET → null on a clean workspace
 *   - POST → message persisted
 *   - GET → returns persisted message
 *   - DELETE → cleared
 */
test.describe("Commit-message draft persistence", () => {
  test("round-trips through GET/POST/DELETE on /api/workspaces/:id/git/commit-draft", async ({
    request,
    baseURL,
  }) => {
    // Pick an existing workspace from the index — the test environment is
    // expected to have at least one (the auto-created one for the dev cwd).
    const { workspaces } = await request
      .get(`${baseURL}/api/workspaces`)
      .then((r) => r.json() as Promise<{ workspaces: Array<{ id: string }> }>);
    expect(workspaces?.length ?? 0, "expected at least one workspace").toBeGreaterThan(0);
    const wsId = workspaces[0].id;

    // Start clean.
    await request.delete(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    let r = await request.get(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    expect(r.ok()).toBeTruthy();
    let body = (await r.json()) as { message: string | null };
    expect(body.message).toBeNull();

    // Persist a draft.
    const draft = `feat(test): persist this draft ${Date.now().toString(36)}`;
    r = await request.post(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`, {
      data: { message: draft },
    });
    expect(r.ok()).toBeTruthy();

    // Read it back.
    r = await request.get(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    body = (await r.json()) as { message: string | null };
    expect(body.message).toBe(draft);

    // Overwrite (regenerate scenario).
    const draft2 = `chore: regenerated message ${Date.now().toString(36)}`;
    await request.post(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`, {
      data: { message: draft2 },
    });
    r = await request.get(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    body = (await r.json()) as { message: string | null };
    expect(body.message).toBe(draft2);

    // Clear (commit scenario).
    r = await request.delete(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    expect(r.ok()).toBeTruthy();
    r = await request.get(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    body = (await r.json()) as { message: string | null };
    expect(body.message).toBeNull();

    // Empty-string POST acts as DELETE (defensive — the page might call
    // this when the user clears the textarea manually after a generate).
    await request.post(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`, {
      data: { message: "" },
    });
    r = await request.get(`${baseURL}/api/workspaces/${wsId}/git/commit-draft`);
    body = (await r.json()) as { message: string | null };
    expect(body.message).toBeNull();
  });
});
