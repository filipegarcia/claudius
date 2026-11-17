//! Publishing a customization into the live source: port of
//! `publishCustomization` (`lib/server/customization-publish.ts`, D14;
//! `computeDiff` is [`Store::compute_diff`], D13).
//!
//! The base files a publish overwrites are copied to
//! `<root>/<id>/.publishes/<pubId>/snapshot/` first (any failure stops it
//! before the live tree is touched), then the changed and added files are
//! copied over the live source, the live tree is hashed (the upgrade check's
//! `baseHash`), and the publish is written to its `manifest.json` and to
//! the index.

use anyhow::{anyhow, bail};
use serde_json::{Value, json};

use crate::customizations::{DiffError, Store, hash_tree};
use crate::node_fs::{self, FsError};
use crate::{js_string, node_path};

fn fs_error(e: FsError) -> anyhow::Error {
    anyhow!(e.message)
}

/// `copyFile` (the module's): `mkdir -p` the parent, then copy.
fn copy_into(src: &str, dst: &str) -> Result<(), FsError> {
    node_fs::mkdir_recursive(&node_path::dirname(dst), 0o777)?;
    node_fs::copy_file(src, dst)
}

/// `computeDiff`'s error as TS throws it.
pub fn diff_error(e: DiffError) -> anyhow::Error {
    match e {
        DiffError::Fs(e) => fs_error(e),
        DiffError::Outside => anyhow!("path outside allowed root"),
    }
}

/// `publishCustomization(id)` into the live source dir `live`: the
/// `PublishRecord` it stored.
pub fn publish_customization(store: &Store, live: &str, id: &str) -> anyhow::Result<Value> {
    let src = store.customization_src_dir(id);
    let diff = store.compute_diff(id, live).map_err(diff_error)?;
    let count = |k: &str| diff[k].as_u64().unwrap_or(0);
    if count("changedFiles") + count("addedFiles") == 0 {
        bail!("nothing to publish");
    }
    let files = diff["files"].as_array().cloned().unwrap_or_default();
    let path_of = |f: &Value| f["path"].as_str().unwrap_or_default().to_owned();
    let publish_id = store.new_publish_id();
    let pub_root = node_path::join(&[&store.customization_publishes_dir(id), &publish_id]);
    let snapshot_root = node_path::join(&[&pub_root, "snapshot"]);
    node_fs::mkdir_recursive(&snapshot_root, 0o777).map_err(fs_error)?;
    for f in files.iter().filter(|f| f["kind"] != "added") {
        let rel = path_of(f);
        copy_into(
            &node_path::join(&[live, &rel]),
            &node_path::join(&[&snapshot_root, &rel]),
        )
        .map_err(fs_error)?;
    }
    let mut applied = Vec::with_capacity(files.len());
    for f in &files {
        let rel = path_of(f);
        copy_into(
            &node_path::join(&[&src, &rel]),
            &node_path::join(&[live, &rel]),
        )
        .map_err(fs_error)?;
        applied
            .push(json!({"path": rel, "baseHash": f["baseHash"], "customHash": f["customHash"]}));
    }
    let base_hash = hash_tree(live).map_err(fs_error)?;
    let published_at = store.now();
    let manifest = json!({
        "publishId": publish_id,
        "customizationId": id,
        "publishedAt": published_at,
        "files": applied,
        "baseHashAfterPublish": base_hash,
    });
    node_fs::write_file(
        &node_path::join(&[&pub_root, "manifest.json"]),
        &(js_string::stringify_pretty(&manifest) + "\n"),
        0o666,
    )
    .map_err(fs_error)?;
    let rec = json!({
        "id": publish_id,
        "customizationId": id,
        "publishedAt": published_at,
        "revertedAt": null,
        "baseHash": base_hash,
        "files": applied,
        "snapshotDir": snapshot_root,
    });
    store.record_publish(&rec)?;
    Ok(rec)
}
