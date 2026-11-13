/**
 * CC 2.1.325 parity — "Improved the add-marketplace confirmations, plugin
 * recommendation prompts and plugin install warning to say that plugins can
 * run code on your computer, with access to your files and shell."
 *
 * The engine only draws this copy in its terminal plugin dialogs (`/plugin`
 * install screen, "Add marketplace?" confirmation, plugin recommendation
 * prompt). Claudius has its own surfaces for those actions on `/plugins` —
 * the install form, the catalog browser and the marketplace add form — so the
 * warning never reached the browser. These are the engine's words, verbatim
 * from the 2.1.325 bundle, so the two hosts say the same thing.
 */

/** Short form — the engine's plugin details / recommendation one-liner. */
export const PLUGIN_RUNS_CODE_NOTE = "Plugins can run code on your computer, with access to your files and shell.";

/** Long form — the engine's plugin install warning. */
export const PLUGIN_INSTALL_TRUST_WARNING =
  `${PLUGIN_RUNS_CODE_NOTE} Make sure you trust a plugin before installing, updating, or using it. ` +
  "Anthropic does not control what MCP servers, files, or other software are included in plugins and " +
  "cannot verify that they will work as intended or that they won't change. " +
  "See each plugin's homepage for more information.";

/** The engine's add-marketplace confirmation note. */
export const MARKETPLACE_TRUST_NOTE =
  "Plugins from this marketplace can run code on your computer, with access to your files and shell. " +
  "Only add marketplaces you trust.";
