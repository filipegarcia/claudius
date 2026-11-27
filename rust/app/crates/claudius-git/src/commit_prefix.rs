//! `lib/shared/commit-prefix.ts`: a commit-message prefix from the branch
//! name. The TS compiles the `{name}` pattern into a `RegExp`; this matches
//! the same language by hand (no regex is ever built from the config),
//! with the engine's backtracking order: greedy captures longest first,
//! the optional tail tried before skipping it. JS regexes without the `u`
//! flag see UTF-16 code units, and so does this.

use crate::types::{CommitPrefixConfig, js_trim};

/// One `{name}` match of `PLACEHOLDER_RE` (`/\{(\w+)\}/g`) in UTF-16 units:
/// its start, its end (past the `}`) and the name.
fn placeholders(s: &[u16]) -> Vec<(usize, usize, Vec<u16>)> {
    let word = |u: u16| u < 128 && (u as u8 == b'_' || (u as u8).is_ascii_alphanumeric());
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] == u16::from(b'{') {
            let mut j = i + 1;
            while j < s.len() && word(s[j]) {
                j += 1;
            }
            if j > i + 1 && j < s.len() && s[j] == u16::from(b'}') {
                out.push((i, j + 1, s[i + 1..j].to_vec()));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Node {
    /// An escaped literal.
    Lit(Vec<u16>),
    /// `(?<name>[^/-]+)`, or `(?<name>.+)` for the last placeholder.
    Cap { idx: usize, last: bool },
    /// `(?:…)?`: the trailing run when there are two placeholders or more.
    Opt(Vec<Node>),
}

/// A compiled pattern: `^…$` over [`Node`]s, and the placeholder names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Compiled {
    nodes: Vec<Node>,
    names: Vec<String>,
}

impl Compiled {
    pub fn names(&self) -> &[String] {
        &self.names
    }
}

/// `compilePattern` (commit-prefix.ts:39): `None` for no placeholder, a
/// repeated name, or one `new RegExp` rejects (a group name starting with
/// a digit).
pub fn compile_pattern(pattern: &str) -> Option<Compiled> {
    let s: Vec<u16> = pattern.encode_utf16().collect();
    let found = placeholders(&s);
    if found.is_empty() {
        return None;
    }
    let mut names: Vec<Vec<u16>> = Vec::new();
    for (_, _, name) in &found {
        if names.contains(name) {
            return None;
        }
        names.push(name.clone());
    }
    let n = found.len();
    let mut nodes = Vec::new();
    let mut last_index = 0;
    // Where the trailing run (the literal before the last placeholder
    // onwards) starts in `nodes`.
    let mut trailing_start = 0;
    for (i, (start, end, _)) in found.iter().enumerate() {
        trailing_start = nodes.len();
        if *start > last_index {
            nodes.push(Node::Lit(s[last_index..*start].to_vec()));
        }
        nodes.push(Node::Cap {
            idx: i,
            last: i == n - 1,
        });
        last_index = *end;
    }
    if last_index < s.len() {
        nodes.push(Node::Lit(s[last_index..].to_vec()));
    }
    if n >= 2 {
        let tail = nodes.split_off(trailing_start);
        nodes.push(Node::Opt(tail));
    }
    // `(?<1>…)` is a SyntaxError: group names are identifiers.
    if names
        .iter()
        .any(|n| n.first().is_some_and(|u| (0x30..=0x39).contains(u)))
    {
        return None;
    }
    Some(Compiled {
        nodes,
        names: names.iter().map(|n| String::from_utf16_lossy(n)).collect(),
    })
}

/// `.` without the `s` flag: anything but a line terminator.
fn dot(u: u16) -> bool {
    !matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// `[^/-]`.
fn not_separator(u: u16) -> bool {
    u != u16::from(b'/') && u != u16::from(b'-')
}

type Caps = Vec<Option<(usize, usize)>>;

/// Matches `nodes` then the continuations in `rest` (innermost last), then
/// `$`, depth first in the backtracking engine's order.
fn run<'n>(
    nodes: &'n [Node],
    rest: &mut Vec<&'n [Node]>,
    s: &[u16],
    pos: usize,
    caps: &mut Caps,
) -> bool {
    let Some((first, tail)) = nodes.split_first() else {
        let Some(next) = rest.pop() else {
            return pos == s.len();
        };
        let ok = run(next, rest, s, pos, caps);
        rest.push(next);
        return ok;
    };
    match first {
        Node::Lit(lit) => s[pos..].starts_with(lit) && run(tail, rest, s, pos + lit.len(), caps),
        Node::Cap { idx, last } => {
            let class: fn(u16) -> bool = if *last { dot } else { not_separator };
            let max = s[pos..].iter().take_while(|u| class(**u)).count();
            let saved = caps[*idx];
            for len in (1..=max).rev() {
                caps[*idx] = Some((pos, pos + len));
                if run(tail, rest, s, pos + len, caps) {
                    return true;
                }
            }
            caps[*idx] = saved;
            false
        }
        Node::Opt(inner) => {
            let saved = caps.clone();
            rest.push(tail);
            let took = run(inner, rest, s, pos, caps);
            rest.pop();
            if took {
                return true;
            }
            *caps = saved;
            run(tail, rest, s, pos, caps)
        }
    }
}

impl Compiled {
    /// `re.exec(branch)`: each name's capture (`None` when its optional
    /// group didn't take part), or `None` for no match.
    pub fn exec(&self, branch: &str) -> Option<Vec<(String, Option<String>)>> {
        let s: Vec<u16> = branch.encode_utf16().collect();
        let mut caps: Caps = vec![None; self.names.len()];
        if !run(&self.nodes, &mut Vec::new(), &s, 0, &mut caps) {
            return None;
        }
        Some(
            self.names
                .iter()
                .zip(caps)
                .map(|(n, c)| {
                    (
                        n.clone(),
                        c.map(|(a, b)| String::from_utf16_lossy(&s[a..b])),
                    )
                })
                .collect(),
        )
    }
}

/// `renderCommitPrefix` (commit-prefix.ts:93): the template with each
/// known placeholder replaced by its capture (`""` when unmatched), an
/// unknown one kept as written; `None` when disabled, unset, malformed or
/// the branch doesn't match.
pub fn render_commit_prefix(
    branch: Option<&str>,
    config: Option<&CommitPrefixConfig>,
) -> Option<String> {
    let config = config.filter(|c| c.enabled)?;
    let branch = branch.filter(|b| !b.is_empty())?;
    if js_trim(&config.branch_pattern).is_empty() || config.template.is_empty() {
        return None;
    }
    let groups = compile_pattern(&config.branch_pattern)?.exec(branch)?;
    let t: Vec<u16> = config.template.encode_utf16().collect();
    let mut out: Vec<u16> = Vec::new();
    let mut at = 0;
    for (start, end, name) in placeholders(&t) {
        out.extend_from_slice(&t[at..start]);
        let name = String::from_utf16_lossy(&name);
        match groups.iter().find(|(n, _)| *n == name) {
            Some((_, v)) => out.extend(v.as_deref().unwrap_or_default().encode_utf16()),
            None => out.extend_from_slice(&t[start..end]),
        }
        at = end;
    }
    out.extend_from_slice(&t[at..]);
    Some(String::from_utf16_lossy(&out))
}
