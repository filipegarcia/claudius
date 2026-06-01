"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  Check,
  CreditCard,
  Database,
  Globe,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

type AccountKind = "oauth-token" | "api-key";
type PublicAccountProfile = {
  id: string;
  label: string;
  kind: AccountKind;
  secretPreview: string;
  createdAt: string;
};
type AccountsState = {
  profiles: PublicAccountProfile[];
  activeProfileId: string | null;
  autoRotateOnRateLimit: boolean;
};

const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  "oauth-token": "Subscription (OAuth)",
  "api-key": "API key",
};

type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "mantle";
  /**
   * When populated, this AccountInfo was synthesized from the active
   * account-switcher profile rather than from a live session's
   * `accountInfo()`. The Account section uses this flag to swap the
   * header label and skip the "open a session" empty-state copy.
   */
  fromActiveProfile?: {
    label: string;
    kind: "oauth-token" | "api-key";
    errored?: boolean;
    error?: string;
  };
};

type AccountProfileInfoResponse = {
  info: {
    provider: "firstParty";
    profileId: string;
    profileLabel: string;
    profileKind: "oauth-token" | "api-key";
    email?: string;
    displayName?: string;
    organizationUuid?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
    errored?: boolean;
    error?: string;
  } | null;
};

type ActiveSession = { id: string; cwd?: string; model?: string };

const PROVIDERS: {
  id: NonNullable<AccountInfo["apiProvider"]>;
  label: string;
  helper: string;
  envSnippet: string;
}[] = [
  {
    id: "firstParty",
    label: "Anthropic API (default)",
    helper: "Use ANTHROPIC_API_KEY or sign in with Claude Code's OAuth.",
    envSnippet: "export ANTHROPIC_API_KEY=sk-ant-…",
  },
  {
    id: "bedrock",
    label: "Amazon Bedrock",
    helper: "Set CLAUDE_CODE_USE_BEDROCK=1 and configure AWS credentials (sso/role/keys).",
    envSnippet: "export CLAUDE_CODE_USE_BEDROCK=1\nexport AWS_REGION=us-east-1",
  },
  {
    id: "vertex",
    label: "Google Vertex AI",
    helper: "Set CLAUDE_CODE_USE_VERTEX=1 and run `gcloud auth application-default login`.",
    envSnippet:
      "export CLAUDE_CODE_USE_VERTEX=1\nexport CLOUD_ML_REGION=us-east5\nexport ANTHROPIC_VERTEX_PROJECT_ID=your-project",
  },
  {
    id: "foundry",
    label: "Microsoft Foundry",
    helper: "Set CLAUDE_CODE_USE_FOUNDRY=1 and configure Azure credentials.",
    envSnippet: "export CLAUDE_CODE_USE_FOUNDRY=1",
  },
  {
    id: "anthropicAws",
    label: "Anthropic via AWS",
    helper: "Anthropic API hosted on AWS infra — same env as firstParty.",
    envSnippet: "export ANTHROPIC_API_KEY=sk-ant-…",
  },
  {
    id: "mantle",
    label: "Mantle",
    helper: "Mantle-hosted relay — see your org docs.",
    envSnippet: "# org-specific",
  },
];

function fmtUsd(n?: number): string {
  if (typeof n !== "number" || n === 0) return n === 0 ? "$0.00" : "—";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

function fmtTokens(n?: number): string {
  if (typeof n !== "number") return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtMs(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
}

export default function UsagePage() {
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [refetchTrigger, setRefetchTrigger] = useState(0);

  // Account-switcher state — separate from the read-only `account` info
  // above. The handlers (add / switch / delete) update `accounts` straight
  // from each endpoint's response, so the only place we need an explicit
  // fetch is the initial mount load.
  const [accounts, setAccounts] = useState<AccountsState | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/accounts");
        if (cancelled) return;
        if (!r.ok) {
          const e = (await r.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setAccountsError(e.error ?? `HTTP ${r.status}`);
          return;
        }
        const data = (await r.json()) as AccountsState;
        if (!cancelled) {
          setAccounts(data);
          setAccountsError(null);
        }
      } catch (err) {
        if (!cancelled) setAccountsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Active-profile-driven Account section. When the user has an
  // account-switcher profile selected, the Account section should
  // describe THAT profile — not whatever credential the most-recent
  // running session happens to have. We resolve the profile info
  // server-side (so the raw token never crosses the network) and
  // overwrite the `account` state with it. When no profile is
  // configured this effect is a no-op and the per-session fetch below
  // remains the authority — preserves pre-account-switcher behavior.
  //
  // Includes `refetchTrigger` in the deps + forwards `refresh=1` when
  // the user clicked the header Refresh button, so an explicit refresh
  // bypasses the server-side 5min cache.
  const activeProfileId = accounts?.activeProfileId ?? null;
  useEffect(() => {
    if (!activeProfileId) return;
    let cancelled = false;
    const force = refetchTrigger > 0;
    void (async () => {
      try {
        const r = await fetch(
          `/api/accounts/profile?id=${encodeURIComponent(activeProfileId)}${force ? "&refresh=1" : ""}`,
        );
        if (cancelled || !r.ok) return;
        const { info } = (await r.json()) as AccountProfileInfoResponse;
        if (cancelled || !info) return;
        // MERGE with the per-session fetch's result instead of clobbering
        // it. The session-derived `account` (from `/api/account?sessionId=X`)
        // carries the SDK's `accountInfo()` — which reads
        // ~/.claude.json's `oauthAccount` block and is often richer
        // than what /api/oauth/profile returns under an inference-only
        // token. We layer: profile-endpoint data overrides ONLY the
        // fields it has values for; session-derived data fills the
        // gaps. `fromActiveProfile` always reflects the profile-endpoint
        // call so the UI banner shows the active profile's label.
        setAccount((prev) => ({
          ...prev,
          apiProvider: info.provider ?? prev?.apiProvider,
          email: info.email ?? prev?.email,
          organization: info.organizationUuid ?? prev?.organization,
          subscriptionType: info.subscriptionType ?? prev?.subscriptionType,
          tokenSource:
            info.profileKind === "oauth-token"
              ? "account-switcher"
              : prev?.tokenSource,
          apiKeySource:
            info.profileKind === "api-key"
              ? "account-switcher"
              : prev?.apiKeySource,
          fromActiveProfile: {
            label: info.profileLabel,
            kind: info.profileKind,
            errored: info.errored,
            error: info.error,
          },
        }));
        setAccountError(null);
        setLoading(false);
      } catch (err) {
        if (!cancelled) setAccountError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, refetchTrigger]);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const listRes = await fetch("/api/sessions", { signal: controller.signal });
        const list = (await listRes.json()) as ActiveSession[];
        const first = Array.isArray(list) ? list[0] ?? null : null;
        if (controller.signal.aborted) return;
        setSession(first);
        if (!first) return;
        try {
          const r = await fetch(
            `/api/account?sessionId=${encodeURIComponent(first.id)}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          if (r.ok) {
            setAccount((await r.json()) as AccountInfo);
            setAccountError(null);
          } else {
            const e = (await r.json().catch(() => ({}))) as { error?: string };
            setAccountError(e.error ?? `HTTP ${r.status}`);
          }
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setAccountError(err instanceof Error ? err.message : String(err));
        }
        // Snapshot the most recent /cost from the session manager via
        // cookieless client side. We can't read it from the server (it
        // lives in the SSE stream), so leave usage best-effort.
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Best-effort: don't surface the /sessions list failure to UI.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [refetchTrigger]);

  const refresh = () => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  };

  const apiProvider = account?.apiProvider ?? "firstParty";
  const providerMeta = PROVIDERS.find((p) => p.id === apiProvider) ?? PROVIDERS[0];

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main data-pane-name="usage-main" className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 text-xs">
          <Link href="/" className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </Link>
          <span className="opacity-50">·</span>
          <Wallet className="h-3.5 w-3.5 text-[var(--muted)]" />
          <span className="font-medium">Usage &amp; account</span>
          {loading && <span className="text-[var(--muted)]">loading…</span>}
          {accountError && <span className="text-amber-400">account: {accountError}</span>}
          <button
            onClick={refresh}
            className="ml-auto flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 hover:bg-[var(--panel)]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </header>

        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-4xl space-y-5 px-6 py-6">
            <AccountsSection
              accounts={accounts}
              error={accountsError}
              pendingId={pendingAccountId}
              onSwitch={async (id) => {
                setPendingAccountId(id);
                try {
                  const r = await fetch("/api/accounts", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ activeProfileId: id }),
                  });
                  if (!r.ok) {
                    const e = (await r.json().catch(() => ({}))) as { error?: string };
                    setAccountsError(e.error ?? `HTTP ${r.status}`);
                    return;
                  }
                  setAccounts((await r.json()) as AccountsState);
                  setAccountsError(null);
                } finally {
                  setPendingAccountId(null);
                }
              }}
              onDelete={async (id) => {
                setPendingAccountId(id);
                try {
                  const r = await fetch(`/api/accounts?id=${encodeURIComponent(id)}`, {
                    method: "DELETE",
                  });
                  if (!r.ok) {
                    const e = (await r.json().catch(() => ({}))) as { error?: string };
                    setAccountsError(e.error ?? `HTTP ${r.status}`);
                    return;
                  }
                  setAccounts((await r.json()) as AccountsState);
                  setAccountsError(null);
                } finally {
                  setPendingAccountId(null);
                }
              }}
              onAdd={async (input) => {
                const r = await fetch("/api/accounts", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(input),
                });
                if (!r.ok) {
                  const e = (await r.json().catch(() => ({}))) as { error?: string };
                  throw new Error(e.error ?? `HTTP ${r.status}`);
                }
                const next = (await r.json()) as { state: AccountsState };
                setAccounts(next.state);
                setAccountsError(null);
              }}
              onOAuthStart={async () => {
                const r = await fetch("/api/accounts/oauth", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "start" }),
                });
                if (!r.ok) {
                  const e = (await r.json().catch(() => ({}))) as { error?: string };
                  throw new Error(e.error ?? `HTTP ${r.status}`);
                }
                return (await r.json()) as { flowId: string; authUrl: string };
              }}
              onOAuthComplete={async (input) => {
                const r = await fetch("/api/accounts/oauth", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "complete", ...input }),
                });
                if (!r.ok) {
                  const e = (await r.json().catch(() => ({}))) as { error?: string };
                  throw new Error(e.error ?? `HTTP ${r.status}`);
                }
                const next = (await r.json()) as { state: AccountsState };
                setAccounts(next.state);
                setAccountsError(null);
              }}
              onSetAutoRotate={async (on) => {
                const r = await fetch("/api/accounts", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ autoRotateOnRateLimit: on }),
                });
                if (!r.ok) {
                  const e = (await r.json().catch(() => ({}))) as { error?: string };
                  setAccountsError(e.error ?? `HTTP ${r.status}`);
                  return;
                }
                setAccounts((await r.json()) as AccountsState);
                setAccountsError(null);
              }}
            />

            <Section title="Account" icon={Building2}>
              {/* When the account-switcher has an active profile, the
                  section describes THAT profile (resolved via the
                  Anthropic profile endpoint server-side). Otherwise we
                  fall back to the live session's account info — the
                  pre-account-switcher behavior. */}
              {account?.fromActiveProfile && (
                <div className="mb-2 flex items-center gap-2 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1 text-[11px]">
                  <Check className="h-3 w-3 text-[var(--accent)]" />
                  <span>
                    Showing info for active profile{" "}
                    <span className="font-medium">{account.fromActiveProfile.label}</span>
                  </span>
                  {/* Two error tiers:
                      - `errored: true`  ⇒ we have NOTHING cached and
                        the live lookup also failed. Hard red banner.
                      - `error` only      ⇒ live lookup failed but the
                        rows render from sign-in-time cached data.
                        Show as a soft "(stale)" note. */}
                  {account.fromActiveProfile.errored && (
                    <span className="ml-auto text-amber-300">
                      {account.fromActiveProfile.error ?? "lookup failed"}
                    </span>
                  )}
                  {!account.fromActiveProfile.errored && account.fromActiveProfile.error && (
                    <span
                      className="ml-auto text-[var(--muted)]"
                      title={account.fromActiveProfile.error}
                    >
                      cached
                    </span>
                  )}
                </div>
              )}
              {!session && !account?.fromActiveProfile && (
                <div className="text-[11px] text-[var(--muted)]">
                  Open a chat session — or add an account above — to query account info.
                </div>
              )}
              {(session || account?.fromActiveProfile) && (
                <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                  <Row icon={KeyRound} label="API provider" value={providerMeta.label} />
                  <Row icon={Globe} label="Email" value={account?.email ?? "—"} />
                  <Row icon={Building2} label="Organization" value={account?.organization ?? "—"} />
                  <Row icon={CreditCard} label="Subscription" value={account?.subscriptionType ?? "—"} />
                  <Row icon={ShieldCheck} label="API key source" value={account?.apiKeySource ?? "—"} />
                  <Row icon={Database} label="Token source" value={account?.tokenSource ?? "—"} />
                </dl>
              )}
            </Section>

            <Section title="Provider switcher" icon={Globe}>
              <p className="mb-3 text-[11px] text-[var(--muted)]">
                Claudius reads provider env vars at session creation. Changing providers requires
                restarting the dev server with the right env set — Claudius itself never stores
                secrets.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {PROVIDERS.map((p) => {
                  const active = p.id === apiProvider;
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        "rounded-lg border p-3 text-xs",
                        active
                          ? "border-[var(--accent)] bg-[var(--panel-2)]"
                          : "border-[var(--border)] bg-[var(--panel)]/40",
                      )}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <span className="font-medium">{p.label}</span>
                        {active && (
                          <span className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                            active
                          </span>
                        )}
                      </div>
                      <p className="mb-2 text-[var(--muted)]">{p.helper}</p>
                      <pre className="overflow-x-auto rounded bg-[var(--panel-2)] p-2 font-mono text-[10.5px] leading-4 scroll-thin">
                        {p.envSnippet}
                      </pre>
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section title="Logout / clear credentials" icon={LogOut}>
              <p className="mb-2 text-[11px] text-[var(--muted)]">
                Claudius doesn&apos;t mint or store credentials — it reads whatever Claude Code itself
                has authenticated. To sign out, clear the credentials file or revoke at the source.
              </p>
              <pre className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-2 font-mono text-[11px] scroll-thin">
                {`# Anthropic OAuth\nrm ~/.claude/.credentials.json\n\n# API key (env)\nunset ANTHROPIC_API_KEY\n\n# Bedrock (uses AWS chain)\naws sso logout\n\n# Vertex (uses ADC)\ngcloud auth application-default revoke`}
              </pre>
            </Section>

            <Section title="Live session counters" icon={Wallet}>
              <p className="text-[11px] text-[var(--muted)]">
                The status-line pill on the chat page shows the cumulative cost and output tokens
                for the active session, updating after each turn. Click it to open the full /cost
                overlay (per-token / per-cache breakdown, durations, turns).
              </p>
            </Section>
          </div>
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Building2;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-[var(--accent)]" /> {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 px-3 py-2">
      <Icon className="mt-0.5 h-3 w-3 shrink-0 text-[var(--muted)]" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</div>
        <div className="truncate font-mono text-xs">{value}</div>
      </div>
    </div>
  );
}

// Suppress unused-helper warnings for the formatters until we wire live
// per-page numbers (they're useful when /cost is embedded inline).
void fmtUsd;
void fmtTokens;
void fmtMs;

/**
 * Account-switcher panel. Lets the user keep several Claude credentials
 * on hand and pick which one new SDK sessions spawn under — the
 * motivating use case is the "hit my Max limit on account A, flip to
 * account B" workflow. Switching only affects NEW sessions: live
 * sessions keep the auth they spawned under, matching the SDK's
 * "env is read at query() time" contract.
 *
 * Secrets are never round-tripped to the client — the list response
 * only carries a 4-char preview (`secretPreview`), and the Add form
 * POSTs the raw token to the server which then stores it under
 * `~/.claude/.claudius/accounts.json` (0600).
 */
function AccountsSection({
  accounts,
  error,
  pendingId,
  onSwitch,
  onDelete,
  onAdd,
  onOAuthStart,
  onOAuthComplete,
  onSetAutoRotate,
}: {
  accounts: AccountsState | null;
  error: string | null;
  pendingId: string | null;
  onSwitch: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAdd: (input: { label: string; kind: AccountKind; secret: string }) => Promise<void>;
  /** Begin a browser OAuth flow. Returns the URL the user opens. */
  onOAuthStart: () => Promise<{ flowId: string; authUrl: string }>;
  /** Exchange the user-pasted code for a token and add the profile. */
  onOAuthComplete: (input: { flowId: string; code: string; label: string }) => Promise<void>;
  /** Toggle the auto-rotate-on-rate-limit flag. */
  onSetAutoRotate: (on: boolean) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [addLabel, setAddLabel] = useState("");
  const [addKind, setAddKind] = useState<AccountKind>("oauth-token");
  const [addSecret, setAddSecret] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Browser OAuth flow state. `flow` is non-null after the user clicks
  // "Sign in with browser" — until the paste-code step completes. We
  // also surface a "paste an existing token instead" escape hatch via
  // `showPasteFallback` for users who already have a token from
  // `claude setup-token` in a terminal.
  const [flow, setFlow] = useState<{ flowId: string; authUrl: string } | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [showPasteFallback, setShowPasteFallback] = useState(false);

  const reset = () => {
    setAdding(false);
    setAddLabel("");
    setAddKind("oauth-token");
    setAddSecret("");
    setAddError(null);
    setFlow(null);
    setOauthCode("");
    setShowPasteFallback(false);
  };

  const submit = async () => {
    setBusy(true);
    setAddError(null);
    try {
      await onAdd({ label: addLabel, kind: addKind, secret: addSecret });
      reset();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startBrowserLogin = async () => {
    if (!addLabel.trim()) {
      setAddError("Add a label first — it's how you'll recognize the account in the list.");
      return;
    }
    setBusy(true);
    setAddError(null);
    try {
      const f = await onOAuthStart();
      setFlow(f);
      // Auto-open the authorize URL. Pop-up blockers may eat this — the
      // visible "Open sign-in page" link below is the canonical
      // affordance, so a blocked window is recoverable.
      window.open(f.authUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const completeBrowserLogin = async () => {
    if (!flow) return;
    setBusy(true);
    setAddError(null);
    try {
      await onOAuthComplete({ flowId: flow.flowId, code: oauthCode, label: addLabel });
      reset();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const profiles = accounts?.profiles ?? [];
  const activeId = accounts?.activeProfileId ?? null;

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-[var(--accent)]" /> Accounts
        </h2>
        <span className="text-[11px] text-[var(--muted)]">
          Switch which Claude account new sessions spawn under
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* Auto-rotate toggle. Only meaningful with 2+ profiles —
              with one (or zero) there's no peer to rotate to. We keep
              it visible-but-disabled below the threshold so the user
              can see the feature exists. */}
          <label
            className={cn(
              "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]",
              profiles.length < 2
                ? "border-[var(--border)] bg-[var(--panel-2)]/40 text-[var(--muted)]/60"
                : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--panel)]",
            )}
            title={
              profiles.length < 2
                ? "Add at least two accounts to enable auto-rotate"
                : "When the active account hits its rate limit, switch to the next configured account automatically."
            }
          >
            <input
              type="checkbox"
              checked={accounts?.autoRotateOnRateLimit ?? false}
              disabled={profiles.length < 2}
              onChange={(e) => void onSetAutoRotate(e.target.checked)}
              className="h-3 w-3 accent-[var(--accent)]"
              data-testid="accounts-auto-rotate-toggle"
            />
            Auto-rotate on rate limit
          </label>
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-xs hover:bg-[var(--panel)]"
              data-testid="accounts-add-btn"
            >
              <Plus className="h-3 w-3" /> Add account
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300">
          {error}
        </div>
      )}

      {profiles.length === 0 && !adding && (
        <div className="rounded-md border border-dashed border-[var(--border)] bg-[var(--panel-2)]/30 px-3 py-4 text-center text-[11px] text-[var(--muted)]">
          No accounts configured. Claudius is using the credential Claude Code
          itself is signed in with (keychain / env).
          <br />
          Click <span className="font-medium">Add account</span> to register an
          OAuth token (from <code className="rounded bg-[var(--panel-2)] px-1">claude setup-token</code>) or an API key.
        </div>
      )}

      {profiles.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {profiles.map((p) => {
            const isActive = p.id === activeId;
            const isPending = pendingId === p.id;
            return (
              <li
                key={p.id}
                data-testid={`account-row-${p.id}`}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-xs",
                  isActive
                    ? "border-[var(--accent)]/60 bg-[var(--accent)]/10"
                    : "border-[var(--border)] bg-[var(--panel-2)]/40",
                )}
              >
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.label}</span>
                    {isActive && (
                      <span className="flex items-center gap-1 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                        <Check className="h-2.5 w-2.5" /> Active
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-[var(--muted)]">
                    {ACCOUNT_KIND_LABEL[p.kind]} · {p.secretPreview || "—"}
                  </div>
                </div>
                {!isActive && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void onSwitch(p.id)}
                    className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] hover:bg-[var(--panel-2)] disabled:opacity-50"
                    data-testid={`account-switch-${p.id}`}
                  >
                    {isPending ? "…" : "Switch"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (window.confirm(`Remove "${p.label}"? The credential will be deleted from disk.`)) {
                      void onDelete(p.id);
                    }
                  }}
                  className="rounded-md border border-[var(--border)] bg-[var(--panel)] p-1 text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-red-300 disabled:opacity-50"
                  aria-label={`Delete ${p.label}`}
                  data-testid={`account-delete-${p.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {profiles.length > 0 && activeId && (
        <p className="mb-3 text-[10.5px] text-[var(--muted)]">
          Switching affects only <span className="font-medium">new</span> sessions.
          Open chats keep the credential they started under until you restart them.
        </p>
      )}

      {adding && (
        <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--panel-2)]/40 p-3 text-xs">
          {/* Label + kind picker — common to both auth paths. */}
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Label
            </label>
            <input
              autoFocus
              type="text"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="e.g. Personal Max, Work API"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs focus:border-[var(--accent)] focus:outline-none"
              data-testid="account-add-label"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
              Kind
            </label>
            <select
              value={addKind}
              onChange={(e) => {
                setAddKind(e.target.value as AccountKind);
                // Switching kind resets the OAuth flow — api-key has no
                // browser-login path so any in-flight state would be
                // dead weight.
                setFlow(null);
                setOauthCode("");
                setShowPasteFallback(e.target.value === "api-key");
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-xs focus:border-[var(--accent)] focus:outline-none"
              data-testid="account-add-kind"
            >
              <option value="oauth-token">Subscription OAuth token (Pro / Max)</option>
              <option value="api-key">API key (pay-per-token)</option>
            </select>
          </div>

          {/* OAuth browser flow (default for oauth-token). Three states:
              (1) idle — show "Sign in with browser" button
              (2) flow started — show URL + paste-code input
              (3) paste-fallback — show the bare secret input (existing token) */}
          {addKind === "oauth-token" && !flow && !showPasteFallback && (
            <div className="space-y-2 rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3">
              <p className="text-[11px] text-[var(--muted)]">
                Sign in to your Anthropic account in the browser. You&apos;ll get back
                a code to paste here — same flow as <code className="rounded bg-[var(--panel)] px-1">claude /login</code>.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void startBrowserLogin()}
                  disabled={busy}
                  className="rounded-md border border-[var(--accent)]/60 bg-[var(--accent)]/15 px-3 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
                  data-testid="account-oauth-start"
                >
                  {busy ? "Opening…" : "Sign in with browser"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPasteFallback(true)}
                  className="text-[11px] text-[var(--muted)] underline hover:text-[var(--foreground)]"
                  data-testid="account-oauth-paste-fallback"
                >
                  Or paste an existing token
                </button>
              </div>
            </div>
          )}

          {addKind === "oauth-token" && flow && (
            <div className="space-y-2 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-3">
              <p className="text-[11px] text-[var(--muted)]">
                1. Sign in at the link below (we already opened a tab).
                <br />
                2. Copy the code from the success page and paste it here.
              </p>
              <a
                href={flow.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 font-mono text-[10.5px] text-[var(--accent)] hover:bg-[var(--panel-2)]"
                data-testid="account-oauth-authurl"
              >
                {flow.authUrl}
              </a>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  Paste the code (format: <code className="rounded bg-[var(--panel)] px-1">code#state</code>)
                </label>
                <input
                  type="text"
                  value={oauthCode}
                  onChange={(e) => setOauthCode(e.target.value)}
                  placeholder="abc123…#xyz…"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 font-mono text-xs focus:border-[var(--accent)] focus:outline-none"
                  data-testid="account-oauth-code"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void completeBrowserLogin()}
                  disabled={busy || !oauthCode.trim()}
                  className="rounded-md border border-[var(--accent)]/60 bg-[var(--accent)]/15 px-3 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
                  data-testid="account-oauth-submit"
                >
                  {busy ? "Exchanging…" : "Complete sign-in"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFlow(null);
                    setOauthCode("");
                  }}
                  className="text-[11px] text-[var(--muted)] underline hover:text-[var(--foreground)]"
                >
                  Restart
                </button>
              </div>
            </div>
          )}

          {/* Paste path — for api-key always, for oauth-token only when
              the user explicitly opts in via the "paste an existing token"
              link above. */}
          {(addKind === "api-key" || (addKind === "oauth-token" && showPasteFallback)) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              className="space-y-2"
            >
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
                  Secret
                </label>
                <input
                  type="password"
                  value={addSecret}
                  onChange={(e) => setAddSecret(e.target.value)}
                  placeholder={addKind === "oauth-token" ? "sk-ant-oat01-…" : "sk-ant-…"}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 font-mono text-xs focus:border-[var(--accent)] focus:outline-none"
                  data-testid="account-add-secret"
                />
                <p className="mt-1 text-[10.5px] text-[var(--muted)]">
                  {addKind === "oauth-token" ? (
                    <>
                      Paste a long-lived <code className="rounded bg-[var(--panel)] px-1">sk-ant-oat01-…</code> token, e.g. one you generated earlier with <code className="rounded bg-[var(--panel)] px-1">claude setup-token</code>.
                    </>
                  ) : (
                    <>
                      Paste any <code className="rounded bg-[var(--panel)] px-1">sk-ant-…</code> API key from the Anthropic console. Pay-per-token billing — not subject to subscription rate limits.
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  disabled={busy || !addLabel.trim() || !addSecret.trim()}
                  className="rounded-md border border-[var(--accent)]/60 bg-[var(--accent)]/15 px-3 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
                  data-testid="account-add-submit"
                >
                  {busy ? "Adding…" : "Add"}
                </button>
                {addKind === "oauth-token" && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowPasteFallback(false);
                      setAddSecret("");
                    }}
                    className="text-[11px] text-[var(--muted)] underline hover:text-[var(--foreground)]"
                  >
                    Use browser sign-in instead
                  </button>
                )}
              </div>
            </form>
          )}

          {addError && (
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-300">
              {addError}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-[var(--border)]/50 pt-2">
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-xs hover:bg-[var(--panel-2)]"
            >
              Cancel
            </button>
            <span className="text-[10px] text-[var(--muted)]">
              Stored locally at ~/.claude/.claudius/accounts.json (0600).
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
