"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { FolderPlus, Radio, LogIn, Loader2 } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { ClaudiusMark } from "@/components/brand/ClaudiusMark";
import { WorkspaceForm } from "@/components/workspaces/WorkspaceForm";
import { useWorkspaces } from "@/lib/client/useWorkspaces";

/**
 * First-run splash shown at `/welcome` when the install has zero workspaces.
 *
 * We deliberately do NOT auto-create a workspace from the claudius checkout
 * anymore (see `ensureBootstrap`), so a fresh install lands here instead of
 * inside a bogus "claudius" workspace. The two calls to action mirror the
 * onboarding story: point Claudius at one of your own projects, then say
 * hello in the community channel.
 *
 * If no accounts are configured we also surface a sign-in step first, so a
 * brand-new install gets a clear "sign in → open workspace → say hello" flow
 * rather than silently falling back to Claude Code's own keychain credential.
 *
 * The full SideNav rail renders alongside so the chrome matches the rest of
 * the app and the community/settings tiles are reachable; with no workspaces
 * the workspace-scoped tiles are inert (disabled) until the first one exists.
 */
export function WelcomeSplash() {
  const { create, uploadIcon } = useWorkspaces();
  const [showForm, setShowForm] = useState(false);

  // ── account / login state ──────────────────────────────────────────────
  // null  = still loading (don't flash the login banner)
  // false = no accounts configured → show sign-in prompt
  // true  = at least one account → skip sign-in step
  const [hasAccounts, setHasAccounts] = useState<boolean | null>(null);
  const [oauthFlow, setOauthFlow] = useState<{ flowId: string; authUrl: string } | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data: { profiles?: unknown[] }) => {
        setHasAccounts((data.profiles?.length ?? 0) > 0);
      })
      .catch(() => setHasAccounts(false));
  }, []);

  const startLogin = async () => {
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await fetch("/api/accounts/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const flow = (await res.json()) as { flowId: string; authUrl: string };
      setOauthFlow(flow);
      // Auto-open the authorize URL. Pop-up blockers may eat this —
      // the "Re-open sign-in page" link below is the fallback.
      window.open(flow.authUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Failed to start sign-in");
    } finally {
      setLoginBusy(false);
    }
  };

  const completeLogin = async () => {
    if (!oauthFlow || !oauthCode.trim()) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      const res = await fetch("/api/accounts/oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          flowId: oauthFlow.flowId,
          code: oauthCode.trim(),
          label: "", // server derives label from the email returned by the token exchange
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Sign-in failed");
      setHasAccounts(true);
      setOauthFlow(null);
      setOauthCode("");
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const notLoggedIn = hasAccounts === false;

  return (
    <div className="flex h-full" data-testid="welcome-splash">
      <SideNav />
      <main className="flex flex-1 items-center justify-center overflow-y-auto p-8">
        <div className="flex max-w-md flex-col items-center text-center">
          <ClaudiusMark color="var(--foreground)" size={96} className="mb-6 opacity-90" />
          <h1 className="mb-2 text-3xl font-semibold tracking-tight">Welcome to Claudius</h1>
          <p className="mb-8 text-sm text-[var(--muted)]">
            Claude Code in your browser. To get started, open one of your own
            projects as a workspace — then drop into the community to say hi.
          </p>

          <ol className="mb-8 w-full space-y-4 text-left">
            {notLoggedIn && (
              <Step
                n={1}
                title="Sign in to Claude"
                body="Connect your Claude account so Claudius can run Claude Code on your behalf."
              />
            )}
            <Step
              n={notLoggedIn ? 2 : 1}
              title="Open your workspace"
              body="Point Claudius at a project folder on this machine. Each workspace gets its own sessions, files, and git view."
            />
            <Step
              n={notLoggedIn ? 3 : 2}
              title="Say hello in the community"
              body="Introduce yourself in the community channel and see what others are building."
            />
          </ol>

          {/* ── Sign-in panel (no accounts configured) ── */}
          {notLoggedIn && !oauthFlow && (
            <div className="mb-4 w-full rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-4 text-left">
              <p className="mb-3 text-xs text-[var(--muted)]">
                No Claude account connected yet. Sign in with your Anthropic account to get
                started.
              </p>
              <button
                type="button"
                onClick={startLogin}
                disabled={loginBusy}
                data-testid="welcome-login-btn"
                className="inline-flex items-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:brightness-110 disabled:opacity-50"
              >
                {loginBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                Sign in with Claude
              </button>
              {loginError && <p className="mt-2 text-xs text-red-400">{loginError}</p>}
            </div>
          )}

          {/* ── OAuth code-paste step ── */}
          {notLoggedIn && oauthFlow && (
            <div className="mb-4 w-full rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-4 text-left">
              <p className="mb-1 text-sm font-medium">Complete sign-in</p>
              <p className="mb-3 text-xs text-[var(--muted)]">
                After signing in on Claude.ai, paste the code you received below.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  placeholder="Paste code here…"
                  value={oauthCode}
                  onChange={(e) => setOauthCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void completeLogin();
                  }}
                  className="flex-1 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  data-testid="welcome-oauth-code"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={completeLogin}
                  disabled={loginBusy || !oauthCode.trim()}
                  data-testid="welcome-oauth-confirm"
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)] hover:brightness-110 disabled:opacity-50"
                >
                  {loginBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
                </button>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <a
                  href={oauthFlow.authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--accent)] underline underline-offset-2"
                >
                  Re-open sign-in page
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setOauthFlow(null);
                    setOauthCode("");
                    setLoginError(null);
                  }}
                  className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
              {loginError && <p className="mt-2 text-xs text-red-400">{loginError}</p>}
            </div>
          )}

          <div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => setShowForm(true)}
              data-testid="welcome-create-workspace"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:brightness-110"
            >
              <FolderPlus className="h-4 w-4" />
              Open a workspace
            </button>
            <Link
              href="/community"
              data-testid="welcome-community-link"
              className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-medium hover:bg-[var(--panel-2)]"
            >
              <Radio className="h-4 w-4" />
              Say hello in the community
            </Link>
          </div>
        </div>
      </main>

      {showForm && (
        <WorkspaceForm
          onCancel={() => setShowForm(false)}
          onIconUpload={async (id, file) => uploadIcon(id, file)}
          onSubmit={async (input) => {
            const r = await create(input);
            // `create` already selects the new workspace (cookie + activeId).
            // Hard-navigate to its chat root so the server resolves the new
            // cwd for the SDK child process, same as the WorkspaceSwitcher's
            // select flow.
            if (r.ok && typeof window !== "undefined") {
              window.location.href = `/${r.workspace.id}`;
            }
            return r;
          }}
        />
      )}
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/15 text-xs font-semibold text-[var(--accent)]">
        {n}
      </span>
      <div>
        <div className="text-sm font-medium text-[var(--foreground)]">{title}</div>
        <p className="text-xs text-[var(--muted)]">{body}</p>
      </div>
    </li>
  );
}
