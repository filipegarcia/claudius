/**
 * Known output-style names, shared between the Settings page's `outputStyle`
 * dropdown and the `/output-style` slash command's sessionless fallback list.
 *
 * Claude Code 2.1.269 parity: "Added `/output-style [name]` to list and
 * switch output styles, including over Remote Control and in cloud and
 * other headless sessions." Claudius already modeled `outputStyle` as a
 * `ClaudeSettings` field (`app/settings/page.tsx`'s dropdown) — this module
 * just gives the slash command the same static list to fall back to when no
 * live session is bound to offer the SDK's richer `available_output_styles`
 * (which can include plugin-provided custom styles this static list can't
 * know about).
 */
export const STATIC_OUTPUT_STYLES: readonly string[] = [
  "default",
  "explanatory",
  "concise",
  "developer",
];
