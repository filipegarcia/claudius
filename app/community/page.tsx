"use client";

import { MessagesSquare, ShieldOff } from "lucide-react";
import { SideNav } from "@/components/nav/SideNav";
import { CommunityChat } from "@/components/community/CommunityChat";
import { useCommunityConsent } from "@/lib/client/use-community-consent";

/**
 * /community top-level — a thin consent router.
 *
 * The actual chat surface (and the network calls it makes) lives in
 * `<CommunityChat />`. This component decides *whether* to render it:
 *
 *   consent === null  → consent prompt (no network)
 *   consent === "no"  → opted-out screen (no network)
 *   consent === "yes" → <CommunityChat /> mounted; chat-server traffic flows
 *
 * Because `<CommunityChat />` only mounts in the "yes" branch, the
 * `useCommunity()` hook inside it isn't called in the other branches,
 * so the SSE connection and /rooms fetch never happen until the user
 * explicitly opts in. The choice is persisted in localStorage and
 * reversible via "Disconnect from community" in the chat sidebar.
 */
export default function CommunityPage() {
  const { consent, accept, decline, reset } = useCommunityConsent();

  if (consent === "yes") {
    return <CommunityChat onOptOut={decline} />;
  }
  if (consent === "no") {
    return <OptedOutScreen onReconnect={reset} />;
  }
  return <ConsentPrompt onAccept={accept} onDecline={decline} />;
}

function ConsentPrompt({
  onAccept,
  onDecline,
}: {
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="flex h-full" data-testid="community-consent-prompt">
      <SideNav />
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="mb-3 flex items-center gap-2 text-[var(--accent)]">
            <MessagesSquare className="h-5 w-5" />
            <h1 className="text-base font-semibold text-[var(--foreground)]">
              Connect to the Claudius community?
            </h1>
          </div>
          <p className="text-sm text-[var(--muted)]">
            The community page is a real-time chat hosted at a small
            standalone server. Connecting will open a persistent SSE
            connection to that server, which lets it see your IP
            address and the rooms you’re viewing.
          </p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Nothing is sent until you actually post a message, and you
            can disconnect any time from the sidebar. Your choice is
            remembered in your Claude user settings, so a fresh install
            or a switch between desktop and browser won’t ask again.
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onDecline}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--panel-2)]"
              data-testid="community-consent-decline"
            >
              No thanks
            </button>
            <button
              type="button"
              onClick={onAccept}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)] hover:brightness-110"
              data-testid="community-consent-accept"
            >
              Connect
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function OptedOutScreen({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div className="flex h-full" data-testid="community-opted-out">
      <SideNav />
      <main className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="mb-3 flex items-center gap-2 text-[var(--muted)]">
            <ShieldOff className="h-5 w-5" />
            <h1 className="text-base font-semibold text-[var(--foreground)]">
              Community disconnected
            </h1>
          </div>
          <p className="text-sm text-[var(--muted)]">
            Claudius is not connecting to the community chat-server
            from this device. No requests are being sent.
          </p>
          <button
            type="button"
            onClick={onReconnect}
            className="mt-4 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--panel-2)]"
            data-testid="community-reconnect"
          >
            Change my mind
          </button>
        </div>
      </main>
    </div>
  );
}
