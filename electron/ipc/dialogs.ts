/**
 * Native file/folder dialog handlers — Phase 8 of
 * docs/electron-conversion/PLAN.md.
 *
 * Two `ipcMain.handle` topics so the renderer's `dialog.openWorkspace()`
 * / `dialog.openFile(opts?)` calls (via the preload) can `await` the
 * picked path. Both return `string | null` (`null` when the user
 * cancels) — that's the contract in `lib/shared/electron.d.ts`.
 */
import { BrowserWindow, dialog, ipcMain } from "electron";

const TOPIC_OPEN_WORKSPACE = "dialog:open-workspace";
const TOPIC_OPEN_FILE = "dialog:open-file";

type OpenFileOpts = {
  filters?: { name: string; extensions: string[] }[];
};

function ownerWindow(senderId: number): BrowserWindow | undefined {
  return (
    BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.id === senderId,
    ) ?? BrowserWindow.getFocusedWindow() ?? undefined
  );
}

export function registerDialogHandlers(): void {
  ipcMain.handle(TOPIC_OPEN_WORKSPACE, async (event) => {
    const win = ownerWindow(event.sender.id);
    const res = await dialog.showOpenDialog(win!, {
      title: "Open workspace",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Add Workspace",
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0] ?? null;
  });

  ipcMain.handle(
    TOPIC_OPEN_FILE,
    async (event, raw: OpenFileOpts | undefined) => {
      const win = ownerWindow(event.sender.id);
      const filters = Array.isArray(raw?.filters) ? raw.filters : undefined;
      const res = await dialog.showOpenDialog(win!, {
        title: "Open file",
        properties: ["openFile"],
        filters,
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0] ?? null;
    },
  );
}
