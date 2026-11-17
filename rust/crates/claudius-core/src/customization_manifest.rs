//! A customization's base manifest, the fork point of its mirror: port of
//! `lib/server/customization-manifest.ts` (D14). It lives at
//! `<root>/<id>/base-manifest.json` as `{version: 1, createdAt, files}`,
//! where `files` maps each `/`-joined path of the mirror to its SHA-1.
//!
//! The manifest is kept as the JSON value TS works on: a file another
//! writer left (foreign keys, an array of `files`, hashes that aren't
//! strings) reads back as `JSON.parse` reads it, and only `version === 1`
//! with an object (or array) `files` counts as a manifest.

use anyhow::{anyhow, bail};
use serde_json::{Map, Value, json};

use crate::customizations::{self, Store};
use crate::node_fs::{self, FsError};
use crate::{js_string, node_path};

fn fs_error(e: FsError) -> anyhow::Error {
    anyhow!(e.message)
}

/// `manifestPath(id)`.
pub fn manifest_path(store: &Store, id: &str) -> String {
    node_path::join(&[&store.customization_dir(id), "base-manifest.json"])
}

/// `readManifest(id)`: the parsed file when it is `{version: 1, files}` with
/// `files` an object or array, else `None`; a missing file is `None` too. A
/// `null` file, a parse error and any other read error throw (their TS
/// messages).
pub fn read_manifest(store: &Store, id: &str) -> anyhow::Result<Option<Value>> {
    let text = match node_fs::read_to_string(&manifest_path(store, id)) {
        Ok(t) => t,
        Err(e) if e.is_not_found() => return Ok(None),
        Err(e) => return Err(fs_error(e)),
    };
    let parsed = js_string::parse(&text).map_err(|m| anyhow!(m))?;
    match &parsed {
        Value::Null => bail!("Cannot read properties of null (reading 'version')"),
        Value::Object(m)
            if m.get("version").and_then(Value::as_f64) == Some(1.0)
                && m.get("files")
                    .is_some_and(|f| f.is_object() || f.is_array()) =>
        {
            Ok(Some(parsed))
        }
        _ => Ok(None),
    }
}

/// `writeManifest(id, manifest)`: `JSON.stringify(manifest, null, 2) + "\n"`
/// to `<path>.<pid>.<now>.tmp`, renamed over the manifest. The customization
/// dir isn't made first, so a missing one fails the write (ENOENT on the
/// temp file).
pub fn write_manifest(store: &Store, id: &str, manifest: &Value) -> Result<(), FsError> {
    let path = manifest_path(store, id);
    let tmp = format!("{path}.{}.{}.tmp", std::process::id(), store.now());
    node_fs::write_file(&tmp, &(js_string::stringify_pretty(manifest) + "\n"), 0o666)?;
    node_fs::rename(&tmp, &path)
}

/// `buildManifestFromTree(root)`: every file of the walk
/// ([`customizations::list_source_files`]) and its SHA-1, stamped `now`. A
/// root file named `__proto__` sets the object's prototype in TS (to a
/// string, which is ignored), so it never becomes a key.
pub fn build_manifest_from_tree(root: &str, now: i64) -> Result<Value, FsError> {
    let mut files = Map::new();
    for rel in customizations::list_source_files(root)? {
        let hash = customizations::hash_file(&node_path::join(&[root, &rel]))?;
        if rel != "__proto__" {
            files.insert(rel, json!(hash));
        }
    }
    Ok(json!({"version": 1, "createdAt": now, "files": files}))
}

/// `ensureManifest(id, srcRoot)`: the stored manifest, or one built from the
/// mirror as it is now and written.
pub fn ensure_manifest(store: &Store, id: &str, src_root: &str) -> anyhow::Result<Value> {
    if let Some(existing) = read_manifest(store, id)? {
        return Ok(existing);
    }
    let manifest = build_manifest_from_tree(src_root, store.now()).map_err(fs_error)?;
    write_manifest(store, id, &manifest).map_err(fs_error)?;
    Ok(manifest)
}

/// `Object.keys(manifest.files)`: an object's keys in JS order (array
/// indices first), or an array's indices.
pub fn file_keys(files: &Value) -> Vec<String> {
    match files {
        Value::Object(m) => claudius_agent::js::own_keys_order(m)
            .into_iter()
            .map(|(k, _)| k.clone())
            .collect(),
        Value::Array(a) => (0..a.len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// `manifest.files[rel] ?? null` for an own key (an array's index or
/// `length` too); `Null` otherwise. TS would read an inherited
/// `Object.prototype` member for a root file named `constructor`,
/// `toString`, … (PORT_PLAN known gap).
pub fn file_hash(files: &Value, rel: &str) -> Value {
    match files {
        Value::Object(m) => m.get(rel).cloned().unwrap_or(Value::Null),
        Value::Array(a) if rel == "length" => json!(a.len()),
        Value::Array(a) => claudius_agent::js::array_index(rel)
            .and_then(|i| a.get(i as usize))
            .cloned()
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}
