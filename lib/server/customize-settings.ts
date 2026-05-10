import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Customize-wide settings (not per-customization). Currently holds the
 * prompt template the "Auto-fix conflicts" button feeds to Claude Code.
 *
 * Persisted at `~/.claude/.claudius/customize-settings.json` so the
 * standalone CLI tools and any future Claudius runtime can both read it
 * without going through SQLite.
 */

export type CustomizeSettings = {
  autoFixPrompt: string;
};

const SETTINGS_PATH = join(
  homedir(),
  ".claude",
  ".claudius",
  "customize-settings.json",
);

/**
 * Default prompt — uses `{{conflict_count}}` and `{{conflict_paths}}`
 * placeholders that the auto-fix endpoint substitutes at run time.
 */
export const DEFAULT_AUTO_FIX_PROMPT = `You are resolving merge conflicts between this customization and upstream Claudius.

For each path below, the upstream Claudius and the customization both diverged from a common ancestor. Your job: produce a single resolved file that

  - preserves the user's customization intent (visible UI tweaks, behavioral changes, copy edits)
  - pulls in the upstream bug fixes and improvements
  - doesn't break the build

Approach:

  1. For each conflicted path, read all three sides:
     - the upstream version: <repo-root>/{path}
     - the customization version: <customization-src>/{path}
     - the manifest snapshot if available (the fork point)
  2. Diff them mentally. Identify what each side is doing and why.
  3. Write the resolved file back to the customization src.
  4. Once every conflict is resolved, run \`npm run lint\` on the touched files. Report any failures with the file path so the user can act on them.

Conflicting paths ({{conflict_count}}):

{{conflict_paths}}

Don't ask before each file — work through the list and report when done.`;

export async function getSettings(): Promise<CustomizeSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CustomizeSettings>;
    return {
      autoFixPrompt:
        typeof parsed.autoFixPrompt === "string" && parsed.autoFixPrompt.trim()
          ? parsed.autoFixPrompt
          : DEFAULT_AUTO_FIX_PROMPT,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { autoFixPrompt: DEFAULT_AUTO_FIX_PROMPT };
    }
    throw err;
  }
}

export async function setSettings(
  patch: Partial<CustomizeSettings>,
): Promise<CustomizeSettings> {
  const current = await getSettings();
  const next: CustomizeSettings = { ...current, ...patch };
  await fs.mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}
