//! `lib/server/settings-export.ts`: the `SettingsBundle` that
//! `GET /api/settings/export` sends.
//!
//! Everything Claudius keeps on disk, assembled as the TS does: the user
//! `settings.json`, the customize prompt (only when it isn't the shipped
//! template), the four updater knobs, `keybindings.json` when the file
//! exists and holds a truthy value, every non-`customization` workspace
//! with its project / local settings and icon bytes, and each
//! customization's most recent publish's source files.
//!
//! Only a *missing* entry is dropped. A read that fails for any other
//! reason throws, so a half-empty backup is never shipped; a workspace
//! whose `rootPath` no longer exists (ENOENT / ENOTDIR) contributes no
//! settings. Values are the stored ones, so a settings file holding an
//! array, a string or a number is bundled as it is, and
//! `Object.keys(...).length` over it decides whether it's included
//! (a literal `null` file throws `Cannot convert undefined or null to
//! object`, as `Object.keys(null)` does).

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::settings::{self, Scope};
use crate::skills::Thrown;
use crate::{customizations, customize_settings, js_string, keybindings, node_err, node_path};
use crate::{paths, updater, workspaces};

/// `os.platform()` / `process.platform`.
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        std::env::consts::OS
    }
}

/// `os.hostname()` — libuv's `uv_os_gethostname`, i.e. `gethostname(2)`.
#[cfg(unix)]
pub fn hostname() -> String {
    let mut buf = vec![0u8; 256];
    // SAFETY: `buf` is a writable allocation of `buf.len()` bytes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(not(unix))]
pub fn hostname() -> String {
    String::new()
}

/// `JSON.parse`'s value for one settings file, and whether the file holds a
/// literal `null` (which `Object.keys` refuses, where a number past `f64`
/// — also `Value::Null` — gives `[]`).
fn read_scope(scope: Scope, cwd: &str) -> Result<(Value, bool), Thrown> {
    settings::read_settings_raw(scope, cwd).map_err(thrown)
}

fn thrown(e: settings::SettingsError) -> Thrown {
    Thrown {
        name: e.name(),
        message: e.to_string(),
    }
}

/// `Object.keys(v).length`: an object's own keys, an array's indices, a
/// string's UTF-16 units; `0` for a number or boolean, and a `TypeError`
/// for `null`.
fn own_keys_len(value: &Value, literal_null: bool) -> Result<usize, Thrown> {
    if literal_null {
        return Err(Thrown::type_error(
            "Cannot convert undefined or null to object",
        ));
    }
    Ok(match value {
        Value::Object(m) => m.len(),
        Value::Array(items) => items.len(),
        Value::String(s) => js_string::len16(s),
        _ => 0,
    })
}

/// `v.key` without optional chaining: a `TypeError` on `null`, `None`
/// (`undefined`) for a missing key or any primitive.
fn member<'a>(v: &'a Value, key: &str) -> Result<Option<&'a Value>, Thrown> {
    match v {
        Value::Null => Err(Thrown::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `String(v)` in a template literal; an object with no primitive throws.
fn to_text(v: Option<&Value>) -> Result<String, Thrown> {
    match v {
        None => Ok("undefined".into()),
        Some(v) => js_string::to_js_string(v)
            .map_err(|_| Thrown::type_error("Cannot convert object to primitive value")),
    }
}

/// `readSettings(scope, rootPath)` for a workspace entry's `rootPath`,
/// where `assertWithin` refuses a non-string or empty base and the caller
/// turns a missing path (ENOENT / ENOTDIR) into `{}`.
fn read_workspace_scope(scope: Scope, root_path: Option<&Value>) -> Result<(Value, bool), Thrown> {
    let Some(Value::String(root)) = root_path else {
        return Err(Thrown::path_injection("invalid base path"));
    };
    match read_scope(scope, root) {
        Ok(v) => Ok(v),
        // `isFsLookupError` — the rootPath is gone off disk.
        Err(e)
            if e.name == "Error"
                && (e.message.starts_with("ENOENT:") || e.message.starts_with("ENOTDIR:")) =>
        {
            Ok((Value::Object(Map::new()), false))
        }
        Err(e) => Err(e),
    }
}

/// `buildExportBundle()` at `now` (the TS reads `Date.now()` once).
pub fn build_export_bundle(now: i64) -> Result<Value, Thrown> {
    let home = paths::home_dir().to_string_lossy().into_owned();

    // ── system ───────────────────────────────────────────────────────────
    let (user_settings, user_null) = read_scope(Scope::User, "")?;
    let customize = customize_settings::get_settings().map_err(|e| Thrown {
        name: "Error",
        message: e.to_string(),
    })?;
    // The file is read as UTF-16, so a lone surrogate in `remote` / `branch`
    // survives the read; the bundle has U+FFFD for it, as for every other
    // file it carries.
    let updater = js_string::lossy_value(&updater::settings::get_updater_settings().to_json());
    let keys = keybindings::read_keybindings(&home)?;

    let mut system = Map::new();
    if own_keys_len(&user_settings, user_null)? > 0 {
        system.insert("userSettings".into(), user_settings);
    }
    // `customizeSettings.autoFixPrompt` is always a non-blank string, so
    // only a prompt the user changed is bundled.
    if customize
        .get(customize_settings::AUTO_FIX_PROMPT)
        .and_then(Value::as_str)
        != Some(customize_settings::DEFAULT_AUTO_FIX_PROMPT)
    {
        system.insert("customizeSettings".into(), Value::Object(customize));
    }
    system.insert("updaterSettings".into(), updater);
    if claudius_agent::js::truthy(&keys["exists"]) && claudius_agent::js::truthy(&keys["data"]) {
        system.insert("keybindings".into(), keys["data"].clone());
    }

    // ── workspaces ───────────────────────────────────────────────────────
    let mut bundled_workspaces: Vec<Value> = Vec::new();
    for ws in workspaces::list_raw().map_err(|e| Thrown::error(e.to_string()))? {
        // `ws.kind !== "customization"`.
        if member(&ws, "kind")?.and_then(Value::as_str) == Some("customization") {
            continue;
        }
        let root_path = member(&ws, "rootPath")?.cloned();
        let (project, project_null) = read_workspace_scope(Scope::Project, root_path.as_ref())?;
        let (local, local_null) = read_workspace_scope(Scope::Local, root_path.as_ref())?;
        let icon = workspaces::read_icon(&to_text(member(&ws, "id")?)?);

        let mut out = Map::new();
        out.insert("meta".into(), ws.clone());
        if own_keys_len(&project, project_null)? > 0 {
            out.insert("projectSettings".into(), project);
        }
        if own_keys_len(&local, local_null)? > 0 {
            out.insert("localSettings".into(), local);
        }
        if let Some((bytes, ext)) = icon {
            out.insert(
                "iconBytes".into(),
                json!({ "ext": ext, "base64": base64(&bytes) }),
            );
        }
        bundled_workspaces.push(Value::Object(out));
    }

    // ── customization overlays ───────────────────────────────────────────
    let store = customizations::Store::from_env();
    let list = store
        .list_customizations()
        .map_err(|e| Thrown::error(e.to_string()))?;
    let publishes = store
        .list_publishes(None)
        .map_err(|e| Thrown::error(e.to_string()))?;
    let mut bundled_customizations: Vec<Value> = Vec::new();
    for c in &list {
        let id = member(c, "id")?.cloned();
        let mut mine: Vec<&Value> = Vec::new();
        for p in &publishes {
            // `p.customizationId === c.id` — strict equality.
            if strict_eq(member(p, "customizationId")?, id.as_ref()) {
                mine.push(p);
            }
        }
        sort_by_published_at_desc(&mut mine)?;
        let Some(latest) = mine.first().copied() else {
            continue; // never published — no files to bundle
        };
        let src_dir = store.customization_src_dir(&to_text(id.as_ref())?);
        let files_value = member(latest, "files")?;
        let Some(files) = files_value.and_then(Value::as_array) else {
            // `latestPublish.files.map(...)` on a value that has no `map`.
            return Err(Thrown::type_error(match files_value {
                None => "Cannot read properties of undefined (reading 'map')".to_owned(),
                Some(Value::Null) => "Cannot read properties of null (reading 'map')".to_owned(),
                Some(_) => "latestPublish.files.map is not a function".to_owned(),
            }));
        };
        let mut bundled_files: Vec<Value> = Vec::new();
        for f in files {
            // `async ({ path }) => …` — destructuring a `null` entry rejects.
            if f.is_null() {
                return Err(Thrown::type_error(
                    "Cannot destructure property 'path' of 'object null' as it is null.",
                ));
            }
            let path = member(f, "path")?;
            // `join(srcDir, path)` throws inside the `try` for a non-string
            // path, which skips the file like a failed read.
            let Some(Value::String(rel)) = path else {
                continue;
            };
            // `join(srcDir, path)` (an absolute-looking path stays under
            // `srcDir`), then resolved and checked right above the read, as
            // the Rust path rules require; the TS reads a `..` path outside
            // without a guard, here it is skipped.
            let joined = node_path::join(&[&src_dir, rel]);
            let target = node_path::resolve(&[&joined]);
            if !target.starts_with(&format!("{src_dir}/")) {
                continue;
            }
            let Ok(bytes) = node_err::fs::read_file(Path::new(&target)) else {
                continue; // removed from src/ after the publish — skipped
            };
            bundled_files.push(json!({
                "path": rel,
                "content": String::from_utf8_lossy(&bytes),
            }));
        }
        bundled_customizations.push(json!({
            "meta": c,
            "publishedFiles": bundled_files,
        }));
    }

    let mut bundle = Map::new();
    bundle.insert("version".into(), json!(1));
    bundle.insert("exportedAt".into(), json!(now));
    bundle.insert(
        "exportedFrom".into(),
        json!({ "hostname": hostname(), "platform": platform() }),
    );
    bundle.insert("system".into(), Value::Object(system));
    bundle.insert("workspaces".into(), Value::Array(bundled_workspaces));
    if !bundled_customizations.is_empty() {
        bundle.insert(
            "customizations".into(),
            Value::Array(bundled_customizations),
        );
    }
    Ok(Value::Object(bundle))
}

/// `a === b` for two optional (`undefined` = `None`) JSON values.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Object(_) | Value::Array(_)), _)
        | (_, Some(Value::Object(_) | Value::Array(_))) => false,
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// `.sort((a, b) => b.publishedAt - a.publishedAt)`: V8's binary insertion
/// sort (what TimSort runs for fewer than 64 elements), with a comparator
/// result of `NaN` read as `0` the way the spec says. `publishedAt` off a
/// `null` entry throws, as the comparator does.
fn sort_by_published_at_desc(items: &mut [&Value]) -> Result<(), Thrown> {
    let at = |v: &Value| -> Result<f64, Thrown> {
        Ok(member(v, "publishedAt")?
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN))
    };
    for i in 1..items.len() {
        let pivot = items[i];
        let pivot_at = at(pivot)?;
        let (mut left, mut right) = (0, i);
        while left < right {
            let mid = (left + right) / 2;
            // `comparefn(pivot, items[mid]) < 0`.
            let d = at(items[mid])? - pivot_at;
            if d < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        items[left..=i].rotate_right(1);
    }
    Ok(())
}

/// `buf.toString("base64")`.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// `suggestedFilename(at)` — `claudius-backup-YYYY-MM-DD.json` in UTC. An
/// `at` outside the JS Date range (or not a number) gives the TS's
/// `claudius-backup-NaN-NaN-NaN.json`.
pub fn suggested_filename(at: f64) -> String {
    let Some(ms) = time_clip(at) else {
        return "claudius-backup-NaN-NaN-NaN.json".to_owned();
    };
    let (y, m, d) = utc_ymd(ms);
    format!("claudius-backup-{y}-{m:02}-{d:02}.json")
}

/// `TimeClip(v)`: `NaN` past ±8.64e15, else truncated toward zero.
fn time_clip(v: f64) -> Option<i64> {
    (v.is_finite() && v.abs() <= 8.64e15).then(|| v.trunc() as i64)
}

/// `getUTCFullYear` / `getUTCMonth` + 1 / `getUTCDate` (proleptic
/// Gregorian, Howard Hinnant's `civil_from_days`).
fn utc_ymd(ms: i64) -> (i64, i64, i64) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_follow_the_ts() {
        assert_eq!(suggested_filename(0.0), "claudius-backup-1970-01-01.json");
        assert_eq!(
            suggested_filename(1_762_000_000_000.0),
            "claudius-backup-2025-11-01.json"
        );
        assert_eq!(
            suggested_filename(f64::NAN),
            "claudius-backup-NaN-NaN-NaN.json"
        );
        assert_eq!(
            suggested_filename(8.64e15 + 1.0),
            "claudius-backup-NaN-NaN-NaN.json"
        );
        assert_eq!(
            suggested_filename(-0.5),
            "claudius-backup-1970-01-01.json",
            "truncated toward zero"
        );
    }

    #[test]
    fn base64_matches_buffer() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0x00, 0xff, 0x10]), "AP8Q");
    }
}
