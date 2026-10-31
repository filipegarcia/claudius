//! Plugins: port of `lib/server/plugins.ts` and the `lib/shared` helpers it
//! runs on: `marketplace-settings.ts` (the redacted marketplace views and
//! the structural edits), `plugin-ref-lint.ts`'s `lintMarketplaceName`,
//! `plugin-metadata.ts`, `plugin-config.ts`, `parse-init.ts`'s
//! `plugin_errors` reader, `reload-plugins.ts`'s `isForceReload` and
//! `settings-load-error.ts`'s `pluginSettingsWriteBlockedMessage`. The
//! routes are `claudius-server`'s `plugins.rs`.
//!
//! What lives where:
//! * a scope's plugin state is in its settings file ([`settings::path_for`]):
//!   `enabledPlugins` (a plugin is enabled by `"<id>": true`; disabling
//!   deletes the key, and the last one drops `enabledPlugins`),
//!   `extraKnownMarketplaces` (alias `additionalMarketplaces`),
//!   `strictKnownMarketplaces` (alias `allowedMarketplaces`),
//!   `blockedMarketplaces` and `pluginConfigs`;
//! * the marketplaces Claude Code has cloned are under
//!   `homedir()/.claude/plugins/marketplaces/<name>/.claude-plugin/
//!   marketplace.json`, with the public install counts in
//!   `homedir()/.claude/plugins/install-counts-cache.json`;
//! * an installed plugin's own `plugin.json` is at the path its live
//!   session's CLI reports (`reload_plugins`).
//!
//! Values follow the JS the TS runs on them. Settings files are read the
//! way [`settings`] reads them (a literal `null` file makes property reads
//! throw, a primitive one makes `in` throw) and written as
//! `JSON.stringify(next, null, 2)`, so untouched keys, key order and number
//! text come out as the TS writes them. `obj[key] = v` with key `__proto__`
//! only lands when the object has that own key (otherwise JS runs the
//! prototype setter, which adds nothing), and `String(key)` throws for an
//! object with its own `toString`. The other files are parsed like
//! `JSON.parse` (lossy UTF-8, a BOM is a syntax error); a number past f64 is
//! JS `Infinity`, kept apart from `null` where the TS can tell them apart
//! (an install count, a `userConfig` default).

use std::cmp::Ordering;

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::db_agents;
use crate::fs_list::{self, DirentKind};
use crate::mcp_config::OBJECT_PROTOTYPE_KEYS;
use crate::node_err::{self, NodeError};
use crate::node_path;
use crate::paths;
use crate::settings::{self, Scope, SettingsError};

/// Why a plugins call failed: the TS function threw.
#[derive(Debug, thiserror::Error)]
pub enum PluginsError {
    /// `readSettings` / `writeSettings` threw. `SettingsError::Parse` is the
    /// `SettingsParseError` the routes tell apart.
    #[error(transparent)]
    Settings(#[from] SettingsError),
    /// A `TypeError` (V8's message).
    #[error("TypeError: {0}")]
    Type(String),
    /// `listAvailable`'s `readdir` (Node's message).
    #[error(transparent)]
    Io(#[from] NodeError),
}

type Result<T> = std::result::Result<T, PluginsError>;

const SCOPES: [(Scope, &str); 3] = [
    (Scope::User, "user"),
    (Scope::Project, "project"),
    (Scope::Local, "local"),
];

// ─── JS object semantics ─────────────────────────────────────────────────

/// `obj[key] = v` on a plain object built from JSON: an existing key keeps
/// its place. `__proto__` that isn't an own key runs the prototype setter
/// (an object or `null` becomes the prototype, anything else is ignored),
/// which adds no own key.
fn js_set(obj: &mut Map<String, Value>, key: &str, v: Value) {
    if key == "__proto__" && !obj.contains_key(key) {
        return;
    }
    obj.insert(key.to_owned(), v);
}

/// `delete obj[key]`: own keys only, the others keep their order.
fn js_delete(obj: &mut Map<String, Value>, key: &str) {
    obj.shift_remove(key);
}

/// `String(v)` (`ToPropertyKey`) for a request-body value parsed with
/// [`db_agents::json_parse`] (its infinities print as JS prints them). An
/// object with its own `toString` throws, and so does an array holding one.
pub fn property_key(v: &Value) -> Result<String> {
    if let Some(f) = db_agents::infinity(v) {
        return Ok(if f > 0.0 { "Infinity" } else { "-Infinity" }.into());
    }
    match v {
        Value::Object(m) if m.contains_key("toString") => Err(PluginsError::Type(
            "Cannot convert object to primitive value".into(),
        )),
        Value::Array(items) => Ok(items
            .iter()
            .map(|item| match item {
                Value::Null => Ok(String::new()),
                item => property_key(item),
            })
            .collect::<Result<Vec<_>>>()?
            .join(",")),
        v => Ok(js::to_string(Some(v))),
    }
}

/// `String(v)` of a settings value as V8 prints it in a `TypeError` (a
/// `Value::Null` that isn't a literal `null` is a number past f64).
fn settings_text(v: &Value, literal_null: bool) -> String {
    match v {
        Value::Null if !literal_null => "Infinity".into(),
        v => js::to_string(Some(v)),
    }
}

/// A settings file's value as `readSettings` returns it.
struct Settings {
    value: Value,
    /// The file is a literal `null` (property reads throw).
    null: bool,
}

impl Settings {
    fn read(scope: Scope, cwd: &str) -> Result<Settings> {
        let (value, null) = settings::read_settings_raw(scope, cwd)?;
        Ok(Settings { value, null })
    }

    /// `settings.key`: `undefined` for a non-object; a `null` file throws.
    fn get(&self, key: &str) -> Result<Option<&Value>> {
        if self.null {
            return Err(PluginsError::Type(settings::null_property_error(key)));
        }
        Ok(self.value.as_object().and_then(|m| m.get(key)))
    }

    /// `aliased(settings, canonical, alias)`: `canonical in s ? s[canonical]
    /// : s[alias]`. `in` throws on a primitive (or `null`) file.
    fn aliased(&self, canonical: &str, alias: &str) -> Result<Option<&Value>> {
        match &self.value {
            Value::Object(m) => Ok(m.get(canonical).or_else(|| m.get(alias))),
            Value::Array(_) => Ok(None),
            v => Err(PluginsError::Type(format!(
                "Cannot use 'in' operator to search for '{canonical}' in {}",
                settings_text(v, self.null)
            ))),
        }
    }

    /// `{ ...settings }`.
    fn spread(&self) -> Map<String, Value> {
        settings::spread(&self.value)
    }
}

// ─── parse-init.ts ───────────────────────────────────────────────────────

/// `pluginErrorArray(init.plugin_errors)`: the rows of a `system/init`'s
/// `plugin_errors` that have non-empty `plugin`, `type` and `message`
/// strings, as `{plugin, type, message, path?}` (`path` only when a
/// non-empty string). Anything else is `[]`.
pub fn plugin_error_array(v: Option<&Value>) -> Vec<Value> {
    let Some(rows) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    let text = |e: &Map<String, Value>, k: &str| {
        e.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    rows.iter()
        .filter_map(Value::as_object)
        .filter_map(|e| {
            let (plugin, kind, message) =
                (text(e, "plugin")?, text(e, "type")?, text(e, "message")?);
            let mut row = json!({"plugin": plugin, "type": kind, "message": message});
            if let Some(path) = text(e, "path") {
                row["path"] = Value::String(path);
            }
            Some(row)
        })
        .collect()
}

// ─── reload-plugins.ts, settings-load-error.ts ───────────────────────────

/// `isForceReload(value)`: the `?force=` of the reload route.
pub fn is_force_reload(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true"))
}

/// `pluginSettingsWriteBlockedMessage(path, reason)`: the 422 a plugin
/// write gets when its scope's settings file doesn't load.
pub fn plugin_settings_write_blocked_message(path: &str, reason: &str) -> String {
    format!(
        "{path} doesn't load ({reason}) — fix it before Claudius can change plugins there. The file was not changed."
    )
}

// ─── plugin-metadata.ts ──────────────────────────────────────────────────

/// `pluginSubdirFromSource(source)`: a marketplace entry's plugin dir,
/// relative to the marketplace: a string `source`, or an object's string
/// `path`; one leading `./` dropped, then JS-trimmed; `None` when empty.
pub fn plugin_subdir_from_source(source: Option<&Value>) -> Option<String> {
    let raw = match source? {
        Value::String(s) => s.as_str(),
        Value::Object(m) => m.get("path")?.as_str()?,
        _ => return None,
    };
    let trimmed = js::trim(raw.strip_prefix("./").unwrap_or(raw));
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `typeof v === "string" && v.trim().length > 0 ? v : undefined`.
fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !js::trim(s).is_empty())
        .map(str::to_owned)
}

/// `mergePluginMeta(entry, manifest)`: the entry's `description` /
/// `displayName`, else the manifest's (each a string with non-blank text).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginMeta {
    pub description: Option<String>,
    pub display_name: Option<String>,
}

pub fn merge_plugin_meta(entry: Option<&Value>, manifest: Option<&Value>) -> PluginMeta {
    let field =
        |k: &str| non_empty(js::prop(entry, k)).or_else(|| non_empty(js::prop(manifest, k)));
    PluginMeta {
        description: field("description"),
        display_name: field("displayName"),
    }
}

// ─── plugin-config.ts ────────────────────────────────────────────────────

/// `parseUserConfig(manifest)`: the `userConfig` option schema, entries in
/// JS key order, non-object entries skipped. `twin` is the same manifest as
/// [`db_agents::json_parse`] reads it, so a `default` past f64 (JS
/// `Infinity`, a number) is told apart from `null`.
pub fn parse_user_config(manifest: &Value, twin: &Value) -> Vec<Value> {
    let Some(uc) = manifest.get("userConfig").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, raw) in js::own_keys_order(uc) {
        let Some(raw) = raw.as_object() else { continue };
        let enum_options = raw
            .get("options")
            .and_then(Value::as_array)
            .filter(|a| a.iter().all(Value::is_string));
        let kind = if enum_options.is_some() {
            "enum"
        } else {
            match raw.get("type").and_then(Value::as_str) {
                Some("boolean") => "boolean",
                Some("number" | "integer") => "number",
                Some("array") => "array",
                _ => "string",
            }
        };
        let default = match raw.get("default") {
            Some(v @ (Value::String(_) | Value::Number(_) | Value::Bool(_))) => Some(v.clone()),
            Some(v @ Value::Array(a)) if a.iter().all(Value::is_string) => Some(v.clone()),
            // `Infinity`: a number, which JSON.stringify writes as `null`.
            Some(Value::Null)
                if db_agents::infinity(&twin["userConfig"][name.as_str()]["default"]).is_some() =>
            {
                Some(Value::Null)
            }
            _ => None,
        };
        let mut o = Map::new();
        o.insert("name".into(), json!(name));
        o.insert("type".into(), json!(kind));
        if let Some(t) = raw.get("title").and_then(Value::as_str) {
            o.insert("title".into(), json!(t));
        }
        if let Some(d) = raw.get("description").and_then(Value::as_str) {
            o.insert("description".into(), json!(d));
        }
        if let Some(d) = default {
            o.insert("default".into(), d);
        }
        if let Some(opts) = enum_options {
            o.insert("options".into(), Value::Array(opts.clone()));
        }
        o.insert(
            "sensitive".into(),
            json!(raw.get("sensitive") == Some(&Value::Bool(true))),
        );
        out.push(Value::Object(o));
    }
    out
}

/// `setPluginOption(pluginConfigs, pluginId, name, value)`: set (or, with
/// `None`, clear) `pluginConfigs[pluginId].options[name]`, keeping every
/// other plugin and key, pruning emptied containers. `None` when the map
/// ends up empty (the caller drops `pluginConfigs`).
pub fn set_plugin_option(
    plugin_configs: Option<&Value>,
    plugin_id: &str,
    name: &str,
    value: Option<&Value>,
) -> Option<Map<String, Value>> {
    let spread_obj = |v: Option<&Value>| v.and_then(Value::as_object).cloned().unwrap_or_default();
    // An inherited `base[pluginId]` (a function, or `Object.prototype` for
    // `__proto__`) spreads to `{}` too.
    let mut base = spread_obj(plugin_configs);
    let mut entry = spread_obj(base.get(plugin_id));
    let mut options = spread_obj(entry.get("options"));
    match value {
        None => js_delete(&mut options, name),
        Some(v) => js_set(&mut options, name, v.clone()),
    }
    if options.is_empty() {
        js_delete(&mut entry, "options");
    } else {
        js_set(&mut entry, "options", Value::Object(options));
    }
    if entry.is_empty() {
        js_delete(&mut base, plugin_id);
    } else {
        js_set(&mut base, plugin_id, Value::Object(entry));
    }
    (!base.is_empty()).then_some(base)
}

// ─── plugin-ref-lint.ts ──────────────────────────────────────────────────

/// `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`.
fn is_plugin_name(s: &str) -> bool {
    let mut b = s.bytes();
    b.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && b.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `RESERVED_MARKETPLACE_NAMES` (compared lowercased).
const RESERVED_MARKETPLACE_NAMES: [&str; 19] = [
    "claude-code-marketplace",
    "claude-code-plugins",
    "claude-plugins-official",
    "anthropic-marketplace",
    "anthropic-plugins",
    "agent-skills",
    "anthropic-agent-skills",
    "life-sciences",
    "knowledge-work-plugins",
    "claude-for-legal",
    "claude-for-financial-services",
    "financial-services-plugins",
    "first-party-plugins",
    "claude-tag-plugins",
    "healthcare",
    "claude-community",
    "claude-plugins-community",
    "anthropic-plugin-directory",
    "claude-plugin-directory",
];

/// `RESERVED_SOURCE_NAMES`: what each name is reserved for.
const RESERVED_SOURCE_NAMES: [(&str, &str); 11] = [
    ("inline", "--plugin-dir session plugins"),
    ("builtin", "built-in plugins"),
    ("skills-dir", "plugins auto-loaded from .claude/skills/"),
    ("synced", "plugins synced from your claude.ai account"),
    ("claude-plugin-test", "plugins loaded by claude plugin test"),
    (
        "npm",
        "plugins installed from an npm registry (<package>@npm)",
    ),
    ("pip", "plugins installed from a Python package index"),
    (
        "uv",
        "plugins installed from a Python package index through uv",
    ),
    ("cargo", "plugins installed from a Rust crate registry"),
    (
        "github",
        "plugins installed straight from a GitHub repository (<owner>/<repo>@github)",
    ),
    ("gh", "plugins installed straight from a GitHub repository"),
];

/// `isAnthropicsGithubSource(source)`: a `github` source whose trimmed
/// `repo` is `anthropics/<name>` (prefix case-insensitive; the name has no
/// `/`, `:` or whitespace).
fn is_anthropics_github_source(source: &Value) -> bool {
    let Some(s) = source.as_object() else {
        return false;
    };
    if s.get("source").and_then(Value::as_str) != Some("github") {
        return false;
    }
    let Some(repo) = s.get("repo").and_then(Value::as_str) else {
        return false;
    };
    let repo = js::trim(repo);
    let Some(prefix) = repo.get(..11) else {
        return false;
    };
    let rest = &repo[11..];
    prefix.eq_ignore_ascii_case("anthropics/")
        && !rest.is_empty()
        && !rest
            .chars()
            .any(|c| c == '/' || c == ':' || js::is_whitespace(c))
}

/// `lintMarketplaceName(name, source)`: why a marketplace can't be
/// registered under `name`, or `None`.
pub fn lint_marketplace_name(name: &str, source: &Value) -> Option<String> {
    let trimmed = js::trim(name);
    if trimmed.is_empty() {
        return None;
    }
    if !is_plugin_name(trimmed) || trimmed.contains("..") {
        return Some(format!(
            "“{trimmed}” can't be used as a marketplace name — plugins are installed as <plugin>@<marketplace>, so use letters, digits, “.”, “-”, or “_” (starting with a letter or digit)."
        ));
    }
    if OBJECT_PROTOTYPE_KEYS.contains(&trimmed) {
        return Some(format!(
            "“{trimmed}” is reserved by Claude Code and can't be used as a marketplace name — use another name."
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if let Some((_, what)) = RESERVED_SOURCE_NAMES.iter().find(|(n, _)| *n == lower) {
        return Some(format!(
            "“{trimmed}” is reserved for {what} — use another name."
        ));
    }
    if RESERVED_MARKETPLACE_NAMES.contains(&lower.as_str()) && !is_anthropics_github_source(source)
    {
        return Some(format!(
            "“{trimmed}” is reserved for Anthropic's official marketplace."
        ));
    }
    None
}

// ─── marketplace-settings.ts ─────────────────────────────────────────────

/// `sourceKind(source)`: an object's string `source`.
pub fn source_kind(source: Option<&Value>) -> Option<&str> {
    source?.as_object()?.get("source")?.as_str()
}

/// `sourceLabel(source)`: a readable identifier by kind.
pub fn source_label(source: Option<&Value>) -> String {
    let Some(s) = source.and_then(Value::as_object) else {
        return source
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
    };
    let field = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or_default();
    let kind = s.get("source").and_then(Value::as_str);
    match kind {
        Some("url" | "git") => field("url").to_owned(),
        Some("github") => match field("ref") {
            "" => field("repo").to_owned(),
            r => format!("{}@{r}", field("repo")),
        },
        Some("npm") => match field("version") {
            "" => field("package").to_owned(),
            v => format!("{}@{v}", field("package")),
        },
        Some("file" | "directory") => field("path").to_owned(),
        Some("hostPattern") => field("hostPattern").to_owned(),
        Some("pathPattern") => field("pathPattern").to_owned(),
        Some("settings") => field("name").to_owned(),
        Some("skills-dir") => "skills-dir".into(),
        Some(other) => other.to_owned(),
        None => String::new(),
    }
}

/// `redactSource(source)`: `{kind, label, headerKeys, hasHeadersHelper,
/// legacy?}`, with header names only and no helper text.
pub fn redact_source(source: Option<&Value>) -> Map<String, Value> {
    let mut o = Map::new();
    let Some(kind) = source_kind(source) else {
        let text = source.and_then(Value::as_str);
        o.insert(
            "kind".into(),
            json!(if text.is_some() { "legacy" } else { "unknown" }),
        );
        o.insert("label".into(), json!(text.unwrap_or_default()));
        o.insert("headerKeys".into(), json!([]));
        o.insert("hasHeadersHelper".into(), json!(false));
        if text.is_some() {
            o.insert("legacy".into(), json!(true));
        }
        return o;
    };
    let s = source.and_then(Value::as_object).expect("an object source");
    let header_keys: Vec<Value> = s
        .get("headers")
        .and_then(Value::as_object)
        .map(|h| {
            js::own_keys_order(h)
                .into_iter()
                .map(|(k, _)| json!(k))
                .collect()
        })
        .unwrap_or_default();
    o.insert("kind".into(), json!(kind));
    o.insert("label".into(), json!(source_label(source)));
    o.insert("headerKeys".into(), Value::Array(header_keys));
    o.insert(
        "hasHeadersHelper".into(),
        json!(
            s.get("headersHelper")
                .and_then(Value::as_str)
                .is_some_and(|h| !h.is_empty())
        ),
    );
    o
}

fn legacy_view(label: &str) -> Map<String, Value> {
    let mut o = Map::new();
    o.insert("kind".into(), json!("legacy"));
    o.insert("label".into(), json!(label));
    o.insert("headerKeys".into(), json!([]));
    o.insert("hasHeadersHelper".into(), json!(false));
    o.insert("legacy".into(), json!(true));
    o
}

/// `readExtraMarketplaces(raw)`: the redacted `extraKnownMarketplaces`
/// views; a legacy `string[]` lists its strings as legacy entries.
pub fn read_extra_marketplaces(raw: Option<&Value>) -> Vec<Value> {
    match raw {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|label| {
                let mut o = Map::new();
                o.insert("name".into(), json!(label));
                o.extend(legacy_view(label));
                Value::Object(o)
            })
            .collect(),
        Some(Value::Object(m)) => js::own_keys_order(m)
            .into_iter()
            .map(|(name, entry)| {
                let mut o = Map::new();
                o.insert("name".into(), json!(name));
                o.extend(redact_source(
                    entry.as_object().and_then(|e| e.get("source")),
                ));
                Value::Object(o)
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `readPolicyMarketplaces(raw)`: an array's redacted sources; a legacy
/// `true` is one legacy entry.
pub fn read_policy_marketplaces(raw: Option<&Value>) -> Vec<Value> {
    match raw {
        Some(Value::Array(items)) => items
            .iter()
            .map(|s| Value::Object(redact_source(Some(s))))
            .collect(),
        Some(Value::Bool(true)) => vec![Value::Object(legacy_view("true"))],
        _ => Vec::new(),
    }
}

/// `validateAddSource(source)`: only `github` (`owner/repo`, no wildcard)
/// and `url` (`http(s)://…`) sources can be added here.
pub fn validate_add_source(source: &Value) -> std::result::Result<(), String> {
    let field = |k: &str| source.get(k).and_then(Value::as_str);
    match source_kind(Some(source)) {
        Some("github") => {
            // `/^[^/\s]+\/[^/\s*]+$/`
            let ok = field("repo")
                .and_then(|r| r.split_once('/'))
                .is_some_and(|(owner, name)| {
                    !owner.is_empty()
                        && !name.is_empty()
                        && !owner.chars().any(js::is_whitespace)
                        && !name
                            .chars()
                            .any(|c| c == '/' || c == '*' || js::is_whitespace(c))
                });
            if ok {
                Ok(())
            } else {
                Err("GitHub source needs an owner/repo (no wildcard).".into())
            }
        }
        Some("url") => {
            if field("url").is_some_and(|u| u.starts_with("http://") || u.starts_with("https://")) {
                Ok(())
            } else {
                Err("URL source needs an http(s) marketplace.json URL.".into())
            }
        }
        _ => Err("Unsupported source kind for add; edit settings.json directly.".into()),
    }
}

/// `addExtraMarketplace(raw, name, source)` (the pure one): the next
/// `extraKnownMarketplaces` with `{source}` under the trimmed name, or why
/// not.
pub fn add_extra_entry(
    raw: Option<&Value>,
    name: &str,
    source: &Value,
) -> std::result::Result<Map<String, Value>, String> {
    let trimmed = js::trim(name);
    if trimmed.is_empty() {
        return Err("A marketplace name is required.".into());
    }
    if let Some(lint) = lint_marketplace_name(trimmed, source) {
        return Err(lint);
    }
    if matches!(raw, Some(Value::Array(_))) {
        return Err(
            "Legacy string entries are present — remove them before adding named marketplaces."
                .into(),
        );
    }
    validate_add_source(source)?;
    let mut base = raw.and_then(Value::as_object).cloned().unwrap_or_default();
    if base.contains_key(trimmed) {
        return Err(format!(
            "A marketplace named \"{trimmed}\" already exists — remove it first."
        ));
    }
    base.insert(trimmed.to_owned(), json!({ "source": source }));
    Ok(base)
}

/// `removeExtraMarketplace(raw, name)` (the pure one): the next value, or
/// `None` when it's empty (or wasn't an array or object).
pub fn remove_extra_entry(raw: Option<&Value>, name: &str) -> Option<Value> {
    match raw? {
        Value::Array(items) => {
            let next: Vec<Value> = items
                .iter()
                .filter(|x| x.as_str() != Some(name))
                .cloned()
                .collect();
            (!next.is_empty()).then_some(Value::Array(next))
        }
        Value::Object(m) => {
            let mut next = m.clone();
            js_delete(&mut next, name);
            (!next.is_empty()).then_some(Value::Object(next))
        }
        _ => None,
    }
}

/// `removePolicyMarketplace(raw, index)`: the array without the entry at
/// `index` (compared as a JS number), or `None` when empty or not an array.
pub fn remove_policy_entry(raw: Option<&Value>, index: f64) -> Option<Value> {
    let items = raw?.as_array()?;
    let next: Vec<Value> = items
        .iter()
        .enumerate()
        .filter(|(i, _)| *i as f64 != index)
        .map(|(_, v)| v.clone())
        .collect();
    (!next.is_empty()).then_some(Value::Array(next))
}

// ─── plugins.ts ──────────────────────────────────────────────────────────

/// `listAll(cwd)`: each scope's `PluginsByScope`, user, project, local. A
/// file that doesn't parse is listed empty with its `parseError`; any other
/// read failure (or a `TypeError` on an odd file) fails the whole list.
pub fn list_all(cwd: &str) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for (scope, scope_name) in SCOPES {
        let settings = match Settings::read(scope, cwd) {
            Ok(s) => s,
            Err(PluginsError::Settings(SettingsError::Parse { path, reason })) => {
                out.push(json!({
                    "scope": scope_name,
                    "path": path,
                    "enabledPlugins": {},
                    "extraKnownMarketplaces": [],
                    "strictKnownMarketplaces": [],
                    "blockedMarketplaces": [],
                    "legacyExtra": false,
                    "pluginConfigs": {},
                    "parseError": reason,
                }));
                continue;
            }
            Err(e) => return Err(e),
        };
        let ep = settings.get("enabledPlugins")?;
        let extra = settings.aliased("extraKnownMarketplaces", "additionalMarketplaces")?;
        let strict = settings.aliased("strictKnownMarketplaces", "allowedMarketplaces")?;
        let blocked = settings.get("blockedMarketplaces")?;
        let configs = settings.get("pluginConfigs")?;
        let object_or_empty = |v: Option<&Value>| match v {
            Some(v @ (Value::Object(_) | Value::Array(_))) => v.clone(),
            _ => json!({}),
        };
        out.push(json!({
            "scope": scope_name,
            "path": settings::path_for(scope, cwd).to_string_lossy(),
            "enabledPlugins": object_or_empty(ep),
            "extraKnownMarketplaces": read_extra_marketplaces(extra),
            "strictKnownMarketplaces": read_policy_marketplaces(strict),
            "blockedMarketplaces": read_policy_marketplaces(blocked),
            "legacyExtra": matches!(extra, Some(Value::Array(_))),
            "pluginConfigs": object_or_empty(configs),
        }));
    }
    Ok(out)
}

/// `fs.readFile(path, "utf8")` + `JSON.parse`: the value twice, as
/// [`js::json_parse`] and as [`db_agents::json_parse`] (infinities kept);
/// `None` when either step throws.
fn read_json(path: &str) -> Option<(Value, Value)> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let plain = js::json_parse(&text).ok()?;
    let twin = db_agents::json_parse(&text).ok()?;
    Some((plain, twin))
}

/// `readPluginManifest(base, dir)`: `.claude-plugin/plugin.json`, else
/// `plugin.json`, under `path.resolve(base, dir)` (which must be `base` or
/// below it, compared as strings): the first that parses to an object or
/// array.
fn read_plugin_manifest(base: &str, dir: &str) -> Option<(Value, Value)> {
    let resolved = node_path::resolve(&[base, dir]);
    if resolved != base && !resolved.starts_with(&format!("{base}/")) {
        return None;
    }
    [".claude-plugin/plugin.json", "plugin.json"]
        .iter()
        .find_map(|rel| {
            read_json(&node_path::join(&[&resolved, rel]))
                .filter(|(v, _)| v.is_object() || v.is_array())
        })
}

/// `enrichInstalled(raw)`: the `plugins` of a `reload_plugins` reply with a
/// non-empty string `name`, as `{name, path?, source?, version?,
/// description?, displayName?, userConfig?}`; the description, display name
/// and option schema fall back to the plugin's own `plugin.json` at `path`.
pub fn enrich_installed(raw: &[Value]) -> Vec<Value> {
    let str_field = |o: &Map<String, Value>, k: &str| {
        o.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let mut out = Vec::new();
    for item in raw {
        let Some(o) = item.as_object() else { continue };
        let Some(name) = str_field(o, "name") else {
            continue;
        };
        let path = str_field(o, "path");
        let manifest = path.as_deref().and_then(|p| read_plugin_manifest(p, "."));
        let meta = merge_plugin_meta(Some(item), manifest.as_ref().map(|(m, _)| m));
        let user_config = manifest
            .as_ref()
            .map(|(m, twin)| parse_user_config(m, twin))
            .unwrap_or_default();
        let mut row = Map::new();
        row.insert("name".into(), json!(name));
        for (k, v) in [
            ("path", path),
            ("source", str_field(o, "source")),
            ("version", str_field(o, "version")),
            ("description", meta.description),
            ("displayName", meta.display_name),
        ] {
            if let Some(v) = v {
                row.insert(k.into(), json!(v));
            }
        }
        if !user_config.is_empty() {
            row.insert("userConfig".into(), Value::Array(user_config));
        }
        out.push(Value::Object(row));
    }
    out
}

/// `setPluginOptionValue(scope, cwd, pluginId, name, value)`: set (or,
/// with `None`, clear) one option under `pluginConfigs`.
pub fn set_plugin_option_value(
    scope: Scope,
    cwd: &str,
    plugin_id: &str,
    name: &str,
    value: Option<&Value>,
) -> Result<()> {
    let settings = Settings::read(scope, cwd)?;
    let mut next = settings.spread();
    let configs = settings.get("pluginConfigs")?;
    match set_plugin_option(configs, plugin_id, name, value) {
        None => js_delete(&mut next, "pluginConfigs"),
        Some(updated) => js_set(&mut next, "pluginConfigs", Value::Object(updated)),
    }
    settings::write_settings(scope, cwd, &next)?;
    Ok(())
}

/// `setEnabled(scope, cwd, pluginId, enabled)`: `enabledPlugins[pluginId]
/// = true`, or delete it; an emptied map drops `enabledPlugins`. The key is
/// `String(pluginId)`, which can throw.
pub fn set_enabled(scope: Scope, cwd: &str, plugin_id: &Value, enabled: bool) -> Result<()> {
    let settings = Settings::read(scope, cwd)?;
    let mut ep = match settings.get("enabledPlugins")? {
        Some(v @ (Value::Object(_) | Value::Array(_))) => settings::spread(v),
        _ => Map::new(),
    };
    let key = property_key(plugin_id)?;
    if enabled {
        js_set(&mut ep, &key, Value::Bool(true));
    } else {
        js_delete(&mut ep, &key);
    }
    let mut next = settings.spread();
    if ep.is_empty() {
        js_delete(&mut next, "enabledPlugins");
    } else {
        next.insert("enabledPlugins".into(), Value::Object(ep));
    }
    settings::write_settings(scope, cwd, &next)?;
    Ok(())
}

/// One `listAvailable` row, with the install count it sorts by.
struct Available {
    row: Value,
    name: String,
    installs: Option<f64>,
}

/// `readInstallCounts()`: `counts[].plugin` → `counts[].unique_installs`
/// (later rows win); empty when the file is missing or odd.
fn read_install_counts(claude_home: &str) -> Vec<(String, f64)> {
    let path = node_path::join(&[claude_home, "plugins", "install-counts-cache.json"]);
    let Some((plain, twin)) = read_json(&path) else {
        return Vec::new();
    };
    let (Some(rows), Some(twins)) = (
        plain.get("counts").and_then(Value::as_array),
        twin.get("counts").and_then(Value::as_array),
    ) else {
        return Vec::new();
    };
    let mut out: Vec<(String, f64)> = Vec::new();
    for (c, t) in rows.iter().zip(twins) {
        let Some(plugin) = c.get("plugin").and_then(Value::as_str) else {
            continue;
        };
        let Some(n) = c
            .get("unique_installs")
            .and_then(Value::as_f64)
            .or_else(|| t.get("unique_installs").and_then(db_agents::infinity))
        else {
            continue;
        };
        match out.iter_mut().find(|(p, _)| p == plugin) {
            Some(slot) => slot.1 = n,
            None => out.push((plugin.to_owned(), n)),
        }
    }
    out
}

/// `listAvailable()`: every plugin of every cloned marketplace under
/// `homedir()/.claude/plugins/marketplaces`, most installs first (no count
/// sorts as -1), then by `localeCompare` of the name, ties in directory
/// order. No marketplaces dir is `[]`; another `readdir` failure throws.
pub fn list_available() -> Result<Vec<Value>> {
    list_available_in(&paths::claude_home().to_string_lossy())
}

/// [`list_available`] for a given `homedir()/.claude`.
pub fn list_available_in(claude_home: &str) -> Result<Vec<Value>> {
    let root = node_path::join(&[claude_home, "plugins", "marketplaces"]);
    let entries = match fs_list::read_dir(&root) {
        Ok(e) => e,
        Err(e) if fs_list::error_code(&e) == Some("ENOENT") => return Ok(Vec::new()),
        Err(e) => {
            return Err(node_err::uv_exception(&e, "scandir", Some(root.as_ref()), None).into());
        }
    };
    let counts = read_install_counts(claude_home);
    let mut out: Vec<Available> = Vec::new();
    for entry in entries {
        if entry.kind != DirentKind::Dir {
            continue;
        }
        let dir = node_path::join(&[&root, &entry.name]);
        let manifest_path = node_path::join(&[&dir, ".claude-plugin", "marketplace.json"]);
        let Some((manifest, _)) = read_json(&manifest_path) else {
            continue;
        };
        let Some(plugins) = manifest.get("plugins").and_then(Value::as_array) else {
            continue;
        };
        for p in plugins {
            let Some(name) = p
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
            else {
                continue;
            };
            let reference = format!("{name}@{}", entry.name);
            let mut meta = merge_plugin_meta(Some(p), None);
            if (meta.description.is_none() || meta.display_name.is_none())
                && let Some(subdir) = plugin_subdir_from_source(p.get("source"))
                && let Some((m, _)) = read_plugin_manifest(&dir, &subdir)
            {
                meta = merge_plugin_meta(Some(p), Some(&m));
            }
            let installs = counts
                .iter()
                .find(|(plugin, _)| *plugin == reference)
                .map(|(_, n)| *n);
            let mut row = Map::new();
            row.insert("marketplace".into(), json!(entry.name));
            row.insert("name".into(), json!(name));
            if let Some(d) = meta.display_name {
                row.insert("displayName".into(), json!(d));
            }
            if let Some(d) = meta.description {
                row.insert("description".into(), json!(d));
            }
            if let Some(a @ (Value::String(_) | Value::Object(_) | Value::Array(_))) =
                p.get("author")
            {
                row.insert("author".into(), a.clone());
            }
            for k in ["category", "homepage"] {
                if let Some(v) = p.get(k).filter(|v| v.is_string()) {
                    row.insert(k.into(), v.clone());
                }
            }
            if let Some(n) = installs {
                row.insert("installs".into(), crate::js_num(n));
            }
            out.push(Available {
                row: Value::Object(row),
                name: name.to_owned(),
                installs,
            });
        }
    }
    out.sort_by(|a, b| {
        let (ai, bi) = (a.installs.unwrap_or(-1.0), b.installs.unwrap_or(-1.0));
        if ai != bi {
            return bi.partial_cmp(&ai).unwrap_or(Ordering::Equal);
        }
        crate::collate::locale_compare(&a.name, &b.name)
    });
    Ok(out.into_iter().map(|a| a.row).collect())
}

/// `addExtraMarketplace(scope, cwd, name, source)`: `Ok(Err(why))` when the
/// add is refused (nothing written). The value goes under the canonical key
/// and the alias is dropped.
pub fn add_extra_marketplace(
    scope: Scope,
    cwd: &str,
    name: &str,
    source: &Value,
) -> Result<std::result::Result<(), String>> {
    let settings = Settings::read(scope, cwd)?;
    let raw = settings.aliased("extraKnownMarketplaces", "additionalMarketplaces")?;
    let value = match add_extra_entry(raw, name, source) {
        Ok(v) => v,
        Err(why) => return Ok(Err(why)),
    };
    let mut next = settings.spread();
    js_delete(&mut next, "additionalMarketplaces");
    next.insert("extraKnownMarketplaces".into(), Value::Object(value));
    settings::write_settings(scope, cwd, &next)?;
    Ok(Ok(()))
}

/// `removeExtraMarketplace(scope, cwd, name)`: always rewrites the file,
/// with the alias moved to the canonical key.
pub fn remove_extra_marketplace(scope: Scope, cwd: &str, name: &str) -> Result<()> {
    let settings = Settings::read(scope, cwd)?;
    let raw = settings.aliased("extraKnownMarketplaces", "additionalMarketplaces")?;
    let value = remove_extra_entry(raw, name);
    let mut next = settings.spread();
    js_delete(&mut next, "additionalMarketplaces");
    match value {
        None => js_delete(&mut next, "extraKnownMarketplaces"),
        Some(v) => {
            next.insert("extraKnownMarketplaces".into(), v);
        }
    }
    settings::write_settings(scope, cwd, &next)?;
    Ok(())
}

/// Which policy list `removePolicyMarketplaceEntry` edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyList {
    Strict,
    Blocked,
}

/// `removePolicyMarketplaceEntry(scope, cwd, list, index)`.
pub fn remove_policy_marketplace_entry(
    scope: Scope,
    cwd: &str,
    list: PolicyList,
    index: f64,
) -> Result<()> {
    let settings = Settings::read(scope, cwd)?;
    let mut next = settings.spread();
    let (key, value) = match list {
        PolicyList::Strict => {
            let raw = settings.aliased("strictKnownMarketplaces", "allowedMarketplaces")?;
            let value = remove_policy_entry(raw, index);
            js_delete(&mut next, "allowedMarketplaces");
            ("strictKnownMarketplaces", value)
        }
        PolicyList::Blocked => (
            "blockedMarketplaces",
            remove_policy_entry(settings.get("blockedMarketplaces")?, index),
        ),
    };
    match value {
        None => js_delete(&mut next, key),
        Some(v) => {
            next.insert(key.into(), v);
        }
    }
    settings::write_settings(scope, cwd, &next)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proto_assignment_adds_no_key() {
        let mut m = Map::new();
        js_set(&mut m, "__proto__", json!({"a": 1}));
        assert!(m.is_empty());
        m.insert("__proto__".into(), json!(1));
        js_set(&mut m, "__proto__", json!(2));
        assert_eq!(Value::Object(m), json!({"__proto__": 2}));
    }

    #[test]
    fn property_keys() {
        let inf = db_agents::json_parse("[1e400,-1e400]").unwrap();
        assert_eq!(property_key(&inf[0]).unwrap(), "Infinity");
        assert_eq!(property_key(&inf[1]).unwrap(), "-Infinity");
        assert_eq!(property_key(&inf).unwrap(), "Infinity,-Infinity");
        assert_eq!(property_key(&json!([1, null, [2, "x"]])).unwrap(), "1,,2,x");
        assert!(property_key(&json!([{"toString": 1}])).is_err());
        assert_eq!(
            property_key(&json!({"valueOf": 1})).unwrap(),
            "[object Object]"
        );
    }
}
