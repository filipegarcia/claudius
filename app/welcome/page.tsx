import { redirect } from "next/navigation";

import { listWorkspaces } from "@/lib/server/workspaces-store";
import { WelcomeSplash } from "@/components/welcome/WelcomeSplash";

/**
 * First-run splash. `app/page.tsx` sends a workspace-less install here
 * instead of auto-seeding a "claudius" workspace from the source checkout.
 *
 * Guard: if a workspace already exists (the user created one, or came back
 * to this URL by hand) bounce to `/`, which resolves the active workspace
 * and 307s into it — so the splash never shows once onboarding is done.
 */
export default async function WelcomePage() {
  const all = await listWorkspaces();
  if (all.length > 0) redirect("/");
  return <WelcomeSplash />;
}
