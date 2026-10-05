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

/**
 * CC 2.1.286 — the `/output-style` picker shows a description under each name.
 * The SDK's `available_output_styles` is names-only, so these come from here
 * for the known built-ins; a plugin/custom style not in this map falls back to
 * a generic line via {@link outputStyleDescription}.
 */
const OUTPUT_STYLE_DESCRIPTIONS: Record<string, string> = {
  default: "Claude's standard responses.",
  explanatory: "Adds educational insights about the choices it makes while working.",
  concise: "Shorter responses that get to the point.",
  developer: "Tuned for software engineering — direct, code-first.",
};

export function outputStyleDescription(name: string): string {
  return OUTPUT_STYLE_DESCRIPTIONS[name] ?? "Custom output style.";
}
