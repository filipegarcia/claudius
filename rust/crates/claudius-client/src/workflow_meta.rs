//! `lib/shared/workflow-meta.ts`: the best-effort reader of a Workflow
//! script's `export const meta = { name, description, phases }` literal,
//! which also reads a script still streaming in (truncated values are
//! absent). It never fails: anything malformed is `{ phases: [] }`.
//!
//! The TS scans UTF-16 code units; this scans chars. Every unit it tests is
//! ASCII (quotes, brackets, `\`, `:`, JS whitespace, none astral), a
//! surrogate pair's halves are copied or skipped together, and a lone
//! surrogate is one char (`claudius_core::js_string`), so the two agree.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `WorkflowPhase`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowPhase {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// `WorkflowMeta`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub phases: Vec<WorkflowPhase>,
}

fn is_ws(c: char) -> bool {
    claudius_agent::js::is_whitespace(c)
}

fn is_quote(c: char) -> bool {
    matches!(c, '\'' | '"' | '`')
}

/// `readString(src, from)`: the quoted literal at or after `from` (JS
/// whitespace skipped), `\n` and `\t` unescaped and any other escaped char
/// taken as is; `None` when there is no quote or it never closes.
fn read_string(src: &[char], from: usize) -> Option<String> {
    let mut i = from;
    while i < src.len() && is_ws(src[i]) {
        i += 1;
    }
    let q = *src.get(i).filter(|c| is_quote(**c))?;
    i += 1;
    let mut out = String::new();
    while i < src.len() {
        let c = src[i];
        if c == '\\' {
            match src.get(i + 1) {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(&next) => out.push(next),
                None => {}
            }
            i += 2;
            continue;
        }
        if c == q {
            return Some(out);
        }
        out.push(c);
        i += 1;
    }
    None
}

/// `sliceBalanced(src, openIdx)`: the balanced `{…}` or `[…]` opening at
/// `open`, string bodies skipped; `None` when it doesn't close.
fn slice_balanced(src: &[char], open: usize) -> Option<&[char]> {
    let (o, close) = match src.get(open)? {
        '{' => ('{', '}'),
        '[' => ('[', ']'),
        _ => return None,
    };
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut i = open;
    while i < src.len() {
        let c = src[i];
        if let Some(q) = quote {
            if c == '\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
        } else if is_quote(c) {
            quote = Some(c);
        } else if c == o {
            depth += 1;
        } else if c == close {
            // `depth` is at least 1 here: the scan starts on `open`.
            depth -= 1;
            if depth == 0 {
                return Some(&src[open..=i]);
            }
        }
        i += 1;
    }
    None
}

/// The end of `/(?:^|[<boundary>])<key>\s*:\s*<tail>/`'s first match:
/// `key` right after a boundary char, then optional whitespace, `:`,
/// optional whitespace and `tail` (if any). The `^` alternative never
/// matches: every slice searched starts with its `{`.
fn find_field(src: &[char], key: &str, boundary: &[char], tail: Option<char>) -> Option<usize> {
    let key: Vec<char> = key.chars().collect();
    let after_key = |at: usize| -> Option<usize> {
        if src.get(at..at + key.len())? != key.as_slice() {
            return None;
        }
        let mut i = at + key.len();
        while src.get(i).is_some_and(|c| is_ws(*c)) {
            i += 1;
        }
        if src.get(i) != Some(&':') {
            return None;
        }
        i += 1;
        while src.get(i).is_some_and(|c| is_ws(*c)) {
            i += 1;
        }
        match tail {
            None => Some(i),
            Some(t) => (src.get(i) == Some(&t)).then_some(i + 1),
        }
    };
    debug_assert_eq!(src.first(), Some(&'{'));
    (0..src.len()).find_map(|s| {
        let c = src[s];
        (boundary.contains(&c) || is_ws(c))
            .then(|| after_key(s + 1))
            .flatten()
    })
}

/// `extractStringField(objSrc, key)`: the string after the first
/// `<key>:` at a property boundary (start, `,`, `{`, `[` or whitespace).
fn extract_string_field(obj: &[char], key: &str) -> Option<String> {
    let end = find_field(obj, key, &[',', '{', '['], None)?;
    read_string(obj, end)
}

/// `parsePhases(metaSrc)`: each `{…}` in the balanced `phases: […]` with a
/// non-empty `title`.
fn parse_phases(meta: &[char]) -> Vec<WorkflowPhase> {
    // The match ends on the array's `[`, the first one at or after its
    // start (the boundary class has no `[`).
    let Some(end) = find_field(meta, "phases", &[',', '{'], Some('[')) else {
        return Vec::new();
    };
    let Some(arr) = slice_balanced(meta, end - 1) else {
        return Vec::new();
    };
    let inner = &arr[1..arr.len() - 1];
    let mut phases = Vec::new();
    let mut i = 0;
    while i < inner.len() {
        if inner[i] != '{' {
            i += 1;
            continue;
        }
        let Some(obj) = slice_balanced(inner, i) else {
            break;
        };
        if let Some(title) = extract_string_field(obj, "title").filter(|t| !t.is_empty()) {
            phases.push(WorkflowPhase {
                title,
                detail: extract_string_field(obj, "detail"),
            });
        }
        i += obj.len();
    }
    phases
}

/// The end of `/export\s+const\s+meta\s*=\s*\{/`'s first match (just past
/// the `{`).
fn find_meta(src: &[char]) -> Option<usize> {
    let word = |i: usize, w: &str| -> Option<usize> {
        let w: Vec<char> = w.chars().collect();
        (src.get(i..i + w.len())? == w.as_slice()).then_some(i + w.len())
    };
    let spaces = |mut i: usize, at_least_one: bool| -> Option<usize> {
        let start = i;
        while src.get(i).is_some_and(|c| is_ws(*c)) {
            i += 1;
        }
        (!at_least_one || i > start).then_some(i)
    };
    (0..src.len()).find_map(|s| {
        let i = word(s, "export")?;
        let i = word(spaces(i, true)?, "const")?;
        let i = word(spaces(i, true)?, "meta")?;
        let i = spaces(i, false)?;
        let i = word(i, "=")?;
        word(spaces(i, false)?, "{")
    })
}

/// `parseWorkflowMeta(source)`: the `meta` literal's `name`,
/// `description` and `phases`. A missing, empty or non-string source has
/// none. A literal that doesn't balance (still streaming) is read to the
/// end of the source.
pub fn parse_workflow_meta(source: Option<&Value>) -> WorkflowMeta {
    let Some(Value::String(source)) = source else {
        return WorkflowMeta::default();
    };
    let src: Vec<char> = source.chars().collect();
    let Some(end) = find_meta(&src) else {
        return WorkflowMeta::default();
    };
    let brace = end - 1;
    let meta = slice_balanced(&src, brace).unwrap_or(&src[brace..]);
    WorkflowMeta {
        name: extract_string_field(meta, "name"),
        description: extract_string_field(meta, "description"),
        phases: parse_phases(meta),
    }
}
