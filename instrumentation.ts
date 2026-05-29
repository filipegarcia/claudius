// Next.js calls register() once per server runtime at boot. We use it to
// wake the scheduler so jobs persisted to disk get re-armed without manual
// action after a dev-server restart or production redeploy.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Lazy import — instrumentation.ts must not pull Next-only modules at
  // top level.
  const { scheduler } = await import("@/lib/server/scheduler");
  await scheduler.boot();

  // Best-effort: detect when the live source has been upgraded out from
  // under an active customization publish, and auto-revert before the new
  // base files get clobbered by stale snapshots. Failures are logged inside.
  const { runCustomizationsUpgradeCheck, backfillCustomizationDefaults } = await import(
    "@/lib/server/customizations-startup"
  );
  await runCustomizationsUpgradeCheck();
  // Patch older customization workspaces (pre-defaults) to use bypass mode
  // so chats inside them auto-allow tool calls. Idempotent.
  await backfillCustomizationDefaults();

  // Self-update: kick off the background updater. Boot tick fires after a
  // short delay (so the UI is up first), then a daily timer re-checks. See
  // lib/server/updater/scheduler.ts for the policy and lib/server/updater/
  // for the rest. Runs in dev too — the canonical `claudius` launcher uses
  // `bun run dev` so gating on NODE_ENV=production would skip most installs.
  // The scheduler is global-cached and has its own `booted` guard, so HMR
  // doesn't double-tick. Set CLAUDIUS_UPDATER_DISABLED=1 to opt out entirely.
  const { updaterScheduler } = await import("@/lib/server/updater/scheduler");
  await updaterScheduler.boot();
}
