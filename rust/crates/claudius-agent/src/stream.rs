//! The byte-level half of the SDK's `ProcessTransport`: Node's `readline`
//! over the CLI's stdout, and a `StringDecoder` plus a bounded tail over its
//! stderr. Both decode UTF-8 the way Node does, with U+FFFD for each maximal
//! invalid subpart, so a stray byte never stops the reader.

use crate::js;
use crate::redact::redact;

/// How much stderr the exit error quotes, in UTF-16 code units (`bw`). The
/// buffer is trimmed back to this once it passes twice as much.
pub(crate) const STDERR_TAIL_UNITS: usize = 2048;

/// `readline` line splitting over raw bytes. Lines end at `\n`, `\r\n` or a
/// bare `\r`, and a `\r\n` split across two reads is still one ending. Each
/// line is decoded as UTF-8 with replacement characters. The separators are
/// ASCII, so splitting before decoding gives the same lines as Node's
/// decode-then-split.
#[derive(Default)]
pub(crate) struct LineSplitter {
    buf: Vec<u8>,
    /// The last chunk ended in `\r`, so a leading `\n` in the next chunk
    /// belongs to it.
    skip_lf: bool,
}

impl LineSplitter {
    pub(crate) fn push(&mut self, chunk: &[u8], emit: &mut impl FnMut(String)) {
        let mut i = 0;
        if std::mem::take(&mut self.skip_lf) && chunk.first() == Some(&b'\n') {
            i = 1;
        }
        let mut start = i;
        while i < chunk.len() {
            let b = chunk[i];
            i += 1;
            if b != b'\n' && b != b'\r' {
                continue;
            }
            self.buf.extend_from_slice(&chunk[start..i - 1]);
            emit(String::from_utf8_lossy(&self.buf).into_owned());
            self.buf.clear();
            if b == b'\r' {
                match chunk.get(i) {
                    Some(b'\n') => i += 1,
                    Some(_) => {}
                    None => self.skip_lf = true,
                }
            }
            start = i;
        }
        self.buf.extend_from_slice(&chunk[start..]);
    }

    /// End of input: an unterminated last line still counts.
    pub(crate) fn finish(&mut self, emit: &mut impl FnMut(String)) {
        if !self.buf.is_empty() {
            emit(String::from_utf8_lossy(&self.buf).into_owned());
            self.buf.clear();
        }
    }
}

/// Node's `StringDecoder("utf8")`: decodes chunk by chunk, holding back a
/// code point split across chunks instead of mangling it.
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn write(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut out = String::with_capacity(bytes.len());
        let mut rest = &bytes[..];
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            rest = &after[n..];
                        }
                        // Incomplete at the end: wait for the next chunk.
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// `end()`: an incomplete trailing code point becomes one U+FFFD.
    pub fn end(&mut self) -> &'static str {
        if std::mem::take(&mut self.pending).is_empty() {
            ""
        } else {
            "\u{fffd}"
        }
    }
}

/// Append decoded stderr to the tail. Once it passes twice
/// [`STDERR_TAIL_UNITS`], it's redacted and cut back to the last
/// [`STDERR_TAIL_UNITS`], like the SDK's buffer.
pub(crate) fn push_stderr(tail: &mut String, text: &str) {
    tail.push_str(text);
    if tail.encode_utf16().count() > 2 * STDERR_TAIL_UNITS {
        let redacted = redact(tail);
        *tail = js::utf16_tail(&redacted, STDERR_TAIL_UNITS).to_owned();
    }
}

/// `formatStderrTail()`'s text: redacted, then the last
/// [`STDERR_TAIL_UNITS`], JS-trimmed.
pub(crate) fn format_stderr_tail(tail: &str) -> String {
    js::trim(js::utf16_tail(&redact(tail), STDERR_TAIL_UNITS)).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(chunks: &[&[u8]]) -> Vec<String> {
        let mut s = LineSplitter::default();
        let mut lines = Vec::new();
        for c in chunks {
            s.push(c, &mut |l| lines.push(l));
        }
        s.finish(&mut |l| lines.push(l));
        lines
    }

    #[test]
    fn lines_end_at_lf_crlf_and_bare_cr() {
        assert_eq!(split(&[b"a\nb\r\nc\rd"]), ["a", "b", "c", "d"]);
        assert_eq!(split(&[b"a\r\r\nb\n\n"]), ["a", "", "b", ""]);
        // A `\r\n` split across reads is one ending, but only right at the
        // chunk boundary.
        assert_eq!(split(&[b"a\r", b"\nb\n"]), ["a", "b"]);
        assert_eq!(split(&[b"a\r", b"b\n"]), ["a", "b"]);
        assert_eq!(split(&[b"a\r", b"", b"\nb"]), ["a", "", "b"]);
        assert_eq!(split(&[b"a\r", b"\n", b"\n"]), ["a", ""]);
        assert_eq!(split(&[b"ab", b"c\n"]), ["abc"]);
        assert_eq!(split(&[b"\n"]), [""]);
        assert!(split(&[b""]).is_empty());
    }

    #[test]
    fn lines_decode_lossily_across_chunks() {
        assert_eq!(split(&[b"caf\xc3", b"\xa9\n"]), ["caf\u{e9}"]);
        assert_eq!(
            split(&[b"a\xffb\xc3(\xf0\x9f\x98\n"]),
            ["a\u{fffd}b\u{fffd}(\u{fffd}"]
        );
        assert_eq!(split(&[b"\xc3\n\xa9"]), ["\u{fffd}", "\u{fffd}"]);
    }

    #[test]
    fn decoder_holds_split_code_points() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.write(b"caf\xc3"), "caf");
        assert_eq!(d.write(b"\xa9!"), "\u{e9}!");
        assert_eq!(d.write(b"\xf0\x9f"), "");
        assert_eq!(d.write(b"\x98"), "");
        assert_eq!(d.write(b"\x80"), "\u{1f600}");
        // An incomplete sequence the next chunk can't finish.
        assert_eq!(d.write(b"\xf0\x9f"), "");
        assert_eq!(d.write(b"A"), "\u{fffd}A");
        assert_eq!(d.write(b"\xff\xfe x"), "\u{fffd}\u{fffd} x");
        assert_eq!(d.end(), "");
        assert_eq!(d.write(b"\xe2\x82"), "");
        assert_eq!(d.end(), "\u{fffd}");
        assert_eq!(d.end(), "");
    }

    #[test]
    fn stderr_tail_keeps_the_last_units() {
        let mut tail = String::new();
        push_stderr(&mut tail, &"a".repeat(4096));
        assert_eq!(tail.len(), 4096, "not trimmed until past 2 * 2048");
        push_stderr(&mut tail, "b");
        assert_eq!(tail, format!("{}b", "a".repeat(2047)));
        // The limit is in UTF-16 units, not bytes.
        let mut tail = String::new();
        push_stderr(&mut tail, &"\u{e9}".repeat(3000));
        assert_eq!(tail.chars().count(), 3000);
        // Astral characters count two units; a pair cut in half is dropped.
        let mut tail = String::new();
        push_stderr(&mut tail, &format!("x{}", "\u{1f600}".repeat(2100)));
        assert_eq!(tail, "\u{1f600}".repeat(1024));
        assert_eq!(
            format_stderr_tail(&format!("{}\n", "\u{1f600}".repeat(1100))),
            "\u{1f600}".repeat(1023)
        );
        assert_eq!(format_stderr_tail(" \u{a0}oops\u{feff}\n"), "oops");
        assert_eq!(format_stderr_tail("\u{85}x\u{85}"), "\u{85}x\u{85}");
    }

    #[test]
    fn stderr_tail_is_redacted() {
        let key = format!("sk-ant-api03-{}", "a1B2".repeat(10));
        assert_eq!(
            format_stderr_tail(&format!("auth failed for {key}\n")),
            "auth failed for <token>"
        );
        let straddling = format!("{}{key} {}", "x".repeat(2100), "y".repeat(2039));
        assert_eq!(
            format_stderr_tail(&straddling),
            format!("x<token> {}", "y".repeat(2039))
        );
        // Redacted before the cut: cutting first would keep the key's last
        // 8 characters, which no longer look like a key.
        let mut tail = String::new();
        push_stderr(&mut tail, &"x".repeat(2100));
        push_stderr(&mut tail, &format!("{key} {}", "y".repeat(2039)));
        assert_eq!(tail, format!("x<token> {}", "y".repeat(2039)));
    }
}
