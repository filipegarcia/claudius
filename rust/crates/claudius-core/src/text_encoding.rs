//! `lib/shared/text-encoding.ts`: sniff which encoding a file's bytes are
//! in, decode them for the editor, and encode an edited string back into
//! the same encoding (the Files API's GET and PUT, D03).
//!
//! Only UTF-8, UTF-8 with a BOM and UTF-16LE (with its BOM) are editable,
//! the encodings that round-trip byte for byte. Anything else is
//! `unsupported` with a guess (UTF-16BE, UTF-32, binary, a legacy code
//! page) that words the read-only notice and picks a lossy preview decode.
//! Decoded text is always well formed (the decodes are fatal, or put U+FFFD
//! in), so it is a plain `String`; text to encode is UTF-16 code units,
//! which can hold a lone surrogate. Replayed against the TS by
//! `tests/workspace_files_golden.rs` (`pure`).

/// Bytes inspected for a NUL when deciding "looks binary".
const BINARY_PROBE_BYTES: usize = 8 * 1024;

const UTF8_BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

/// An encoding Claudius can decode, edit and write back byte for byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Editable {
    Utf8,
    Utf8Bom,
    Utf16Le,
}

impl Editable {
    /// The TS name (`"utf-8"`, `"utf-8-bom"`, `"utf-16le"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Editable::Utf8 => "utf-8",
            Editable::Utf8Bom => "utf-8-bom",
            Editable::Utf16Le => "utf-16le",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Editable::Utf8 => "UTF-8",
            Editable::Utf8Bom => "UTF-8 with BOM",
            Editable::Utf16Le => "UTF-16LE",
        }
    }
}

/// What an `unsupported` buffer most likely is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Guess {
    Utf16Be,
    Utf32,
    Binary,
    Legacy,
}

impl Guess {
    pub fn as_str(self) -> &'static str {
        match self {
            Guess::Utf16Be => "utf-16be",
            Guess::Utf32 => "utf-32",
            Guess::Binary => "binary",
            Guess::Legacy => "legacy",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Guess::Utf16Be => "UTF-16BE",
            Guess::Utf32 => "UTF-32",
            Guess::Binary => "binary",
            Guess::Legacy => "non-UTF-8",
        }
    }

    /// The read-only banner's sentence.
    pub fn reason(self) -> &'static str {
        match self {
            Guess::Utf16Be => {
                "Read-only: this file's encoding (UTF-16BE) isn't UTF-8 or UTF-16LE, and saving would convert it."
            }
            Guess::Utf32 => {
                "Read-only: this file's encoding (UTF-32) isn't UTF-8 or UTF-16LE, and saving would convert it."
            }
            Guess::Binary => {
                "Read-only: this file looks binary (it contains NUL bytes), and saving it as text would corrupt it."
            }
            Guess::Legacy => {
                "Read-only: this file's encoding (likely Windows-1252, Shift-JIS or GBK) isn't UTF-8, and saving would convert it."
            }
        }
    }
}

/// `DetectedTextEncoding`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detected {
    Editable(Editable),
    Unsupported(Guess),
}

impl Detected {
    /// `detected.encoding` (`"unsupported"` for a guess).
    pub fn encoding(self) -> &'static str {
        match self {
            Detected::Editable(e) => e.as_str(),
            Detected::Unsupported(_) => "unsupported",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Detected::Editable(e) => e.label(),
            Detected::Unsupported(g) => g.label(),
        }
    }
}

/// `new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes)`.
fn decode_strict_utf8(bytes: &[u8]) -> Option<String> {
    std::str::from_utf8(bytes).ok().map(str::to_owned)
}

/// The fatal UTF-16LE decode: an odd length or a lone surrogate fails.
fn decode_strict_utf16le(bytes: &[u8]) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    char::decode_utf16(utf16le_units(bytes))
        .collect::<Result<String, _>>()
        .ok()
}

fn utf16le_units(bytes: &[u8]) -> impl Iterator<Item = u16> + '_ {
    bytes
        .chunks_exact(2)
        .map(|p| u16::from_le_bytes([p[0], p[1]]))
}

/// `detectTextEncoding(bytes)`: a BOM first (UTF-8, UTF-32 either way,
/// UTF-16LE, UTF-16BE), then a NUL in the first 8 KiB (binary), then a
/// fatal UTF-8 decode (else a legacy code page).
pub fn detect(bytes: &[u8]) -> Detected {
    if bytes.starts_with(&UTF8_BOM) {
        return if decode_strict_utf8(&bytes[3..]).is_some() {
            Detected::Editable(Editable::Utf8Bom)
        } else {
            Detected::Unsupported(Guess::Legacy)
        };
    }
    if bytes.starts_with(&[0xff, 0xfe, 0x00, 0x00]) || bytes.starts_with(&[0x00, 0x00, 0xfe, 0xff])
    {
        return Detected::Unsupported(Guess::Utf32);
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return if decode_strict_utf16le(&bytes[2..]).is_some() {
            Detected::Editable(Editable::Utf16Le)
        } else {
            Detected::Unsupported(Guess::Binary)
        };
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return Detected::Unsupported(Guess::Utf16Be);
    }
    if bytes[..bytes.len().min(BINARY_PROBE_BYTES)].contains(&0) {
        return Detected::Unsupported(Guess::Binary);
    }
    if decode_strict_utf8(bytes).is_some() {
        Detected::Editable(Editable::Utf8)
    } else {
        Detected::Unsupported(Guess::Legacy)
    }
}

/// `decodeText(bytes, encoding)`: the editor string, its BOM (if any)
/// stripped. `Err` is the TS throw's message.
pub fn decode_text(bytes: &[u8], encoding: Editable) -> Result<String, String> {
    let out = match encoding {
        Editable::Utf8 => decode_strict_utf8(bytes),
        Editable::Utf8Bom => decode_strict_utf8(bytes.strip_prefix(&UTF8_BOM[..]).unwrap_or(bytes)),
        Editable::Utf16Le => {
            decode_strict_utf16le(bytes.strip_prefix(&[0xff, 0xfe][..]).unwrap_or(bytes))
        }
    };
    out.ok_or_else(|| format!("bytes are not valid {}", encoding.as_str()))
}

/// `encodeText(text, encoding)` for a JS string given as its UTF-16 code
/// units: UTF-8 (a lone surrogate is U+FFFD, as `TextEncoder` writes it),
/// with the BOM for `utf-8-bom`, or the UTF-16LE BOM and the units as they
/// are.
pub fn encode_text(units: &[u16], encoding: Editable) -> Vec<u8> {
    let utf8 = |head: &[u8]| {
        let body = String::from_utf16_lossy(units);
        let mut out = Vec::with_capacity(head.len() + body.len());
        out.extend_from_slice(head);
        out.extend_from_slice(body.as_bytes());
        out
    };
    match encoding {
        Editable::Utf8 => utf8(&[]),
        Editable::Utf8Bom => utf8(&UTF8_BOM),
        Editable::Utf16Le => {
            let mut out = Vec::with_capacity(2 + units.len() * 2);
            out.extend_from_slice(&[0xff, 0xfe]);
            for u in units {
                out.extend_from_slice(&u.to_le_bytes());
            }
            out
        }
    }
}

/// WHATWG windows-1252 for 0x80..=0x9F (the rest is Latin-1).
const WINDOWS_1252_HIGH: [u16; 32] = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/// `decodePreview(bytes, guess)`: the lossy read-only text. UTF-16BE is
/// byte-swapped (the BOM and an odd last byte dropped) and decoded with
/// U+FFFD for lone surrogates; a legacy code page reads as windows-1252;
/// binary and UTF-32 as UTF-8 with U+FFFD and a leading BOM dropped.
pub fn decode_preview(bytes: &[u8], guess: Guess) -> String {
    match guess {
        Guess::Utf16Be => {
            let body = if bytes.len() < 2 {
                &[][..]
            } else {
                &bytes[2..2 + ((bytes.len() - 2) & !1)]
            };
            char::decode_utf16(
                body.chunks_exact(2)
                    .map(|p| u16::from_be_bytes([p[0], p[1]])),
            )
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect()
        }
        Guess::Legacy => bytes
            .iter()
            .map(|&b| match b {
                0x80..=0x9f => char::from_u32(u32::from(WINDOWS_1252_HIGH[usize::from(b - 0x80)]))
                    .expect("a BMP scalar"),
                b => char::from(b),
            })
            .collect(),
        Guess::Utf32 | Guess::Binary => {
            // Only `EF BB BF` decodes to U+FEFF.
            let s = String::from_utf8_lossy(bytes);
            match s.strip_prefix('\u{FEFF}') {
                Some(rest) => rest.to_owned(),
                None => s.into_owned(),
            }
        }
    }
}

/// The GET handler's pick: `decodeText` for an editable encoding (it
/// decoded during the sniff, so it can't fail), `decodePreview` otherwise.
pub fn content(bytes: &[u8], detected: Detected) -> String {
    match detected {
        Detected::Editable(e) => decode_text(bytes, e).unwrap_or_default(),
        Detected::Unsupported(g) => decode_preview(bytes, g),
    }
}
