import { applyUpdate } from "./apply";
import { checkForUpdates } from "./detect";
import { isRunningInsideCustomizationMirror } from "../customizations-startup";
import { getUpdaterSettings, patchUpdaterState, readUpdaterFile } from "./settings";

/**
 * Background updater scheduler — single instance per process.
 *
 *   - On boot: wait BOOT_DELAY_MS so the HTTP server is up, then run a
 *     check. If the user's mode allows auto-apply (cc-merge or ff-only) and
 *     an update is pending, apply it.
 *   - Every interval (default 24h): repeat the same dance.
 *
 * Only ever runs in the primary Claudius process. Customization preview
 * mirrors (auto-spawned dev servers) deliberately skip — their tree is
 * already divergent and you don't want them auto-pulling upstream.
 */

const BOOT_DELAY_MS = 5_000;
const HOUR_MS = 60 * 60 * 1000;

type Timer = ReturnType<typeof setTimeout>;

class UpdaterScheduler {
  private booted = false;
  private bootTimer: Timer | null = null;
  private dailyTimer: Timer | null = null;

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    if (isRunningInsideCustomizationMirror()) return;
    if (process.env.CLAUDIUS_UPDATER_DISABLED === "1") return;
    // Reaching here means this process booted far enough to serve, so whatever
    // build is live actually works. Clear any leftover recoverable
    // install/build-failure marker from a *previous* process — if the user
    // restarted after fixing it (via "Resolve with Claude Code" or by hand),
    // the banner shouldn't linger. A failure in THIS process is set later and
    // survives because boot() only runs once per process.
    void this.clearStaleRecovery();
    // Defer the first tick a bit so Next finishes initializing routes and
    // the user gets the UI before we start chewing on git.
    this.bootTimer = setTimeout(() => {
      void this.tick("boot");
    }, BOOT_DELAY_MS);
    this.bootTimer.unref?.();
  }

  /** Manual trigger (used by API route). Resolves after the check completes. */
  async runNow(): Promise<void> {
    await this.tick("manual");
  }

  /**
   * Drop a stale recoverable install/build-failure marker on a fresh boot.
   * Only clears `recovery` (and the matching `lastError`) — a live pending
   * update or unrelated error is left untouched.
   */
  private async clearStaleRecovery(): Promise<void> {
    try {
      const file = await readUpdaterFile();
      if (!file.state.recovery) return;
      await patchUpdaterState({ recovery: undefined, lastError: undefined });
    } catch {
      // Best-effort — a failed read/write just leaves the banner up, which is
      // the safe default.
    }
  }

  private async tick(source: "boot" | "daily" | "manual"): Promise<void> {
    try {
      const settings = await getUpdaterSettings();
      if (settings.mode === "disabled") {
        // Don't even check when fully disabled — but still rearm so a
        // settings flip later picks up.
        this.scheduleNext(settings.intervalHours);
        return;
      }
      const result = await checkForUpdates();
      if (result.kind === "update-available") {
        // Auto-apply path: only if mode permits unattended action.
        const autoApply = settings.mode === "cc-merge" || settings.mode === "ff-only";
        if (autoApply) {
          // Don't await the full apply — restart will SIGTERM us mid-await
          // and we don't want to surface a misleading rejection to the
          // caller. Fire and let log capture the outcome.
          void applyUpdate().catch((err) => {
            console.warn("[updater] apply failed:", err);
          });
          // Don't rearm: if apply succeeds we'll be restarted; if it fails,
          // patchUpdaterState surfaces the error and the next boot picks up.
          if (source !== "manual") return;
        }
      }
      this.scheduleNext(settings.intervalHours);
    } catch (err) {
      console.warn("[updater] tick failed:", err);
      // Even on failure, rearm so we try again later.
      this.scheduleNext(24);
    }
  }

  private scheduleNext(intervalHours: number): void {
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
    const delay = Math.max(HOUR_MS, intervalHours * HOUR_MS);
    this.dailyTimer = setTimeout(() => {
      void this.tick("daily");
    }, delay);
    this.dailyTimer.unref?.();
  }
}

declare global {
  var __claudiusUpdaterScheduler: UpdaterScheduler | undefined;
}

function pick(): UpdaterScheduler {
  const cached = globalThis.__claudiusUpdaterScheduler;
  if (cached) return cached;
  const fresh = new UpdaterScheduler();
  globalThis.__claudiusUpdaterScheduler = fresh;
  return fresh;
}

export const updaterScheduler: UpdaterScheduler = pick();
