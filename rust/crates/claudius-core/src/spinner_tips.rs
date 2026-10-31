//! The spinner-tip settings `start()` caches for the `tips` event
//! (`lib/server/session.ts`): `normalizeSpinnerTipsOverride`,
//! `mergeSpinnerTipsFile` and the `spinnerTipsConfig` they build from the user
//! `settings.json`. [`events::select_tips`] turns that into the list a
//! subscriber receives.
//!
//! The `tipsFile` is read once, at session start, never per subscribe. Like
//! TS, it's best-effort: anything wrong with it leaves the inline tips as they
//! are.

use std::path::Path;

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::events;

/// `SPINNER_TIPS_FILE_MAX_BYTES`: a larger `tipsFile` is ignored.
pub const SPINNER_TIPS_FILE_MAX_BYTES: u64 = 256 * 1024;

/// The `{excludeDefault, tips, label, tipsFile}` shape
/// `normalizeSpinnerTipsOverride` returns. `None` is `undefined`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpinnerTipsOverride {
    pub exclude_default: bool,
    /// Trimmed non-empty strings, or `{text, id?, priority?, cooldownSessions?}`.
    pub tips: Option<Vec<Value>>,
    pub label: Option<String>,
    pub tips_file: Option<String>,
}

impl SpinnerTipsOverride {
    /// The object as `JSON.stringify` sees it: JS key order, `undefined`
    /// fields left out.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("excludeDefault".into(), Value::Bool(self.exclude_default));
        if let Some(t) = &self.tips {
            m.insert("tips".into(), Value::Array(t.clone()));
        }
        if let Some(l) = &self.label {
            m.insert("label".into(), Value::String(l.clone()));
        }
        if let Some(f) = &self.tips_file {
            m.insert("tipsFile".into(), Value::String(f.clone()));
        }
        Value::Object(m)
    }
}

/// `typeof v === "string" && v.trim() ? v.trim() : undefined`.
fn trimmed(v: Option<&Value>) -> Option<String> {
    let s = js::trim(v?.as_str()?);
    (!s.is_empty()).then(|| s.to_owned())
}

/// One `tips` entry, mapped the same way inline and from a `tipsFile`: a
/// string trimmed, an object to `{text, id?, priority?, cooldownSessions?}`
/// (each kept only with the right type), anything without text dropped.
fn normalize_entry(t: &Value) -> Option<Value> {
    if t.is_string() {
        return trimmed(Some(t)).map(Value::String);
    }
    let o = t.as_object()?;
    let mut e = Map::new();
    e.insert("text".into(), Value::String(trimmed(o.get("text"))?));
    if let Some(id @ Value::String(_)) = o.get("id") {
        e.insert("id".into(), id.clone());
    }
    for key in ["priority", "cooldownSessions"] {
        if let Some(n @ Value::Number(_)) = o.get(key) {
            e.insert(key.into(), n.clone());
        }
    }
    Some(Value::Object(e))
}

/// `normalizeSpinnerTipsOverride`: `None` unless the setting is a plain
/// object.
pub fn normalize_spinner_tips_override(over: Option<&Value>) -> Option<SpinnerTipsOverride> {
    let o = over?.as_object()?;
    Some(SpinnerTipsOverride {
        exclude_default: o.get("excludeDefault") == Some(&Value::Bool(true)),
        tips: o
            .get("tips")
            .and_then(Value::as_array)
            .map(|tips| tips.iter().filter_map(normalize_entry).collect()),
        label: trimmed(o.get("label")),
        tips_file: trimmed(o.get("tipsFile")),
    })
}

/// Node's `path.join(home, rest)` (`path.posix`) when the result is absolute:
/// the non-empty parts joined with `/`, then normalized (empty and `.`
/// segments dropped, `..` resolved lexically and never above `/`, a trailing
/// `/` kept). A relative result is `None`, since only absolute paths are read.
fn join_absolute(home: &str, rest: &str) -> Option<String> {
    let parts: Vec<&str> = [home, rest].into_iter().filter(|p| !p.is_empty()).collect();
    let joined = parts.join("/");
    if !joined.starts_with('/') {
        return None;
    }
    let mut segs: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            s => segs.push(s),
        }
    }
    let mut out = format!("/{}", segs.join("/"));
    if joined.ends_with('/') && !segs.is_empty() {
        out.push('/');
    }
    Some(out)
}

/// `mergeSpinnerTipsFile`'s path: `~/x` is `path.join(homedir(), "x")`,
/// anything else is taken as is; only an absolute result is read.
pub fn expand_tips_file(tips_file: &str, home: &str) -> Option<String> {
    match tips_file.strip_prefix("~/") {
        Some(rest) => join_absolute(home, rest),
        None => tips_file.starts_with('/').then(|| tips_file.to_owned()),
    }
}

/// The usable entries of a `tipsFile`: a regular file (through symlinks) of
/// at most [`SPINNER_TIPS_FILE_MAX_BYTES`], decoded as lossy UTF-8, holding a
/// JSON array. `None` when it isn't one, or has no entry with text.
fn read_tips_file(path: &Path) -> Option<Vec<Value>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SPINNER_TIPS_FILE_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let Ok(Value::Array(items)) = serde_json::from_str(&String::from_utf8_lossy(&bytes)) else {
        return None;
    };
    let tips: Vec<Value> = items.iter().filter_map(normalize_entry).collect();
    (!tips.is_empty()).then_some(tips)
}

/// `mergeSpinnerTipsFile` with `home` as `os.homedir()`: the `tipsFile`'s
/// entries appended to the inline `tips`, and `tipsFile` dropped.
pub fn merge_spinner_tips_file(
    over: Option<SpinnerTipsOverride>,
    home: &Path,
) -> Option<SpinnerTipsOverride> {
    let mut rest = over?;
    let file_tips = rest
        .tips_file
        .take()
        .and_then(|f| expand_tips_file(&f, &home.to_string_lossy()))
        .and_then(|p| read_tips_file(Path::new(&p)));
    if let Some(file_tips) = file_tips {
        rest.tips.get_or_insert_default().extend(file_tips);
    }
    Some(rest)
}

/// The `spinnerTipsConfig` `start()` builds from the user settings.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpinnerTipsConfig {
    /// `spinnerTipsEnabled` when it's a boolean.
    pub enabled: Option<bool>,
    /// The normalized override with its `tipsFile` merged in.
    pub over: Option<SpinnerTipsOverride>,
}

impl SpinnerTipsConfig {
    /// Reads the `tipsFile`, if any, against `home`.
    pub fn from_settings(settings: &Map<String, Value>, home: &Path) -> Self {
        Self {
            enabled: settings.get("spinnerTipsEnabled").and_then(Value::as_bool),
            over: merge_spinner_tips_file(
                normalize_spinner_tips_override(settings.get("spinnerTipsOverride")),
                home,
            ),
        }
    }

    /// `{enabled, override}` as `JSON.stringify` prints it.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(e) = self.enabled {
            m.insert("enabled".into(), Value::Bool(e));
        }
        if let Some(o) = &self.over {
            m.insert("override".into(), o.to_json());
        }
        Value::Object(m)
    }

    /// `selectTips({spinnerTipsEnabled, spinnerTipsOverride})`: the `tips`
    /// event's list.
    pub fn tips(&self) -> Value {
        let over = self.over.as_ref().map(SpinnerTipsOverride::to_json);
        events::select_tips(self.enabled, over.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only a regular file is read (`stat.isFile()`): a pipe holding a valid
    /// list is skipped, where reading it could block start() forever.
    #[cfg(unix)]
    #[test]
    fn a_pipe_is_never_read() {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::FileTypeExt;
        let body = r#"["from a pipe"]"#;
        let mut child = std::process::Command::new("printf")
            .arg(body)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        assert!(child.wait().unwrap().success());
        let out = child.stdout.take().unwrap();
        let pipe = format!("/dev/fd/{}", out.as_raw_fd());
        assert!(std::fs::metadata(&pipe).unwrap().file_type().is_fifo());
        assert_eq!(read_tips_file(Path::new(&pipe)), None);

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("tips.json");
        std::fs::write(&file, body).unwrap();
        assert_eq!(
            read_tips_file(&file),
            Some(vec![Value::from("from a pipe")])
        );
    }
}
