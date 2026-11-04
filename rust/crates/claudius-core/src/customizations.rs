//! `~/.claude/.claudius/customizations/`: port of
//! `lib/server/customizations-store.ts` (the `index.json` store and the
//! mirror dir layout), plus `computeDiff` (`lib/server/customization-publish.ts`)
//! over the walk and hash helpers of `lib/server/customization-hash.ts`.
//! This is also the one customization read side the rest of the port uses
//! (`getCustomization`, `customizationSrcDir`, `customizationsRoot`).
//!
//! Layout: `<root>/index.json` is the store; `<root>/<id>/src/` is a
//! customization's editable mirror and `<root>/<id>/.publishes/` its publish
//! snapshots. Every path is a `path.join` of the root and the id, so the id
//! is normalized in (`a/../b` is `b`, a leading `/` doesn't reset it).
//!
//! The store is kept as the JSON value TS works on, as in
//! [`crate::workspaces`]: whatever a file holds survives a read-modify-write
//! as `JSON.parse` / `JSON.stringify(shape, null, 2)` round-trip it (unknown
//! keys and their order, array-index keys first, number text, foreign
//! entries, lone surrogates via [`js_string`]). An index that isn't
//! `{version: 1, customizations: [..], publishes: [..]}` reads as an empty
//! store (and the next write replaces it); a missing one too; a `null` file,
//! a parse error and every other read error throw. Lookups follow the TS
//! callbacks: `c.id === id` is strict equality, and an entry that is `null`
//! throws (`Cannot read properties of null`) where a `find` / `filter` /
//! `findIndex` reaches it. Errors carry the TS `message`.
//!
//! Writes are atomic (`index.json.<pid>.<now>.tmp`, then a rename, which
//! replaces a symlinked index rather than writing through it), with no
//! backups. One process-wide lock serializes each read-modify-write; TS can
//! interleave two requests' awaits and lose an update.
//!
//! Path safety: [`Store::remove_customization_dir`] and
//! [`Store::compute_diff`] refuse an id whose dir is not strictly inside the
//! root, where TS would `rm` / walk outside it. Symlinks are followed as TS
//! follows them (a symlinked `src`, a base-side link to anywhere); see
//! PORT_PLAN "Mirrored TS bugs" (T08a).

use std::io::Read;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use anyhow::{anyhow, bail};
use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::accounts::{Clock, Random};
use crate::node_fs::{self, FsError};
use crate::{asset_list, collate, js_string, node_path, paths, workspaces};

/// `TREE_SKIP_DIRS`: directories the walk never enters, at any depth.
pub const TREE_SKIP_DIRS: [&str; 10] = [
    "node_modules",
    ".next",
    ".git",
    ".turbo",
    ".cache",
    "dist",
    "out",
    "playwright-report",
    "test-results",
    ".vercel",
];

/// `TREE_SKIP_FILES`.
const TREE_SKIP_FILES: [&str; 1] = [".DS_Store"];

/// Serializes the store's read-modify-writes.
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `CLAUDIUS_VERSION` (`lib/shared/version.ts`): the SDK version
/// `package.json` mirrors, then the release counter baked in at build time
/// (`NEXT_PUBLIC_CLAUDIUS_RELEASE`, default `0`).
pub fn claudius_version() -> String {
    format!(
        "{}.{}",
        claudius_agent::SDK_VERSION,
        option_env!("NEXT_PUBLIC_CLAUDIUS_RELEASE").unwrap_or("0")
    )
}

// ---- paths ------------------------------------------------------------------

/// `customizationsRoot()`: `homedir()/.claude/.claudius/customizations`.
pub fn customizations_root() -> String {
    node_path::join(&[
        &paths::home_dir().to_string_lossy(),
        ".claude",
        ".claudius",
        "customizations",
    ])
}

/// `customizationDir(id)`.
pub fn customization_dir(id: &str) -> String {
    node_path::join(&[&customizations_root(), id])
}

/// `customizationSrcDir(id)`: the editable mirror.
pub fn customization_src_dir(id: &str) -> String {
    node_path::join(&[&customizations_root(), id, "src"])
}

/// `customizationPublishesDir(id)`.
pub fn customization_publishes_dir(id: &str) -> String {
    node_path::join(&[&customizations_root(), id, ".publishes"])
}

/// `listCustomizations()` on the store under the current home.
pub fn list_customizations() -> anyhow::Result<Vec<Value>> {
    Store::from_env().list_customizations()
}

/// `getCustomization(id)` on the store under the current home.
pub fn get_customization(id: &str) -> anyhow::Result<Option<Value>> {
    Store::from_env().get_customization(id)
}

// ---- JS semantics -----------------------------------------------------------------

fn null_read(key: &str) -> anyhow::Error {
    anyhow!("Cannot read properties of null (reading '{key}')")
}

/// `x[key]` for a store entry: `None` is `undefined` (a primitive, an
/// array, an object without the key); `null` throws.
fn member<'a>(x: &'a Value, key: &str) -> anyhow::Result<Option<&'a Value>> {
    match x {
        Value::Null => Err(null_read(key)),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `x.id === target`, where `target` may be `undefined` (`None`).
fn same(a: Option<&Value>, target: Option<&Value>) -> bool {
    match target {
        None => a.is_none(),
        Some(t) => workspaces::strict_eq(a, t),
    }
}

/// `list.findIndex((x) => x.id === target)`.
fn find_index(list: &[Value], target: Option<&Value>) -> anyhow::Result<Option<usize>> {
    for (i, x) in list.iter().enumerate() {
        if same(member(x, "id")?, target) {
            return Ok(Some(i));
        }
    }
    Ok(None)
}

/// `{ ...x }`.
fn spread(x: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    js_string::spread_into(&mut out, x);
    out
}

/// `x.key == null`.
fn loosely_null(x: Option<&Value>) -> bool {
    x.is_none_or(Value::is_null)
}

fn fs_error(e: FsError) -> anyhow::Error {
    anyhow!(e.message)
}

fn empty_shape() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("version".into(), json!(1));
    m.insert("customizations".into(), json!([]));
    m.insert("publishes".into(), json!([]));
    m
}

fn list_of<'a>(shape: &'a Map<String, Value>, key: &str) -> &'a Vec<Value> {
    shape[key]
        .as_array()
        .expect("readShape only returns stores with both arrays")
}

fn list_mut<'a>(shape: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    shape
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("readShape only returns stores with both arrays")
}

// ---- the store ------------------------------------------------------------------

/// Why [`Store::compute_diff`] failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiffError {
    /// The id's `src` mirror isn't inside the root (TS walks it anyway).
    Outside,
    /// A walk or hash error, with Node's `err.message`.
    Fs(FsError),
}

impl From<FsError> for DiffError {
    fn from(e: FsError) -> DiffError {
        DiffError::Fs(e)
    }
}

/// Why [`Store::remove_customization_dir`] removed nothing (or not all).
#[derive(Debug)]
pub enum RemoveError {
    /// The id's dir isn't strictly inside the root (TS removes it anyway).
    Outside(String),
    /// `fs.rm` failed.
    Io(String, std::io::Error),
}

impl std::fmt::Display for RemoveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoveError::Outside(dir) => {
                write!(
                    f,
                    "refusing to remove {dir}: outside the customizations root"
                )
            }
            RemoveError::Io(dir, e) => write!(f, "could not remove {dir}: {e}"),
        }
    }
}

/// The store at one root (TS `customizationsRoot()`), with the clock behind
/// its times and temp names and the randomness behind its ids.
#[derive(Clone)]
pub struct Store {
    root: String,
    now: Clock,
    random: Random,
}

impl Store {
    /// The store at `root` (absolute), on the system clock and randomness.
    pub fn new(root: impl Into<String>) -> Store {
        Store {
            root: root.into(),
            now: Arc::new(crate::now_ms),
            random: Arc::new(crate::accounts::os_random),
        }
    }

    /// The store TS uses: [`customizations_root`].
    pub fn from_env() -> Store {
        Store::new(customizations_root())
    }

    /// Replace the clock (ms since the epoch).
    pub fn with_clock(mut self, now: Clock) -> Store {
        self.now = now;
        self
    }

    /// Replace the bytes behind `randomUUID()`.
    pub fn with_random(mut self, random: Random) -> Store {
        self.random = random;
        self
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    /// `customizationDir(id)`.
    pub fn customization_dir(&self, id: &str) -> String {
        node_path::join(&[&self.root, id])
    }

    /// `customizationSrcDir(id)`.
    pub fn customization_src_dir(&self, id: &str) -> String {
        node_path::join(&[&self.root, id, "src"])
    }

    /// `customizationPublishesDir(id)`.
    pub fn customization_publishes_dir(&self, id: &str) -> String {
        node_path::join(&[&self.root, id, ".publishes"])
    }

    fn index_file(&self) -> String {
        node_path::join(&[&self.root, "index.json"])
    }

    /// 12 hex digits of `randomUUID()` (its first 6 bytes, which the
    /// version and variant bits leave alone).
    fn uuid12(&self) -> String {
        let mut b = [0u8; 16];
        (self.random)(&mut b);
        uuid::Builder::from_random_bytes(b)
            .into_uuid()
            .simple()
            .to_string()[..12]
            .to_owned()
    }

    /// `readShape`: `fs.readFile(_, "utf8")` (a BOM kept, so `JSON.parse`
    /// fails on it; invalid bytes U+FFFD) then `JSON.parse`; only ENOENT is
    /// an empty store.
    fn read_shape(&self) -> anyhow::Result<Map<String, Value>> {
        let text = match node_fs::read_to_string(&self.index_file()) {
            Ok(t) => t,
            Err(e) if e.is_not_found() => return Ok(empty_shape()),
            Err(e) => return Err(fs_error(e)),
        };
        match js_string::parse(&text).map_err(|m| anyhow!(m))? {
            Value::Null => Err(null_read("version")),
            Value::Object(m)
                if m.get("version").and_then(Value::as_f64) == Some(1.0)
                    && m.get("customizations").is_some_and(Value::is_array)
                    && m.get("publishes").is_some_and(Value::is_array) =>
            {
                Ok(m)
            }
            _ => Ok(empty_shape()),
        }
    }

    /// `writeShape`: `mkdir -p` the root, write
    /// `JSON.stringify(shape, null, 2) + "\n"` to the temp name, rename it
    /// over the index.
    fn write_shape(&self, shape: &Map<String, Value>) -> anyhow::Result<()> {
        node_fs::mkdir_recursive(&self.root, 0o777).map_err(fs_error)?;
        let index = self.index_file();
        let tmp = format!("{index}.{}.{}.tmp", std::process::id(), (self.now)());
        let text = js_string::stringify_pretty(&Value::Object(shape.clone())) + "\n";
        node_fs::write_file(&tmp, &text, 0o666).map_err(fs_error)?;
        node_fs::rename(&tmp, &index).map_err(fs_error)
    }

    /// `listCustomizations`: the entries as stored.
    pub fn list_customizations(&self) -> anyhow::Result<Vec<Value>> {
        Ok(list_of(&self.read_shape()?, "customizations").clone())
    }

    /// `getCustomization`: the first entry whose `id` is `=== id`.
    pub fn get_customization(&self, id: &str) -> anyhow::Result<Option<Value>> {
        let shape = self.read_shape()?;
        let list = list_of(&shape, "customizations");
        Ok(find_index(list, Some(&json!(id)))?.map(|i| list[i].clone()))
    }

    /// `createCustomizationRecord({name})`: id `cust_` + 12 hex digits of a
    /// v4 UUID, the JS-trimmed name or `Untitled`, both times now, and the
    /// running version as `baseVersion`.
    pub fn create_customization_record(&self, name: &str) -> anyhow::Result<Value> {
        let _g = lock();
        let mut shape = self.read_shape()?;
        let id = format!("cust_{}", self.uuid12());
        let name = match js::trim(name) {
            "" => "Untitled",
            t => t,
        };
        let now = (self.now)();
        let c = json!({
            "id": id,
            "name": name,
            "createdAt": now,
            "updatedAt": now,
            "baseVersion": claudius_version(),
        });
        list_mut(&mut shape, "customizations").push(c.clone());
        self.write_shape(&shape)?;
        Ok(c)
    }

    /// Replace the entry `id` with `next(entry)` (TS's
    /// `findIndex` / spread / `writeShape` pattern).
    fn rewrite(
        &self,
        list: &str,
        id: &str,
        next: impl FnOnce(&Value, i64) -> Option<Map<String, Value>>,
    ) -> anyhow::Result<Option<Value>> {
        let _g = lock();
        let mut shape = self.read_shape()?;
        let Some(idx) = find_index(list_of(&shape, list), Some(&json!(id)))? else {
            return Ok(None);
        };
        let entry = &list_of(&shape, list)[idx];
        let Some(next) = next(entry, (self.now)()) else {
            return Ok(Some(entry.clone()));
        };
        let next = Value::Object(next);
        list_mut(&mut shape, list)[idx] = next.clone();
        self.write_shape(&shape)?;
        Ok(Some(next))
    }

    /// `updateCustomizationRecord`: `{...c, ...patch, id, updatedAt}`, for a
    /// `patch` of any JSON type (a string spreads its code units).
    pub fn update_customization_record(
        &self,
        id: &str,
        patch: &Value,
    ) -> anyhow::Result<Option<Value>> {
        self.rewrite("customizations", id, |c, now| {
            let mut next = spread(c);
            js_string::spread_into(&mut next, patch);
            next.insert("id".into(), json!(id));
            next.insert("updatedAt".into(), json!(now));
            Some(next)
        })
    }

    /// `setCustomizationDescription`: the generated description and the
    /// diff hash it was made from.
    pub fn set_customization_description(
        &self,
        id: &str,
        description: &str,
        diff_hash: &str,
    ) -> anyhow::Result<Option<Value>> {
        self.rewrite("customizations", id, |c, now| {
            let mut next = spread(c);
            next.insert("description".into(), json!(description));
            next.insert("descriptionGeneratedAt".into(), json!(now));
            next.insert("descriptionDiffHash".into(), json!(diff_hash));
            next.insert("descriptionIsManual".into(), json!(false));
            next.insert("updatedAt".into(), json!(now));
            Some(next)
        })
    }

    /// `setCustomizationDescriptionManual`: the JS-trimmed text, flagged
    /// manual; an empty one drops the description (TS sets the keys to
    /// `undefined`, which `JSON.stringify` leaves out). The diff hash goes.
    pub fn set_customization_description_manual(
        &self,
        id: &str,
        description: &str,
    ) -> anyhow::Result<Option<Value>> {
        let trimmed = js::trim(description);
        self.rewrite("customizations", id, |c, now| {
            let mut next = spread(c);
            let mut set = |key: &str, v: Option<Value>| match v {
                Some(v) => {
                    next.insert(key.into(), v);
                }
                None => {
                    next.shift_remove(key);
                }
            };
            let some = !trimmed.is_empty();
            set("description", some.then(|| json!(trimmed)));
            set("descriptionGeneratedAt", some.then(|| json!(now)));
            set("descriptionDiffHash", None);
            set("descriptionIsManual", some.then(|| json!(true)));
            set("updatedAt", Some(json!(now)));
            Some(next)
        })
    }

    /// `deleteCustomizationRecord`: drop every entry with the id (publish
    /// records stay); `false` (and no write) when there was none.
    pub fn delete_customization_record(&self, id: &str) -> anyhow::Result<bool> {
        let _g = lock();
        let mut shape = self.read_shape()?;
        let target = json!(id);
        let mut next = Vec::new();
        for c in list_of(&shape, "customizations") {
            if !workspaces::strict_eq(member(c, "id")?, &target) {
                next.push(c.clone());
            }
        }
        if next.len() == list_of(&shape, "customizations").len() {
            return Ok(false);
        }
        shape.insert("customizations".into(), Value::Array(next));
        self.write_shape(&shape)?;
        Ok(true)
    }

    /// `upsertCustomizationRecord(c)`: `{...c}` without `workspaceId`,
    /// merged over the entry whose `id` is `=== clean.id` (which, when the
    /// record has none, is the first entry without one), else appended.
    pub fn upsert_customization_record(&self, c: &Value) -> anyhow::Result<()> {
        let _g = lock();
        let mut shape = self.read_shape()?;
        let mut clean = spread(c);
        clean.shift_remove("workspaceId");
        let target = clean.get("id").cloned();
        let list = list_mut(&mut shape, "customizations");
        match find_index(list, target.as_ref())? {
            Some(idx) => {
                let mut merged = spread(&list[idx]);
                js_string::spread_into(&mut merged, &Value::Object(clean));
                list[idx] = Value::Object(merged);
            }
            None => list.push(Value::Object(clean)),
        }
        self.write_shape(&shape)
    }

    /// `stripCustomizationWorkspaceIds`: drop `workspaceId` from every
    /// entry, writing only when one had it. `"workspaceId" in c` throws on
    /// a primitive or `null` entry.
    pub fn strip_customization_workspace_ids(&self) -> anyhow::Result<usize> {
        let _g = lock();
        let mut shape = self.read_shape()?;
        let mut changed = 0;
        for c in list_mut(&mut shape, "customizations") {
            match c {
                Value::Object(m) => {
                    if m.shift_remove("workspaceId").is_some() {
                        changed += 1;
                    }
                }
                Value::Array(_) => {}
                other => bail!(
                    "Cannot use 'in' operator to search for 'workspaceId' in {}",
                    js::to_string(Some(other))
                ),
            }
        }
        if changed > 0 {
            self.write_shape(&shape)?;
        }
        Ok(changed)
    }

    /// `listPublishes(customizationId?)`: all of them, or (for a non-empty
    /// id) those whose `customizationId` is `=== id`.
    pub fn list_publishes(&self, customization_id: Option<&str>) -> anyhow::Result<Vec<Value>> {
        let shape = self.read_shape()?;
        let all = list_of(&shape, "publishes");
        let Some(cid) = customization_id.filter(|c| !c.is_empty()) else {
            return Ok(all.clone());
        };
        let target = json!(cid);
        let mut out = Vec::new();
        for p in all {
            if workspaces::strict_eq(member(p, "customizationId")?, &target) {
                out.push(p.clone());
            }
        }
        Ok(out)
    }

    /// `activePublishesOrdered`: the publishes with `revertedAt == null`,
    /// sorted by `a.publishedAt - b.publishedAt` as V8 sorts (a `NaN`
    /// difference is "equal"; an object `publishedAt` that has no primitive
    /// throws once there is anything to compare).
    pub fn active_publishes_ordered(&self) -> anyhow::Result<Vec<Value>> {
        let shape = self.read_shape()?;
        let mut active = Vec::new();
        for p in list_of(&shape, "publishes") {
            if loosely_null(member(p, "revertedAt")?) {
                active.push(p);
            }
        }
        let keys: Vec<_> = active
            .iter()
            .map(|p| js_string::to_js_number(p.get("publishedAt")))
            .collect();
        if active.len() > 1 && keys.iter().any(Result::is_err) {
            bail!("Cannot convert object to primitive value");
        }
        let mut keyed: Vec<(f64, &Value)> = keys
            .into_iter()
            .map(|k| k.unwrap_or(f64::NAN))
            .zip(active)
            .collect();
        asset_list::v8_sort(&mut keyed, |a, b| a.0 - b.0);
        Ok(keyed.into_iter().map(|(_, p)| p.clone()).collect())
    }

    /// `recordPublish(rec)`: appended as given.
    pub fn record_publish(&self, rec: &Value) -> anyhow::Result<()> {
        let _g = lock();
        let mut shape = self.read_shape()?;
        list_mut(&mut shape, "publishes").push(rec.clone());
        self.write_shape(&shape)
    }

    /// `markPublishReverted(publishId, reason = "user")`: stamps
    /// `revertedAt` and `revertReason`, unless it already has a
    /// `revertedAt` (then the record comes back unchanged, unwritten).
    pub fn mark_publish_reverted(
        &self,
        publish_id: &str,
        reason: Option<&str>,
    ) -> anyhow::Result<Option<Value>> {
        let reason = reason.unwrap_or("user");
        self.rewrite("publishes", publish_id, |p, now| {
            if !loosely_null(p.get("revertedAt")) {
                return None;
            }
            let mut next = spread(p);
            next.insert("revertedAt".into(), json!(now));
            next.insert("revertReason".into(), json!(reason));
            Some(next)
        })
    }

    /// `newPublishId()`: `pub_` + 12 hex digits of a v4 UUID.
    pub fn new_publish_id(&self) -> String {
        format!("pub_{}", self.uuid12())
    }

    /// `fs.rm(customizationDir(id), { recursive: true, force: true })`:
    /// the dir (or file, or the symlink itself) and everything in it.
    pub fn remove_customization_dir(&self, id: &str) -> Result<(), RemoveError> {
        let root = &self.root;
        let target = node_path::resolve(&[&self.customization_dir(id)]);
        if !target.starts_with(&format!("{root}/")) {
            return Err(RemoveError::Outside(target));
        }
        node_fs::rm_recursive_force(&target).map_err(|e| RemoveError::Io(target.clone(), e))
    }

    /// `computeDiff(id)` against the live source dir `live`: every file of
    /// the mirror ([`list_source_files`]) hashed next to the same path under
    /// `live` (missing there: `added`; another hash: `changed`; else
    /// counted as identical), the files sorted by `localeCompare`.
    pub fn compute_diff(&self, id: &str, live: &str) -> Result<Value, DiffError> {
        let root = &self.root;
        let src = node_path::resolve(&[&self.customization_src_dir(id)]);
        if !src.starts_with(&format!("{root}/")) {
            return Err(DiffError::Outside);
        }
        let files = list_source_files(&src)?;
        let (mut changed, mut added, mut identical) = (0, 0, 0);
        let mut out: Vec<(String, Value)> = Vec::new();
        for rel in files {
            let custom = hash_file(&node_path::join(&[&src, &rel]))?;
            match hash_file_or_null(&node_path::join(&[live, &rel]))? {
                None => {
                    added += 1;
                    let f = json!({"path": rel, "kind": "added", "customHash": custom, "baseHash": null});
                    out.push((rel, f));
                }
                Some(base) if base != custom => {
                    changed += 1;
                    let f = json!({"path": rel, "kind": "changed", "customHash": custom, "baseHash": base});
                    out.push((rel, f));
                }
                Some(_) => identical += 1,
            }
        }
        out.sort_by(|a, b| collate::locale_compare(&a.0, &b.0));
        Ok(json!({
            "changedFiles": changed,
            "addedFiles": added,
            "identicalFiles": identical,
            "files": out.into_iter().map(|(_, f)| f).collect::<Vec<_>>(),
        }))
    }
}

// ---- hashing and the walk ---------------------------------------------------------

/// `createHash("sha1").update(bytes).digest("hex")`.
pub fn sha1_hex(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, bytes).as_ref())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `hashFile(path)`: the SHA-1 of the file, streamed (through symlinks, as
/// `createReadStream` opens it). `open` errors name the path; `read`
/// errors (a directory) don't.
pub fn hash_file(path: &str) -> Result<String, FsError> {
    let mut f =
        std::fs::File::open(path).map_err(|e| FsError::new(&e, "open", Some(path), None))?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| FsError::new(&e, "read", None, None))?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(hex(ctx.finish().as_ref()))
}

/// `hashFileOrNull(path)`: `None` for ENOENT (a dangling link too).
pub fn hash_file_or_null(path: &str) -> Result<Option<String>, FsError> {
    match hash_file(path) {
        Ok(h) => Ok(Some(h)),
        Err(e) if e.is_not_found() => Ok(None),
        Err(e) => Err(e),
    }
}

/// `listSourceFiles(root)` (`walkFiles`): the regular files under `root`,
/// as `/`-joined relative paths in JS sort order (UTF-16 code units). The
/// root is followed when it is a symlink; below it, entries are typed as
/// `readdir` types them, so a symlink is neither walked nor listed. The
/// [`TREE_SKIP_DIRS`] and `.DS_Store` files are skipped; a dir that is
/// gone is passed over; any other `readdir` error throws.
pub fn list_source_files(root: &str) -> Result<Vec<String>, FsError> {
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = node_path::join(&[root, &rel]);
        let entries = match node_fs::readdir_dirents(&dir) {
            Ok(e) => e,
            Err(e) => {
                let e = FsError::new(&e, "scandir", Some(&dir), None);
                if e.is_not_found() {
                    continue;
                }
                return Err(e);
            }
        };
        for (name, kind) in entries {
            if kind.is_dir() {
                if !TREE_SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(node_path::join(&[&rel, &name]));
                }
            } else if kind.is_file() && !TREE_SKIP_FILES.contains(&name.as_str()) {
                out.push(node_path::join(&[&rel, &name]));
            }
        }
    }
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_sdk_and_release() {
        assert!(claudius_version().starts_with(&format!("{}.", claudius_agent::SDK_VERSION)));
    }

    #[test]
    fn upsert_without_an_id_matches_the_first_entry_without_one() {
        let list = vec![json!({"id": "a"}), json!(5), json!({})];
        assert_eq!(find_index(&list, None).unwrap(), Some(1));
        assert_eq!(find_index(&list, Some(&json!("a"))).unwrap(), Some(0));
        let err = find_index(&[json!(null)], None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "Cannot read properties of null (reading 'id')"
        );
    }
}
