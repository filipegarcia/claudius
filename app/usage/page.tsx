"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  CreditCard,
  Database,
  Globe,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { cn } from "@/lib/utils/cn";

type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "mantle";
};

type SessionUsage = {
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
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
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const list = (await (await fetch("/api/sessions")).json()) as ActiveSession[];
      const first = Array.isArray(list) ? list[0] ?? null : null;
      setSession(first);
      if (first) {
        try {
          const r = await fetch(`/api/account?sessionId=${encodeURIComponent(first.id)}`);
          if (r.ok) {
            setAccount((await r.json()) as AccountInfo);
            setAccountError(null);
          } else {
            const e = (await r.json().catch(() => ({}))) as { error?: string };
            setAccountError(e.error ?? `HTTP ${r.status}`);
          }
        } catch (err) {
          setAccountError(err instanceof Error ? err.message : String(err));
        }
        // Snapshot the most recent /cost from the session manager via cookieless client side.
        // We can't read it from the server (it lives in the SSE stream), so leave usage best-effort.
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // The /cost numbers tick from the chat-page hook; this page can't subscribe
    // to that without re-running the SSE consumer. We surface the static
    // account info; live cost is on the StatusLine pill.
    void usage;
    void setUsage;
  }, []);

  const apiProvider = account?.apiProvider ?? "firstParty";
  const providerMeta = PROVIDERS.find((p) => p.id === apiProvider) ?? PROVIDERS[0];

  return (
    <div className="flex h-full">
      <SideNav running={false} />
      <main className="flex h-full flex-1 flex-col overflow-hidden">
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
            <Section title="Account" icon={Building2}>
              {!session && (
                <div className="text-[11px] text-[var(--muted)]">
                  Open a chat session to query account info.
                </div>
              )}
              {session && (
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
