/**
 * First-run file-permission priming — front-loads the macOS TCC
 * ("Files and Folders") consent prompts.
 *
 * Why this exists:
 *   Claudius embeds Claude Code, which reads/writes files in whatever
 *   workspace the user opens. On macOS the OS intercepts the FIRST access
 *   to each protected folder (Desktop, Documents, Downloads, Pictures,
 *   Music, Movies) and shows its own consent dialog. Because Claude Code
 *   touches those folders at unpredictable times (mid-chat, during a tool
 *   call, from a spawned `git`/`bash`), the prompt appears seemingly at
 *   random with no in-app explanation. There is no API to query TCC state
 *   ahead of time, so the only fix is to deliberately touch each protected
 *   folder once — up front, right after the user clicks "Allow" in our own
 *   modal — so all the OS prompts fire in a context the user understands.
 *
 * Why the MAIN process:
 *   TCC attributes the prompt to the GUI app's code signature. The scan
 *   must run here in the main process (not in the embedded Next server,
 *   which is a spawned child) so the grant lands against the Claudius
 *   bundle the user sees in System Settings → Privacy & Security →
 *   Files and Folders.
 *
 * Persistence:
 *   A small JSON marker in `app.getPath("userData")` records that priming
 *   completed, so the first-run modal only shows once per install. Mirrors
 *   the `embedded-port` file helpers in `electron/main.ts`.
 *
 * This module is intentionally self-contained: `electron/` is compiled
 * with its own `rootDir`-locked tsconfig and cannot import from `lib/`.
 * The category list below is a mirror of `CATEGORY_DIRS` in
 * `lib/shared/tcc-protected.ts` — keep the two in lockstep (same
 * convention as `electron/ipc/link-target.ts`).
 */
import { app, ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

const TOPIC_STATUS = "permission:status";
const TOPIC_RUN_SCAN = "permission:run-scan";
const TOPIC_MARK_SEEN = "permission:mark-seen";

/**
 * The macOS TCC categories we prime, paired with the `app.getPath()` key
 * that resolves each to a real folder. Note Electron maps the `videos`
 * key to `~/Movies` on macOS — that's the "Movies" category.
 *
 * Mirror of `CATEGORY_DIRS` in `lib/shared/tcc-protected.ts`.
 */
const PROTECTED_FOLDERS: readonly {
  category: string;
  pathKey: "desktop" | "documents" | "downloads" | "videos" | "music" | "pictures";
}[] = [
  { category: "Desktop", pathKey: "desktop" },
  { category: "Documents", pathKey: "documents" },
  { category: "Downloads", pathKey: "downloads" },
  { category: "Movies", pathKey: "videos" },
  { category: "Music", pathKey: "music" },
  { category: "Pictures", pathKey: "pictures" },
] as const;

/** One folder's outcome — shape mirrored by `FilePermissionScanResult` in
 * `lib/shared/electron.d.ts`. */
export type ScanResult = {
  category: string;
  path: string;
  ok: boolean;
  error?: string;
};

type PrimingFile = {
  completed: boolean;
  ts?: number;
  lastResult?: ScanResult[];
};

function primingFilePath(): string {
  return path.join(app.getPath("userData"), "file-permissions.json");
}

async function readPrimingFile(): Promise<PrimingFile | null> {
  try {
    const raw = await fs.readFile(primingFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PrimingFile;
    return null;
  } catch {
    return null;
  }
}

export async function hasCompletedPriming(): Promise<boolean> {
  const file = await readPrimingFile();
  return file?.completed === true;
}

/** Persist the "priming done" marker. Best-effort — a write failure must
 * not crash the app, the worst case is the modal showing again next launch. */
async function writePrimingFile(lastResult?: ScanResult[]): Promise<void> {
  const payload: PrimingFile = {
    completed: true,
    // `Date.now()` is fine here — this is plain main-process code, not a
    // replayable workflow script.
    ts: Date.now(),
    ...(lastResult ? { lastResult } : {}),
  };
  try {
    await fs.writeFile(
      primingFilePath(),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  } catch (err) {
    console.warn("[electron/permission-priming] could not persist marker:", err);
  }
}

/**
 * Touch each protected folder once to trigger its macOS TCC prompt. A
 * single non-recursive `readdir` is enough to trip the gate. Each folder
 * is independent — one denial/error doesn't abort the rest. No-op (returns
 * `[]`) off macOS, where TCC doesn't exist.
 */
export async function runPermissionScan(): Promise<ScanResult[]> {
  if (process.platform !== "darwin") return [];
  const results: ScanResult[] = [];
  for (const { category, pathKey } of PROTECTED_FOLDERS) {
    let dir = "";
    try {
      dir = app.getPath(pathKey);
      await fs.readdir(dir);
      results.push({ category, path: dir, ok: true });
    } catch (err) {
      results.push({
        category,
        path: dir,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function registerPermissionPrimingHandlers(): void {
  ipcMain.handle(TOPIC_STATUS, async () => ({
    completed: await hasCompletedPriming(),
    platform: process.platform,
  }));

  ipcMain.handle(TOPIC_RUN_SCAN, async () => {
    const results = await runPermissionScan();
    await writePrimingFile(results);
    return results;
  });

  ipcMain.handle(TOPIC_MARK_SEEN, async () => {
    await writePrimingFile();
    return true;
  });
}
