// Rotating "did you know" tips shown under the working spinner — the
// browser-side analog of the Claude Code CLI spinner tips. The SDK only
// renders its spinner (and `spinnerTipsOverride`) in a terminal, never in
// Claudius's programmatic use, so we surface our own Claudius-specific tips.
//
// This is the single source of truth for tip content. The shape is kept
// deliberately small and serializable so a backend/SDK-driven feed could
// later replace {@link DEFAULT_TIPS} without touching the renderer.

export type Tip = {
  /** Stable id — used as a React key and for de-duping a backend feed. */
  id: string;
  /** The tip body. One short line; the renderer truncates rather than wraps. */
  text: string;
  /**
   * Optional slash command surfaced as a clickable affordance, *without* the
   * leading slash (e.g. `"skills"` renders and runs as `/skills`). Every value
   * here must resolve to a real command in `lib/shared/slash-commands.ts` whose
   * action is non-destructive (navigation/overlay), since a tip can be clicked
   * mid-turn.
   */
  command?: string;
  /**
   * Minimum number of concurrently-open sessions (browser tabs in the active
   * workspace) required to surface this tip. Used by {@link selectClientTips}
   * for just-in-time nudges that only make sense once the user has crossed a
   * usage threshold — kept as a plain number rather than a predicate so the
   * tip shape stays JSON-serializable across the `tips` SSE event.
   */
  minSessions?: number;
  /**
   * Plan-mode follow-up gate. When true, {@link selectClientTips} surfaces the
   * tip only if its `planModeNudgeEligible` flag is also true — i.e. the user
   * has actually used Plan Mode in this session AND has not persisted a default
   * permission mode on the active workspace. Mirrors the Claude Code TUI's
   * `id:"default-permission-mode-config"` conditional spinner tip
   * (`q && !K` where `q = Boolean(H.lastPlanModeUse)` and `K =
   * Boolean(_?.permissions?.defaultMode)`). Serialized as a plain boolean so
   * tips stay portable across the `tips` SSE event.
   */
  requiresPlanModeNudge?: boolean;
  /**
   * New-user gate. When true, {@link selectClientTips} surfaces the tip only
   * if its `newUser` flag is also true — i.e. this browser has opened
   * Claudius fewer than N times (caller decides the threshold via
   * `useStartupCount`, today `< 10` to match the Claude Code TUI's
   * `numStartups < 10` first-run gate on the `id:"powerup-onboarding"` tip).
   * Serialized as a plain boolean so tips stay portable across the `tips`
   * SSE event.
   */
  requiresNewUser?: boolean;
};

// Each command below maps to a native, non-destructive handler in the chat
// page's `runNative` dispatcher (navigation or an overlay) — safe to invoke
// while the agent is mid-turn.
export const DEFAULT_TIPS: Tip[] = [
  {
    id: "agents",
    text: "Define specialist subagents — reviewers, planners, debuggers — each with their own prompt, tools, and model.",
    command: "agents",
  },
  {
    id: "mcp",
    text: "Plug in tools from anywhere over the Model Context Protocol — they show up to Claude automatically.",
    command: "mcp",
  },
  {
    id: "skills",
    text: "Skills are short, opinionated playbooks Claude calls up when the moment is right.",
    command: "skills",
  },
  {
    id: "cost",
    text: "See exactly where your tokens go — spend broken down per session, per model, per day.",
    command: "cost",
  },
  {
    id: "schedule",
    text: "Run the agent on a cron schedule — daily standups, deploy checks, log triage, without you there.",
    command: "schedule",
  },
  {
    id: "memory",
    text: "Claude keeps notes that persist across sessions, so you don't re-explain the same context.",
    command: "memory",
  },
  {
    id: "context",
    text: "Watch how full your context window is — and compact it before it overflows.",
    command: "context",
  },
  {
    id: "goal",
    text: "Set a goal for this session and Claude tracks it until it's achieved.",
    command: "goal",
  },
  {
    id: "files",
    text: "Browse the exact project tree the agent sees — with quick file previews.",
    command: "files",
  },
  {
    id: "hooks",
    text: "Run shell commands at lifecycle events — guardrails, notifications, auto-formatting.",
    command: "hooks",
  },
  {
    id: "plugins",
    text: "Install community plugins from any marketplace you trust — skills, agents, MCP servers, and hooks.",
    command: "plugin",
  },
  {
    id: "keybindings",
    text: "Rebind any shortcut — including chords — to match the muscle memory you already have.",
    command: "keybindings",
  },
  {
    id: "help",
    text: "Lost? Open the full list of slash commands and keyboard shortcuts.",
    command: "help",
  },
  {
    // Conditional: only surfaces once the user has 2+ tabs open in this
    // workspace (see `selectClientTips`). Mirrors the Claude Code TUI's
    // `wo_() >= 2` gate. Command-less because both /color (sdk-handled) and
    // /rename (destructive — filtered by tips.test.ts) are unsafe to expose
    // as a clickable affordance — the text names them so the user can run
    // them themselves.
    id: "multi-claude-color-rename",
    text: "Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.",
    minSessions: 2,
  },
  {
    // Conditional follow-up to Plan Mode (see `selectClientTips`'s
    // `planModeNudgeEligible` gate). Only surfaces once the user has actually
    // used Plan Mode in this session AND has not persisted a default
    // permission mode on the active workspace — mirrors the Claude Code TUI's
    // `id:"default-permission-mode-config"` tip with its `q && !K` predicate.
    // Command-less because the surface is the Workspace settings page (no
    // `/workspace` slash command); the text names the field so the user can
    // navigate there themselves. Cooldown is intentionally not modelled —
    // the existing dismiss-weighting ("show less, not never") is Claudius's
    // analog of `cooldownSessions`.
    id: "default-permission-mode-config",
    text: "Liked Plan Mode? Make it sticky in Workspace settings → Permission mode (it'll apply to every new session here).",
    requiresPlanModeNudge: true,
  },
  {
    // First-run-only nudge mirroring the Claude Code TUI's
    // `id:"powerup-onboarding"` tip with its `numStartups < 10` gate (see
    // `selectClientTips`'s `newUser` option). Command-less because /powerup
    // is `external` in our registry — clicking would just toast "terminal/
    // hosted only," self-defeating for a tip pitching the command. The text
    // names /powerup so the user can run it themselves. The TUI's
    // `cooldownSessions:1` and `powerupsUnlocked` gates are intentionally not
    // mirrored: Claudius's dismiss-weighting
    // (DISMISSED_TIP_SHOW_PROBABILITY) covers the same "stop showing this"
    // intent, and /powerup being external means we can't observe engagement
    // anyway.
    id: "powerup-onboarding",
    text: "New to Claudius? Run /powerup for a quick interactive tutorial.",
    requiresNewUser: true,
  },
];

/**
 * The tips the server surfaces to a session's clients (broadcast as a `tips`
 * SSE event). This is the single injection point for backend/SDK-driven tips:
 * today it returns the default catalog, optionally gated to the slash commands
 * a given session actually supports, so a tip never points at a command that
 * isn't available on this surface. A future backend feed (e.g. "new feature"
 * announcements) appends here without touching the renderer.
 *
 * Honors the user-settings.json knobs that mirror the Claude Code CLI:
 *   - `spinnerTipsEnabled: false`  → return [] (disable the rotation entirely)
 *   - `spinnerTipsOverride.tips`   → append `custom-tip-${K}` entries
 *   - `spinnerTipsOverride.excludeDefault: true` → REPLACE the catalog with the
 *     custom entries instead of appending. When `tips` is empty/missing while
 *     `excludeDefault` is true, the result is [] (the user has explicitly
 *     opted out of every built-in tip without supplying replacements).
 *
 * Pure and server-agnostic so it stays unit-testable. Command-less tips always
 * pass; command tips pass only when their command is available (when no
 * availability list is supplied, nothing is gated). Returns `DEFAULT_TIPS` by
 * reference on the no-op path so subscribers that compare identity don't
 * needlessly invalidate.
 */
export function selectTips(opts?: {
  availableCommands?: readonly string[];
  spinnerTipsEnabled?: boolean;
  spinnerTipsOverride?: { excludeDefault?: boolean; tips?: readonly string[] };
}): Tip[] {
  if (opts?.spinnerTipsEnabled === false) return [];
  const override = opts?.spinnerTipsOverride;
  // Normalize override into a stable list of custom Tip objects. Trims
  // entries and drops empties so a stray `""` in the user's settings doesn't
  // surface as a blank line under the spinner.
  const customTips: Tip[] =
    override?.tips
      ?.map((t, i) => ({ id: `custom-tip-${i}`, text: typeof t === "string" ? t.trim() : "" }))
      .filter((t) => t.text.length > 0) ?? [];
  const avail = opts?.availableCommands;
  // Fast path — no availability gate, no override knobs touched. Preserves
  // the historical contract that `selectTips()` / `selectTips({})` return
  // the module-level DEFAULT_TIPS reference (tips.test.ts asserts identity).
  if (!avail && !override) return DEFAULT_TIPS;
  const set = avail ? new Set(avail) : null;
  const gated = set
    ? DEFAULT_TIPS.filter((t) => !t.command || set.has(t.command))
    : DEFAULT_TIPS;
  if (!override) return gated === DEFAULT_TIPS ? DEFAULT_TIPS : gated;
  // `excludeDefault: true` means "swap the rotation, don't append" — even when
  // the user supplies no tips at all (a deliberate opt-out of the built-ins).
  if (override.excludeDefault === true) return customTips;
  return [...gated, ...customTips];
}

/**
 * Client-side gate for context-sensitive tips. Drops any tip whose
 * `minSessions` exceeds the caller's `activeSessionCount` — the just-in-time
 * "you've crossed a threshold, here's the trick" affordance from the Claude
 * Code TUI's conditional spinner tips. Tips with no `minSessions` always
 * pass. Also drops any tip whose `requiresPlanModeNudge` is true when the
 * caller's `planModeNudgeEligible` is not true (default false) — the
 * post-Plan-Mode follow-up nudge ("make it sticky") only surfaces after the
 * user has actually exercised Plan Mode and hasn't yet persisted a default
 * permission mode. Also drops any tip whose `requiresNewUser` is true when
 * the caller's `newUser` is not true (default false) — the `/powerup`
 * onboarding nudge surfaces only on the first ~N launches in this browser
 * (mirrors the Claude Code TUI's `numStartups < 10` first-run gate). Pure so
 * it stays unit-testable and so the renderer doesn't have to re-derive the
 * filter on every interval tick.
 */
export function selectClientTips(
  tips: readonly Tip[],
  activeSessionCount: number,
  opts?: { planModeNudgeEligible?: boolean; newUser?: boolean },
): Tip[] {
  const planModeNudgeEligible = opts?.planModeNudgeEligible === true;
  const newUser = opts?.newUser === true;
  return tips.filter((t) => {
    if ((t.minSessions ?? 0) > activeSessionCount) return false;
    if (t.requiresPlanModeNudge && !planModeNudgeEligible) return false;
    if (t.requiresNewUser && !newUser) return false;
    return true;
  });
}

/**
 * Advance the rotation index, wrapping at the end. Pure so it can be unit
 * tested without driving a React interval. Guards against an empty list and a
 * non-finite/out-of-range current index so a bad backend feed can't crash the
 * spinner.
 */
export function nextTipIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  const safe = Number.isFinite(current) ? Math.floor(current) : 0;
  return ((safe % count) + count + 1) % count;
}

/**
 * Dismissed-tip weighting: when the renderer lands on a tip the user has
 * pressed × on, show it with this probability instead of skipping to the next
 * non-dismissed tip. 0.2 → dismissed tips appear ~20% as often (1 in 5),
 * matching the "show less, but not never" semantic of the dismiss control.
 *
 * Exported so the test can pin it without re-deriving the constant.
 */
export const DISMISSED_TIP_SHOW_PROBABILITY = 0.2;

/**
 * Rotation variant that respects {@link useTipDismissals}: dismissed tips stay
 * in the list but are mostly skipped — clicking × on a tip should make it
 * appear less, not vanish. When every tip is dismissed (or `dismissed` is
 * empty), behaves like {@link nextTipIndex}.
 *
 * `rng` is injectable so the unit test can drive the random branch
 * deterministically; production defaults to `Math.random`.
 */
export function nextTipIndexWithDismissals(
  current: number,
  tips: ReadonlyArray<Pick<Tip, "id">>,
  dismissed: ReadonlySet<string>,
  rng: () => number = Math.random,
): number {
  const count = tips.length;
  if (count <= 0) return 0;
  let next = nextTipIndex(current, count);
  if (dismissed.size === 0) return next;
  // Walk forward at most one full lap. If we land on a dismissed tip, give
  // it the show-less probability; otherwise skip ahead. If we lap without
  // finding a non-dismissed tip, every tip is dismissed — return wherever
  // we ended up so the spinner doesn't sit stuck on the same id.
  for (let n = 0; n < count; n++) {
    const tip = tips[next];
    if (!dismissed.has(tip.id)) return next;
    if (rng() < DISMISSED_TIP_SHOW_PROBABILITY) return next;
    next = (next + 1) % count;
  }
  return next;
}
