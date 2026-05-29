"use client";

import { useState } from "react";
import Link from "next/link";
import { FolderPlus, Radio } from "lucide-react";
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
 * The full SideNav rail renders alongside so the chrome matches the rest of
 * the app and the community/settings tiles are reachable; with no workspaces
 * the workspace-scoped tiles are inert (disabled) until the first one exists.
 */
export function WelcomeSplash() {
  const { create, uploadIcon } = useWorkspaces();
  const [showForm, setShowForm] = useState(false);

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
            <Step
              n={1}
              title="Open your workspace"
              body="Point Claudius at a project folder on this machine. Each workspace gets its own sessions, files, and git view."
            />
            <Step
              n={2}
              title="Say hello in the community"
              body="Introduce yourself in the community channel and see what others are building."
            />
          </ol>

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
