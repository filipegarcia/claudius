//! `lib/server/asset-store.ts`: the content-addressed store of the images a
//! chat sends, under `~/.claude/projects/<encoded cwd>/assets/`: each file is
//! `<sha256[:2]>/<sha256>.<ext>`, the extension taken from the media type
//! it was sent with.
//!
//! Paths are the strings the TS builds (`path.join`). `EXT_BY_MEDIA` is a
//! plain object in TS, so the two lowercase names on `Object.prototype` are
//! "extensions" too: `constructor` gives `function Object() { [native code] }`
//! and `__proto__` gives `[object Object]` (both mirrored).
//!
//! Deliberate difference: TS joins whatever hash a database row holds into
//! the path, so a row another writer stored with `/` or `..` in its hash
//! reads and deletes files outside the store. Every fs call here checks,
//! right above it, that the path stays under `<root>/assets/`; one that
//! doesn't reads as missing and is never deleted.

use sha2::{Digest, Sha256};

use crate::node_fs::{self, FsError};
use crate::node_path;
use crate::paths;

/// `extFor(mediaType)`: `EXT_BY_MEDIA[mediaType.toLowerCase()] ?? "bin"`.
pub fn ext_for(media_type: &str) -> String {
    match media_type.to_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/heic" => "heic",
        "image/avif" => "avif",
        "application/pdf" => "pdf",
        // `Object.prototype` members, as a template literal prints them.
        "constructor" => "function Object() { [native code] }",
        "__proto__" => "[object Object]",
        _ => "bin",
    }
    .to_owned()
}

/// `sha256(buf)`: lowercase hex.
pub fn sha256_hex(buf: &[u8]) -> String {
    Sha256::digest(buf)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `projectRoot(cwd)` as a string: `assertWithin(<home>/.claude/projects,
/// encodeProjectDir(cwd))`, which refuses an empty `cwd`.
pub fn project_root(cwd: &str) -> Option<String> {
    let enc = paths::encode_project_dir(cwd);
    if enc.is_empty() {
        return None; // "invalid child path"
    }
    let home = paths::home_dir().to_string_lossy().into_owned();
    let base = node_path::join(&[&home, ".claude", "projects"]);
    Some(node_path::resolve(&[&base, &enc]))
}

/// `assetsDir(cwd)`.
pub fn assets_dir(cwd: &str) -> Option<String> {
    Some(node_path::join(&[&project_root(cwd)?, "assets"]))
}

/// `hash.slice(0, 2)`: the first two UTF-16 units. Half of an astral
/// character becomes U+FFFD, as Node writes a lone surrogate to a path.
fn shard(hash: &str) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in hash.chars() {
        if units >= 2 {
            break;
        }
        if units + c.len_utf16() > 2 {
            out.push('\u{FFFD}');
            break;
        }
        out.push(c);
        units += c.len_utf16();
    }
    out
}

/// `assetPath(cwd, hash, mediaType)`.
pub fn asset_path(cwd: &str, hash: &str, media_type: &str) -> Option<String> {
    let dir = assets_dir(cwd)?;
    Some(node_path::join(&[
        &dir,
        &shard(hash),
        &format!("{hash}.{}", ext_for(media_type)),
    ]))
}

/// `writeIfAbsent`'s result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub hash: String,
    pub path: String,
    pub bytes: usize,
    /// The file wasn't there before (or a racing writer made it first).
    pub created: bool,
}

/// `writeIfAbsent(cwd, buf, mediaType)`: an existing path (anything that
/// `access` sees: a file, a folder, a symlink to one) is kept; otherwise
/// the shard folder is made and the bytes written with `wx` (`EEXIST`, a
/// racing writer or a dangling symlink, is fine).
pub fn write_if_absent(cwd: &str, buf: &[u8], media_type: &str) -> Result<Written, FsError> {
    let hash = sha256_hex(buf);
    // `projectRoot` refuses a cwd that encodes to nothing.
    let dir = assets_dir(cwd).ok_or_else(|| FsError {
        code: None,
        message: "invalid child path".into(),
    })?;
    let path = asset_path(cwd, &hash, media_type).ok_or_else(|| FsError {
        code: None,
        message: "invalid child path".into(),
    })?;
    let invalid = || FsError {
        code: None,
        message: "path escapes base directory".into(),
    };
    let under = format!("{dir}/");
    let done = |created| Written {
        hash: hash.clone(),
        path: path.clone(),
        bytes: buf.len(),
        created,
    };
    if !path.starts_with(&under) {
        return Err(invalid());
    }
    if std::fs::metadata(&path).is_ok() {
        return Ok(done(false));
    }
    let shard_dir = node_path::join(&[&dir, &shard(&hash)]);
    if !shard_dir.starts_with(&under) {
        return Err(invalid());
    }
    node_fs::mkdir_recursive(&shard_dir, 0o777)?;
    if !path.starts_with(&under) {
        return Err(invalid());
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path);
    match file {
        Ok(mut f) => {
            use std::io::Write;
            f.write_all(buf)
                .map_err(|e| FsError::new(&e, "write", None, None))?;
        }
        Err(e) if node_fs::code(&e).as_deref() == Some("EEXIST") => {}
        Err(e) => return Err(FsError::new(&e, "open", Some(&path), None)),
    }
    Ok(done(true))
}

/// `readAsset(cwd, hash, mediaType)`: the bytes, or `None` on any error.
pub fn read_asset(cwd: &str, hash: &str, media_type: &str) -> Option<Vec<u8>> {
    let dir = assets_dir(cwd)?;
    let path = asset_path(cwd, hash, media_type)?;
    if !path.starts_with(&format!("{dir}/")) {
        return None;
    }
    std::fs::read(&path).ok()
}

/// `deleteAsset(cwd, hash, mediaType)`: `Ok(false)` when there was nothing
/// to unlink (and for a path that would leave the store).
pub fn delete_asset(cwd: &str, hash: &str, media_type: &str) -> Result<bool, FsError> {
    let (Some(dir), Some(path)) = (assets_dir(cwd), asset_path(cwd, hash, media_type)) else {
        return Err(FsError {
            code: None,
            message: "invalid child path".into(),
        });
    };
    if !path.starts_with(&format!("{dir}/")) {
        return Ok(false);
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if node_fs::code(&e).as_deref() == Some("ENOENT") => Ok(false),
        Err(e) => Err(FsError::new(&e, "unlink", Some(&path), None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_and_shard() {
        assert_eq!(ext_for("IMAGE/PNG"), "png");
        assert_eq!(ext_for("image/x-icon"), "bin");
        assert_eq!(
            ext_for("Constructor"),
            "function Object() { [native code] }"
        );
        assert_eq!(shard("abcdef"), "ab");
        assert_eq!(shard("a\u{1F600}"), "a\u{FFFD}");
        assert_eq!(shard("\u{1F600}x"), "\u{1F600}");
        assert_eq!(shard(""), "");
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
