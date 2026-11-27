//! `components/git/DiffViewer.tsx`: the unified diff's rows.

use crate::types::js_number;

/// `Line`: one row of the viewer.
#[derive(Clone, Debug, PartialEq)]
pub enum Line {
    Hunk { text: String },
    Add { text: String, n: f64 },
    Del { text: String, n: f64 },
    Ctx { text: String, ln: f64, rn: f64 },
    Meta { text: String },
}

impl Line {
    pub fn text(&self) -> &str {
        match self {
            Line::Hunk { text }
            | Line::Add { text, .. }
            | Line::Del { text, .. }
            | Line::Ctx { text, .. }
            | Line::Meta { text } => text,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Line::Hunk { .. } => "hunk",
            Line::Add { .. } => "add",
            Line::Del { .. } => "del",
            Line::Ctx { .. } => "ctx",
            Line::Meta { .. } => "meta",
        }
    }

    /// `gutterLeft` (DiffViewer.tsx:132).
    pub fn gutter_left(&self) -> String {
        match self {
            Line::Del { n, .. } => js_number(*n),
            Line::Ctx { ln, .. } => js_number(*ln),
            _ => String::new(),
        }
    }

    /// `gutterRight` (DiffViewer.tsx:138).
    pub fn gutter_right(&self) -> String {
        match self {
            Line::Add { n, .. } => js_number(*n),
            Line::Ctx { rn, .. } => js_number(*rn),
            _ => String::new(),
        }
    }

    /// `prefix` (DiffViewer.tsx:144): `−` is U+2212.
    pub fn prefix(&self) -> &'static str {
        match self {
            Line::Add { .. } => "+",
            Line::Del { .. } => "−",
            Line::Hunk { .. } => "@",
            _ => " ",
        }
    }
}

const META_PREFIXES: [&str; 9] = [
    "diff --git ",
    "index ",
    "--- ",
    "+++ ",
    "new file",
    "deleted file",
    "rename ",
    "similarity ",
    "Binary files ",
];

/// `\d+` at the start of `s`: the digits and the rest.
fn digits(s: &str) -> Option<(&str, &str)> {
    let n = s.bytes().take_while(u8::is_ascii_digit).count();
    (n > 0).then(|| s.split_at(n))
}

/// `(?:,\d+)?`.
fn opt_count(s: &str) -> &str {
    match s.strip_prefix(',').and_then(digits) {
        Some((_, rest)) => rest,
        None => s,
    }
}

/// `/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/`: the two start lines.
pub fn hunk_starts(raw: &str) -> Option<(f64, f64)> {
    let s = raw.strip_prefix("@@ -")?;
    let (left, s) = digits(s)?;
    let s = opt_count(s).strip_prefix(" +")?;
    let (right, s) = digits(s)?;
    opt_count(s).strip_prefix(" @@")?;
    // `Number("123")`: a digit string parses exactly as JS rounds it.
    Some((left.parse().ok()?, right.parse().ok()?))
}

/// `parseUnifiedDiff` (DiffViewer.tsx:26): the header lines as meta, each
/// `@@` its own row (resetting both counters), `+` / `-` / ` ` numbered,
/// an empty line skipped, anything else (`\ No newline…`) meta.
pub fn parse_unified_diff(diff: &str) -> Vec<Line> {
    let mut out = Vec::new();
    if diff.is_empty() {
        return out;
    }
    let mut left = 0f64;
    let mut right = 0f64;
    for raw in diff.split('\n') {
        if META_PREFIXES.iter().any(|p| raw.starts_with(p)) {
            out.push(Line::Meta { text: raw.into() });
            continue;
        }
        if let Some((l, r)) = hunk_starts(raw) {
            left = l;
            right = r;
            out.push(Line::Hunk { text: raw.into() });
            continue;
        }
        if let Some(t) = raw.strip_prefix('+') {
            out.push(Line::Add {
                text: t.into(),
                n: right,
            });
            right += 1.;
            continue;
        }
        if let Some(t) = raw.strip_prefix('-') {
            out.push(Line::Del {
                text: t.into(),
                n: left,
            });
            left += 1.;
            continue;
        }
        if let Some(t) = raw.strip_prefix(' ') {
            out.push(Line::Ctx {
                text: t.into(),
                ln: left,
                rn: right,
            });
            left += 1.;
            right += 1.;
            continue;
        }
        if raw.is_empty() {
            continue;
        }
        out.push(Line::Meta { text: raw.into() });
    }
    out
}

/// What the diff pane shows (DiffViewer.tsx:72): loading, the error, the
/// binary notice, "No textual changes.", or the rows.
#[derive(Clone, Debug, PartialEq)]
pub enum DiffView {
    Loading,
    Error(String),
    Binary,
    Empty,
    Rows(Vec<Line>),
}

/// The viewer's branches, in its order.
pub fn diff_view(diff: &str, binary: bool, loading: bool, error: Option<&str>) -> DiffView {
    if loading {
        return DiffView::Loading;
    }
    if let Some(e) = error.filter(|e| !e.is_empty()) {
        return DiffView::Error(e.into());
    }
    if binary {
        return DiffView::Binary;
    }
    let lines = parse_unified_diff(diff);
    if diff.is_empty() || lines.is_empty() {
        return DiffView::Empty;
    }
    DiffView::Rows(lines)
}
