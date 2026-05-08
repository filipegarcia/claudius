// Next.js calls register() once per server runtime at boot. We use it to
// wake the scheduler so jobs persisted to disk get re-armed without manual
// action after a dev-server restart or production redeploy.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Lazy import — instrumentation.ts must not pull Next-only modules at
  // top level.
  const { scheduler } = await import("@/lib/server/scheduler");
  await scheduler.boot();
}
