/**
 * CC 2.1.299 parity — "Fixed Read garbling UTF-16LE files with a byte-order
 * mark, and Write dropping byte-order marks or silently converting
 * Windows-1252, Shift-JIS, GBK or UTF-16BE files to UTF-8 (now refused)".
 *
 * Claudius's own editors (the /files browser and the /git FileEditor) round-
 * trip file text through `GET/PUT /api/workspaces/:id/files`. That route used
 * to `readFile(…, "utf8")` and `writeFile(…, "utf8")` unconditionally, so a
 * UTF-8 BOM was dropped on save, a UTF-16LE file opened as mojibake and saved
 * back as U+FFFD soup, and a Windows-1252 `é` became U+FFFD.
 *
 * This module is the pure, browser-safe half of the fix: sniff which encoding
 * a byte buffer is in, decode it to a JS string, and re-encode an edited
 * string back into the *same* encoding. Only encodings we can round-trip
 * losslessly are `editable`; everything else is reported `unsupported` so the
 * server refuses to save it (that would silently convert it to UTF-8).
 *
 * Only `Uint8Array` / `TextDecoder` / `TextEncoder` — no Node `Buffer` — so it
 * runs on either side (a Node `Buffer` is a `Uint8Array`, so the route passes
 * one straight in).
 */

/** Encodings Claudius can decode, edit and write back byte-for-byte. */
export type EditableTextEncoding = "utf-8" | "utf-8-bom" | "utf-16le";

export type TextEncodingKind = EditableTextEncoding | "unsupported";

/**
 * What an `unsupported` buffer most likely is. Only used to word the read-only
 * notice and pick a best-effort preview decode — never to write.
 */
export type UnsupportedTextGuess = "utf-16be" | "utf-32" | "binary" | "legacy";

export type DetectedTextEncoding =
  | { encoding: EditableTextEncoding; editable: true; label: string }
  | {
      encoding: "unsupported";
      editable: false;
      guess: UnsupportedTextGuess;
      /** Short human label for the encoding, e.g. "UTF-16BE". */
      label: string;
      /** One-sentence explanation suitable for a read-only banner. */
      reason: string;
    };

/** Bytes inspected for a NUL when deciding "looks binary" (matches the files route's content-search probe). */
const BINARY_PROBE_BYTES = 8 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

// `ignoreBOM: true` everywhere: we slice the BOM off ourselves, and the
// default (`ignoreBOM: false`) would silently eat a *second* U+FEFF that is
// genuinely part of the text — breaking the round trip.
function decodeStrict(label: "utf-8" | "utf-16le", bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function unsupported(guess: UnsupportedTextGuess): DetectedTextEncoding {
  switch (guess) {
    case "utf-16be":
      return {
        encoding: "unsupported",
        editable: false,
        guess,
        label: "UTF-16BE",
        reason: "Read-only: this file's encoding (UTF-16BE) isn't UTF-8 or UTF-16LE, and saving would convert it.",
      };
    case "utf-32":
      return {
        encoding: "unsupported",
        editable: false,
        guess,
        label: "UTF-32",
        reason: "Read-only: this file's encoding (UTF-32) isn't UTF-8 or UTF-16LE, and saving would convert it.",
      };
    case "binary":
      return {
        encoding: "unsupported",
        editable: false,
        guess,
        label: "binary",
        reason: "Read-only: this file looks binary (it contains NUL bytes), and saving it as text would corrupt it.",
      };
    case "legacy":
      return {
        encoding: "unsupported",
        editable: false,
        guess,
        label: "non-UTF-8",
        reason:
          "Read-only: this file's encoding (likely Windows-1252, Shift-JIS or GBK) isn't UTF-8, and saving would convert it.",
      };
  }
}

/**
 * Sniff the encoding of `bytes`. Order matters:
 *  1. BOM — EF BB BF (UTF-8), FF FE 00 00 (UTF-32LE), FF FE (UTF-16LE),
 *     FE FF (UTF-16BE), 00 00 FE FF (UTF-32BE). A UTF-16LE file legitimately
 *     contains NULs, so the BOM check must run before the binary probe.
 *  2. NUL probe — no BOM and a NUL in the first 8 KB → binary (BOM-less
 *     UTF-16 lands here too: we can't tell its byte order reliably).
 *  3. Fatal UTF-8 decode — anything that isn't valid UTF-8 is a legacy code
 *     page (Windows-1252, Shift-JIS, GBK, …) we refuse to round-trip.
 */
export function detectTextEncoding(bytes: Uint8Array): DetectedTextEncoding {
  if (startsWith(bytes, UTF8_BOM)) {
    return decodeStrict("utf-8", bytes.subarray(3)) != null
      ? { encoding: "utf-8-bom", editable: true, label: "UTF-8 with BOM" }
      : unsupported("legacy");
  }
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) || startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) {
    return unsupported("utf-32");
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return decodeStrict("utf-16le", bytes.subarray(2)) != null
      ? { encoding: "utf-16le", editable: true, label: "UTF-16LE" }
      : unsupported("binary");
  }
  if (startsWith(bytes, [0xfe, 0xff])) return unsupported("utf-16be");
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return unsupported("binary");
  return decodeStrict("utf-8", bytes) != null
    ? { encoding: "utf-8", editable: true, label: "UTF-8" }
    : unsupported("legacy");
}

/**
 * Decode `bytes` (already sniffed as `encoding`) to the editor string. The
 * BOM, if any, is stripped from the string — it's reported via `encoding` and
 * re-added by `encodeText`. Throws if the bytes don't actually decode.
 */
export function decodeText(bytes: Uint8Array, encoding: EditableTextEncoding): string {
  const out =
    encoding === "utf-8"
      ? decodeStrict("utf-8", bytes)
      : encoding === "utf-8-bom"
        ? decodeStrict("utf-8", startsWith(bytes, UTF8_BOM) ? bytes.subarray(3) : bytes)
        : decodeStrict("utf-16le", startsWith(bytes, [0xff, 0xfe]) ? bytes.subarray(2) : bytes);
  if (out == null) throw new Error(`bytes are not valid ${encoding}`);
  return out;
}

/** Encode an edited string back into `encoding`, BOM included where the original had one. */
export function encodeText(text: string, encoding: EditableTextEncoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  if (encoding === "utf-8-bom") {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.length + 3);
    out.set(UTF8_BOM, 0);
    out.set(body, 3);
    return out;
  }
  // UTF-16LE: there's no TextEncoder for it, so write the code units by hand
  // (lone surrogates pass through unchanged, which is what UTF-16 means).
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    out[2 + i * 2] = u & 0xff;
    out[3 + i * 2] = u >> 8;
  }
  return out;
}

/**
 * Best-effort, lossy decode for showing an `unsupported` file read-only.
 * UTF-16BE is byte-swapped and decoded properly; a legacy code page is shown
 * as Windows-1252 (the commonest case — Shift-JIS/GBK will look garbled, but
 * the file can't be saved, so nothing is lost). Never used on the write path.
 */
export function decodePreview(bytes: Uint8Array, guess: UnsupportedTextGuess): string {
  if (guess === "utf-16be") {
    const body = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1));
    const swapped = new Uint8Array(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return new TextDecoder("utf-16le", { ignoreBOM: true }).decode(swapped);
  }
  if (guess === "legacy") {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      // Small-ICU builds don't ship windows-1252 — fall back to latin1, which
      // agrees with it everywhere outside 0x80–0x9F.
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
