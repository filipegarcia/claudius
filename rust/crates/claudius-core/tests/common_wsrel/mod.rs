//! The disk side of `fixtures/workspace_relocate_golden.json` (recorded by
//! `rust/scripts/workspace-relocate-golden.mjs`): a temp root and its
//! placeholders, the recorder's setup ops, its tree snapshot (with a
//! `.claudius.db` dumped table by table) and `changes`. Shared with
//! claudius-server's `tests/workspace_relocate.rs` (`#[path]`).
#![allow(dead_code)] // each test binary uses a different subset

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};

use claudius_core::db::{self, Mode};
use claudius_core::paths;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/workspace_relocate_golden.json")).unwrap()
}

pub fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// The workspace store, relative to the root.
pub const STORE: &str = "home/.claude/.claudius/workspaces.json";

/// A temp root (through realpath) and its placeholders: `$ROOT`, and
/// `$EROOT` for its `encodeProjectDir` form.
pub struct World {
    pub dir: tempfile::TempDir,
    pub root: String,
    pub eroot: String,
}

impl World {
    pub fn new() -> World {
        let dir = tempfile::Builder::new()
            .prefix("wsrel-golden-")
            .tempdir()
            .unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        // Placeholders are swapped textually.
        assert!(
            root.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b)),
            "root needs escaping: {root}"
        );
        let eroot = paths::encode_project_dir(&root);
        World { dir, root, eroot }
    }

    pub fn abs(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root)
    }

    pub fn rel(&self, s: &str) -> String {
        s.replace(&self.eroot, "$EROOT")
            .replace(&self.root, "$ROOT")
    }

    /// [`World::rel`] over every string (keys too) of a JSON value.
    pub fn deep_rel(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.rel(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.deep_rel(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (self.rel(k), self.deep_rel(x)))
                    .collect(),
            ),
            v => v.clone(),
        }
    }

    /// `join(ROOT, toAbs(rel))`.
    pub fn path(&self, rel: &str) -> PathBuf {
        PathBuf::from(format!("{}/{}", self.root, self.abs(rel)))
    }

    /// `buildWorld(dirs)`: everything in the root removed, the base dirs
    /// (and `dirs`) made.
    pub fn build(&self, dirs: &[&str]) {
        open_up(Path::new(&self.root));
        for e in std::fs::read_dir(&self.root).unwrap() {
            let p = e.unwrap().path();
            if std::fs::symlink_metadata(&p).unwrap().is_dir() {
                std::fs::remove_dir_all(&p).unwrap();
            } else {
                std::fs::remove_file(&p).unwrap();
            }
        }
        for d in ["home/.claude/.claudius", "config", "outside"]
            .iter()
            .chain(dirs)
        {
            std::fs::create_dir_all(self.path(d)).unwrap();
        }
    }

    /// A root's `.claudius.db` under `$ROOT/home`.
    pub fn db_file(&self, root: &str) -> PathBuf {
        self.path(&format!(
            "home/.claude/projects/{}/.claudius.db",
            self.rel(&paths::encode_project_dir(root))
        ))
    }

    /// The recorder's setup ops.
    pub fn apply(&self, op: &Value) {
        let p = || self.path(str_of(&op["path"]));
        match str_of(&op["op"]) {
            "write" => {
                std::fs::create_dir_all(p().parent().unwrap()).unwrap();
                let bytes: Vec<u8> = match op.get("bytes") {
                    Some(b) => b
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|n| n.as_u64().unwrap() as u8)
                        .collect(),
                    None => self.abs(str_of(&op["text"])).into_bytes(),
                };
                std::fs::write(p(), bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(p()).unwrap(),
            "rm" => {
                open_up(&p());
                match std::fs::symlink_metadata(p()) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(p()).unwrap(),
                    Ok(_) => std::fs::remove_file(p()).unwrap(),
                    Err(_) => {}
                }
            }
            "symlink" => {
                std::fs::create_dir_all(p().parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(self.abs(str_of(&op["target"])), p()).unwrap();
            }
            "hardlink" => {
                std::fs::create_dir_all(p().parent().unwrap()).unwrap();
                std::fs::hard_link(self.path(str_of(&op["target"])), p()).unwrap();
            }
            "chmod" => std::fs::set_permissions(
                p(),
                std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
            )
            .unwrap(),
            "fifo" => {
                std::fs::create_dir_all(p().parent().unwrap()).unwrap();
                let st = std::process::Command::new("mkfifo")
                    .arg(p())
                    .status()
                    .unwrap();
                assert!(st.success(), "mkfifo {}", p().display());
            }
            "sql" => {
                // `openDb(root)` (made, migrated), `exec`, `closeDb(root)`.
                let file = self.db_file(&self.abs(str_of(&op["root"])));
                let c = db::open_path(&file, Mode::ReadWrite).unwrap();
                c.execute_batch(&self.abs(str_of(&op["sql"]))).unwrap();
            }
            "rawdb" => {
                std::fs::create_dir_all(p().parent().unwrap()).unwrap();
                let c = Connection::open(p()).unwrap();
                if op["wal"] == true {
                    c.pragma_update(None, "journal_mode", "WAL").unwrap();
                }
                c.execute_batch(&self.abs(str_of(&op["sql"]))).unwrap();
            }
            other => panic!("unknown op {other}"),
        }
    }

    /// The recorder's `snapshot(extra)`: every entry under
    /// `home/.claude/projects`, `outside` and `extra`.
    pub fn snapshot(&self, extra: &[&str]) -> BTreeMap<String, Value> {
        let mut snap = BTreeMap::new();
        for rel in ["home/.claude/projects", "outside"].iter().chain(extra) {
            self.visit(rel, &mut snap);
        }
        snap
    }

    fn visit(&self, rel: &str, snap: &mut BTreeMap<String, Value>) {
        let abs = self.path(rel);
        let Ok(meta) = std::fs::symlink_metadata(&abs) else {
            return;
        };
        let mode = meta.permissions().mode() & 0o7777;
        let ft = meta.file_type();
        if ft.is_symlink() {
            let target = std::fs::read_link(&abs).unwrap().display().to_string();
            snap.insert(
                rel.into(),
                json!({"kind": "symlink", "target": self.rel(&target)}),
            );
        } else if ft.is_dir() {
            let mut entry = json!({"kind": "dir", "mode": mode});
            let names = match std::fs::read_dir(&abs) {
                Ok(rd) => {
                    let mut names: Vec<String> = rd
                        .map(|e| e.unwrap().file_name().into_string().unwrap())
                        .collect();
                    js_sort(&mut names);
                    names
                }
                Err(_) => {
                    entry["unreadable"] = json!(true);
                    Vec::new()
                }
            };
            snap.insert(rel.into(), entry);
            for n in names {
                if n.ends_with(".claudius.db-wal") || n.ends_with(".claudius.db-shm") {
                    continue;
                }
                self.visit(&format!("{rel}/{}", self.rel(&n)), snap);
            }
        } else if ft.is_fifo() {
            snap.insert(rel.into(), json!({"kind": "fifo", "mode": mode}));
        } else if rel.ends_with("/.claudius.db") {
            snap.insert(
                rel.into(),
                json!({"kind": "db", "mode": mode, "db": self.dump_db(&abs)}),
            );
        } else {
            let entry = match std::fs::read(&abs) {
                Err(_) => json!({"kind": "file", "mode": mode, "unreadable": true}),
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(text) => json!({"kind": "file", "mode": mode, "text": self.rel(&text)}),
                    Err(e) => json!({"kind": "file", "mode": mode, "bytes": e.into_bytes()}),
                },
            };
            snap.insert(rel.into(), entry);
        }
    }

    /// The recorder's `dumpDb`: every table, its columns and each cell's
    /// SQLite type and text.
    fn dump_db(&self, file: &Path) -> Value {
        // `new Database(file, { fileMustExist: true })`.
        let conn = match Connection::open_with_flags(
            file,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(c) => c,
            Err(e) => return json!({"error": sqlite_message(&e, file)}),
        };
        let dump = || -> rusqlite::Result<Value> {
            let tables: Vec<String> = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let mut out = Vec::new();
            for name in tables {
                let cols: Vec<String> = conn
                    .prepare("SELECT name FROM pragma_table_info(?)")?
                    .query_map([&name], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                let sel = cols
                    .iter()
                    .map(|c| {
                        let q = quote_ident(c);
                        format!(
                            "typeof({q}), CASE typeof({q}) WHEN 'blob' THEN hex({q}) ELSE CAST({q} AS TEXT) END"
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut st = conn.prepare(&format!("SELECT {sel} FROM {}", quote_ident(&name)))?;
                let n = st.column_count();
                let rows: Vec<Value> = st
                    .query_map([], |r| {
                        (0..n)
                            .map(|i| {
                                // Text as V8 decodes it: U+FFFD per bad byte.
                                r.get_ref(i).map(|x| match x {
                                    ValueRef::Text(t) => {
                                        Value::String(self.rel(&String::from_utf8_lossy(t)))
                                    }
                                    _ => Value::Null,
                                })
                            })
                            .collect::<rusqlite::Result<Vec<Value>>>()
                            .map(Value::Array)
                    })?
                    .collect::<Result<_, _>>()?;
                out.push(json!({"name": name, "cols": cols, "rows": rows}));
            }
            Ok(json!({ "tables": out }))
        };
        dump().unwrap_or_else(|e| json!({"error": sqlite_message(&e, file)}))
    }
}

/// A failed check can leave `chmod`ed folders behind: open them up so the
/// temp dir can go.
impl Drop for World {
    fn drop(&mut self) {
        open_up(Path::new(&self.root));
    }
}

/// chmod every directory under `p` back to 0755, so it can be removed.
pub fn open_up(p: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return;
    };
    if !meta.is_dir() {
        return;
    }
    if std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).is_err() {
        return;
    }
    for e in std::fs::read_dir(p).into_iter().flatten().flatten() {
        open_up(&e.path());
    }
}

/// JS's default `sort()`: by UTF-16 code units.
pub fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

fn quote_ident(n: &str) -> String {
    format!("\"{}\"", n.replace('"', "\"\""))
}

/// What better-sqlite3's `e.message` reads for a failed call.
fn sqlite_message(e: &rusqlite::Error, file: &Path) -> String {
    let m = db::sqlite_message(e);
    let suffix = format!(": {}", file.display());
    m.strip_suffix(&suffix)
        .map_or_else(|| m.clone(), str::to_owned)
}

/// The recorder's `changes`: each path whose entry differs, with its new
/// entry (`null` once gone), in JS sort order.
pub fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<String> = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    js_sort(&mut keys);
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(k) != after.get(k))
            .map(|k| {
                let v = after.get(&k).cloned().unwrap_or(Value::Null);
                json!([k, v])
            })
            .collect(),
    )
}

/// Whether this disk enforces permissions (not root).
pub fn perm_enforced() -> bool {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("probe");
    std::fs::create_dir(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o0)).unwrap();
    let enforced = std::fs::read_dir(&p).is_err();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    enforced
}

/// Whether a recorded scenario / group can replay here: not skipped by the
/// recorder, and `needs: ["perm"]` only where permissions are enforced.
pub fn runs_here(sc: &Value, perm: bool) -> bool {
    if sc["skipped"] == true {
        return false;
    }
    let needs_perm = sc["needs"]
        .as_array()
        .is_some_and(|n| n.iter().any(|x| x == "perm"));
    if needs_perm && !perm {
        eprintln!("skipping {}: permissions aren't enforced here", sc["name"]);
        return false;
    }
    true
}
