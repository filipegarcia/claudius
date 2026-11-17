//! Creating a customization: port of `lib/server/customization-bootstrap.ts`
//! (D14). [`bootstrap_customization`] registers the record, mirrors the
//! live source into `<root>/<id>/src/`, snapshots the fork point
//! ([`crate::customization_manifest`]) and hard-links the live
//! `node_modules` into the mirror ([`ensure_node_modules_mirror`], which the
//! preview server reuses). A failure after the record exists removes the
//! record and the customization dir again, then reports the error.
//!
//! Walks follow `fs.readdir(…, { withFileTypes: true })`: names in raw-byte
//! order, each typed as the entry itself (a symlink is never followed by the
//! mirror copy). Errors carry Node's messages.

use anyhow::{anyhow, bail};
use serde_json::Value;

use crate::customization_manifest::{build_manifest_from_tree, write_manifest};
use crate::customizations::Store;
use crate::node_fs::{self, FsError};
use crate::node_path;

/// `SKIP_DIRS`: never copied into a mirror, at any depth.
pub const SKIP_DIRS: [&str; 13] = [
    "node_modules",
    ".next",
    ".next-e2e",
    ".git",
    ".turbo",
    ".cache",
    "dist",
    "out",
    "playwright-report",
    "test-results",
    ".vercel",
    "release",
    "dist-electron",
];

/// `SKIP_FILES`.
const SKIP_FILES: [&str; 2] = [".DS_Store", "scheduled_tasks.lock"];

fn fs_error(e: FsError) -> anyhow::Error {
    anyhow!(e.message)
}

fn readdir(dir: &str) -> Result<Vec<(String, std::fs::FileType)>, FsError> {
    node_fs::readdir_dirents(dir).map_err(|e| FsError::new(&e, "scandir", Some(dir), None))
}

/// What `bootstrapCustomization` resolves.
#[derive(Clone, Debug)]
pub struct Bootstrapped {
    /// The new record, as stored.
    pub customization: Value,
    pub files_copied: usize,
    pub src_dir: String,
}

/// `bootstrapCustomization({name})` against the live source dir `live`.
pub fn bootstrap_customization(
    store: &Store,
    live: &str,
    name: &str,
) -> anyhow::Result<Bootstrapped> {
    let cust = store.create_customization_record(name)?;
    let id = cust["id"]
        .as_str()
        .expect("a created record has a string id")
        .to_owned();
    let dst = store.customization_src_dir(&id);
    match mirror(store, live, &id, &dst) {
        Ok(files_copied) => Ok(Bootstrapped {
            customization: cust,
            files_copied,
            src_dir: dst,
        }),
        Err(e) => {
            // Roll back, best-effort, then report the original error.
            let _ = store.delete_customization_record(&id);
            let _ = store.remove_customization_dir(&id);
            Err(e)
        }
    }
}

/// Everything after the record: the overlap check, the copy, the manifest
/// and the `node_modules` mirror.
fn mirror(store: &Store, live: &str, id: &str, dst: &str) -> anyhow::Result<usize> {
    let rel = node_path::relative(live, dst);
    if !rel.starts_with("..") && !rel.is_empty() {
        bail!("refusing to bootstrap: mirror dir {dst} is inside live source {live}");
    }
    node_fs::mkdir_recursive(dst, 0o777).map_err(fs_error)?;
    let copied = copy_tree(live, dst).map_err(fs_error)?;
    let manifest = build_manifest_from_tree(dst, store.now()).map_err(fs_error)?;
    write_manifest(store, id, &manifest).map_err(fs_error)?;
    ensure_node_modules_mirror(live, dst).map_err(fs_error)?;
    Ok(copied)
}

/// `copyTree(srcRoot, dstRoot)`: a stack walk (last pushed first) that makes
/// each dir under `dst_root` and copies the regular files (a clone where
/// the file system can), skipping [`SKIP_DIRS`], `SKIP_FILES` and symlinks.
/// The number of files copied.
fn copy_tree(src_root: &str, dst_root: &str) -> Result<usize, FsError> {
    let mut count = 0;
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let src_dir = node_path::join(&[src_root, &rel]);
        let dst_dir = node_path::join(&[dst_root, &rel]);
        node_fs::mkdir_recursive(&dst_dir, 0o777)?;
        for (name, kind) in readdir(&src_dir)? {
            if kind.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(node_path::join(&[&rel, &name]));
                }
            } else if kind.is_file() && !SKIP_FILES.contains(&name.as_str()) {
                node_fs::copy_file(
                    &node_path::join(&[&src_dir, &name]),
                    &node_path::join(&[&dst_dir, &name]),
                )?;
                count += 1;
            }
        }
    }
    Ok(count)
}

/// `ensureNodeModulesMirror(srcDir)`: `<src_dir>/node_modules` as an
/// in-tree copy of `<live>/node_modules`, files hard-linked and symlinks
/// recreated with their targets as they are. A symlink there (an older
/// bootstrap's) is replaced; a directory there is taken as done; without a
/// live `node_modules` there is nothing to do.
pub fn ensure_node_modules_mirror(live: &str, src_dir: &str) -> Result<(), FsError> {
    let live_nm = node_path::join(&[live, "node_modules"]);
    let dst_nm = node_path::join(&[src_dir, "node_modules"]);
    match std::fs::symlink_metadata(&dst_nm) {
        Ok(st) if st.file_type().is_symlink() => {
            if let Err(e) = std::fs::remove_file(&dst_nm) {
                let e = FsError::new(&e, "unlink", Some(&dst_nm), None);
                if !e.is_not_found() {
                    return Err(e);
                }
            }
        }
        Ok(st) if st.is_dir() => return Ok(()),
        Ok(_) => {}
        Err(e) => {
            let e = FsError::new(&e, "lstat", Some(&dst_nm), None);
            if !e.is_not_found() {
                return Err(e);
            }
        }
    }
    if node_fs::access(&live_nm, node_fs::F_OK).is_err() {
        return Ok(());
    }
    hardlink_tree(&live_nm, &dst_nm)
}

/// `hardlinkTree(src, dst)`, depth first: symlinks recreated (an existing or
/// refused one skipped), files hard-linked (an existing one skipped; else
/// copied, and a failed copy skipped). Only the dirs' `mkdir` / `readdir`
/// errors stop it.
fn hardlink_tree(src: &str, dst: &str) -> Result<(), FsError> {
    node_fs::mkdir_recursive(dst, 0o777)?;
    for (name, kind) in readdir(src)? {
        let s = node_path::join(&[src, &name]);
        let d = node_path::join(&[dst, &name]);
        if kind.is_symlink() {
            // `fs.readlink` hands the target back as a (lossy) UTF-8 string.
            if let Ok(target) = std::fs::read_link(&s) {
                let _ = node_fs::symlink(&target.to_string_lossy(), &d);
            }
        } else if kind.is_dir() {
            hardlink_tree(&s, &d)?;
        } else if kind.is_file()
            && let Err(e) = std::fs::hard_link(&s, &d)
            && node_fs::code(&e).as_deref() != Some("EEXIST")
        {
            let _ = node_fs::copy_file(&s, &d);
        }
    }
    Ok(())
}

/// `Customization ${new Date().toISOString().slice(0, 10)}`: the name
/// `POST /api/customizations` falls back to, in UTC.
pub fn fallback_name(now: i64) -> String {
    let day = chrono::DateTime::from_timestamp_millis(now)
        .unwrap_or_default()
        .format("%Y-%m-%d");
    format!("Customization {day}")
}
