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
