//! The event stream's framing: WHATWG HTML §9.2.6 "Interpreting an event
//! stream", over bytes as Chromium's `EventSourceParser` reads them.
//!
//! - One parser per connection. A BOM (`EF BB BF`) at its very start is
//!   dropped; anywhere else it's data.
//! - Lines end at CR, LF or CRLF, also when the CR and the LF arrive in
//!   different chunks. An unfinished last line is never processed.
//! - A line is decoded as UTF-8 with U+FFFD for a bad sequence (the
//!   stream's UTF-8 decode; CR, LF and `:` are ASCII, so decoding line by
//!   line gives the same text as decoding the stream).
//! - An empty line dispatches; a line starting with `:` is a comment;
//!   otherwise the field is what precedes the first `:` (the whole line
//!   without one) and the value what follows it, less one leading space.
//! - `event` sets the type; `data` appends the value and a LF; `id` sets
//!   the id unless the value has a NUL; `retry` of ASCII digits only (not
//!   empty) sets the reconnection time, at once (a value past `u64` is
//!   ignored, as Chromium's `ToUInt64Strict` fails); any other field is
//!   ignored.
//! - Dispatch: the last event ID becomes the id buffer (even with no data);
//!   then empty data dispatches nothing; else the data less its last LF is a
//!   message of the buffered type (`message` when empty). Data and type
//!   reset; the id does not.
//!
//! The id buffer starts at the source's last event ID, as Chromium's new
//! parser "takes over the event ID" on a reconnect (the spec's text starts
//! it empty, which would let a reconnected stream's first id-less event
//! clear it; Chromium and undici both keep it).

/// What a parser hands its event source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// A dispatched message.
    Message {
        data: String,
        event_type: String,
        last_event_id: String,
    },
    /// A `retry:` field: the new reconnection time, in milliseconds.
    Retry(u64),
}

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// One connection's stream state.
#[derive(Debug, Clone)]
pub struct Parser {
    /// The start of the stream while it may still be a BOM.
    head: Vec<u8>,
    bom_checked: bool,
    /// The current line so far.
    line: Vec<u8>,
    /// The last line ended with CR: a LF right after it ends nothing.
    after_cr: bool,
    data: String,
    event_type: String,
    /// The last event ID buffer.
    id: String,
    /// The event source's last event ID string.
    last_event_id: String,
}

impl Parser {
    /// A parser for a new connection of a source whose last event ID is
    /// `last_event_id`.
    pub fn new(last_event_id: impl Into<String>) -> Self {
        let last_event_id = last_event_id.into();
        Self {
            head: Vec::new(),
            bom_checked: false,
            line: Vec::new(),
            after_cr: false,
            data: String::new(),
            event_type: String::new(),
            id: last_event_id.clone(),
            last_event_id,
        }
    }

    /// The source's last event ID string (what `Last-Event-ID` carries on
    /// the next connection).
    pub fn last_event_id(&self) -> &str {
        &self.last_event_id
    }

    /// Feed the next chunk of the body; what it completes goes to `out`, in
    /// order.
    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<Parsed>) {
        if self.bom_checked {
            self.lines(bytes, out);
            return;
        }
        self.head.extend_from_slice(bytes);
        if self.head.len() < BOM.len() && BOM.starts_with(&self.head) {
            return;
        }
        self.bom_checked = true;
        let head = std::mem::take(&mut self.head);
        let rest = head.strip_prefix(&BOM[..]).unwrap_or(&head);
        self.lines(rest, out);
    }

    fn lines(&mut self, bytes: &[u8], out: &mut Vec<Parsed>) {
        let mut start = 0;
        for (i, &b) in bytes.iter().enumerate() {
            if std::mem::take(&mut self.after_cr) && b == b'\n' {
                start = i + 1;
                continue;
            }
            if b == b'\r' || b == b'\n' {
                self.line.extend_from_slice(&bytes[start..i]);
                let line = std::mem::take(&mut self.line);
                self.process(&line, out);
                start = i + 1;
                self.after_cr = b == b'\r';
            }
        }
        self.line.extend_from_slice(&bytes[start..]);
    }

    fn process(&mut self, line: &[u8], out: &mut Vec<Parsed>) {
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line[0] == b':' {
            return;
        }
        let (field, value) = match line.iter().position(|&b| b == b':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(b" ").unwrap_or(v))
            }
            None => (line, &b""[..]),
        };
        match field {
            b"event" => self.event_type = String::from_utf8_lossy(value).into_owned(),
            b"data" => {
                self.data.push_str(&String::from_utf8_lossy(value));
                self.data.push('\n');
            }
            b"id" if !value.contains(&0) => self.id = String::from_utf8_lossy(value).into_owned(),
            b"retry" if value.iter().all(u8::is_ascii_digit) => {
                // ASCII digits are UTF-8; an empty value or an overflow
                // fails to parse, so is ignored.
                if let Ok(ms) = std::str::from_utf8(value).unwrap_or_default().parse() {
                    out.push(Parsed::Retry(ms));
                }
            }
            _ => {}
        }
    }

    fn dispatch(&mut self, out: &mut Vec<Parsed>) {
        self.last_event_id.clone_from(&self.id);
        if self.data.is_empty() {
            self.event_type.clear();
            return;
        }
        let mut data = std::mem::take(&mut self.data);
        data.pop();
        let event_type = match std::mem::take(&mut self.event_type) {
            t if t.is_empty() => "message".to_owned(),
            t => t,
        };
        out.push(Parsed::Message {
            data,
            event_type,
            last_event_id: self.last_event_id.clone(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(data: &str, event_type: &str, id: &str) -> Parsed {
        Parsed::Message {
            data: data.into(),
            event_type: event_type.into(),
            last_event_id: id.into(),
        }
    }

    fn parse_chunks(chunks: &[&[u8]]) -> (Vec<Parsed>, String) {
        let mut p = Parser::new("");
        let mut out = Vec::new();
        for c in chunks {
            p.feed(c, &mut out);
        }
        (out, p.last_event_id().to_owned())
    }

    fn parse(s: &str) -> Vec<Parsed> {
        parse_chunks(&[s.as_bytes()]).0
    }

    /// The same input fed whole, byte by byte, and split at every point
    /// gives the same output.
    fn every_split(input: &[u8]) -> Vec<Parsed> {
        let (whole, id) = parse_chunks(&[input]);
        let bytes: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(parse_chunks(&bytes), (whole.clone(), id.clone()));
        for i in 0..=input.len() {
            let (a, b) = input.split_at(i);
            assert_eq!(
                parse_chunks(&[a, b]),
                (whole.clone(), id.clone()),
                "split at {i}"
            );
        }
        whole
    }

    #[test]
    fn line_endings_cr_lf_crlf() {
        let expect = vec![msg("a", "message", ""), msg("b", "message", "")];
        assert_eq!(every_split(b"data: a\n\ndata: b\n\n"), expect);
        assert_eq!(every_split(b"data: a\r\rdata: b\r\r"), expect);
        assert_eq!(every_split(b"data: a\r\n\r\ndata: b\r\n\r\n"), expect);
        assert_eq!(every_split(b"data: a\r\n\ndata: b\n\r\n"), expect);
        // CR LF is one line end, LF CR two.
        assert_eq!(every_split(b"data: a\n\rdata: b\r\n\n"), expect);
        // So CR LF inside an event doesn't end it.
        let joined = vec![msg("a\nb", "message", "")];
        assert_eq!(every_split(b"data: a\r\ndata: b\r\n\r\n"), joined);
        assert_eq!(every_split(b"data: a\rdata: b\r\r"), joined);
    }

    #[test]
    fn data_lines_join_with_lf() {
        assert_eq!(
            every_split(b"data: one\ndata:two\ndata:  three\ndata\n\n"),
            vec![msg("one\ntwo\n three\n", "message", "")]
        );
        // Empty data still dispatches (`data` alone, `data:`).
        assert_eq!(
            parse("data\n\ndata:\n\n"),
            vec![msg("", "message", ""), msg("", "message", "")]
        );
        // Two empty data lines: one LF.
        assert_eq!(parse("data:\ndata:\n\n"), vec![msg("\n", "message", "")]);
    }

    #[test]
    fn no_data_no_dispatch() {
        assert_eq!(parse("event: x\n\n\n\n: c\n\nid: 1\n\n"), vec![]);
        // The type doesn't carry over to the next event.
        assert_eq!(
            parse("event: x\n\ndata: y\n\n"),
            vec![msg("y", "message", "")]
        );
    }

    #[test]
    fn event_types() {
        assert_eq!(
            parse(
                "event: add\ndata: 1\n\nevent:\ndata: 2\n\nevent:  sp\ndata: 3\n\nevent: a\nevent: b\ndata: 4\n\n"
            ),
            vec![
                msg("1", "add", ""),
                msg("2", "message", ""),
                msg("3", " sp", ""),
                msg("4", "b", ""),
            ]
        );
    }

    #[test]
    fn ids() {
        let (out, last) = parse_chunks(&[
            b"id: 1\ndata: a\n\ndata: b\n\nid: 2\n\nid\ndata: c\n\nid: x\0y\ndata: d\n\nid: 3\n",
        ]);
        assert_eq!(
            out,
            vec![
                msg("a", "message", "1"),
                // The id persists.
                msg("b", "message", "1"),
                // `id` alone (no colon) is the empty id; an id-only block
                // set "2" first.
                msg("c", "message", ""),
                // An id with NUL is ignored.
                msg("d", "message", ""),
            ]
        );
        // `id: 3` was never dispatched: the last event ID is still "".
        assert_eq!(last, "");
        let (_, last) = parse_chunks(&[b"id: 2\n\n"]);
        assert_eq!(last, "2", "an id-only block sets it");
        // A new connection's parser starts from the source's id.
        let mut p = Parser::new("7");
        let mut out = Vec::new();
        p.feed(b"data: e\n\n", &mut out);
        assert_eq!(out, vec![msg("e", "message", "7")]);
        // Non-ASCII ids and values are UTF-8.
        let (out, last) = parse_chunks(&["id: \u{e9}\u{1f600}\ndata: \u{e9}\n\n".as_bytes()]);
        assert_eq!(out, vec![msg("\u{e9}", "message", "\u{e9}\u{1f600}")]);
        assert_eq!(last, "\u{e9}\u{1f600}");
    }

    #[test]
    fn retry_digits_only() {
        assert_eq!(
            every_split(b"retry: 1500\nretry:7\nretry: 007\n\n"),
            vec![Parsed::Retry(1500), Parsed::Retry(7), Parsed::Retry(7)]
        );
        for bad in [
            "retry:\n",
            "retry: \n",
            "retry: 1a\n",
            "retry: -1\n",
            "retry: 1.5\n",
            "retry:  5\n",
            "retry: 5 \n",
            "retry: \u{661}\n",
            "retry: 99999999999999999999999\n",
            "retry: +5\n",
            "Retry: 5\n",
        ] {
            assert_eq!(parse(bad), vec![], "{bad:?}");
        }
        // Applied at once, not at dispatch: it comes out before the
        // block's message, and without a blank line.
        assert_eq!(
            parse("data: a\nretry: 10\n\nretry: 20\n"),
            vec![
                Parsed::Retry(10),
                msg("a", "message", ""),
                Parsed::Retry(20)
            ]
        );
        assert_eq!(
            parse("retry: 18446744073709551615\n"),
            vec![Parsed::Retry(u64::MAX)]
        );
    }

    #[test]
    fn comments_and_unknown_fields() {
        assert_eq!(
            parse(": ping\n:\ndata: a\n: mid\nfoo: bar\ndata : no\n data: no\nDATA: no\n\n"),
            vec![msg("a", "message", "")]
        );
        // A comment line still ends the line before it.
        assert_eq!(parse("data: a\n:x\n\n"), vec![msg("a", "message", "")]);
    }

    #[test]
    fn colon_and_space_rules() {
        // Only the first colon splits; only one leading space goes.
        assert_eq!(
            parse("data:a:b\ndata:  c\ndata:\td\n\n"),
            vec![msg("a:b\n c\n\td", "message", "")]
        );
    }

    #[test]
    fn bom_only_at_the_start() {
        let expect = vec![msg("a", "message", "")];
        assert_eq!(every_split(b"\xEF\xBB\xBFdata: a\n\n"), expect);
        // A second BOM is not stripped: the line's field is "\u{feff}data".
        assert_eq!(
            parse_chunks(&[b"\xEF\xBB\xBF\xEF\xBB\xBFdata: a\n\n"]).0,
            vec![]
        );
        // A BOM later in the stream is data.
        assert_eq!(
            parse("data: \u{feff}x\n\n"),
            vec![msg("\u{feff}x", "message", "")]
        );
        // A BOM line on its own, then an event.
        assert_eq!(every_split(b"\xEF\xBB\xBF\ndata: a\n\n"), expect);
        // A partial BOM is not one.
        assert_eq!(
            every_split(b"\xEF\xBBdata: a\n\ndata: b\n\n"),
            vec![msg("b", "message", "")]
        );
        // A short stream that ends inside the BOM check: nothing.
        assert_eq!(parse_chunks(&[b"\xEF"]).0, vec![]);
        assert_eq!(every_split(b"\n"), vec![]);
        assert_eq!(every_split(b"\xEF\n\n"), vec![]);
    }

    #[test]
    fn bad_utf8_is_replaced() {
        assert_eq!(
            every_split(b"data: a\xFFb\xE2\x82\ndata: \xF0\x9F\x98\x80\n\n"),
            vec![msg("a\u{fffd}b\u{fffd}\n\u{1f600}", "message", "")]
        );
    }

    #[test]
    fn an_unfinished_event_or_line_is_not_dispatched() {
        assert_eq!(parse("data: a\n\ndata: b\n"), vec![msg("a", "message", "")]);
        assert_eq!(parse("data: a\n\ndata: b"), vec![msg("a", "message", "")]);
    }

    #[test]
    fn the_servers_frames() {
        // `data: <json>\n\n` and `: ping\n\n`, as `/api/sessions/<id>/stream`
        // sends them.
        assert_eq!(
            every_split(b"data: {\"type\":\"ready\"}\n\n: ping\n\ndata: {\"a\":1}\n\n"),
            vec![
                msg("{\"type\":\"ready\"}", "message", ""),
                msg("{\"a\":1}", "message", ""),
            ]
        );
    }
}
