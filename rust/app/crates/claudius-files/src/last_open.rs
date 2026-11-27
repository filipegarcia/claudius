//! `lib/client/files-last-open.ts`: the last file opened per workspace, as
//! `localStorage` keeps it (`claudius.files.lastOpen.<workspace id>` →
//! `JSON.stringify({root, relPath})`).
//!
//! The React page never calls it (the module has no importer on the
//! branch); the native page uses it as its docs describe: a visit without
//! `?path=` reopens it, a pick writes it, a delete clears it, a rename
//! writes the new path.

use claudius_core::js_string;
use serde_json::{Map, Value};

/// files-last-open.ts:24.
pub const PREFIX: &str = "claudius.files.lastOpen.";

/// files-last-open.ts:19 `LastOpenFile`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastOpenFile {
    /// `primary` or `extra:<n>`.
    pub root: String,
    pub rel_path: String,
}

/// files-last-open.ts:26 `keyFor(workspaceId)`.
pub fn key_for(workspace_id: &str) -> String {
    format!("{PREFIX}{workspace_id}")
}

/// files-last-open.ts:36 `readLastOpenFile`'s parse of the stored text:
/// `None` for nothing (`""` too), a value that isn't JSON, or one without
/// a string `root` and a non-empty string `relPath`.
pub fn parse(raw: Option<&str>) -> Option<LastOpenFile> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let v = js_string::parse(raw).ok()?;
    let root = v.get("root")?.as_str()?;
    let rel = v.get("relPath")?.as_str()?;
    if rel.is_empty() {
        return None;
    }
    Some(LastOpenFile {
        root: root.to_owned(),
        rel_path: rel.to_owned(),
    })
}

/// files-last-open.ts:63 `writeLastOpenFile`'s value:
/// `JSON.stringify(entry)` (`root` first).
pub fn serialize(entry: &LastOpenFile) -> String {
    let mut m = Map::new();
    m.insert("root".into(), Value::String(entry.root.clone()));
    m.insert("relPath".into(), Value::String(entry.rel_path.clone()));
    js_string::stringify(&Value::Object(m))
}
