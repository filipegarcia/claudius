/**
 * File-type detection helpers used by both the chat preview components and
 * the file browser page.
 */

export const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif", "tiff", "tif",
]);

export const HTML_EXTS = new Set(["html", "htm"]);

export type PreviewType = "image" | "html";

/** Returns the preview type for a file path, or null if not previewable. */
export function getPreviewType(path: string): PreviewType | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (HTML_EXTS.has(ext)) return "html";
  return null;
}

/**
 * CC 2.1.301 ("Fixed the Read tool reading binary files such as .xlsm,
 * .parquet, .epub and .heic as text"). The Files viewer's NUL-byte sniff
 * (`detectTextEncoding`) catches most binaries, but a tiny or oddly-packed
 * container can slip past it; these extensions are never shown as text.
 * Text-based formats that merely look exotic (svg, csv, json, ipynb) are
 * deliberately absent.
 */
export const BINARY_EXTS = new Set([
  // office / documents
  "xls", "xlsx", "xlsm", "xlsb", "doc", "docx", "docm", "ppt", "pptx", "pptm", "odt", "ods", "odp", "pdf", "epub", "mobi",
  // data
  "parquet", "orc", "avro", "feather", "arrow", "sqlite", "sqlite3", "db", "npy", "npz", "pkl", "pickle", "h5", "hdf5",
  // images the browser preview doesn't cover
  "heic", "heif", "psd", "raw", "cr2", "nef", "dng",
  // archives / executables / media / fonts
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "class", "wasm", "exe", "dll", "so", "dylib", "o", "a",
  "mp3", "mp4", "m4a", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm", "woff", "woff2", "ttf", "otf", "eot",
]);

/** True when `path`'s extension marks it as a binary format. */
export function isKnownBinaryPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTS.has(base.slice(dot + 1).toLowerCase());
}
