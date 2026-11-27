//! The app's `localStorage` (U04b): string keys to string values in one
//! JSON file, `~/.claude/.claudius/native-app/local-storage.json`
//! ([`default_path`]). The shell keeps what the React app keeps there under
//! the same keys and in the same value shapes:
//!
//! - `claudius.focusMode` (`useFocusMode.ts`): `off`, `focus` or `zen`
//!   (`1` from an older build reads as focus; anything else, off).
//! - `claudius.workspace.lastPath` (`workspace-route-memory.ts`): a JSON
//!   object from workspace id to the last pathname under it, without the
//!   `/<id>` prefix (`""` for the chat, `"/git"`).
//!
//! Like `localStorage`, a failed read or write is swallowed: a missing or
//! unreadable file is an empty store, and a write that fails leaves the
//! value in memory only. Each write replaces the file (a temp file, then a
//! rename).

use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::nav::FocusLevel;
use crate::route::{Route, WorkspacePage};

pub const FOCUS_KEY: &str = "claudius.focusMode";
pub const LAST_PATH_KEY: &str = "claudius.workspace.lastPath";

/// Where the app keeps its store: under Claudius's own state root.
pub fn default_path() -> PathBuf {
    claudius_core::paths::claudius_root()
        .join("native-app")
        .join("local-storage.json")
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct LocalStore {
    path: Option<PathBuf>,
    items: IndexMap<String, String>,
}

impl LocalStore {
    /// A store that lives as long as the process (tests, the fixture).
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// The store in `path` (read now; an absent or bad file is empty).
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let items = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Map<String, Value>>(&t).ok())
            .map(|m| {
                m.into_iter()
                    .filter_map(|(k, v)| match v {
                        Value::String(s) => Some((k, s)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        LocalStore {
            path: Some(path),
            items,
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// `getItem`.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.items.get(key).map(String::as_str)
    }

    /// `setItem`: kept, and written to the file.
    pub fn set(&mut self, key: &str, value: &str) {
        if self.get(key) == Some(value) {
            return;
        }
        self.items.insert(key.to_owned(), value.to_owned());
        self.flush();
    }

    /// `removeItem`.
    pub fn remove(&mut self, key: &str) {
        if self.items.shift_remove(key).is_some() {
            self.flush();
        }
    }

    fn flush(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let map: Map<String, Value> = self
            .items
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        let Ok(text) = serde_json::to_string_pretty(&Value::Object(map)) else {
            return;
        };
        let write = || -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
            std::fs::write(&tmp, text)?;
            std::fs::rename(&tmp, path)
        };
        let _ = write();
    }

    // ---- focus mode -------------------------------------------------------

    /// `readSnapshot()`.
    pub fn focus(&self) -> FocusLevel {
        match self.get(FOCUS_KEY) {
            Some("zen") => FocusLevel::Zen,
            Some("focus" | "1") => FocusLevel::Focus,
            _ => FocusLevel::Off,
        }
    }

    /// `write(level)`.
    pub fn set_focus(&mut self, level: FocusLevel) {
        self.set(FOCUS_KEY, level.as_str());
    }

    // ---- route memory -----------------------------------------------------

    /// `readMap()`: the stored object, or `{}` (absent, not JSON, or not an
    /// object).
    fn last_paths(&self) -> Map<String, Value> {
        self.get(LAST_PATH_KEY)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| match v {
                Value::Object(m) => Some(m),
                _ => None,
            })
            .unwrap_or_default()
    }

    /// `getLastPath(id)`: the full pathname, or `None`. A value already
    /// carrying the `/<id>` prefix (an older build's) is taken as is.
    pub fn last_path(&self, workspace_id: &str) -> Option<String> {
        let map = self.last_paths();
        let v = map.get(workspace_id)?.as_str()?;
        if v.starts_with(&format!("/{workspace_id}")) {
            return Some(v.to_owned());
        }
        if !v.starts_with('/') && !v.is_empty() {
            return None;
        }
        Some(format!("/{workspace_id}{v}"))
    }

    /// `setLastPath(id, pathname)`: only a workspace-scoped `/wks_<hex>…`
    /// pathname is kept, without its prefix; an unchanged value isn't
    /// written again.
    pub fn set_last_path(&mut self, workspace_id: &str, pathname: &str) {
        if !pathname.starts_with('/') || !is_workspace_scoped_path(pathname) {
            return;
        }
        let Some(inner) = strip_prefix(pathname) else {
            return;
        };
        let mut map = self.last_paths();
        if map.get(workspace_id).and_then(Value::as_str) == Some(inner) {
            return;
        }
        map.insert(workspace_id.to_owned(), Value::String(inner.to_owned()));
        if let Ok(text) = serde_json::to_string(&Value::Object(map)) {
            self.set(LAST_PATH_KEY, &text);
        }
    }

    /// Every remembered page, as the shell's route memory holds it (the
    /// pathname's page; a path no page has is skipped).
    pub fn remembered_pages(&self) -> Vec<(String, WorkspacePage)> {
        self.last_paths()
            .keys()
            .filter_map(|id| {
                let path = self.last_path(id)?;
                match Route::parse(&path)? {
                    Route::Workspace { id: at, page } if at == *id => {
                        Some((id.clone(), page.without_query()))
                    }
                    _ => None,
                }
            })
            .collect()
    }
}

/// `isWorkspaceScopedPath`.
pub fn is_workspace_scoped_path(pathname: &str) -> bool {
    ![
        "/community",
        "/plugins",
        "/settings",
        "/usage",
        "/customize",
        "/doctor",
        "/release-notes",
        "/updater",
    ]
    .iter()
    .any(|p| pathname.starts_with(p))
}

/// `stripPrefix`: what follows `/wks_<hex>` (`/^\/wks_[a-f0-9]+(\/.*)?$/`).
fn strip_prefix(pathname: &str) -> Option<&str> {
    let rest = pathname.strip_prefix("/wks_")?;
    let hex = rest
        .bytes()
        .take_while(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        .count();
    if hex == 0 {
        return None;
    }
    let tail = &rest[hex..];
    // `(\/.*)?$`: nothing, or a slash and anything without a line break
    // (`.` stops at one, and `$` has no `m` flag).
    if tail.is_empty()
        || (tail.starts_with('/') && !tail.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
    {
        Some(tail)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: &str = "wks_3f2a9c81d0e4";

    #[test]
    fn focus_reads_as_use_focus_mode() {
        let mut s = LocalStore::in_memory();
        assert_eq!(s.focus(), FocusLevel::Off);
        for (raw, level) in [
            ("zen", FocusLevel::Zen),
            ("focus", FocusLevel::Focus),
            ("1", FocusLevel::Focus),
            ("off", FocusLevel::Off),
            ("ZEN", FocusLevel::Off),
            ("", FocusLevel::Off),
        ] {
            s.set(FOCUS_KEY, raw);
            assert_eq!(s.focus(), level, "{raw:?}");
        }
        s.set_focus(FocusLevel::Zen);
        assert_eq!(s.get(FOCUS_KEY), Some("zen"));
    }

    #[test]
    fn route_memory_is_workspace_route_memory() {
        let mut s = LocalStore::in_memory();
        assert_eq!(s.last_path(W), None);
        s.set_last_path(W, &format!("/{W}/git"));
        assert_eq!(s.get(LAST_PATH_KEY), Some(r#"{"wks_3f2a9c81d0e4":"/git"}"#));
        assert_eq!(s.last_path(W).as_deref(), Some("/wks_3f2a9c81d0e4/git"));
        s.set_last_path(W, &format!("/{W}"));
        assert_eq!(s.last_path(W).as_deref(), Some("/wks_3f2a9c81d0e4"));
        // Not scoped, not a workspace path, or relative: ignored.
        for p in [
            "/settings",
            "/git",
            "git",
            "/wks_/x",
            "/wks_XYZ/x",
            "/wks_3f2ax",
        ] {
            s.set_last_path(W, p);
            assert_eq!(s.last_path(W).as_deref(), Some("/wks_3f2a9c81d0e4"), "{p}");
        }
        // Older values: a full path stays, a relative one is dropped.
        s.set(
            LAST_PATH_KEY,
            r#"{"wks_3f2a9c81d0e4":"/wks_3f2a9c81d0e4/files","b":"git","c":7}"#,
        );
        assert_eq!(s.last_path(W).as_deref(), Some("/wks_3f2a9c81d0e4/files"));
        assert_eq!(s.last_path("b"), None);
        assert_eq!(s.last_path("c"), None);
        // A map that isn't one reads as empty.
        s.set(LAST_PATH_KEY, "[1]");
        assert_eq!(s.last_path(W), None);
        s.set(LAST_PATH_KEY, "{");
        assert_eq!(s.last_path(W), None);
    }

    #[test]
    fn remembered_pages_parse() {
        let mut s = LocalStore::in_memory();
        s.set_last_path(W, &format!("/{W}/git"));
        s.set_last_path("wks_7b41e05c92aa", "/wks_7b41e05c92aa");
        s.set_last_path("wks_c09d4e7f1b36", "/wks_c09d4e7f1b36/nope/nope");
        // An older full path under another id that only shares the prefix.
        let mut raw: serde_json::Map<String, Value> =
            serde_json::from_str(s.get(LAST_PATH_KEY).unwrap()).unwrap();
        raw.insert(
            "wks_0123456789ab".into(),
            Value::String("/wks_0123456789abcd/git".into()),
        );
        s.set(LAST_PATH_KEY, &Value::Object(raw).to_string());
        assert_eq!(
            s.remembered_pages(),
            vec![
                (W.to_owned(), WorkspacePage::Git),
                (
                    "wks_7b41e05c92aa".to_owned(),
                    WorkspacePage::Chat { session: None }
                ),
            ]
        );
    }

    #[test]
    fn the_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("local-storage.json");
        let mut s = LocalStore::open(&path);
        assert_eq!(s.get(FOCUS_KEY), None);
        s.set_focus(FocusLevel::Focus);
        s.set_last_path(W, &format!("/{W}/memory"));
        let again = LocalStore::open(&path);
        assert_eq!(again, s);
        assert_eq!(again.focus(), FocusLevel::Focus);
        // A bad file is an empty store; a non-string value is dropped.
        std::fs::write(&path, "nope").unwrap();
        assert_eq!(LocalStore::open(&path).get(FOCUS_KEY), None);
        std::fs::write(&path, r#"{"a":"1","b":2}"#).unwrap();
        let s = LocalStore::open(&path);
        assert_eq!((s.get("a"), s.get("b")), (Some("1"), None));
    }
}
