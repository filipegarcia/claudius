import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  describeBedrockConfig,
  isAccountKind,
  normalizeBedrockConfig,
  type AccountKind,
  type BedrockConfig,
  type PublicBedrockConfig,
} from "@/lib/shared/accounts";

export type { AccountKind, BedrockConfig, PublicBedrockConfig } from "@/lib/shared/accounts";

/**
 * Account-switcher store. Lets a single Claudius install hold several
 * Claude credentials (subscription OAuth tokens, raw API keys) and pick
 * which one new SDK sessions spawn under. The motivating use case is the
 * "I hit my Max-plan limit on account A, let me flip to account B"
 * workflow — see the README / Settings → Accounts.
 *
 * Storage: ~/.claude/.claudius/accounts.json with mode 0600 so the
 * secret material isn't world-readable. The blob is intentionally kept
 * out of the per-project SQLite db because accounts are system-global —
 * one account can serve many workspaces.
 *
 * IMPORTANT: profile `secret` is a raw credential. Server-side code is
 * the ONLY caller that ever sees it; API responses go through
 * `toPublic()` which strips the secret and replaces it with a short
 * preview (last 4 chars) so the client can render a recognizable hint
 * without exposing the token to e.g. the browser's network panel.
 */

/**
 * `AccountKind` lives in `lib/shared/accounts.ts` (the /usage page needs
 * it too). Summary:
 *
 * - `oauth-token`: long-lived `CLAUDE_CODE_OAUTH_TOKEN` — what
 *   `claude setup-token` emits. Backed by the user's Anthropic
 *   subscription (Pro/Max). Don't confuse with the short-lived access
 *   token in the macOS keychain — that one expires in ~hours and would
 *   leave the profile dead after the first use.
 * - `api-key`: pay-per-token `ANTHROPIC_API_KEY` (`sk-ant-...`). Not
 *   subject to subscription rate limits; a useful "overflow lane" when
 *   a subscription account is exhausted.
 * - `bedrock`: Claude Code's own Amazon Bedrock mode
 *   (`CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials). Same SDK harness,
 *   different inference backend; billed to the AWS account. Non-secret
 *   settings live in `AccountProfile.bedrock`, the secret half (secret
 *   access key / Bedrock API key) in `secret` like every other kind.
 */

export type AccountProfile = {
  id: string;
  label: string;
  kind: AccountKind;
  /**
   * Raw credential. Never sent to the client — see `toPublic`.
   * Empty string is legal ONLY for `bedrock` profiles whose auth method
   * carries no secret of its own (`aws-profile`, `ambient`).
   */
  secret: string;
  createdAt: string;
  /** Bedrock settings — present iff `kind === "bedrock"`. */
  bedrock?: BedrockConfig;
  /**
   * Cached metadata captured at the moment the profile was created
   * (either from the OAuth token-exchange response, or — for paste
   * flows — left undefined). Used as the fallback when the live
   * /api/oauth/profile lookup fails (e.g. Anthropic 5xx, scope
   * limits on inference-only tokens). Treated as best-effort: never
   * authoritative, just "what we knew at sign-in time".
   *
   * When all three of accountUuid+emailAddress+organizationUuid are
   * present, `buildEnvForProfile` also exports them as
   * CLAUDE_CODE_{ACCOUNT_UUID,USER_EMAIL,ORGANIZATION_UUID} so the
   * SDK populates its accountInfo cache without hitting
   * /api/oauth/profile — the path that's failing under inference-
   * only scope / Anthropic 529s.
   */
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  subscriptionType?: string;
  /**
   * Unix-ms instant the OAuth access token stops working, when the
   * token-exchange response reported one (CC 2.1.203 parity: "warning when
   * your login is about to expire"). Claudius never refreshes this token on
   * the profile's behalf — the `oauth-token` kind is meant to be the
   * long-lived `setup-token`-style credential (see `AccountKind` doc), so in
   * practice most profiles never set this. But when the exchange DOES report
   * an expiry (short-lived grants, org policy, etc.) and nothing refreshes
   * it, the session will eventually 401 exactly like `auth-failed-detector.ts`
   * already handles reactively. `Session.noteTokenExpiringAtStartup()` reads
   * this to fire a *proactive* nudge before that happens. Absent ⇒ treated
   * as "never expires" (no nudge).
   */
  expiresAt?: number;
};

export type PublicAccountProfile = {
  id: string;
  label: string;
  kind: AccountKind;
  /**
   * Last 4 chars of the secret, for a recognizable badge in the UI. For
   * `bedrock` profiles this is a secret-free one-liner instead
   * (`us-east-1 · profile work-sso`) — see `describeBedrockConfig`.
   */
  secretPreview: string;
  createdAt: string;
  /** Secret-stripped Bedrock settings — present iff `kind === "bedrock"`. */
  bedrock?: PublicBedrockConfig;
};

export type AccountsState = {
  profiles: AccountProfile[];
  /** Profile used as the default for new SDK sessions. */
  activeProfileId: string | null;
  /**
   * When true, hitting a rate-limit on the active account triggers a
   * round-robin switch to the next configured profile. The current
   * (already-rate-limited) session can't be auto-resumed under the new
   * credential — the SDK reads env at `query()` time — so the user
   * still needs to start a new session, but the *next* session will be
   * under the rotated profile without an extra click.
   */
  autoRotateOnRateLimit: boolean;
};

export type PublicAccountsState = {
  profiles: PublicAccountProfile[];
  activeProfileId: string | null;
  autoRotateOnRateLimit: boolean;
};

function accountsDir(): string {
  // Smoke / unit tests must NOT touch the user's real
  // ~/.claude/.claudius/accounts.json. We tried overriding `HOME`
  // and that didn't work — bun caches `os.homedir()` at the native
  // layer, so runtime mutations to process.env.HOME are ignored.
  // Honor an explicit `CLAUDIUS_ACCOUNTS_DIR` override instead;
  // tests set this to a tmp dir and the writes land safely there.
  // Empty string falls back to the user's home (production path).
  const override = process.env.CLAUDIUS_ACCOUNTS_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), ".claude", ".claudius");
}

function accountsPath(): string {
  return join(accountsDir(), "accounts.json");
}

/**
 * Per-profile config dir under our accounts root. Each profile gets
 * a shadow `~/.claude/`-equivalent that the SDK reads from when we
 * point `CLAUDE_CONFIG_DIR` at it — see `provisionProfileConfigDir`
 * for the why-we-need-this.
 */
function profileConfigDir(profileId: string): string {
  return join(accountsDir(), "profiles", profileId);
}

/**
 * Real user config dir the SDK reads by default. We mirror its
 * contents (minus `.credentials.json`) into the per-profile dir via
 * symlinks so plugins/settings/MCP-servers/history etc. still apply
 * to the session.
 */
function realClaudeDir(): string {
  return join(homedir(), ".claude");
}

/**
 * Create (or refresh) the per-profile config dir backing the
 * `CLAUDE_CONFIG_DIR` env var for sessions spawned under `profile`.
 *
 * WHY THIS EXISTS — the load-bearing piece of the account switcher.
 * Env-only injection of `CLAUDE_CODE_OAUTH_TOKEN` does NOT suppress
 * the SDK's macOS Keychain credential lookup. Confirmed empirically:
 * with profile B "active", sessions kept billing the keychain
 * account A (the `claude /login` identity) regardless of which env
 * we passed via `Options.env`. The keychain branch inside the SDK's
 * credential resolver fires unless `CLAUDE_CONFIG_DIR` (or
 * `ANTHROPIC_API_KEY`) is set in the context that resolver actually
 * reads from — which evidently isn't the subprocess env our
 * injection lands in.
 *
 * Pointing `CLAUDE_CONFIG_DIR` at a per-profile dir we control AND
 * writing the profile's token into that dir's `.credentials.json`
 * forces the SDK to read OUR token from disk and skip the keychain
 * entirely. The other entries of `~/.claude/` (plugins, settings,
 * MCP servers, projects, history, …) are mirrored via symlinks so
 * the session still sees the user's real customizations.
 *
 * Idempotent: safe to call on every session start. The
 * `.credentials.json` write is atomic (tmp + rename) so a concurrent
 * spawn can't read a half-written file.
 */
async function provisionProfileConfigDir(profile: AccountProfile): Promise<string> {
  const dir = profileConfigDir(profile.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // Mirror everything from the real ~/.claude/ via symlinks, EXCEPT
  // .credentials.json (which we write fresh, per-profile, below).
  // The mirror is best-effort: a symlinkable error on one entry
  // doesn't block the session — at worst the session won't see that
  // particular customization.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(realClaudeDir());
  } catch {
    // No ~/.claude/ at all (fresh machine, or a Claudius-only user
    // who never ran `claude /login`). Nothing to mirror — the
    // session runs against the bare per-profile dir.
  }
  for (const name of entries) {
    if (name === ".credentials.json") continue;
    const target = join(realClaudeDir(), name);
    const linkPath = join(dir, name);
    try {
      const existing = await fs.readlink(linkPath);
      if (existing === target) continue;
      // Stale symlink pointing somewhere wrong — replace it.
      await fs.unlink(linkPath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // ENOENT: nothing there yet, fall through to create the link.
      // EINVAL: a real file/dir exists at linkPath, not a symlink.
      //         Leave it alone — could be user data we mustn't lose.
      if (e.code !== "ENOENT" && e.code !== "EINVAL") {
        // Some other error (EACCES etc.). Skip this entry; the
        // mirror is best-effort.
        continue;
      }
      if (e.code === "EINVAL") continue;
    }
    await fs.symlink(target, linkPath).catch(() => { /* best-effort */ });
  }

  // Now the actual credentials file. The SDK's keychain format is
  // `{ claudeAiOauth: { accessToken, refreshToken?, expiresAt?, ... } }`
  // — observed by reading the user's macOS Keychain entry under the
  // `Claude Code-credentials` service. For long-lived setup-token
  // OAuth tokens there's no refresh token, and the SDK only refreshes
  // when it has one, so a minimal blob with just `accessToken` is
  // sufficient.
  const credsPath = join(dir, ".credentials.json");
  if (profile.kind === "oauth-token") {
    const credsBlob = {
      claudeAiOauth: {
        accessToken: profile.secret,
      },
    };
    // Tmp name MUST be unique per call, not just per process. Without the
    // random suffix two concurrent `provisionProfileConfigDir(sameProfile)`
    // calls (the common case: two sessions starting at once, or the
    // "Resolve with Claude Code" updater flow that spawns one) both
    // compute the same `.credentials.json.<pid>.tmp`, both writeFile (the
    // second overwrites the first), then the FIRST rename consumes the
    // tmp and the SECOND rename throws `ENOENT … rename '<tmp>' →
    // '<credsPath>'` because the tmp is gone. The random suffix gives
    // each call its own tmp so the rename's source always exists.
    const tmp = `${credsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(credsBlob, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await fs.rename(tmp, credsPath);
    } catch (err) {
      // Best-effort cleanup so a crashed rename (EXDEV, EACCES) doesn't
      // leak a 0600 tmp containing the token. Idempotent on success.
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
    try { await fs.chmod(credsPath, 0o600); } catch { /* non-fatal */ }
  } else {
    // api-key / bedrock profile — the SDK reads the credential from env
    // (ANTHROPIC_API_KEY, or the AWS credential chain); no
    // credentials.json equivalent. Just make sure no stale file lingers
    // (would shadow the env on the credential resolver's read path).
    await fs.unlink(credsPath).catch(() => {});
  }

  return dir;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(accountsDir(), { recursive: true });
}

/**
 * Read the on-disk state. Missing file ⇒ empty state (first run). All
 * other IO/JSON errors propagate — callers decide whether to surface
 * them or treat as empty.
 */
export async function readAccountsRaw(): Promise<AccountsState> {
  try {
    const raw = await fs.readFile(accountsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AccountsState>;
    const profiles = Array.isArray(parsed.profiles)
      ? parsed.profiles.filter(isProfileShape)
      : [];
    const activeProfileId =
      typeof parsed.activeProfileId === "string" &&
      profiles.some((p) => p.id === parsed.activeProfileId)
        ? parsed.activeProfileId
        : null;
    return {
      profiles,
      activeProfileId,
      autoRotateOnRateLimit: parsed.autoRotateOnRateLimit === true,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { profiles: [], activeProfileId: null, autoRotateOnRateLimit: false };
    }
    throw err;
  }
}

/**
 * Client-safe view: profiles without raw secrets, only a 4-char preview.
 */
export async function readAccountsPublic(): Promise<PublicAccountsState> {
  const cur = await readAccountsRaw();
  return {
    profiles: cur.profiles.map(toPublic),
    activeProfileId: cur.activeProfileId,
    autoRotateOnRateLimit: cur.autoRotateOnRateLimit,
  };
}

async function writeAccounts(next: AccountsState): Promise<AccountsState> {
  await ensureDir();
  // Write to a temp + rename so a crash mid-write doesn't leave a
  // truncated accounts.json (we'd lose all configured profiles).
  // Random suffix on the tmp so two concurrent writers (the
  // settings-page POST + a background rotate, for example) don't both
  // race on `.${pid}.tmp` and have the loser's rename ENOENT. Same fix
  // as `provisionProfileConfigDir` above — see that note for the full
  // race.
  const path = accountsPath();
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  // Belt-and-braces: explicit chmod for the case where the file
  // pre-existed under a looser mode before we adopted 0600.
  try { await fs.chmod(path, 0o600); } catch { /* non-fatal */ }
  return next;
}

/**
 * Add a new profile. First profile auto-becomes the active one (so the
 * "add → use" path doesn't require a second click). Label is trimmed
 * and must be non-empty; secret is trimmed and must be non-empty.
 * Optional metadata fields (email/org/subscription) are stored as the
 * fallback when the live profile endpoint is unreachable — populated
 * by the OAuth flow from the token-exchange response.
 */
export async function addAccount(
  input: Pick<AccountProfile, "label" | "kind"> & {
    /** Required for oauth-token / api-key; per-auth-method for bedrock. */
    secret?: string;
    /** Required iff `kind === "bedrock"`; validated by `normalizeBedrockConfig`. */
    bedrock?: Partial<BedrockConfig>;
    accountUuid?: string;
    emailAddress?: string;
    organizationUuid?: string;
    subscriptionType?: string;
    expiresAt?: number;
  },
): Promise<{ state: AccountsState; profile: AccountProfile }> {
  const label = (input.label ?? "").trim();
  const secret = (input.secret ?? "").trim();
  if (!label) throw new Error("label required");
  if (!isAccountKind(input.kind)) {
    throw new Error("kind must be oauth-token, api-key or bedrock");
  }
  // Bedrock validates its own secret requirement per auth method
  // (aws-profile / ambient legitimately carry none); the Anthropic kinds
  // always need one.
  let bedrock: BedrockConfig | undefined;
  if (input.kind === "bedrock") {
    bedrock = normalizeBedrockConfig(input.bedrock, secret);
  } else if (!secret) {
    throw new Error("secret required");
  }
  const cur = await readAccountsRaw();
  const profile: AccountProfile = {
    id: newProfileId(),
    label,
    kind: input.kind,
    secret,
    createdAt: new Date().toISOString(),
    ...(bedrock ? { bedrock } : {}),
    ...(input.accountUuid ? { accountUuid: input.accountUuid } : {}),
    ...(input.emailAddress ? { emailAddress: input.emailAddress } : {}),
    ...(input.organizationUuid ? { organizationUuid: input.organizationUuid } : {}),
    ...(input.subscriptionType ? { subscriptionType: input.subscriptionType } : {}),
    ...(typeof input.expiresAt === "number" ? { expiresAt: input.expiresAt } : {}),
  };
  const profiles = [...cur.profiles, profile];
  const activeProfileId = cur.activeProfileId ?? profile.id;
  const state = await writeAccounts({
    profiles,
    activeProfileId,
    autoRotateOnRateLimit: cur.autoRotateOnRateLimit,
  });
  return { state, profile };
}

/**
 * Toggle the auto-rotate-on-rate-limit flag.
 */
export async function setAutoRotate(on: boolean): Promise<AccountsState> {
  const cur = await readAccountsRaw();
  return writeAccounts({ ...cur, autoRotateOnRateLimit: on });
}

/**
 * Merge fresh profile metadata onto an existing account. Used by
 * `getProfileInfoForAccount` to backfill the fallback fields after a
 * successful live lookup — so a future 529 / network blip can fall
 * through to the now-cached values instead of showing "—" for every
 * row. No-op when the id is unknown.
 */
export async function updateAccountMetadata(
  id: string,
  meta: {
    accountUuid?: string;
    emailAddress?: string;
    organizationUuid?: string;
    subscriptionType?: string;
  },
): Promise<void> {
  const cur = await readAccountsRaw();
  let mutated = false;
  const profiles = cur.profiles.map((p) => {
    if (p.id !== id) return p;
    const next = { ...p };
    if (meta.accountUuid && meta.accountUuid !== p.accountUuid) {
      next.accountUuid = meta.accountUuid;
      mutated = true;
    }
    if (meta.emailAddress && meta.emailAddress !== p.emailAddress) {
      next.emailAddress = meta.emailAddress;
      mutated = true;
    }
    if (meta.organizationUuid && meta.organizationUuid !== p.organizationUuid) {
      next.organizationUuid = meta.organizationUuid;
      mutated = true;
    }
    if (meta.subscriptionType && meta.subscriptionType !== p.subscriptionType) {
      next.subscriptionType = meta.subscriptionType;
      mutated = true;
    }
    return next;
  });
  if (!mutated) return;
  await writeAccounts({ ...cur, profiles });
}

/**
 * Pick the next profile (round-robin) and promote it to active.
 * Returns the from→to pair so the caller can surface a notification.
 * Returns null when there's no peer to rotate to (zero or one
 * profile), so the caller can no-op gracefully.
 */
export async function rotateToNextProfile(): Promise<
  | { from: PublicAccountProfile; to: PublicAccountProfile }
  | null
> {
  const cur = await readAccountsRaw();
  if (cur.profiles.length < 2) return null;
  const idx = cur.profiles.findIndex((p) => p.id === cur.activeProfileId);
  // No active id (corrupt state) or active is the last in the list:
  // wrap to the first. Otherwise advance by one.
  const fromProfile = idx >= 0 ? cur.profiles[idx] : cur.profiles[0];
  const nextIdx = idx < 0 ? 0 : (idx + 1) % cur.profiles.length;
  const toProfile = cur.profiles[nextIdx];
  if (fromProfile.id === toProfile.id) return null;
  await writeAccounts({ ...cur, activeProfileId: toProfile.id });
  return { from: toPublic(fromProfile), to: toPublic(toProfile) };
}

/**
 * Promote a profile to "active" (= default for new sessions). Throws if
 * the id isn't known.
 */
export async function setActiveAccount(id: string): Promise<AccountsState> {
  const cur = await readAccountsRaw();
  if (!cur.profiles.some((p) => p.id === id)) {
    throw new Error("profile not found");
  }
  return writeAccounts({ ...cur, activeProfileId: id });
}

/**
 * Remove a profile. If it was the active one, the active pointer is
 * re-aimed at whichever profile is left first (or null if none remain).
 * Also wipes the per-profile config dir under
 * `~/.claude/.claudius/profiles/<id>/` so the secret-bearing
 * `.credentials.json` doesn't linger on disk after the user thinks
 * they removed the account.
 */
export async function deleteAccount(id: string): Promise<AccountsState> {
  const cur = await readAccountsRaw();
  const profiles = cur.profiles.filter((p) => p.id !== id);
  if (profiles.length === cur.profiles.length) {
    // No-op delete (id wasn't present) — return current state as-is.
    return cur;
  }
  let activeProfileId = cur.activeProfileId;
  if (activeProfileId === id) {
    activeProfileId = profiles[0]?.id ?? null;
  }
  const state = await writeAccounts({
    profiles,
    activeProfileId,
    autoRotateOnRateLimit: cur.autoRotateOnRateLimit,
  });
  // Best-effort cleanup of the per-profile config dir. A failure here
  // leaks a 0700 dir holding (at worst) a `.credentials.json` with a
  // single OAuth token — annoying but not session-breaking. We log
  // nothing because every interactive disk error during account
  // deletion is one too many for the user.
  await fs.rm(profileConfigDir(id), { recursive: true, force: true }).catch(() => {});
  return state;
}

/**
 * Resolve the active profile for the env-injection path in
 * `session.ts`. Returns null when nothing is configured — in that case
 * the SDK inherits the ambient environment (current Claudius behavior,
 * preserved).
 */
export async function getActiveProfile(): Promise<AccountProfile | null> {
  const cur = await readAccountsRaw();
  if (!cur.activeProfileId) return null;
  return cur.profiles.find((p) => p.id === cur.activeProfileId) ?? null;
}

/**
 * Resolve one profile by id, independent of which one is "active".
 *
 * This is what backs session account *pinning* (see
 * `Session.resolveAccountProfile`). A session records the profile it was
 * first spawned under; when it's later reaped and resumed we want the SAME
 * credential, not whatever the global active pointer happens to be by then
 * — otherwise the conversation silently changes identity and billing
 * mid-thread (confirmed symptom: the agent's injected `userEmail` and
 * per-profile memory dir flip between turns of one session).
 *
 * Returns null when the id is unknown — the caller is expected to fall back
 * to `getActiveProfile()` so a session pinned to a since-deleted account
 * still starts instead of erroring.
 */
export async function getProfileById(id: string): Promise<AccountProfile | null> {
  const cur = await readAccountsRaw();
  return cur.profiles.find((p) => p.id === id) ?? null;
}

/**
 * Build the env block for an SDK spawn under the given profile.
 *
 * The SDK contract is that `Options.env` REPLACES the subprocess
 * environment entirely (not merged with `process.env`) — see
 * `sdk.d.ts`. We therefore spread `process.env`, then explicitly remove
 * every auth-related variable so the spread can't leak a stray
 * `ANTHROPIC_API_KEY` from the parent shell into a subscription-OAuth
 * session (or vice versa). The single var the profile dictates is the
 * last write, so precedence is unambiguous.
 *
 * On top of the env scrub, we provision a per-profile config dir and
 * point `CLAUDE_CONFIG_DIR` at it (see `provisionProfileConfigDir`).
 * This is what actually makes the switch take effect for billing —
 * env-only injection is silently ignored by the SDK's credential
 * resolver, which falls back to the macOS Keychain instead.
 *
 * Async because the config-dir provisioning writes a `.credentials.json`
 * to disk; callers must `await` this. Returns the env dict (never null;
 * the no-profile case is handled by the caller — see `session.ts`).
 */
export async function buildEnvForProfile(
  profile: AccountProfile,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Scrub every auth-related variable we know about. Anything not
  // listed here is irrelevant — keeping the list explicit makes it
  // obvious from one place which vars are part of the precedence chain.
  for (const k of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    // CLAUDE_CONFIG_DIR is set fresh below — scrub a stray parent-
    // shell value so it can't shadow our per-profile dir.
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    // Account-info env vars — always start clean so a stray value from
    // the parent shell can't shadow what THIS profile actually is.
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_ORGANIZATION_UUID",
  ]) {
    delete env[k];
  }
  // NOTE: AWS_* vars are deliberately NOT scrubbed for the Anthropic
  // kinds. With CLAUDE_CODE_USE_BEDROCK gone they're inert for inference,
  // but the agent's Bash tool inherits this env too and users routinely
  // rely on AWS_PROFILE there (`aws s3 ls` from a chat). Only a bedrock
  // profile with explicit credentials overrides them — see below.
  if (profile.kind === "oauth-token") {
    env.CLAUDE_CODE_OAUTH_TOKEN = profile.secret;
  } else if (profile.kind === "api-key") {
    env.ANTHROPIC_API_KEY = profile.secret;
  } else {
    applyBedrockEnv(env, profile);
  }
  // The load-bearing piece. CLAUDE_CONFIG_DIR points the SDK at a
  // per-profile mirror dir whose `.credentials.json` contains THIS
  // profile's token — bypassing the macOS Keychain that env-only
  // injection can't override. Other ~/.claude/ entries (plugins,
  // settings, MCP, etc.) are symlinked into the mirror so the
  // session still sees the user's customizations. (Bedrock profiles
  // get the same mirror — no credentials file, but the per-profile
  // dir keeps memory/settings isolation consistent across kinds.)
  env.CLAUDE_CONFIG_DIR = await provisionProfileConfigDir(profile);
  // Inject the account-info env vars when we have the full triple. The
  // SDK's `populateOAuthAccountInfoIfNeeded` short-circuits to these
  // when all three are set (see
  // `claude-code-leak-main/src/services/oauth/client.ts:457`) —
  // bypassing the /api/oauth/profile round-trip that fails under
  // inference-only scope. Partial sets are skipped: the SDK requires
  // all three together, so injecting just one would do nothing.
  if (profile.accountUuid && profile.emailAddress && profile.organizationUuid) {
    env.CLAUDE_CODE_ACCOUNT_UUID = profile.accountUuid;
    env.CLAUDE_CODE_USER_EMAIL = profile.emailAddress;
    env.CLAUDE_CODE_ORGANIZATION_UUID = profile.organizationUuid;
  }
  return env;
}

/**
 * AWS credential vars a Bedrock profile with explicit credentials takes
 * ownership of. Scrubbed before injection so the AWS default chain can't
 * pick up a parent-shell value that outranks what the profile says
 * (env keys beat `AWS_PROFILE` in the chain, so a stray
 * `AWS_ACCESS_KEY_ID` would silently hijack an `aws-profile` profile).
 */
const BEDROCK_CREDENTIAL_VARS = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

/**
 * Translate a `bedrock` profile into the env Claude Code's Bedrock mode
 * reads (see code.claude.com/docs/en/amazon-bedrock — "Set up manually").
 * Mutates `env` in place. Pure apart from that; unit-tested directly.
 *
 * Contract (Claude Code ≥ 2.1.207, bundled SDK ships 2.1.272):
 *   CLAUDE_CODE_USE_BEDROCK=1             — the switch
 *   AWS_REGION                            — optional; profile/us-east-1 fallback
 *   AWS_PROFILE | AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY[+AWS_SESSION_TOKEN]
 *     | AWS_BEARER_TOKEN_BEDROCK          — one credential source
 *   ANTHROPIC_MODEL                       — default model when the session
 *                                           passes none (`--model` wins)
 *   ANTHROPIC_BEDROCK_REGION_PREFIX       — us/eu/apac/jp/au/global
 *   ANTHROPIC_BEDROCK_BASE_URL            — gateway / custom endpoint
 */
export function applyBedrockEnv(env: NodeJS.ProcessEnv, profile: AccountProfile): void {
  const cfg = profile.bedrock;
  if (profile.kind !== "bedrock" || !cfg) {
    throw new Error("applyBedrockEnv: not a bedrock profile");
  }
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  // Mantle is a different endpoint with its own model lineup; a stray
  // parent-shell opt-in would silently reroute this profile's requests.
  delete env.CLAUDE_CODE_USE_MANTLE;
  if (cfg.auth !== "ambient") {
    for (const k of BEDROCK_CREDENTIAL_VARS) delete env[k];
  }
  switch (cfg.auth) {
    case "aws-profile":
      env.AWS_PROFILE = cfg.awsProfile;
      break;
    case "access-keys":
      env.AWS_ACCESS_KEY_ID = cfg.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = profile.secret;
      if (cfg.sessionToken) env.AWS_SESSION_TOKEN = cfg.sessionToken;
      break;
    case "bearer-token":
      env.AWS_BEARER_TOKEN_BEDROCK = profile.secret;
      break;
    case "ambient":
      // Inherit the chain as-is (instance role, `aws login`, exported keys).
      break;
  }
  if (cfg.region) {
    env.AWS_REGION = cfg.region;
    // AWS_DEFAULT_REGION is lower precedence, but a mismatched value is
    // confusing in `/status` — keep the two in agreement.
    delete env.AWS_DEFAULT_REGION;
  }
  if (cfg.model) env.ANTHROPIC_MODEL = cfg.model;
  else delete env.ANTHROPIC_MODEL;
  if (cfg.regionPrefix) env.ANTHROPIC_BEDROCK_REGION_PREFIX = cfg.regionPrefix;
  else delete env.ANTHROPIC_BEDROCK_REGION_PREFIX;
  if (cfg.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = cfg.baseUrl;
  else delete env.ANTHROPIC_BEDROCK_BASE_URL;
}

/**
 * Client-safe projection of a profile. Exported so route handlers reuse
 * the one definition of "what leaves the server" rather than re-deriving
 * the preview inline.
 */
export function toPublic(p: AccountProfile): PublicAccountProfile {
  if (p.kind === "bedrock" && p.bedrock) {
    // Strip the session token (secret) and describe the rest.
    const { sessionToken: _sessionToken, ...bedrock } = p.bedrock;
    void _sessionToken;
    return {
      id: p.id,
      label: p.label,
      kind: p.kind,
      secretPreview: describeBedrockConfig(bedrock),
      createdAt: p.createdAt,
      bedrock,
    };
  }
  return {
    id: p.id,
    label: p.label,
    kind: p.kind,
    secretPreview: previewSecret(p.secret),
    createdAt: p.createdAt,
  };
}

function previewSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 4) return "•".repeat(s.length);
  return `…${s.slice(-4)}`;
}

function newProfileId(): string {
  return `acc_${randomBytes(8).toString("hex")}`;
}

function isProfileShape(x: unknown): x is AccountProfile {
  if (!x || typeof x !== "object") return false;
  const p = x as Partial<AccountProfile>;
  // Required fields. The optional metadata (emailAddress, …) is
  // tolerated as missing or present — we don't gate validity on it.
  if (
    typeof p.id !== "string" ||
    typeof p.label !== "string" ||
    !isAccountKind(p.kind) ||
    typeof p.secret !== "string" ||
    typeof p.createdAt !== "string"
  ) {
    return false;
  }
  // A bedrock row without its config block can't be turned into env —
  // drop it rather than let `applyBedrockEnv` throw at session start.
  if (p.kind === "bedrock") {
    return !!p.bedrock && typeof p.bedrock === "object" && typeof p.bedrock.auth === "string";
  }
  return true;
}
