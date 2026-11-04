//! `lib/shared/file-types.ts`, the half server code imports (R06):
//! `BINARY_EXTS` and `isKnownBinaryPath`, which the Files API's GET uses to
//! answer a known binary format with the `binary: true` placeholder
//! instead of its text (CC 2.1.301). The preview helpers (`IMAGE_EXTS`,
//! `HTML_EXTS`, `getPreviewType`) are client-only. Replayed against the TS
//! through the route by `claudius-server/tests/workspace_files.rs`.

use crate::js_string;

/// `BINARY_EXTS`: extensions never shown as text. Text formats that only
/// look exotic (svg, csv, json, ipynb) aren't here.
pub const BINARY_EXTS: [&str; 70] = [
    // office / documents
    "xls", "xlsx", "xlsm", "xlsb", "doc", "docx", "docm", "ppt", "pptx", "pptm", "odt", "ods",
    "odp", "pdf", "epub", "mobi", // data
    "parquet", "orc", "avro", "feather", "arrow", "sqlite", "sqlite3", "db", "npy", "npz", "pkl",
    "pickle", "h5", "hdf5", // images the browser preview doesn't cover
    "heic", "heif", "psd", "raw", "cr2", "nef", "dng",
    // archives / executables / media / fonts
    "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "class", "wasm", "exe",
    "dll", "so", "dylib", "o", "a", "mp3", "mp4", "m4a", "mov", "avi", "mkv", "wav", "flac", "ogg",
    "webm", "woff", "woff2", "ttf", "otf", "eot",
];

/// `isKnownBinaryPath(path)`: the last segment (split on `/` *and* `\`)
/// has a dot after its first character, and what follows the last dot,
/// lowercased as JS `toLowerCase` does (the Kelvin sign is a `k`), is in
/// [`BINARY_EXTS`]. A dotfile (`.zip`) and a trailing dot (`a.`) are not.
pub fn is_known_binary_path(path: &str) -> bool {
    let base = path.rsplit(['/', '\\']).next().unwrap_or_default();
    match base.rfind('.') {
        None | Some(0) => false,
        Some(dot) => BINARY_EXTS.contains(&js_string::to_lower(&base[dot + 1..]).as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_binary_paths() {
        for yes in [
            "/w/a.zip",
            "/w/A.XLSM",
            "/w/x.tar.gz",
            "/w/clip.M\u{212a}V",
            "w\\x.parquet",
            "/w/q.txt\\x.heic",
            "a.o",
        ] {
            assert!(is_known_binary_path(yes), "{yes}");
        }
        for no in [
            "/w/.zip",
            "/w/a.",
            "/w/zip",
            "/w/a.zip/b",
            "/w/a.zip\\b",
            "/w/a.json",
            "/w/a.svg",
            "/w/a.Z\u{130}P",
            "",
            "/",
        ] {
            assert!(!is_known_binary_path(no), "{no}");
        }
        let mut sorted = BINARY_EXTS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), BINARY_EXTS.len(), "no duplicates");
    }
}
