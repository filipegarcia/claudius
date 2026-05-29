"use client";

/**
 * Dev-only preview page: mounts the AskUserQuestionPrompt with the exact
 * fixture from session c8de71dd-1fda-441d-b4b5-bbbaf780eaf2 (CLI-emitted, so
 * the option previews are plain text with ASCII box-drawing characters).
 *
 * This is what verifies the new <pre>-fallback branch in PreviewPane —
 * Claudius normally asks the model for HTML previews, but resumed CLI
 * sessions carry markdown/text previews that the old code mis-rendered as
 * collapsed HTML.
 */

import { AskUserQuestionPrompt } from "@/components/chat/AskUserQuestionPrompt";
import type { AskUserQuestionEvent } from "@/lib/shared/events";

const RAIL_FIXTURE: AskUserQuestionEvent = {
  type: "ask_user_question",
  requestId: "preview-rail-rule",
  toolUseId: "toolu_preview_rail_rule",
  questions: [
    {
      question: "How should customization workspaces appear in the left rail?",
      header: "Rail rule",
      multiSelect: false,
      options: [
        {
          label: "Active only (Recommended)",
          description:
            "Customization tile appears in the rail the moment you Open one, vanishes when you switch back to a project. To resume an older customization you go to /customize → Open. Workspace state (sessions, chat) is untouched.",
          preview:
            "Project workspaces:\n  [P] project\n  [E] eli\n  [C] claudius\n  -----\n  [✨] Cat Spinner   ← ACTIVE\n  [+] new\n  -----\n  [✨] /customize\n  [⚙] settings\n\n(no other customizations\n shown anywhere)",
        },
        {
          label: "Active + last 2 recent",
          description:
            "Show the currently-active customization plus the 2 most-recently-opened. Older ones drop off automatically. Good for quick-bouncing between 2-3 customizations you're iterating on this week.",
          preview:
            "Project workspaces:\n  [P] project\n  [E] eli\n  [C] claudius\n  -----\n  [✨] Cat Spinner   ← ACTIVE\n  [✨] DOOM HUD       recent\n  [✨] Clippy         recent\n  [+] new\n  -----\n  [✨] /customize\n  [⚙] settings",
        },
        {
          label: "Pin to rail per customization",
          description:
            "Each customization gets a 'pin to sidebar' toggle in /customize. Unpinned = invisible in rail (except when actively open). You explicitly choose which ones live there. Most flexible, but one more thing to manage.",
          preview:
            "Project workspaces:\n  [P] project\n  [E] eli\n  [C] claudius\n  -----\n  [✨] DOOM HUD     pinned\n  [✨] Cat Spinner  pinned, active\n  [+] new\n  -----\n  [✨] /customize   ← here you toggle\n               the 📌 pin per item\n  [⚙] settings",
        },
        {
          label: "Customizations drawer (one tile)",
          description:
            "Single wand tile in the rail represents the 'customizations' pool. Clicking it opens a popover listing all of them with a small green dot on the active one. The same tile also hosts the active-customization highlight when one is open.",
          preview:
            "Project workspaces:\n  [P] project\n  [E] eli\n  [C] claudius\n  -----\n  [✨]• ← click opens popover:\n      │┌─ Customizations ─┐\n      ││ ● Cat Spinner  ACTIVE\n      ││ ○ DOOM HUD\n      ││ ○ Clippy\n      ││ ○ Minecraft...\n      ││ + Manage all\n      │└─────────────────┘\n  [+] new\n  -----\n  [⚙] settings",
        },
      ],
    },
  ],
};

export default function AskRailPreviewPage() {
  return (
    <AskUserQuestionPrompt
      request={RAIL_FIXTURE}
      onSubmit={() => {
        // Preview page — discard answers, just demonstrate the rendering.
      }}
      onCancel={() => {
        // Same — no real session behind this.
      }}
    />
  );
}
