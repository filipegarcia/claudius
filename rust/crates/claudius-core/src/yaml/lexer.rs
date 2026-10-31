//! Port of yaml 2.9.0's `parse/lexer.js`: `new Lexer().lex(source)` on a
//! complete input (`incomplete = false`), so the "wait for more input"
//! branches (`setNext`) never run. Works on UTF-16 units, like the JS
//! string indexing it mirrors; every comparison is against an ASCII
//! character (or the BOM), so a unit is looked at as a `char` and anything
//! that isn't one (a surrogate) as `'\u{FFFF}'`.

/// A lexical token: one of the three control markers, or a slice of the
/// source (`[start, end)`, UTF-16 units). The empty slice is the empty
/// plain scalar `pushToIndex(i, true)` yields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lexeme {
    /// `\x02`: a document starts with the next token.
    Document,
    /// `\x18`: unexpected end of flow mode.
    FlowEnd,
    /// `\x1f`: the next lexeme is a scalar value.
    Scalar,
    Text(usize, usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Stream,
    BlockStart,
    Doc,
    Flow,
}

pub(super) fn unit_char(u: u16) -> char {
    char::from_u32(u32::from(u)).unwrap_or('\u{FFFF}')
}

/// `isEmpty(ch)`: end of input or white space.
pub(super) fn is_empty(ch: Option<char>) -> bool {
    matches!(ch, None | Some(' ' | '\n' | '\r' | '\t'))
}

fn is_hex(ch: Option<char>) -> bool {
    ch.is_some_and(|c| c.is_ascii_hexdigit())
}

fn is_tag_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-#;/?:@&=+$_.!~*'()".contains(c)
}

fn is_flow_indicator(ch: Option<char>) -> bool {
    matches!(ch, Some(',' | '[' | ']' | '{' | '}'))
}

/// `isNotAnchorChar`: end of input, white space or a flow indicator.
fn is_not_anchor_char(ch: Option<char>) -> bool {
    matches!(
        ch,
        None | Some(' ' | ',' | '[' | ']' | '{' | '}' | '\n' | '\r' | '\t')
    )
}

struct Lexer<'a> {
    buf: &'a [u16],
    block_scalar_indent: i64,
    block_scalar_keep: bool,
    flow_key: bool,
    flow_level: i64,
    indent_next: i64,
    indent_value: i64,
    /// `lineEndPos`: `None` is JS `null`; `Some(-1)` is "no more `\n`".
    line_end_pos: Option<isize>,
    pos: usize,
    out: Vec<Lexeme>,
}

/// `new Lexer().lex(source)`, collected.
pub(super) fn lex(buf: &[u16]) -> Vec<Lexeme> {
    let mut lx = Lexer {
        buf,
        block_scalar_indent: -1,
        block_scalar_keep: false,
        flow_key: false,
        flow_level: 0,
        indent_next: 0,
        indent_value: 0,
        line_end_pos: None,
        pos: 0,
        out: Vec::new(),
    };
    let mut next = State::Stream;
    while lx.has_chars(1) {
        next = lx.parse_next(next);
    }
    lx.out
}

impl Lexer<'_> {
    /// `this.buffer[i]` (`undefined` off either end).
    fn at(&self, i: isize) -> Option<char> {
        if i < 0 {
            return None;
        }
        self.buf.get(i as usize).map(|u| unit_char(*u))
    }

    fn char_at(&self, n: isize) -> Option<char> {
        self.at(self.pos as isize + n)
    }

    fn index_of(&self, ch: char, from: usize) -> isize {
        let from = from.min(self.buf.len());
        self.buf[from..]
            .iter()
            .position(|u| unit_char(*u) == ch)
            .map_or(-1, |p| (from + p) as isize)
    }

    fn has_chars(&self, n: usize) -> bool {
        self.pos + n <= self.buf.len()
    }

    fn at_line_end(&self) -> bool {
        let mut i = self.pos as isize;
        let mut ch = self.at(i);
        while ch == Some(' ') || ch == Some('\t') {
            i += 1;
            ch = self.at(i);
        }
        match ch {
            None | Some('#' | '\n') => true,
            Some('\r') => self.at(i + 1) == Some('\n'),
            _ => false,
        }
    }

    fn continue_scalar(&self, offset: isize) -> isize {
        let mut ch = self.at(offset);
        if self.indent_next > 0 {
            let mut indent: isize = 0;
            while ch == Some(' ') {
                indent += 1;
                ch = self.at(indent + offset);
            }
            if ch == Some('\r') {
                let next = self.at(indent + offset + 1);
                if next == Some('\n') {
                    return offset + indent + 1;
                }
            }
            return if ch == Some('\n') || indent as i64 >= self.indent_next {
                offset + indent
            } else {
                -1
            };
        }
        if ch == Some('-') || ch == Some('.') {
            let dt = self.substr(offset, 3);
            if (self.slice_is(dt, "---") || self.slice_is(dt, "..."))
                && is_empty(self.at(offset + 3))
            {
                return -1;
            }
        }
        offset
    }

    /// `buffer.substr(start, n)` as a range.
    fn substr(&self, start: isize, n: usize) -> (usize, usize) {
        let s = start.max(0) as usize;
        let s = s.min(self.buf.len());
        (s, (s + n).min(self.buf.len()))
    }

    fn slice_is(&self, (s, e): (usize, usize), want: &str) -> bool {
        e - s == want.len()
            && self.buf[s..e]
                .iter()
                .zip(want.bytes())
                .all(|(u, b)| *u == u16::from(b))
    }

    /// `getLine()`: the rest of the current line, without its `\r\n` / `\n`.
    fn get_line(&mut self) -> (usize, usize) {
        let mut end = self.line_end_pos;
        if end.is_none_or(|e| e != -1 && e < self.pos as isize) {
            let e = self.index_of('\n', self.pos);
            self.line_end_pos = Some(e);
            end = Some(e);
        }
        let mut end = end.unwrap_or(-1);
        if end == -1 {
            return (self.pos, self.buf.len());
        }
        if self.at(end - 1) == Some('\r') {
            end -= 1;
        }
        // `substring` swaps reversed bounds.
        let (a, b) = (self.pos as isize, end);
        (a.min(b) as usize, a.max(b) as usize)
    }

    fn line_at(&self, line: (usize, usize), n: usize) -> Option<char> {
        let i = line.0 + n;
        if i < line.1 {
            self.at(i as isize)
        } else {
            None
        }
    }

    fn line_len(line: (usize, usize)) -> isize {
        (line.1 - line.0) as isize
    }

    fn parse_next(&mut self, next: State) -> State {
        match next {
            State::Stream => self.parse_stream(),
            State::BlockStart => self.parse_block_start(),
            State::Doc => self.parse_document(),
            State::Flow => self.parse_flow_collection(),
        }
    }

    fn parse_stream(&mut self) -> State {
        let mut line = self.get_line();
        if self.line_at(line, 0) == Some('\u{FEFF}') {
            self.push_count(1);
            line.0 += 1;
        }
        if self.line_at(line, 0) == Some('%') {
            let len = Self::line_len(line);
            let mut dir_end = len;
            let find = |from: isize| -> isize {
                (from.max(0)..len)
                    .find(|i| self.line_at(line, *i as usize) == Some('#'))
                    .unwrap_or(-1)
            };
            let mut cs = find(0);
            while cs != -1 {
                let ch = if cs >= 1 {
                    self.line_at(line, (cs - 1) as usize)
                } else {
                    None
                };
                if ch == Some(' ') || ch == Some('\t') {
                    dir_end = cs - 1;
                    break;
                }
                cs = find(cs + 1);
            }
            loop {
                let ch = if dir_end >= 1 {
                    self.line_at(line, (dir_end - 1) as usize)
                } else {
                    None
                };
                if ch == Some(' ') || ch == Some('\t') {
                    dir_end -= 1;
                } else {
                    break;
                }
            }
            let n = self.push_count(dir_end) + self.push_spaces(true);
            self.push_count(len - n); // possible comment
            // `this.pushNewline()` without `yield*`: the generator never
            // runs, so the newline is left for the next `parseStream`.
            return State::Stream;
        }
        if self.at_line_end() {
            let sp = self.push_spaces(true);
            self.push_count(Self::line_len(line) - sp);
            self.push_newline();
            return State::Stream;
        }
        self.out.push(Lexeme::Document);
        self.parse_line_start()
    }

    fn parse_line_start(&mut self) -> State {
        let ch = self.char_at(0);
        if ch == Some('-') || ch == Some('.') {
            let s = self.substr(self.pos as isize, 3);
            if (self.slice_is(s, "---") || self.slice_is(s, "...")) && is_empty(self.char_at(3)) {
                self.push_count(3);
                self.indent_value = 0;
                self.indent_next = 0;
                return if self.slice_is(s, "---") {
                    State::Doc
                } else {
                    State::Stream
                };
            }
        }
        self.indent_value = self.push_spaces(false) as i64;
        if self.indent_next > self.indent_value && !is_empty(self.char_at(1)) {
            self.indent_next = self.indent_value;
        }
        self.parse_block_start()
    }

    fn parse_block_start(&mut self) -> State {
        let (ch0, ch1) = (self.char_at(0), self.char_at(1));
        if matches!(ch0, Some('-' | '?' | ':')) && is_empty(ch1) {
            let n = self.push_count(1) + self.push_spaces(true);
            self.indent_next = self.indent_value + 1;
            self.indent_value += n as i64;
            return State::BlockStart;
        }
        State::Doc
    }

    fn parse_document(&mut self) -> State {
        self.push_spaces(true);
        let line = self.get_line();
        let mut n = self.push_indicators();
        match self.line_at(line, n as usize) {
            Some('#') => {
                self.push_count(Self::line_len(line) - n);
                self.push_newline();
                self.parse_line_start()
            }
            None => {
                self.push_newline();
                self.parse_line_start()
            }
            Some('{' | '[') => {
                self.push_count(1);
                self.flow_key = false;
                self.flow_level = 1;
                State::Flow
            }
            Some('}' | ']') => {
                // this is an error
                self.push_count(1);
                State::Doc
            }
            Some('*') => {
                self.push_until(is_not_anchor_char);
                State::Doc
            }
            Some('"' | '\'') => self.parse_quoted_scalar(),
            Some('|' | '>') => {
                n += self.parse_block_scalar_header();
                n += self.push_spaces(true);
                self.push_count(Self::line_len(line) - n);
                self.push_newline();
                self.parse_block_scalar()
            }
            _ => self.parse_plain_scalar(),
        }
    }

    fn parse_flow_collection(&mut self) -> State {
        let mut indent: isize = -1;
        loop {
            let nl = self.push_newline();
            let mut sp;
            if nl > 0 {
                sp = self.push_spaces(false);
                indent = sp;
                self.indent_value = sp as i64;
            } else {
                sp = 0;
            }
            sp += self.push_spaces(true);
            if nl + sp <= 0 {
                break;
            }
        }
        let line = self.get_line();
        let starts = |lx: &Self, s: &str| {
            s.bytes()
                .enumerate()
                .all(|(i, b)| lx.line_at(line, i) == Some(char::from(b)))
        };
        if (indent != -1
            && (indent as i64) < self.indent_next
            && self.line_at(line, 0) != Some('#'))
            || (indent == 0
                && (starts(self, "---") || starts(self, "..."))
                && is_empty(self.line_at(line, 3)))
        {
            // Allowing for the terminal ] or } at the same (rather than
            // greater) indent level as the initial [ or { is technically
            // invalid, but failing here would be surprising to users.
            let at_flow_end_marker = indent as i64 == self.indent_next - 1
                && self.flow_level == 1
                && matches!(self.line_at(line, 0), Some(']' | '}'));
            if !at_flow_end_marker {
                // this is an error
                self.flow_level = 0;
                self.out.push(Lexeme::FlowEnd);
                return self.parse_line_start();
            }
        }
        let mut n: isize = 0;
        while self.line_at(line, n as usize) == Some(',') {
            n += self.push_count(1);
            n += self.push_spaces(true);
            self.flow_key = false;
        }
        n += self.push_indicators();
        match self.line_at(line, n as usize) {
            None => State::Flow,
            Some('#') => {
                self.push_count(Self::line_len(line) - n);
                State::Flow
            }
            Some('{' | '[') => {
                self.push_count(1);
                self.flow_key = false;
                self.flow_level += 1;
                State::Flow
            }
            Some('}' | ']') => {
                self.push_count(1);
                self.flow_key = true;
                self.flow_level -= 1;
                if self.flow_level != 0 {
                    State::Flow
                } else {
                    State::Doc
                }
            }
            Some('*') => {
                self.push_until(is_not_anchor_char);
                State::Flow
            }
            Some('"' | '\'') => {
                self.flow_key = true;
                self.parse_quoted_scalar()
            }
            Some(':') => {
                let next = self.char_at(1);
                if self.flow_key || is_empty(next) || next == Some(',') {
                    self.flow_key = false;
                    self.push_count(1);
                    self.push_spaces(true);
                    return State::Flow;
                }
                self.flow_key = false;
                self.parse_plain_scalar()
            }
            _ => {
                self.flow_key = false;
                self.parse_plain_scalar()
            }
        }
    }

    fn parse_quoted_scalar(&mut self) -> State {
        let quote = self.char_at(0).unwrap_or('"');
        let mut end = self.index_of(quote, self.pos + 1);
        if quote == '\'' {
            while end != -1 && self.at(end + 1) == Some('\'') {
                end = self.index_of('\'', (end + 2) as usize);
            }
        } else {
            // double-quote
            while end != -1 {
                let mut n = 0;
                while self.at(end - 1 - n) == Some('\\') {
                    n += 1;
                }
                if n % 2 == 0 {
                    break;
                }
                end = self.index_of('"', (end + 1) as usize);
            }
        }
        // Only looking for newlines within the quotes: `qb` is
        // `buffer.substring(0, end)`, so with no closing quote (`end` is
        // -1) it is empty.
        let qb_len = end.max(0) as usize;
        let qb_index = |lx: &Self, from: isize| -> isize {
            let from = from.max(0) as usize;
            if from >= qb_len {
                return -1;
            }
            lx.buf[from..qb_len]
                .iter()
                .position(|u| *u == u16::from(b'\n'))
                .map_or(-1, |p| (from + p) as isize)
        };
        let mut nl = qb_index(self, self.pos as isize);
        if nl != -1 {
            while nl != -1 {
                let cs = self.continue_scalar(nl + 1);
                if cs == -1 {
                    break;
                }
                nl = qb_index(self, cs);
            }
            if nl != -1 {
                // this is an error caused by an unexpected unindent
                end = nl
                    - if self.at(nl - 1) == Some('\r') && ((nl - 1) as usize) < qb_len {
                        2
                    } else {
                        1
                    };
            }
        }
        if end == -1 {
            end = self.buf.len() as isize;
        }
        self.push_to_index((end + 1) as usize, false);
        if self.flow_level != 0 {
            State::Flow
        } else {
            State::Doc
        }
    }

    fn parse_block_scalar_header(&mut self) -> isize {
        self.block_scalar_indent = -1;
        self.block_scalar_keep = false;
        let mut i = self.pos as isize;
        loop {
            i += 1;
            let ch = self.at(i);
            match ch {
                Some('+') => self.block_scalar_keep = true,
                Some(c @ '1'..='9') => self.block_scalar_indent = i64::from(c as u8 - b'0') - 1,
                Some('-') => {}
                _ => break,
            }
        }
        self.push_until(|ch| is_empty(ch) || ch == Some('#'))
    }

    fn parse_block_scalar(&mut self) -> State {
        let mut nl = self.pos as isize - 1; // may be -1 if this.pos === 0
        let mut indent: i64 = 0;
        let mut i = self.pos as isize;
        while let Some(ch) = self.at(i) {
            match ch {
                ' ' => indent += 1,
                '\n' => {
                    nl = i;
                    indent = 0;
                }
                '\r' if self.at(i + 1) == Some('\n') => {}
                _ => break,
            }
            i += 1;
        }
        if indent >= self.indent_next {
            if self.block_scalar_indent == -1 {
                self.indent_next = indent;
            } else {
                self.indent_next = self.block_scalar_indent
                    + if self.indent_next == 0 {
                        1
                    } else {
                        self.indent_next
                    };
            }
            loop {
                let cs = self.continue_scalar(nl + 1);
                if cs == -1 {
                    break;
                }
                nl = self.index_of('\n', cs as usize);
                if nl == -1 {
                    break;
                }
            }
            if nl == -1 {
                nl = self.buf.len() as isize;
            }
        }
        // Trailing insufficiently indented tabs are invalid.
        // To catch that during parsing, we include them in the block scalar value.
        let mut i = nl + 1;
        let mut ch = self.at(i);
        while ch == Some(' ') {
            i += 1;
            ch = self.at(i);
        }
        if ch == Some('\t') {
            while matches!(ch, Some('\t' | ' ' | '\r' | '\n')) {
                i += 1;
                ch = self.at(i);
            }
            nl = i - 1;
        } else if !self.block_scalar_keep {
            loop {
                let mut i = nl - 1;
                let mut ch = self.at(i);
                if ch == Some('\r') {
                    i -= 1;
                    ch = self.at(i);
                }
                let last_char = i; // Drop the line if last char not more indented
                while ch == Some(' ') {
                    i -= 1;
                    ch = self.at(i);
                }
                if ch == Some('\n') && i >= self.pos as isize && i + 1 + indent as isize > last_char
                {
                    nl = i;
                } else {
                    break;
                }
            }
        }
        self.out.push(Lexeme::Scalar);
        self.push_to_index((nl + 1) as usize, true);
        self.parse_line_start()
    }

    fn parse_plain_scalar(&mut self) -> State {
        let in_flow = self.flow_level > 0;
        let mut end = self.pos as isize - 1;
        let mut i = self.pos as isize - 1;
        loop {
            i += 1;
            let Some(mut ch) = self.at(i) else { break };
            if ch == ':' {
                let next = self.at(i + 1);
                if is_empty(next) || (in_flow && is_flow_indicator(next)) {
                    break;
                }
                end = i;
            } else if is_empty(Some(ch)) {
                let mut next = self.at(i + 1);
                if ch == '\r' {
                    if next == Some('\n') {
                        i += 1;
                        ch = '\n';
                        next = self.at(i + 1);
                    } else {
                        end = i;
                    }
                }
                if next == Some('#') || (in_flow && is_flow_indicator(next)) {
                    break;
                }
                if ch == '\n' {
                    let cs = self.continue_scalar(i + 1);
                    if cs == -1 {
                        break;
                    }
                    i = i.max(cs - 2); // to advance, but still account for ' #'
                }
            } else {
                if in_flow && is_flow_indicator(Some(ch)) {
                    break;
                }
                end = i;
            }
        }
        self.out.push(Lexeme::Scalar);
        self.push_to_index((end + 1) as usize, true);
        if in_flow { State::Flow } else { State::Doc }
    }

    fn push_count(&mut self, n: isize) -> isize {
        if n > 0 {
            let (s, e) = self.substr(self.pos as isize, n as usize);
            self.out.push(Lexeme::Text(s, e));
            self.pos += n as usize;
            return n;
        }
        0
    }

    fn push_to_index(&mut self, i: usize, allow_empty: bool) -> isize {
        let end = i.min(self.buf.len());
        if end > self.pos {
            let n = end - self.pos;
            self.out.push(Lexeme::Text(self.pos, end));
            self.pos += n;
            return n as isize;
        } else if allow_empty {
            self.out.push(Lexeme::Text(self.pos, self.pos));
        }
        0
    }

    fn push_indicators(&mut self) -> isize {
        let mut n = 0;
        loop {
            match self.char_at(0) {
                Some('!') => {
                    n += self.push_tag();
                    n += self.push_spaces(true);
                    continue;
                }
                Some('&') => {
                    n += self.push_until(is_not_anchor_char);
                    n += self.push_spaces(true);
                    continue;
                }
                // `-` is an error; `?` an error outside flow collections
                Some('-' | '?' | ':') => {
                    let in_flow = self.flow_level > 0;
                    let ch1 = self.char_at(1);
                    if is_empty(ch1) || (in_flow && is_flow_indicator(ch1)) {
                        if !in_flow {
                            self.indent_next = self.indent_value + 1;
                        } else if self.flow_key {
                            self.flow_key = false;
                        }
                        n += self.push_count(1);
                        n += self.push_spaces(true);
                        continue;
                    }
                }
                _ => {}
            }
            break;
        }
        n
    }

    fn push_tag(&mut self) -> isize {
        if self.char_at(1) == Some('<') {
            let mut i = self.pos as isize + 2;
            let mut ch = self.at(i);
            while !is_empty(ch) && ch != Some('>') {
                i += 1;
                ch = self.at(i);
            }
            let to = if ch == Some('>') { i + 1 } else { i };
            self.push_to_index(to as usize, false)
        } else {
            let mut i = self.pos as isize + 1;
            let mut ch = self.at(i);
            while let Some(c) = ch {
                if is_tag_char(c) {
                    i += 1;
                    ch = self.at(i);
                } else if c == '%' && is_hex(self.at(i + 1)) && is_hex(self.at(i + 2)) {
                    i += 3;
                    ch = self.at(i);
                } else {
                    break;
                }
            }
            self.push_to_index(i as usize, false)
        }
    }

    fn push_newline(&mut self) -> isize {
        match self.at(self.pos as isize) {
            Some('\n') => self.push_count(1),
            Some('\r') if self.char_at(1) == Some('\n') => self.push_count(2),
            _ => 0,
        }
    }

    fn push_spaces(&mut self, allow_tabs: bool) -> isize {
        let mut i = self.pos as isize;
        loop {
            let ch = self.at(i);
            if ch == Some(' ') || (allow_tabs && ch == Some('\t')) {
                i += 1;
            } else {
                break;
            }
        }
        let n = i - self.pos as isize;
        if n > 0 {
            self.out.push(Lexeme::Text(self.pos, i as usize));
            self.pos = i as usize;
        }
        n
    }

    fn push_until(&mut self, test: impl Fn(Option<char>) -> bool) -> isize {
        let mut i = self.pos as isize;
        let mut ch = self.at(i);
        while !test(ch) {
            i += 1;
            ch = self.at(i);
        }
        self.push_to_index(i as usize, false)
    }
}
