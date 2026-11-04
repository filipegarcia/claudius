//! The `/doctor prompt-audit` report (D22): `lib/shared/prompt-audit.ts`'s
//! pure heuristics (`findStalePromptPatterns`, `extractReferencedPaths`,
//! `extractReferencedCommands`, `findInstructionContradictions`) and
//! `lib/server/prompt-audit.ts`'s `auditWorkspacePrompts`, which gathers a
//! workspace's CLAUDE.md scopes, project skills, DB agents and
//! `.claude/commands/*.md` and checks what they reference on disk.
//!
//! The TS regexes are fixed patterns, matched here by hand with JS
//! semantics: positions and slices in UTF-16 units, `\s` as JS whitespace,
//! `\w` / `\b` ASCII, and `/i` without `u`, which folds ASCII letters only
//! (V8's canonicalization never maps a non-ASCII unit to ASCII). Each regex
//! is leftmost-first with backtracking, and every alternative below is
//! written so that the first one that matches at a position is the one the
//! backtracker would take. Nothing here ever compiles input as a regex.
//! Replayed against the TS in `tests/prompt_audit_golden.rs`.

use std::collections::HashSet;

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};

use crate::claudemd::{self, ClaudeMdScope};
use crate::fs_list::{self, DirentKind};
use crate::skills::{self, SkillScope, Thrown};
use crate::{db_agents, js_string, node_fs, node_path, slash_commands};
use claudius_agent::js;

// ─────────────────────────────── regex pieces ───────────────────────────────

fn is_ws(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(js::is_whitespace)
}

fn is_word(u: u16) -> bool {
    u < 128 && (u as u8 == b'_' || (u as u8).is_ascii_alphanumeric())
}

/// The literal `lit` (ASCII) at `at`, ASCII letters in any case: where it
/// ends.
fn lit_i(t: &[u16], at: usize, lit: &str) -> Option<usize> {
    let end = at + lit.len();
    let ok = end <= t.len()
        && lit
            .bytes()
            .zip(&t[at..end])
            .all(|(b, &u)| u < 128 && (u as u8).eq_ignore_ascii_case(&b));
    ok.then_some(end)
}

/// `\s+` at `at`: where the run ends, if there is one.
fn ws1(t: &[u16], at: usize) -> Option<usize> {
    let end = at
        + t[at.min(t.len())..]
            .iter()
            .take_while(|&&u| is_ws(u))
            .count();
    (end > at).then_some(end)
}

/// `\b` at `at`.
fn boundary(t: &[u16], at: usize) -> bool {
    let before = at > 0 && is_word(t[at - 1]);
    let after = at < t.len() && is_word(t[at]);
    before != after
}

/// `[- ]`.
fn dash_or_space(t: &[u16], at: usize) -> Option<usize> {
    matches!(t.get(at), Some(&0x2d | &0x20)).then_some(at + 1)
}

/// `step[- ]by[- ]step`.
fn step_by_step(t: &[u16], at: usize) -> Option<usize> {
    let p = lit_i(t, at, "step")?;
    let p = dash_or_space(t, p)?;
    let p = lit_i(t, p, "by")?;
    let p = dash_or_space(t, p)?;
    lit_i(t, p, "step")
}

/// `(?:this|it)`.
fn this_or_it(t: &[u16], at: usize) -> Option<usize> {
    lit_i(t, at, "this").or_else(|| lit_i(t, at, "it"))
}

/// The `cot-scaffolding` pattern at `at`:
/// `think\s+(?:about (?:this|it) )?step[- ]by[- ]step|let'?s think (?:this
/// |it )?through carefully|work(?:ing)? through (?:this|it)
/// step[- ]by[- ]step`.
fn cot_at(t: &[u16], at: usize) -> Option<usize> {
    if let Some(p) = lit_i(t, at, "think").and_then(|p| ws1(t, p)) {
        let grouped = lit_i(t, p, "about ")
            .and_then(|q| this_or_it(t, q))
            .and_then(|q| lit_i(t, q, " "));
        if let Some(end) = grouped.and_then(|q| step_by_step(t, q)) {
            return Some(end);
        }
        if let Some(end) = step_by_step(t, p) {
            return Some(end);
        }
    }
    if let Some(p) = lit_i(t, at, "let") {
        let p = lit_i(t, p, "'").unwrap_or(p);
        if let Some(p) = lit_i(t, p, "s think ") {
            for q in [lit_i(t, p, "this "), lit_i(t, p, "it "), Some(p)]
                .into_iter()
                .flatten()
            {
                if let Some(end) = lit_i(t, q, "through carefully") {
                    return Some(end);
                }
            }
        }
    }
    if let Some(p) = lit_i(t, at, "work") {
        let p = lit_i(t, p, "ing").unwrap_or(p);
        let end = lit_i(t, p, " through ")
            .and_then(|q| this_or_it(t, q))
            .and_then(|q| lit_i(t, q, " "))
            .and_then(|q| step_by_step(t, q));
        if end.is_some() {
            return end;
        }
    }
    None
}

/// `(?:\s+(?:<a>|<b>))?` after `at`: where it ends (`at` when it doesn't
/// match).
fn opt_ws_then(t: &[u16], at: usize, words: &[&str]) -> usize {
    ws1(t, at)
        .and_then(|q| words.iter().find_map(|w| lit_i(t, q, w)))
        .unwrap_or(at)
}

/// The `legacy-persona` pattern at `at`: `you are (?:a |an
/// )?(?:helpful|friendly|knowledgeable)\s+AI\b(?:\s+(?:assistant|language
/// model))?|as an AI\b(?:\s+language model)?`.
fn persona_at(t: &[u16], at: usize) -> Option<usize> {
    if let Some(p) = lit_i(t, at, "you are ") {
        for q in [lit_i(t, p, "a "), lit_i(t, p, "an "), Some(p)]
            .into_iter()
            .flatten()
        {
            let ai = ["helpful", "friendly", "knowledgeable"]
                .iter()
                .find_map(|w| lit_i(t, q, w))
                .and_then(|r| ws1(t, r))
                .and_then(|r| lit_i(t, r, "AI"))
                .filter(|&r| boundary(t, r));
            if let Some(r) = ai {
                return Some(opt_ws_then(t, r, &["assistant", "language model"]));
            }
        }
    }
    let r = lit_i(t, at, "as an AI").filter(|&r| boundary(t, r))?;
    Some(opt_ws_then(t, r, &["language model"]))
}

/// The `deprecated-model-ref` pattern at `at`:
/// `\bclaude[- ](?:1|2|instant|3-(?:opus|sonnet|haiku))\b`.
fn model_ref_at(t: &[u16], at: usize) -> Option<usize> {
    if !boundary(t, at) {
        return None;
    }
    let p = lit_i(t, at, "claude")?;
    let p = dash_or_space(t, p)?;
    let three = lit_i(t, p, "3-").and_then(|q| {
        ["opus", "sonnet", "haiku"]
            .iter()
            .find_map(|w| lit_i(t, q, w))
    });
    [
        lit_i(t, p, "1"),
        lit_i(t, p, "2"),
        lit_i(t, p, "instant"),
        three,
    ]
    .into_iter()
    .flatten()
    .find(|&end| boundary(t, end))
}

// ─────────────────────────────── the patterns ───────────────────────────────

/// `PromptAuditPattern`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pattern {
    CotScaffolding,
    LegacyPersona,
    DeprecatedModelRef,
}

impl Pattern {
    pub fn as_str(self) -> &'static str {
        match self {
            Pattern::CotScaffolding => "cot-scaffolding",
            Pattern::LegacyPersona => "legacy-persona",
            Pattern::DeprecatedModelRef => "deprecated-model-ref",
        }
    }

    pub fn note(self) -> &'static str {
        match self {
            Pattern::CotScaffolding => {
                "chain-of-thought scaffolding — redundant with native extended thinking"
            }
            Pattern::LegacyPersona => "pre-Claude assistant-persona boilerplate",
            Pattern::DeprecatedModelRef => "reference to a retired Claude generation",
        }
    }

    fn match_at(self, t: &[u16], at: usize) -> Option<usize> {
        match self {
            Pattern::CotScaffolding => cot_at(t, at),
            Pattern::LegacyPersona => persona_at(t, at),
            Pattern::DeprecatedModelRef => model_ref_at(t, at),
        }
    }

    const ALL: [Pattern; 3] = [
        Pattern::CotScaffolding,
        Pattern::LegacyPersona,
        Pattern::DeprecatedModelRef,
    ];
}

/// `PromptAuditMatch`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    pub pattern: Pattern,
    /// ~80 UTF-16 units around the match (`js_string` stand-ins where the
    /// cut halves a surrogate pair).
    pub snippet: String,
}

/// `snippetAround(text, index, length)`.
fn snippet_around(t: &[u16], index: usize, length: usize) -> String {
    let start = index.saturating_sub(20);
    let end = t.len().min(index + length + 20);
    // `.replace(/\s+/g, " ").trim()`
    let mut collapsed: Vec<u16> = Vec::with_capacity(end - start);
    for &u in &t[start..end] {
        if is_ws(u) {
            if collapsed.last() != Some(&0x20) {
                collapsed.push(0x20);
            }
        } else {
            collapsed.push(u);
        }
    }
    let lead = collapsed.iter().take_while(|&&u| u == 0x20).count();
    let trail = collapsed[lead..]
        .iter()
        .rev()
        .take_while(|&&u| u == 0x20)
        .count();
    let body = js_string::from_units(&collapsed[lead..collapsed.len() - trail]);
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < t.len() { "…" } else { "" };
    format!("{prefix}{body}{suffix}")
}

/// `findStalePromptPatterns(text)`: every match of each pattern in turn.
pub fn find_stale_prompt_patterns(text: &str) -> Vec<Match> {
    let t = js_string::units(text);
    let mut out = Vec::new();
    for pattern in Pattern::ALL {
        let mut i = 0;
        while i < t.len() {
            match pattern.match_at(&t, i) {
                Some(end) => {
                    out.push(Match {
                        pattern,
                        snippet: snippet_around(&t, i, end - i),
                    });
                    i = end;
                }
                None => i += 1,
            }
        }
    }
    out
}

/// `` `([\w.\-]+(?:\/[\w.\-]+)+\.[A-Za-z0-9]{1,8})` ``'s group, for the
/// text between two backticks.
fn is_path_token(s: &[u8]) -> bool {
    let segs: Vec<&[u8]> = s.split(|&b| b == b'/').collect();
    if segs.len() < 2 || segs.iter().any(|g| g.is_empty()) {
        return false;
    }
    let last = segs[segs.len() - 1];
    // `[\w.\-]+\.[A-Za-z0-9]{1,8}`: the extension is what follows the last
    // dot, with something before it.
    match last.iter().rposition(|&b| b == b'.') {
        Some(dot) if dot > 0 => {
            let ext = &last[dot + 1..];
            (1..=8).contains(&ext.len()) && ext.iter().all(u8::is_ascii_alphanumeric)
        }
        _ => false,
    }
}

fn is_path_char(b: u8) -> bool {
    b == b'/' || b == b'.' || b == b'-' || b == b'_' || b.is_ascii_alphanumeric()
}

/// `extractReferencedPaths(text)`: backtick-quoted path-shaped tokens,
/// deduped in first-seen order.
pub fn extract_referenced_paths(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out: IndexSet<String> = IndexSet::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'`' {
            let end = i + 1 + b[i + 1..].iter().take_while(|&&c| is_path_char(c)).count();
            if b.get(end) == Some(&b'`') && is_path_token(&b[i + 1..end]) {
                out.insert(text[i + 1..end].to_owned());
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    out.into_iter().collect()
}

/// `extractReferencedCommands(text)`: `` `\/([a-z][\w-]*)(?: [^`]*)?` ``
/// names (no `mcp__…`), deduped in first-seen order.
pub fn extract_referenced_commands(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out: IndexSet<String> = IndexSet::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'`'
            && b.get(i + 1) == Some(&b'/')
            && b.get(i + 2).is_some_and(u8::is_ascii_lowercase)
        {
            let name_end = i
                + 3
                + b[i + 3..]
                    .iter()
                    .take_while(|&&c| c == b'_' || c == b'-' || c.is_ascii_alphanumeric())
                    .count();
            let close = match b.get(name_end) {
                Some(b'`') => Some(name_end),
                Some(b' ') => b[name_end..]
                    .iter()
                    .position(|&c| c == b'`')
                    .map(|p| name_end + p),
                _ => None,
            };
            if let Some(close) = close {
                let name = &text[i + 2..name_end];
                if !name.starts_with("mcp__") {
                    out.insert(name.to_owned());
                }
                i = close + 1;
                continue;
            }
        }
        i += 1;
    }
    out.into_iter().collect()
}

/// `\b<word>\b` (ASCII, any case) anywhere in `t` that `ok` accepts.
fn has_word(t: &[u16], word: &str, ok: impl Fn(usize) -> bool) -> bool {
    (0..t.len())
        .any(|i| boundary(t, i) && lit_i(t, i, word).is_some_and(|end| boundary(t, end) && ok(end)))
}

/// `POSITIVE_DIRECTIVE_RE.test(s)`: `\balways\b|\bmust\b(?! not)|\bonly use\b`.
fn positive_directive(t: &[u16]) -> bool {
    has_word(t, "always", |_| true)
        || has_word(t, "must", |end| lit_i(t, end, " not").is_none())
        || has_word(t, "only use", |_| true)
}

/// `NEGATIVE_DIRECTIVE_RE.test(s)`:
/// `\bnever\b|\bdon'?t\b|\bdo not\b|\bmust not\b|\bavoid\b`.
fn negative_directive(t: &[u16]) -> bool {
    has_word(t, "never", |_| true)
        || has_word(t, "don't", |_| true)
        || has_word(t, "dont", |_| true)
        || has_word(t, "do not", |_| true)
        || has_word(t, "must not", |_| true)
        || has_word(t, "avoid", |_| true)
}

/// `InstructionContradiction`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contradiction {
    pub token: String,
    pub sources: Vec<String>,
}

/// JS `Array.prototype.sort()` on strings: by UTF-16 code units.
fn utf16_sort(v: &mut [String]) {
    v.sort_by_cached_key(|a| js_string::units(a));
}

/// `findInstructionContradictions(sources)`: backtick tokens given opposite
/// directives (per sentence, split on `.`, `;`, `\n`) in two different
/// sources, in first-seen token order.
pub fn find_instruction_contradictions(sources: &[(String, String)]) -> Vec<Contradiction> {
    let mut by_token: IndexMap<String, (IndexSet<String>, IndexSet<String>)> = IndexMap::new();
    for (id, text) in sources {
        if text.is_empty() {
            continue;
        }
        for sentence in text.split(['.', ';', '\n']) {
            let t = js_string::units(sentence);
            let pos = positive_directive(&t);
            let neg = negative_directive(&t);
            if pos == neg {
                continue;
            }
            let b = sentence.as_bytes();
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'`'
                    && let Some(len) = b[i + 1..].iter().position(|&c| c == b'`')
                    && len > 0
                {
                    let token = js::trim(&sentence[i + 1..i + 1 + len]);
                    if !token.is_empty() {
                        let entry = by_token.entry(token.to_owned()).or_default();
                        if pos { &mut entry.0 } else { &mut entry.1 }.insert(id.clone());
                    }
                    i += len + 2;
                    continue;
                }
                i += 1;
            }
        }
    }
    let mut out = Vec::new();
    for (token, (pos, neg)) in by_token {
        let conflict = pos.iter().any(|p| neg.iter().any(|n| n != p));
        if conflict {
            let mut ids: Vec<String> = pos
                .into_iter()
                .chain(neg)
                .collect::<IndexSet<_>>()
                .into_iter()
                .collect();
            utf16_sort(&mut ids);
            out.push(Contradiction {
                token,
                sources: ids,
            });
        }
    }
    out
}

// ─────────────────────────────── the audit ───────────────────────────────

/// `PromptAuditSourceKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SourceKind {
    ClaudeMd,
    Skill,
    Agent,
    Command,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::ClaudeMd => "claude-md",
            SourceKind::Skill => "skill",
            SourceKind::Agent => "agent",
            SourceKind::Command => "command",
        }
    }
}

/// `PromptAuditSource`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub kind: SourceKind,
    pub name: String,
}

impl Source {
    /// `${kind}:${name}`.
    pub fn id(&self) -> String {
        format!("{}:{}", self.kind.as_str(), self.name)
    }

    fn to_json(&self) -> Value {
        json!({"kind": self.kind.as_str(), "name": self.name})
    }
}

/// `PromptAuditFinding`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub found: Match,
    pub source: Source,
}

/// `PromptAuditReport`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub findings: Vec<Finding>,
    /// `(source, path)`.
    pub stale_paths: Vec<(Source, String)>,
    /// `(source, command)`.
    pub stale_commands: Vec<(Source, String)>,
    /// `(token, sources)`.
    pub contradictions: Vec<(String, Vec<Source>)>,
    pub had_sources: bool,
}

impl Report {
    /// The report object, in the TS key order.
    pub fn to_json(&self) -> Value {
        let findings: Vec<Value> = self
            .findings
            .iter()
            .map(|f| {
                json!({"pattern": f.found.pattern.as_str(), "note": f.found.pattern.note(),
                    "snippet": f.found.snippet, "source": f.source.to_json()})
            })
            .collect();
        let pairs = |v: &[(Source, String)], key: &str| -> Vec<Value> {
            v.iter()
                .map(|(s, x)| {
                    let mut m = Map::new();
                    m.insert("source".into(), s.to_json());
                    m.insert(key.into(), json!(x));
                    Value::Object(m)
                })
                .collect()
        };
        let contradictions: Vec<Value> = self
            .contradictions
            .iter()
            .map(|(t, s)| json!({"token": t, "sources": s.iter().map(Source::to_json).collect::<Vec<_>>()}))
            .collect();
        json!({
            "findings": findings,
            "stalePaths": pairs(&self.stale_paths, "path"),
            "staleCommands": pairs(&self.stale_commands, "command"),
            "contradictions": contradictions,
            "hadSources": self.had_sources,
        })
    }
}

/// `pathReferenceExists(root, candidate)`: a reference that resolves
/// outside the workspace (or that `assertWithin` refuses) counts as
/// present; inside it, whether `fs.access` finds it (through symlinks).
fn path_reference_exists(root: &str, candidate: &str) -> bool {
    let Ok(resolved) = crate::safe_path::assert_within(root, candidate) else {
        return true;
    };
    let base = node_path::resolve(&[root]);
    if resolved != base && !resolved.starts_with(&format!("{base}/")) {
        return true;
    }
    node_fs::access(&resolved, node_fs::F_OK).is_ok()
}

/// JS `toLowerCase()`.
fn to_lower(s: &str) -> String {
    // Whole-string, for the final-sigma rule; the `js_string` stand-ins
    // (private use) map to themselves.
    s.to_lowercase()
}

/// `listCommandFiles(cwd)`: `.claude/commands/*.md` regular files (any case
/// of `.md`), in readdir order; one that can't be read is skipped.
fn list_command_files(cwd: &str) -> Vec<(String, String)> {
    let dir = node_path::join(&[cwd, ".claude", "commands"]);
    let Ok(entries) = fs_list::read_dir(&dir) else {
        return Vec::new();
    };
    let base = node_path::resolve(&[&dir]);
    let mut out = Vec::new();
    for entry in entries {
        if entry.kind != DirentKind::File || !to_lower(&entry.name).ends_with(".md") {
            continue;
        }
        let target = node_path::resolve(&[&base, &entry.name]);
        if target != base && !target.starts_with(&format!("{base}/")) {
            continue;
        }
        if let Ok(body) = node_fs::read_to_string(&target) {
            out.push((entry.name, body));
        }
    }
    out
}

/// `commandBasenames(dir)`: every entry named `*.md` (any case, any type),
/// without the last 3 UTF-16 units.
fn command_basenames(dir: &str) -> Vec<String> {
    let Ok(names) = node_fs::readdir(dir) else {
        return Vec::new();
    };
    names
        .into_iter()
        .filter(|n| to_lower(n).ends_with(".md"))
        .map(|n| {
            let u = js_string::units(&n);
            js_string::from_units(&u[..u.len().saturating_sub(3)])
        })
        .collect()
}

/// `auditWorkspacePrompts(cwd)`, with `homedir()` as `home`. It throws
/// where a CLAUDE.md scope read throws (the doctor then skips the
/// workspace); skills and agents that fail to list are left out.
pub fn audit_workspace_prompts(home: &str, cwd: &str) -> Result<Report, Thrown> {
    let mut sources: Vec<(Source, String)> = Vec::new();
    for scope in [
        ClaudeMdScope::Project,
        ClaudeMdScope::ProjectClaude,
        ClaudeMdScope::Local,
    ] {
        let f = claudemd::read_scope(home, scope, cwd)?;
        if f.exists && !js::trim(&f.content).is_empty() {
            sources.push((
                Source {
                    kind: SourceKind::ClaudeMd,
                    name: scope.as_str().into(),
                },
                f.content,
            ));
        }
    }
    if let Ok(list) = skills::list_skills(home, SkillScope::Project, cwd) {
        for s in list {
            sources.push((
                Source {
                    kind: SourceKind::Skill,
                    name: s.name,
                },
                s.raw,
            ));
        }
    }
    for row in db_agents::list_db_agents(cwd) {
        let def = &row["definition"];
        // Both are non-blank strings (`coerceAgentDefinition`), so
        // `[d, p].filter(Boolean).join("\n\n")` is never blank.
        let text = [&def["description"], &def["prompt"]]
            .into_iter()
            .filter(|v| js::truthy(v))
            .map(|v| js_string::to_js_string(v).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !js::trim(&text).is_empty() {
            sources.push((
                Source {
                    kind: SourceKind::Agent,
                    name: js_string::to_js_string(&row["name"]).unwrap_or_default(),
                },
                text,
            ));
        }
    }
    for (name, body) in list_command_files(cwd) {
        sources.push((
            Source {
                kind: SourceKind::Command,
                name,
            },
            body,
        ));
    }

    let mut valid: HashSet<String> = HashSet::new();
    for dir in [
        node_path::join(&[cwd, ".claude", "commands"]),
        node_path::join(&[home, ".claude", "commands"]),
    ] {
        for n in command_basenames(&dir) {
            valid.insert(to_lower(&n));
        }
    }
    for scope in [SkillScope::Project, SkillScope::User] {
        if let Ok(list) = skills::list_skills(home, scope, cwd) {
            for s in list.iter().filter(|s| !s.not_offered) {
                valid.insert(to_lower(&s.name));
            }
        }
    }
    let known = |name: &str| {
        slash_commands::find_slash_command(name).is_some() || valid.contains(&to_lower(name))
    };

    let mut report = Report::default();
    for (source, text) in &sources {
        for found in find_stale_prompt_patterns(text) {
            report.findings.push(Finding {
                found,
                source: source.clone(),
            });
        }
        for cmd in extract_referenced_commands(text) {
            if !known(&cmd) {
                report.stale_commands.push((source.clone(), cmd));
            }
        }
        if source.kind == SourceKind::ClaudeMd {
            for p in extract_referenced_paths(text) {
                if !path_reference_exists(cwd, &p) {
                    report.stale_paths.push((source.clone(), p));
                }
            }
        }
    }

    let mut with_user = sources.clone();
    let user = claudemd::read_scope(home, ClaudeMdScope::User, cwd)?;
    if user.exists && !js::trim(&user.content).is_empty() {
        with_user.push((
            Source {
                kind: SourceKind::ClaudeMd,
                name: "user".into(),
            },
            user.content,
        ));
    }
    let mut by_id: std::collections::HashMap<String, Source> = std::collections::HashMap::new();
    for (s, _) in &with_user {
        by_id.insert(s.id(), s.clone());
    }
    let ids: Vec<(String, String)> = with_user
        .iter()
        .map(|(s, text)| (s.id(), text.clone()))
        .collect();
    for c in find_instruction_contradictions(&ids) {
        let srcs = c
            .sources
            .iter()
            .filter_map(|id| by_id.get(id).cloned())
            .collect();
        report.contradictions.push((c.token, srcs));
    }
    report.had_sources = !sources.is_empty();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pats(text: &str) -> Vec<(&'static str, String)> {
        find_stale_prompt_patterns(text)
            .into_iter()
            .map(|m| (m.pattern.as_str(), m.snippet))
            .collect()
    }

    #[test]
    fn patterns() {
        assert_eq!(
            pats("Think step by step."),
            [("cot-scaffolding", "Think step by step.".to_owned())]
        );
        assert_eq!(
            pats("think\u{a0}about it step-by-step"),
            [("cot-scaffolding", "think about it step-by-step".to_owned())]
        );
        assert!(pats("think hard").is_empty());
        assert_eq!(pats("You are a helpful AI assistant").len(), 1);
        assert!(pats("as an aid").is_empty());
        assert_eq!(pats("use claude-2 or claude 3-opus").len(), 2);
        assert!(pats("claude-10").is_empty());
    }

    #[test]
    fn references() {
        assert_eq!(
            extract_referenced_paths("see `a/b.ts` and `x` `c/d.e`"),
            ["a/b.ts", "c/d.e"]
        );
        assert!(extract_referenced_paths("`a/b` `a//b.ts` `a/.ts`").is_empty());
        assert_eq!(
            extract_referenced_commands("`/compact now` `/api/x` `/mcp__x` `/Ab`"),
            ["compact"]
        );
    }

    #[test]
    fn contradictions() {
        let c = find_instruction_contradictions(&[
            ("b".into(), "Always use `pnpm`.".into()),
            ("a".into(), "Never use `pnpm`; must not `x`".into()),
        ]);
        assert_eq!(
            c,
            [Contradiction {
                token: "pnpm".into(),
                sources: vec!["a".into(), "b".into()]
            }]
        );
    }
}
