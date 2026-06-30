import { redirect } from "next/navigation";
import { getCustomization, customizationSrcDir } from "@/lib/server/customizations-store";
import ChatSurface from "@/components/chat/ChatSurface";

/**
 * Customization chat route. Renders the shared {@link ChatSurface} with a
 * customization context — its `cwd` is the editable mirror src dir, so fresh
 * sessions run against the customization rather than any workspace.
 *
 * Server component (mirrors why `app/[workspaceId]/layout.tsx` validates the id
 * server-side): we resolve the customization up front and 307 to `/customize`
 * if it no longer exists, rather than flashing a broken client shell.
 */
export default async function CustomizationChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cust = await getCustomization(id);
  if (!cust) redirect("/customize");
  return <ChatSurface kind="customization" id={id} cwd={customizationSrcDir(id)} />;
}
