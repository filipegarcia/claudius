//! What the page writes to its console (page.tsx:254 `pushConsoleEntry`)
//! and the one-liner its inline errors show (page.tsx:89
//! `summarizeGitError`). The console panel itself is U12b's
//! (`GitConsole.tsx`); the page keeps its entries and its open flag.

use crate::types::{is_js_whitespace, js_len, js_slice_to, js_trim, js_trim_end};

/// `CONSOLE_MAX_ENTRIES`.
pub const CONSOLE_MAX_ENTRIES: usize = 200;
/// `CONSOLE_MAX_OUTPUT_CHARS`.
pub const CONSOLE_MAX_OUTPUT_CHARS: usize = 8000;

/// `[\w-]+` at the start: its byte length.
fn word_len(s: &str) -> usize {
    s.bytes()
        .take_while(|b| *b == b'_' || *b == b'-' || b.is_ascii_alphanumeric())
        .count()
}

/// The end of `/^git [\w-]+(?: [\w-]+)* exited -?\d+:\s*/` in `s`, if it
/// matches. The words are maximal (a shorter one leaves a word character
/// where a space must be), so the backtracking engine's first match is the
/// longest run of words that ` exited <n>:` follows.
pub fn git_failure_prefix_len(s: &str) -> Option<usize> {
    let body = s.strip_prefix("git ")?;
    let mut ends = Vec::new();
    let mut at = word_len(body);
    if at == 0 {
        return None;
    }
    ends.push(at);
    while body[at..].starts_with(' ') {
        let n = word_len(&body[at + 1..]);
        if n == 0 {
            break;
        }
        at += 1 + n;
        ends.push(at);
    }
    for end in ends.into_iter().rev() {
        let Some(rest) = body[end..].strip_prefix(" exited ") else {
            continue;
        };
        let rest = rest.strip_prefix('-').unwrap_or(rest);
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            continue;
        }
        let Some(after) = rest[digits..].strip_prefix(':') else {
            continue;
        };
        let ws = after.len() - after.trim_start_matches(is_js_whitespace).len();
        return Some(s.len() - after.len() + ws);
    }
    None
}

/// `input.replace(/^git … exited N:\s*/, "")`.
pub fn strip_git_failure_prefix(s: &str) -> &str {
    match git_failure_prefix_len(s) {
        Some(n) => &s[n..],
        None => s,
    }
}

/// `summarizeGitError` (page.tsx:89): the `GitFailure` prefix dropped, the
/// first non-blank line (trimmed), cut at 200 UTF-16 units with `…`.
pub fn summarize_git_error(input: &str) -> String {
    let cleaned = js_trim(strip_git_failure_prefix(input));
    let first = cleaned
        .split('\n')
        .map(|l| js_trim(l.strip_suffix('\r').unwrap_or(l)))
        .find(|l| !l.is_empty())
        .unwrap_or(cleaned);
    if js_len(first) > 200 {
        format!("{}…", js_slice_to(first, 200))
    } else {
        first.to_owned()
    }
}

/// The banner's line (page.tsx:1792): `.split("\n")[0]`.
pub fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or_default()
}

/// `GitConsoleEntry["status"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleStatus {
    Ok,
    Error,
    Info,
}

/// One console row (`GitConsoleEntry` without its id, time and cwd).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleEntry {
    pub command: String,
    pub status: ConsoleStatus,
    pub output: String,
}

/// `pushConsoleEntry`'s output (page.tsx:273): the `GitFailure` prefix
/// dropped, `trimEnd`, capped at 8000 UTF-16 units with a count of the rest.
pub fn console_output(output: &str) -> String {
    let cleaned = js_trim_end(strip_git_failure_prefix(output));
    let len = js_len(cleaned);
    if len > CONSOLE_MAX_OUTPUT_CHARS {
        format!(
            "{}\n… {} more chars omitted",
            js_slice_to(cleaned, CONSOLE_MAX_OUTPUT_CHARS),
            len - CONSOLE_MAX_OUTPUT_CHARS
        )
    } else {
        cleaned.to_owned()
    }
}

/// The console's entries and open flag (page.tsx:230).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Console {
    pub entries: Vec<ConsoleEntry>,
    pub open: bool,
}

impl Console {
    /// `pushConsoleEntry`: the newest 200 kept; an error opens the panel.
    pub fn push(&mut self, command: impl Into<String>, status: ConsoleStatus, output: &str) {
        if self.entries.len() >= CONSOLE_MAX_ENTRIES {
            let drop = self.entries.len() - CONSOLE_MAX_ENTRIES + 1;
            self.entries.drain(..drop);
        }
        self.entries.push(ConsoleEntry {
            command: command.into(),
            status,
            output: console_output(output),
        });
        if status == ConsoleStatus::Error {
            self.open = true;
        }
    }

    pub fn last(&self) -> Option<&ConsoleEntry> {
        self.entries.last()
    }
}
