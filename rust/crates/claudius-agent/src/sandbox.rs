//! The SDK's sandbox merge (`CZ()` + `bZ()`, sdk.mjs 0.3.299).
//!
//! `query({sandbox})` doesn't send the sandbox as a flag. It folds it into
//! the `--settings` JSON: the existing `settings.sandbox` is deep-merged with
//! the option, a few keys are pruned so the option's intent survives the
//! merge, and an enabled sandbox defaults to `failIfUnavailable: true`.
//!
//! **Not ported:** for a `network.deniedDomains` that is neither an array, a
//! string nor an object with a numeric `length`, JS would coerce its
//! `.length` with `>`. Such values count as empty here; the CLI's own schema
//! rejects them anyway.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::error::AgentError;
use crate::js;

/// Paths whose arrays are unioned (deduped) instead of replaced (`gVe`).
const UNION_PATHS: [&str; 5] = [
    "filesystem.denyRead",
    "filesystem.denyWrite",
    "network.deniedDomains",
    "credentials.files",
    "credentials.envVars",
];

/// Paths whose objects are replaced wholesale instead of merged (`hVe`).
const REPLACE_PATHS: [&str; 2] = ["ripgrep", "network.tlsTerminate"];

/// Keys the merge never copies (`_Ve`, prototype-pollution guard).
const SKIPPED_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// Proxy ports dropped from the merged network block when the option
/// restricts domains without setting them (`yVe`).
const PROXY_PORTS: [&str; 2] = ["httpProxyPort", "socksProxyPort"];

/// The SDK's error when `settings` is a file path and `sandbox` is set.
pub const SETTINGS_PATH_CONFLICT: &str = "Cannot use both a settings file path and the sandbox option. Include the sandbox configuration in your settings file instead.";

/// `bZ(base, over, path)`: a copy of `base` (if it's an object) with
/// `over`'s entries merged in. Objects merge recursively; arrays at
/// [`UNION_PATHS`] are unioned; everything else, including objects at
/// [`REPLACE_PATHS`], replaces. New keys are appended and existing keys keep
/// their position, like JS property assignment.
pub fn deep_merge(base: Option<&Value>, over: &Value, path: &str) -> Map<String, Value> {
    let mut merged = match base {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    };
    for (key, value) in js::entries(over) {
        if SKIPPED_KEYS.contains(&key.as_str()) {
            continue;
        }
        let key_path = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };
        let next = match (merged.get(&key), &value) {
            (Some(Value::Array(a)), Value::Array(b))
                if UNION_PATHS.contains(&key_path.as_str()) =>
            {
                Value::Array(js::dedupe(a.iter().chain(b).cloned().collect()))
            }
            (Some(a @ Value::Object(_)), Value::Object(_))
                if !REPLACE_PATHS.contains(&key_path.as_str()) =>
            {
                Value::Object(deep_merge(Some(a), &value, &key_path))
            }
            _ => value,
        };
        merged.insert(key, next);
    }
    merged
}

/// `(v?.length ?? 0) > 0` for the value shapes that have a `length`.
fn has_positive_length(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Object(m)) => m
            .get("length")
            .and_then(Value::as_f64)
            .is_some_and(|n| n > 0.0),
        _ => false,
    }
}

/// `CZ(args, sandbox)`. `args` is the SDK's `{...extraArgs, settings?}` flag
/// map (a `None` value is a bare flag). With a truthy `sandbox`, its
/// `settings` entry becomes the merged JSON, at the key's existing position
/// or appended.
///
/// Errors like the SDK when `settings` is a file path (anything that isn't
/// `{…}` after trimming). Settings that fail to parse are treated as `{}`.
pub fn merge_into_args(
    args: &mut IndexMap<String, Option<String>>,
    sandbox: &Value,
) -> Result<(), AgentError> {
    if !js::truthy(sandbox) {
        return Ok(());
    }
    let settings = args
        .get("settings")
        .cloned()
        .flatten()
        .filter(|s| !s.is_empty());
    if let Some(raw) = &settings {
        let t = js::trim(raw);
        if !(t.starts_with('{') && t.ends_with('}')) {
            return Err(AgentError::InvalidOptions(SETTINGS_PATH_CONFLICT.into()));
        }
    }
    let mut base: Map<String, Value> = settings
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();

    let opt = Some(sandbox);
    let mut merged = deep_merge(base.get("sandbox"), sandbox, "");

    // An option that configures the filesystem (or denies credential files)
    // re-enables it unless it says otherwise.
    let denies_files = matches!(
        js::prop(js::prop(opt, "credentials"), "files"),
        Some(Value::Array(files)) if files.iter().any(|f| {
            f.as_object().is_some_and(|f| f.get("mode").and_then(Value::as_str) == Some("deny"))
        })
    );
    let fs_option = js::prop(opt, "filesystem");
    if (fs_option.is_some() || denies_files) && js::prop(fs_option, "disabled").is_none() {
        if let Some(Value::Object(fs)) = merged.get_mut("filesystem") {
            if fs.get("disabled") == Some(&Value::Bool(true)) {
                fs.shift_remove("disabled");
            }
        }
    }

    // An option that restricts domains drops inherited proxy ports it
    // doesn't set itself.
    let net_option = js::prop(opt, "network");
    let restricts = js::prop(net_option, "allowedDomains").is_some()
        || has_positive_length(js::prop(net_option, "deniedDomains"))
        || js::prop(net_option, "strictAllowlist") == Some(&Value::Bool(true));
    if restricts {
        if let Some(Value::Object(net)) = merged.get_mut("network") {
            for port in PROXY_PORTS {
                if js::prop(net_option, port).is_none() {
                    net.shift_remove(port);
                }
            }
        }
    }

    if js::prop(opt, "enabled") == Some(&Value::Bool(true))
        && !merged.contains_key("failIfUnavailable")
    {
        merged.insert("failIfUnavailable".into(), Value::Bool(true));
    }

    base.insert("sandbox".into(), Value::Object(merged));
    args.insert("settings".into(), Some(js::stringify(&Value::Object(base))));
    Ok(())
}
