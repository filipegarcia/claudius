/**
 * CC 2.1.265 — when an oversized image is dropped/pasted/picked, Claude Code
 * surfaces an error naming the cause. Claudius's intake silently dropped images
 * over its limit. This builds the user-facing notice (null when nothing was
 * over the limit). Pure, for unit tests; the byte check stays at the call site
 * where the `File` is.
 */
export function describeOversizedImages(names: string[], limitBytes: number): string | null {
  if (names.length === 0) return null;
  const limitMb = Math.round(limitBytes / (1024 * 1024));
  if (names.length === 1) {
    return `“${names[0]}” is too large to attach (max ${limitMb} MB).`;
  }
  return `${names.length} images are too large to attach (max ${limitMb} MB): ${names.join(", ")}`;
}
