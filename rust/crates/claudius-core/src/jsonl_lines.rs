//! `lib/server/jsonl-lines.ts`: `jsonlLines(createReadStream(file, {
//! encoding: "utf8" }))`, the lines of a JSONL file read as a stream.
//!
//! A line ends at `\n` only (never at a lone `\r`, U+2028 or U+2029), and one
//! trailing `\r` is stripped. The bytes are decoded as UTF-8 with U+FFFD for
//! invalid sequences; node's stream decoder hands an incomplete character at
//! a chunk boundary to V8 together with the bytes after it, so a line reads
//! the same as the lossy decoding of its bytes (`String::from_utf8_lossy`).
//! An empty tail after the last `\n` is no line; a non-empty one is.
//!
//! It backs the ports of the TS's three `jsonlLines` readers:
//! [`crate::peer_source`], `lastRecordedPermissionMode`
//! ([`crate::session_manager::last_recorded_permission_mode`]) and
//! `lastRecordedCostState` ([`crate::sdk_cost_state`], I14b). Memory
//! follows the longest line, not the file, and a caller that stops early
//! stops reading. The whole-file readers elsewhere port a TS (or SDK)
//! `readFile` and stay whole: [`crate::transcript::read_file`]
//! (`getSessionMessages`), `usage_seed` and `asset_ingest`
//! (`readFile(path, "utf8").split("\n")`, no `\r` stripped).
//!
//! One limit is V8's: a line spanning several 64 KiB chunks is joined into
//! one string, which throws `RangeError: Invalid string length` past
//! [`MAX_STRING_LENGTH`] UTF-16 units (the trailing `\r` counts). The
//! iterator then yields that error and ends, as the generator throws out of
//! the caller's loop. A line can't hold fewer UTF-16 units than a third of
//! its bytes, so reading stops as soon as the bytes say it is too long.

use std::io::{self, BufRead, BufReader, Read};

use crate::js_string::MAX_STRING_LENGTH;

/// The lines of `reader`; see the module docs.
pub struct JsonlLines<R> {
    reader: BufReader<R>,
    line: Vec<u8>,
    max_units: usize,
    done: bool,
}

impl<R: Read> JsonlLines<R> {
    pub fn new(reader: R) -> JsonlLines<R> {
        JsonlLines::with_limit(reader, MAX_STRING_LENGTH)
    }

    /// With another string limit than V8's (tests).
    pub fn with_limit(reader: R, max_units: usize) -> JsonlLines<R> {
        JsonlLines {
            reader: BufReader::with_capacity(64 * 1024, reader),
            line: Vec::new(),
            max_units,
            done: false,
        }
    }

    fn fail(&mut self, e: io::Error) -> Option<io::Result<String>> {
        self.done = true;
        Some(Err(e))
    }

    fn too_long(&mut self) -> Option<io::Result<String>> {
        self.fail(io::Error::new(
            io::ErrorKind::InvalidData,
            "RangeError: Invalid string length",
        ))
    }

    /// The finished line: decoded, checked against the limit, one `\r` off.
    fn finish(&mut self) -> Option<io::Result<String>> {
        let text = String::from_utf8_lossy(&self.line).into_owned();
        if self.line.len() > self.max_units && text.encode_utf16().count() > self.max_units {
            return self.too_long();
        }
        Some(Ok(match text.strip_suffix('\r') {
            Some(t) => t.to_owned(),
            None => text,
        }))
    }
}

impl<R: Read> Iterator for JsonlLines<R> {
    type Item = io::Result<String>;

    fn next(&mut self) -> Option<io::Result<String>> {
        if self.done {
            return None;
        }
        self.line.clear();
        loop {
            let chunk = match self.reader.fill_buf() {
                Ok(c) => c,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return self.fail(e),
            };
            if chunk.is_empty() {
                self.done = true;
                if self.line.is_empty() {
                    return None;
                }
                return self.finish();
            }
            if let Some(i) = chunk.iter().position(|&b| b == b'\n') {
                self.line.extend_from_slice(&chunk[..i]);
                self.reader.consume(i + 1);
                return self.finish();
            }
            let n = chunk.len();
            self.line.extend_from_slice(chunk);
            self.reader.consume(n);
            if self.line.len() / 3 > self.max_units {
                return self.too_long();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(bytes: &[u8], max: usize) -> Vec<Result<String, String>> {
        JsonlLines::with_limit(bytes, max)
            .map(|l| l.map_err(|e| e.to_string()))
            .collect()
    }

    fn ok(v: &[&str]) -> Vec<Result<String, String>> {
        v.iter().map(|s| Ok((*s).to_owned())).collect()
    }

    #[test]
    fn splits_on_lf_and_strips_one_cr() {
        let m = MAX_STRING_LENGTH;
        assert_eq!(lines(b"", m), ok(&[]));
        assert_eq!(lines(b"\n", m), ok(&[""]));
        assert_eq!(lines(b"a\r\r\nb\rc\n\r", m), ok(&["a\r", "b\rc", ""]));
        assert_eq!(lines("x\u{2028}y\n".as_bytes(), m), ok(&["x\u{2028}y"]));
        assert_eq!(lines(b"a\xff\xe2\x82\n", m), ok(&["a\u{fffd}\u{fffd}"]));
    }

    /// Reads `parts` in turn, an empty part reading as end of file once.
    struct Script(Vec<&'static [u8]>);

    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.0.is_empty() {
                return Ok(0);
            }
            let part = self.0.remove(0);
            buf[..part.len()].copy_from_slice(part);
            Ok(part.len())
        }
    }

    #[test]
    fn the_stream_ends_at_the_first_end_of_file() {
        // A transcript appended to after the stream ended: node's stream
        // has emitted `end`, so nothing after it is read.
        let got: Vec<String> = JsonlLines::new(Script(vec![b"a\nb", b"", b"c\n"]))
            .map(Result::unwrap)
            .collect();
        assert_eq!(got, ["a", "b"]);
        let mut it = JsonlLines::new(Script(vec![b"a\n", b"", b"c\n"]));
        assert_eq!(it.next().unwrap().unwrap(), "a");
        assert!(it.next().is_none() && it.next().is_none());
    }

    #[test]
    fn a_line_past_the_string_limit_ends_the_iteration() {
        let err = Err("RangeError: Invalid string length".to_owned());
        // Exactly the limit is fine, the trailing `\r` counts, the next
        // line is never read.
        assert_eq!(lines(b"abcd\nabc\r\nx", 4), ok(&["abcd", "abc", "x"]));
        assert_eq!(
            lines(b"ab\nabcd\r\nx\n", 4),
            vec![Ok("ab".to_owned()), err.clone()]
        );
        assert_eq!(lines(b"abcde", 4), vec![err.clone()]);
        // Three bytes per unit: 12 bytes are 4 units, under the cap.
        let euros = "\u{20ac}".repeat(4);
        assert_eq!(
            lines(format!("{euros}\n").as_bytes(), 4),
            ok(&[euros.as_str()])
        );
        // A long line spanning reads stops once its bytes can't fit.
        let long = vec![b'a'; 300_000];
        let got = lines(&long, 1_000);
        assert_eq!(got, vec![err]);
        let mut fits = vec![b'a'; 300_000];
        fits.push(b'\n');
        assert_eq!(lines(&fits, 300_000).len(), 1);
        // Three-byte characters exactly at the limit, across many reads: the
        // early stop must not fire on bytes alone.
        let wide = "\u{20ac}".repeat(100_000);
        assert_eq!(lines(wide.as_bytes(), 100_000), ok(&[wide.as_str()]));
        assert_eq!(
            lines(format!("{wide}\u{20ac}").as_bytes(), 100_000),
            vec![Err("RangeError: Invalid string length".to_owned())]
        );
    }
}
