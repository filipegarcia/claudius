//! The disk side of `app/api/workspaces/[id]/files/preview/[...path]/route.ts`
//! (D03c): the path-based file server behind the HTML preview iframes, so a
//! page's relative `href`s resolve to its neighbours. The route is
//! `claudius-server`'s `files_preview`.
//!
//! The request path is normalized, its leading slashes dropped, and
//! resolved under the workspace root; it must start with `root + "/"` (so
//! the root itself, and everything under a root of `/`, is refused) and
//! pass [`workspace_files::inside`] (a first segment starting with `..`,
//! such as `..foo` or `...`, is refused too). The file is opened
//! `O_RDONLY | O_NONBLOCK` (a FIFO doesn't block), checked through that one
//! handle (only a regular file, at most [`MAX_PREVIEW_BYTES`]) and read
//! through it. Containment is lexical and the open follows symlinks, as in
//! TS (PORT_PLAN "Mirrored TS bugs", T08a).
//!
//! The content type comes from the request path's last `.`-piece, lowercased
//! as JS does, looked up in the route's `MIME` object: `constructor` and
//! `__proto__` find `Object.prototype`'s, which the header prints as
//! `String()` does. Deliberate difference: an empty file is served empty.
//! TS hands `Blob` the 64 KiB scratch `ArrayBuffer` Node's `readFile` read
//! it into (uninitialized memory) and serves that. Replayed against the TS
//! in `claudius-server/tests/files_preview.rs`
//! (`rust/scripts/files-preview-golden.mjs`).

use std::io::Read;

use crate::{js_string, node_path, workspace_files};

/// `MAX_PREVIEW_BYTES`: the CLI's Read cap for image sources (CC 2.1.302).
pub const MAX_PREVIEW_BYTES: u64 = 128 * 1024 * 1024;

/// What the route answers for a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Preview {
    /// 403 `path escapes workspace root`.
    Escapes,
    /// 404 `not found`: the open, the `fstat` or the read failed.
    NotFound,
    /// 404 `not a file`: a folder, FIFO, device or socket.
    NotAFile,
    /// 413 `file too large to preview (>128 MB)`.
    TooLarge,
    /// The file's bytes.
    File(Vec<u8>),
}

/// `MIME[relPath.split(".").pop().toLowerCase()] ?? "application/octet-stream"`.
pub fn content_type(rel_path: &str) -> &'static str {
    let ext = js_string::to_lower(rel_path.rsplit('.').next().unwrap_or_default());
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "jsonc" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        // `Object.prototype.constructor` / `Object.prototype` itself.
        "constructor" => "function Object() { [native code] }",
        "__proto__" => "[object Object]",
        _ => "application/octet-stream",
    }
}

/// The route below its root lookup: `rel_path` is the catch-all's segments
/// joined with `/`, `root` the resolved workspace root (lone surrogates as
/// [`js_string`] stand-ins, opened as U+FFFD as Node opens them).
pub fn read(root: &str, rel_path: &str) -> Preview {
    let rel = workspace_files::rel_path(rel_path);
    let target = node_path::resolve(&[root, &rel]);
    if !target.starts_with(&format!("{root}/")) {
        return Preview::Escapes;
    }
    if !workspace_files::inside(root, &target) {
        return Preview::Escapes;
    }
    // `fs.open(target, O_RDONLY | O_NONBLOCK)`.
    #[cfg(unix)]
    let opened = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(js_string::lossy(&target).as_ref())
    };
    #[cfg(not(unix))]
    let opened = std::fs::File::open(js_string::lossy(&target).as_ref());
    let Ok(mut file) = opened else {
        return Preview::NotFound;
    };
    let Ok(meta) = file.metadata() else {
        return Preview::NotFound;
    };
    if !meta.is_file() {
        return Preview::NotAFile;
    }
    if meta.len() > MAX_PREVIEW_BYTES {
        return Preview::TooLarge;
    }
    // `fh.readFile()`: `size` bytes, or to the end when `fstat` says 0.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    let read = if meta.len() == 0 {
        file.read_to_end(&mut bytes)
    } else {
        (&mut file).take(meta.len()).read_to_end(&mut bytes)
    };
    match read {
        Ok(_) => Preview::File(bytes),
        Err(_) => Preview::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_reads_the_last_dot_piece() {
        assert_eq!(content_type("site/index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("A.HTM"), "text/html; charset=utf-8");
        assert_eq!(content_type("html"), "text/html; charset=utf-8");
        assert_eq!(content_type("dir.css/file"), "application/octet-stream");
        assert_eq!(content_type("x."), "application/octet-stream");
        assert_eq!(
            content_type("x.Constructor"),
            "function Object() { [native code] }"
        );
        assert_eq!(content_type("x.__proto__"), "[object Object]");
        assert_eq!(content_type("x.toString"), "application/octet-stream");
    }

    #[test]
    fn the_root_and_its_escapes_are_refused() {
        assert_eq!(read("/r", "."), Preview::Escapes);
        assert_eq!(read("/r", "../x"), Preview::Escapes);
        assert_eq!(read("/r", "..foo"), Preview::Escapes);
        assert_eq!(read("/r", ".../x"), Preview::Escapes);
        assert_eq!(read("/", "etc/hosts"), Preview::Escapes);
        assert_eq!(read("/r", "a/../../x"), Preview::Escapes);
        // An absolute path can't climb above `/`: `/a/../../x` is `x`.
        assert_eq!(read("/nonexistent-root", "/a/../../x"), Preview::NotFound);
    }
}
