//! `lib/server/customize-settings.ts` (D16): the Customize-wide settings,
//! today only the prompt template the "Auto-fix conflicts" button sends,
//! kept at `homedir()/.claude/.claudius/customize-settings.json`. Served by
//! `claudius-server`'s `customize` (`GET`/`PUT /api/customize-settings`);
//! `settings-export.ts` / `settings-import.ts` (D11) and the auto-fix route
//! (D14) read and write it through [`get_settings`] and [`set_settings`].
//!
//! Read (`getSettings`): `fs.readFile(_, "utf8")` (invalid bytes U+FFFD, a
//! BOM kept, so `JSON.parse` fails on it), then `JSON.parse` with
//! lone-surrogate escapes kept ([`js_string::parse`]). A missing file
//! (ENOENT) is the default; any other read error, a parse error and a
//! `null` file (V8's TypeError) throw. The prompt is the file's
//! `autoFixPrompt` when it is a string with something besides JS whitespace
//! in it (kept untrimmed), else [`DEFAULT_AUTO_FIX_PROMPT`]; every other key
//! is dropped, so the next write loses it.
//!
//! Write (`setSettings`): `{...current, ...patch}` (the read must succeed
//! first, so a file that doesn't load is never overwritten), `mkdir -p` of
//! the folder, then `JSON.stringify(next, null, 2)` (no trailing newline)
//! written in place by `writeFile` (through a symlink; an existing file
//! keeps its mode). The patch is not checked: an empty or blank prompt is
//! stored and answered as is, and reads back as the default.
//!
//! Errors carry the `message` Node or V8 gives (`EISDIR: illegal operation
//! on a directory, read`, `Unexpected token …`), which D11's import reports.
//! Replayed against the TS through the routes in
//! `claudius-server/tests/customize.rs` (`rust/scripts/customize-golden.mjs`).

use std::path::Path;

use anyhow::{anyhow, bail};
use claudius_agent::js;
use serde_json::{Map, Value};

use crate::{js_string, node_fs, node_path, paths};

/// `DEFAULT_AUTO_FIX_PROMPT`: the template, with the `{{conflict_count}}`
/// and `{{conflict_paths}}` placeholders the auto-fix route fills in.
pub const DEFAULT_AUTO_FIX_PROMPT: &str = r#"You are resolving merge conflicts between this customization and upstream Claudius.

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
  4. Once every conflict is resolved, run `npm run lint` on the touched files. Report any failures with the file path so the user can act on them.

Conflicting paths ({{conflict_count}}):

{{conflict_paths}}

Don't ask before each file — work through the list and report when done."#;

/// The settings key.
pub const AUTO_FIX_PROMPT: &str = "autoFixPrompt";

/// `SETTINGS_PATH`: `join(homedir(), ".claude", ".claudius",
/// "customize-settings.json")`.
pub fn settings_path() -> String {
    node_path::join(&[
        &paths::home_dir().to_string_lossy(),
        ".claude",
        ".claudius",
        "customize-settings.json",
    ])
}

fn with_prompt(prompt: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(AUTO_FIX_PROMPT.into(), Value::String(prompt.to_owned()));
    m
}

/// `getSettings()`: always `{autoFixPrompt: <string>}` (lone surrogates as
/// [`js_string`] stand-ins), or the error TS throws.
pub fn get_settings() -> anyhow::Result<Map<String, Value>> {
    let path = settings_path();
    let bytes = match node_fs::sys::read_file(Path::new(js_string::lossy(&path).as_ref())) {
        Ok(b) => b,
        Err(e) if e.code == "ENOENT" => return Ok(with_prompt(DEFAULT_AUTO_FIX_PROMPT)),
        Err(e) => bail!(e.message),
    };
    let parsed = js_string::parse(&String::from_utf8_lossy(&bytes)).map_err(|m| anyhow!(m))?;
    // `parsed.autoFixPrompt`: a `null` file throws; any other non-object
    // (and an object without the key) reads `undefined`.
    let prompt = match &parsed {
        Value::Null => bail!("Cannot read properties of null (reading '{AUTO_FIX_PROMPT}')"),
        Value::Object(m) => m.get(AUTO_FIX_PROMPT),
        _ => None,
    };
    Ok(with_prompt(
        prompt
            .and_then(Value::as_str)
            .filter(|p| !js::trim(p).is_empty())
            .unwrap_or(DEFAULT_AUTO_FIX_PROMPT),
    ))
}

/// `setSettings(patch)`: `{...current, ...patch}` written to the file and
/// returned. The current settings are read first, and their error ends it
/// before anything is written.
pub fn set_settings(patch: &Map<String, Value>) -> anyhow::Result<Map<String, Value>> {
    let mut next = get_settings()?;
    for (k, v) in patch {
        next.insert(k.clone(), v.clone());
    }
    write_settings(&next)?;
    Ok(next)
}

/// The write half of `setSettings`: `fs.mkdir(dirname(SETTINGS_PATH),
/// {recursive: true})`, then `fs.writeFile(SETTINGS_PATH,
/// JSON.stringify(next, null, 2), "utf8")`.
pub fn write_settings(next: &Map<String, Value>) -> anyhow::Result<()> {
    let path = settings_path();
    let dir = node_path::dirname(&path);
    node_fs::sys::mkdir_recursive(Path::new(js_string::lossy(&dir).as_ref()))
        .map_err(|e| anyhow!(e.message))?;
    let text = js_string::stringify_pretty(&Value::Object(next.clone()));
    node_fs::sys::write_file(Path::new(js_string::lossy(&path).as_ref()), text.as_bytes())
        .map_err(|e| anyhow!(e.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_the_ts_template() {
        // 1055 UTF-16 units, one em dash, the two placeholders.
        assert_eq!(js_string::len16(DEFAULT_AUTO_FIX_PROMPT), 1055);
        assert_eq!(
            DEFAULT_AUTO_FIX_PROMPT
                .matches("{{conflict_count}}")
                .count(),
            1
        );
        assert_eq!(
            DEFAULT_AUTO_FIX_PROMPT
                .matches("{{conflict_paths}}")
                .count(),
            1
        );
        assert!(
            DEFAULT_AUTO_FIX_PROMPT
                .ends_with("file \u{2014} work through the list and report when done.")
        );
    }
}
