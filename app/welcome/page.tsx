import { WelcomeGate } from "@/components/nav/WorkspaceRedirects";
import { WelcomeSplash } from "@/components/welcome/WelcomeSplash";

/**
 * First-run splash. `app/page.tsx` sends a workspace-less install here
 * instead of auto-seeding a "claudius" workspace from the source checkout.
 *
 * Guard ({@link WelcomeGate}): if a workspace already exists (the user
 * created one, or came back to this URL by hand) go to `/`, which resolves
 * the active workspace and moves on into it — so the splash never shows
 * once onboarding is done. Behind the Rust front door, its rule R5 answers
 * with a 307 instead.
 */
export default function WelcomePage() {
  return (
    <WelcomeGate>
      <WelcomeSplash />
    </WelcomeGate>
  );
}
