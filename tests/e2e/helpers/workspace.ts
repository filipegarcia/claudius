import { type Page } from "../../helpers/test";

type WorkspaceSummary = { id: string; name: string; rootPath: string };

/**
 * Ensure a "claudius" workspace exists and is the active one.
 *
 * Claudius no longer auto-seeds a workspace on first run (a fresh install
 * lands on `/welcome`), so tests that need the chrome to reflect this
 * project must create the workspace themselves. This helper is idempotent:
 * it reuses an existing workspace named "claudius" (or one whose rootPath is
 * the repo cwd) and only POSTs a new one when none is found. Either way it
 * selects the workspace so the side nav and tab strip render against it.
 *
 * Centralized here (rather than copy-pasted per spec) so the create-if-missing
 * behavior stays consistent across the marketing-screenshot suites.
 */
export async function activateClaudiusWorkspace(page: Page): Promise<void> {
  const cwd = process.cwd();
  const list = await page.request
    .get("/api/workspaces")
    .then((r) => r.json() as Promise<{ workspaces: WorkspaceSummary[] }>);
  let ws =
    list.workspaces.find((w) => w.name === "claudius") ??
    list.workspaces.find((w) => w.rootPath === cwd);
  if (!ws) {
    const created = await page.request.post("/api/workspaces", {
      data: { name: "claudius", rootPath: cwd },
    });
    if (!created.ok()) {
      throw new Error(
        `Failed to create the "claudius" workspace (rootPath=${cwd}): HTTP ${created.status()}`,
      );
    }
    ws = (await created.json()) as WorkspaceSummary;
  }
  await page.request.post(`/api/workspaces/${ws.id}/select`);
}
