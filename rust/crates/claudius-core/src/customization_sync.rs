//! "Sync from base": port of `lib/server/customization-sync.ts` (D14).
//! [`compute_sync_status`] classifies every path of the live source, the
//! mirror and the base manifest (the fork point); [`apply_safe_sync`] copies
//! the upstream-only changes into the mirror, removes the files upstream
//! deleted, re-bases the manifest and advances the record's `baseVersion`.
//!
//! Manifest values are what `JSON.parse` made of the file: a hash that isn't
//! a string never equals a file's hash, and the rebuilt manifest keeps any
//! truthy value as it was.

use std::collections::HashSet;

use anyhow::anyhow;
use claudius_agent::js;
use indexmap::IndexSet;
use serde_json::{Map, Value, json};

use crate::customization_manifest::{ensure_manifest, file_hash, file_keys, write_manifest};
use crate::customizations::{self, Store, claudius_version};
use crate::node_fs::{self, FsError};
use crate::{collate, node_path};

fn fs_error(e: FsError) -> anyhow::Error {
    anyhow!(e.message)
}

/// `SyncVerdict`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    InSync,
    UpstreamOnly,
    UserOnly,
    Conflict,
    NewUpstream,
    NewUser,
    DeletedUpstream,
    DeletedUser,
}

impl Verdict {
    /// Every verdict, in the order of the `totals` keys.
    pub const ALL: [Verdict; 8] = [
        Verdict::InSync,
        Verdict::UpstreamOnly,
        Verdict::UserOnly,
        Verdict::Conflict,
        Verdict::NewUpstream,
        Verdict::NewUser,
        Verdict::DeletedUpstream,
        Verdict::DeletedUser,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::InSync => "in-sync",
            Verdict::UpstreamOnly => "upstream-only",
            Verdict::UserOnly => "user-only",
            Verdict::Conflict => "conflict",
            Verdict::NewUpstream => "new-upstream",
            Verdict::NewUser => "new-user",
            Verdict::DeletedUpstream => "deleted-upstream",
            Verdict::DeletedUser => "deleted-user",
        }
    }

    /// `SAFE_VERDICTS`: what [`apply_safe_sync`] applies.
    fn is_safe(self) -> bool {
        matches!(
            self,
            Verdict::UpstreamOnly | Verdict::NewUpstream | Verdict::DeletedUpstream
        )
    }

    /// `USER_VERDICTS` (customization-description.ts): the user's own work.
    pub fn is_user(self) -> bool {
        matches!(
            self,
            Verdict::UserOnly | Verdict::NewUser | Verdict::Conflict | Verdict::DeletedUser
        )
    }
}

/// `SyncEntry`. `manifest_hash` is `manifest.files[path] ?? null`, any JSON
/// value.
#[derive(Clone, Debug, PartialEq)]
pub struct SyncEntry {
    pub path: String,
    pub verdict: Verdict,
    pub manifest_hash: Value,
    pub custom_hash: Option<String>,
    pub live_hash: Option<String>,
}

impl SyncEntry {
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "verdict": self.verdict.as_str(),
            "manifestHash": self.manifest_hash,
            "customHash": self.custom_hash,
            "liveHash": self.live_hash,
        })
    }
}

/// `SyncStatus`. `manifest_created_at` and `base_version` are `None` where
/// TS has `undefined` (the key is left out).
#[derive(Clone, Debug, PartialEq)]
pub struct SyncStatus {
    pub manifest_created_at: Option<Value>,
    pub base_version: Option<Value>,
    pub current_version: String,
    pub outdated: bool,
    pub entries: Vec<SyncEntry>,
}

impl SyncStatus {
    /// `totals[verdict]`.
    pub fn total(&self, v: Verdict) -> usize {
        self.entries.iter().filter(|e| e.verdict == v).count()
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        if let Some(at) = &self.manifest_created_at {
            out.insert("manifestCreatedAt".into(), at.clone());
        }
        if let Some(v) = &self.base_version {
            out.insert("baseVersion".into(), v.clone());
        }
        out.insert("currentVersion".into(), json!(self.current_version));
        out.insert("outdated".into(), json!(self.outdated));
        let totals: Map<String, Value> = Verdict::ALL
            .iter()
            .map(|v| (v.as_str().to_owned(), json!(self.total(*v))))
            .collect();
        out.insert("totals".into(), Value::Object(totals));
        let entries: Vec<Value> = self.entries.iter().map(SyncEntry::to_json).collect();
        out.insert("entries".into(), Value::Array(entries));
        Value::Object(out)
    }
}

/// `x === hash` for a manifest value and a file's hash (`null` for none).
fn same(manifest: &Value, hash: Option<&str>) -> bool {
    match hash {
        Some(h) => manifest.as_str() == Some(h),
        None => manifest.is_null(),
    }
}

/// `classify({manifestHash, customHash, liveHash})`, branch for branch.
pub fn classify(manifest: &Value, custom: Option<&str>, live: Option<&str>) -> Verdict {
    if custom.is_some() && custom == live {
        return Verdict::InSync;
    }
    if manifest.is_null() {
        return match (custom, live) {
            (None, Some(_)) => Verdict::NewUpstream,
            (Some(_), None) => Verdict::NewUser,
            (Some(c), Some(l)) if c == l => Verdict::InSync,
            (Some(_), Some(_)) => Verdict::Conflict,
            (None, None) => Verdict::InSync,
        };
    }
    match (custom, live) {
        (None, None) => Verdict::InSync,
        (None, Some(_)) => Verdict::DeletedUser,
        (Some(c), None) => {
            if same(manifest, Some(c)) {
                Verdict::DeletedUpstream
            } else {
                Verdict::Conflict
            }
        }
        (Some(c), Some(l)) => {
            let user_changed = !same(manifest, Some(c));
            let upstream_changed = !same(manifest, Some(l));
            match (user_changed, upstream_changed) {
                (false, false) => Verdict::InSync,
                (true, false) => Verdict::UserOnly,
                (false, true) => Verdict::UpstreamOnly,
                (true, true) if c == l => Verdict::InSync,
                (true, true) => Verdict::Conflict,
            }
        }
    }
}

/// `computeSyncStatus(id)` against the live source dir `live`: the manifest
/// (made from the mirror if there is none), the record's `baseVersion`, and
/// one entry per path of the live walk, then the mirror's, then the
/// manifest's keys, sorted by `localeCompare`. Any read error (but a
/// missing file) is the TS error.
pub fn compute_sync_status(store: &Store, live: &str, id: &str) -> anyhow::Result<SyncStatus> {
    let src = store.customization_src_dir(id);
    let manifest = ensure_manifest(store, id, &src)?;
    let record = store.get_customization(id)?;
    let base_version = record.as_ref().and_then(|r| r.get("baseVersion")).cloned();
    let live_files = customizations::list_source_files(live).map_err(fs_error)?;
    let custom_files = customizations::list_source_files(&src).map_err(fs_error)?;
    let files = manifest.get("files").cloned().unwrap_or(Value::Null);
    let live_set: HashSet<&str> = live_files.iter().map(String::as_str).collect();
    let custom_set: HashSet<&str> = custom_files.iter().map(String::as_str).collect();
    let mut all: IndexSet<String> = IndexSet::new();
    all.extend(live_files.iter().cloned());
    all.extend(custom_files.iter().cloned());
    all.extend(file_keys(&files));
    let hash_of = |root: &str, rel: &str, listed: bool| -> anyhow::Result<Option<String>> {
        if !listed {
            return Ok(None);
        }
        customizations::hash_file_or_null(&node_path::join(&[root, rel])).map_err(fs_error)
    };
    let mut entries = Vec::with_capacity(all.len());
    for rel in all {
        let manifest_hash = file_hash(&files, &rel);
        let live_hash = hash_of(live, &rel, live_set.contains(rel.as_str()))?;
        let custom_hash = hash_of(&src, &rel, custom_set.contains(rel.as_str()))?;
        let verdict = classify(&manifest_hash, custom_hash.as_deref(), live_hash.as_deref());
        entries.push(SyncEntry {
            path: rel,
            verdict,
            manifest_hash,
            custom_hash,
            live_hash,
        });
    }
    entries.sort_by(|a, b| collate::locale_compare(&a.path, &b.path));
    let current_version = claudius_version();
    let outdated = base_version
        .as_ref()
        .is_some_and(|v| !v.is_null() && v.as_str() != Some(current_version.as_str()));
    Ok(SyncStatus {
        manifest_created_at: manifest.get("createdAt").cloned(),
        base_version,
        current_version,
        outdated,
        entries,
    })
}

/// `SyncResult`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncResult {
    pub applied: usize,
    pub added: usize,
    pub deleted: usize,
    pub skipped_conflicts: usize,
    pub applied_paths: Vec<String>,
}

impl SyncResult {
    pub fn to_json(&self) -> Value {
        json!({
            "applied": self.applied,
            "added": self.added,
            "deleted": self.deleted,
            "skippedConflicts": self.skipped_conflicts,
            "appliedPaths": self.applied_paths,
        })
    }
}

/// `applySafeSync(id)`: each safe entry in status order, best-effort (a
/// failed copy or delete is skipped), then the re-based manifest (its write
/// error is the error) and `baseVersion` set to the running version (a
/// failed write ignored).
pub fn apply_safe_sync(store: &Store, live: &str, id: &str) -> anyhow::Result<SyncResult> {
    let src = store.customization_src_dir(id);
    let status = compute_sync_status(store, live, id)?;
    let mut result = SyncResult {
        skipped_conflicts: status.total(Verdict::Conflict),
        ..Default::default()
    };
    for entry in status.entries.iter().filter(|e| e.verdict.is_safe()) {
        let live_abs = node_path::join(&[live, &entry.path]);
        let custom_abs = node_path::join(&[&src, &entry.path]);
        if entry.verdict == Verdict::DeletedUpstream {
            if node_fs::rm_force(&custom_abs).is_ok() {
                result.deleted += 1;
                result.applied_paths.push(entry.path.clone());
            }
            continue;
        }
        let copied = node_fs::mkdir_recursive(&node_path::dirname(&custom_abs), 0o777)
            .and_then(|()| node_fs::copy_file(&live_abs, &custom_abs));
        if copied.is_ok() {
            if entry.verdict == Verdict::NewUpstream {
                result.added += 1;
            } else {
                result.applied += 1;
            }
            result.applied_paths.push(entry.path.clone());
        }
    }
    let next = rebuild_manifest_preserving_user_state(&status, store.now());
    write_manifest(store, id, &next).map_err(fs_error)?;
    let _ = store.update_customization_record(id, &json!({"baseVersion": claudius_version()}));
    Ok(result)
}

/// `rebuildManifestPreservingUserState(status)`: the live hash for the
/// files now equal to live, the old (truthy) manifest value for the user's
/// files and conflicts, nothing for the rest. A `__proto__` path sets the
/// prototype in TS, so it never becomes a key.
fn rebuild_manifest_preserving_user_state(status: &SyncStatus, now: i64) -> Value {
    let mut files = Map::new();
    for e in &status.entries {
        let value = match e.verdict {
            Verdict::InSync | Verdict::UpstreamOnly | Verdict::NewUpstream => e
                .live_hash
                .as_ref()
                .filter(|h| !h.is_empty())
                .map(|h| json!(h)),
            Verdict::UserOnly | Verdict::Conflict | Verdict::DeletedUser => {
                Some(e.manifest_hash.clone()).filter(js::truthy)
            }
            Verdict::DeletedUpstream | Verdict::NewUser => None,
        };
        if let Some(v) = value
            && e.path != "__proto__"
        {
            files.insert(e.path.clone(), v);
        }
    }
    json!({"version": 1, "createdAt": now, "files": files})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_follows_the_ts_branches() {
        let m = |s: &str| json!(s);
        let n = Value::Null;
        assert_eq!(classify(&n, Some("a"), Some("a")), Verdict::InSync);
        assert_eq!(classify(&n, None, Some("a")), Verdict::NewUpstream);
        assert_eq!(classify(&n, Some("a"), None), Verdict::NewUser);
        assert_eq!(classify(&n, Some("a"), Some("b")), Verdict::Conflict);
        assert_eq!(classify(&n, None, None), Verdict::InSync);
        assert_eq!(classify(&m("a"), None, None), Verdict::InSync);
        assert_eq!(classify(&m("a"), None, Some("a")), Verdict::DeletedUser);
        assert_eq!(classify(&m("a"), Some("a"), None), Verdict::DeletedUpstream);
        assert_eq!(classify(&m("a"), Some("b"), None), Verdict::Conflict);
        assert_eq!(classify(&m("a"), Some("b"), Some("a")), Verdict::UserOnly);
        assert_eq!(
            classify(&m("a"), Some("a"), Some("b")),
            Verdict::UpstreamOnly
        );
        assert_eq!(classify(&m("a"), Some("b"), Some("c")), Verdict::Conflict);
        // A hash that isn't a string never matches.
        assert_eq!(classify(&json!(5), Some("5"), Some("5")), Verdict::InSync);
        assert_eq!(classify(&json!(5), Some("5"), Some("6")), Verdict::Conflict);
        assert_eq!(classify(&json!(5), Some("5"), None), Verdict::Conflict);
    }
}
