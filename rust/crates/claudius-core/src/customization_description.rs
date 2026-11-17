//! The LLM-written "feature description" of a customization: port of
//! `lib/server/customization-description.ts` (D14).
//!
//! [`describe_customization`] feeds one tool-less, single-turn query two
//! things: a unified diff of the files the user edited (the `git diff
//! --no-index` of each user-verdict entry of [`crate::customization_sync`])
//! and the user's own chat messages from the sessions indexed under the
//! mirror, newest first. [`diff_hash_for`] is the stale check behind the
//! UI's "Regenerate": a SHA-256 over the same user-verdict slice.
//!
//! Both texts are cut to a budget in UTF-16 units, as JS cuts them; a cut
//! through a surrogate pair drops that unit (a Rust string can't hold a lone
//! surrogate), which is the one difference here.
//!
//! The `git` run is `execFile`-shaped (no cwd, 10 s, 16 MiB): exit 0 or 1 is
//! the diff, anything else (a spawn error, a timeout, an overflow) is no
//! diff for that file.

use std::path::PathBuf;

use claudius_agent::{Options, SystemPrompt, Tools, js, oneshot};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;

use crate::customization_sync::{SyncEntry, SyncStatus, Verdict, compute_sync_status};
use crate::customizations::Store;
use crate::{git, js_string, node_path, sessions_db, sessions_store};

/// `SYSTEM_PROMPT`, verbatim.
pub const SYSTEM_PROMPT: &str = "You write concise, plain-prose descriptions of user-authored modifications to a codebase (\"customizations\").\n\nYou will receive two inputs:\n  1. A unified diff of files the USER EDITED in their customization \u{2014} already filtered to remove unrelated upstream drift, so every change you see is the user's own work.\n  2. The user's own chat messages from the workspace where they made these changes \u{2014} these capture WHY they wanted the change.\n\nRules:\n- Output ONLY the description. No preamble, no quotes, no markdown headers, no code fences.\n- Decide first: is this ONE cohesive feature, or SEVERAL distinct concerns?\n  \u{2022} One feature \u{2192} 2\u{2013}3 sentences describing what it does and (if clear from chat) why.\n  \u{2022} Multiple features \u{2192} start with a single sentence saying so (\"This customization bundles N changes:\"), then one short sentence per feature. Stay under ~5 sentences total.\n- Use the user's own words / phrasing when it captures intent well.\n- Don't list files. Don't mention diffs or chat verbatim.\n- If the changes are trivial or unclear, say so honestly in one sentence.";

/// `MAX_DIFF_CHARS`, in UTF-16 units.
const MAX_DIFF_CHARS: usize = 150_000;

/// `MAX_INTENT_CHARS`.
const MAX_INTENT_CHARS: usize = 50_000;

/// `MAX_SESSIONS`.
const MAX_SESSIONS: usize = 50;

/// `git diff --no-index`'s limits (`execFile`'s defaults here).
const GIT_TIMEOUT_MS: u64 = 10_000;
const GIT_MAX_BUFFER: usize = 16 * 1024 * 1024;

/// `DescribeResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Described {
    Ok {
        description: String,
        diff_hash: String,
    },
    Err(String),
}

fn units(s: &str) -> usize {
    js_string::len16(s)
}

/// `s.slice(0, n)` in UTF-16 units. A cut inside a surrogate pair drops the
/// unit JS would have kept as a lone surrogate.
fn utf16_head(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        used += if js_string::lone_unit(c).is_some() {
            1
        } else {
            c.len_utf16()
        };
        if used > n {
            return &s[..i];
        }
    }
    s
}

/// `piece.length > remaining ? piece.slice(0, remaining) + "\n[\u{2026}]\n" : piece`.
fn cap_piece(piece: &str, remaining: usize) -> String {
    if units(piece) > remaining {
        format!("{}\n[\u{2026}]\n", utf16_head(piece, remaining))
    } else {
        piece.to_owned()
    }
}

/// `userEditedFiles(entries)`: the `USER_VERDICTS` slice, in status order.
fn user_edited(status: &SyncStatus) -> Vec<&SyncEntry> {
    status
        .entries
        .iter()
        .filter(|e| e.verdict.is_user())
        .collect()
}

/// `hash.update(v)` for a manifest value that isn't a string: Node's
/// `ERR_INVALID_ARG_TYPE` for `createHash().update`.
fn update_type_error(v: &Value) -> anyhow::Error {
    let received = match v {
        Value::Bool(b) => format!("type boolean ({b})"),
        Value::Number(n) => format!(
            "type number ({})",
            js::number_to_string(n.as_f64().unwrap_or(f64::NAN))
        ),
        Value::Array(_) => "an instance of Array".to_owned(),
        _ => "an instance of Object".to_owned(),
    };
    anyhow::anyhow!(
        "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received {received}"
    )
}

/// The SHA-256 of the user-edited slice of `status`: `verdict \0 path \0
/// customHash \0 manifestHash \n` per entry (a missing hash empty). A
/// manifest value that isn't a string or `null` is the `update` TypeError.
pub fn diff_hash_of(status: &SyncStatus) -> anyhow::Result<String> {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    for f in user_edited(status) {
        let manifest = match &f.manifest_hash {
            Value::Null => "",
            Value::String(s) => s,
            other => return Err(update_type_error(other)),
        };
        for part in [
            f.verdict.as_str(),
            "\0",
            &f.path,
            "\0",
            f.custom_hash.as_deref().unwrap_or(""),
            "\0",
            manifest,
            "\n",
        ] {
            ctx.update(js_string::lossy(part).as_bytes());
        }
    }
    Ok(ctx
        .finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// `diffHashFor(id)`: [`compute_sync_status`] then [`diff_hash_of`].
pub fn diff_hash_for(store: &Store, live: &str, id: &str) -> anyhow::Result<String> {
    diff_hash_of(&compute_sync_status(store, live, id)?)
}

/// What [`describe_customization`] needs beyond the store: the CLI binary
/// the host runs (TS lets the SDK find it).
#[derive(Clone, Debug, Default)]
pub struct DescribeEnv {
    pub claude_bin: Option<PathBuf>,
}

/// `describeCustomization(id)`: the one-shot query's text, with the diff
/// hash it was made from. A missing record, no user-authored changes, a
/// non-success result, an empty answer and anything the query throws are
/// `Err` as the TS reports them; a [`compute_sync_status`] failure before
/// the query propagates (the route's bare 500), as in TS.
pub async fn describe_customization(
    store: &Store,
    live: &str,
    id: &str,
    env: &DescribeEnv,
) -> anyhow::Result<Described> {
    if store.get_customization(id)?.is_none() {
        return Ok(Described::Err("customization not found".to_owned()));
    }
    let status = compute_sync_status(store, live, id)?;
    if user_edited(&status).is_empty() {
        return Ok(Described::Err(
            "no user-authored changes to describe".to_owned(),
        ));
    }
    let src = store.customization_src_dir(id);
    let diff = build_unified_diff(live, &src, &status).await;
    let intent = collect_user_intent(&src);
    let prompt = compose_prompt(&diff, &intent);
    let options = Options {
        cwd: Some(PathBuf::from(&src)),
        system_prompt: Some(SystemPrompt::Custom {
            prompt: SYSTEM_PROMPT.to_owned(),
            snapshot: None,
        }),
        tools: Some(Tools::List(vec![])),
        permission_mode: Some("bypassPermissions".to_owned()),
        max_turns: Some(1.0),
        verbatim_prompts: true,
        path_to_claude_code_executable: env.claude_bin.clone(),
        ..Default::default()
    };
    let msg = match oneshot(&prompt, options).await {
        Ok(msg) => msg,
        Err(e) => return Ok(Described::Err(e.to_string())),
    };
    let Some(msg) = msg else {
        return Ok(Described::Err("no result from claude".to_owned()));
    };
    let subtype = msg.get("subtype");
    if subtype.map(|s| s == "success") != Some(true) {
        let text = match subtype {
            Some(v) => js_string::to_js_string(v)
                .unwrap_or_else(|_| "Cannot convert object to primitive value".to_owned()),
            None => "undefined".to_owned(),
        };
        return Ok(Described::Err(format!("claude returned {text}")));
    }
    // `msg.result.trim()`: the TypeError of a result that isn't a string.
    let text = match msg.get("result") {
        Some(Value::String(s)) => strip_fences(js::trim(s)),
        Some(Value::Null) => {
            return Ok(Described::Err(
                "Cannot read properties of null (reading 'trim')".to_owned(),
            ));
        }
        Some(_) => {
            return Ok(Described::Err(
                "msg.result.trim is not a function".to_owned(),
            ));
        }
        None => {
            return Ok(Described::Err(
                "Cannot read properties of undefined (reading 'trim')".to_owned(),
            ));
        }
    };
    if text.is_empty() {
        return Ok(Described::Err("claude returned empty text".to_owned()));
    }
    // The second walk is inside the TS `try`, so its error is the result.
    match diff_hash_for(store, live, id) {
        Ok(diff_hash) => Ok(Described::Ok {
            description: text,
            diff_hash,
        }),
        Err(e) => Ok(Described::Err(format!("{e}"))),
    }
}

/// `composePrompt(diff, intent)`.
pub fn compose_prompt(diff: &str, intent: &str) -> String {
    let block = if js::trim(intent).is_empty() {
        "USER INTENT (from chat): no chat history available.".to_owned()
    } else {
        format!("USER INTENT (from chat \u{2014} user messages only, newest first):\n{intent}")
    };
    format!("Describe the following customization.\n\nCHANGES (unified diff):\n{diff}\n\n{block}")
}

/// `buildUnifiedDiff(id, files)`: each user-edited file's `git diff
/// --no-index`, joined with a newline, to [`MAX_DIFF_CHARS`].
async fn build_unified_diff(live: &str, src: &str, status: &SyncStatus) -> String {
    let mut chunks: Vec<String> = Vec::new();
    let mut total = 0;
    for f in user_edited(status) {
        if total >= MAX_DIFF_CHARS {
            chunks.push("\n[diff truncated \u{2014} remaining files omitted]\n".to_owned());
            break;
        }
        let (a, b) = match f.verdict {
            Verdict::NewUser => ("/dev/null".to_owned(), node_path::join(&[src, &f.path])),
            Verdict::DeletedUser => (node_path::join(&[live, &f.path]), "/dev/null".to_owned()),
            _ => (
                node_path::join(&[live, &f.path]),
                node_path::join(&[src, &f.path]),
            ),
        };
        let piece = git_diff_no_index(&a, &b).await;
        if piece.is_empty() {
            continue;
        }
        let trimmed = cap_piece(&piece, MAX_DIFF_CHARS - total);
        total += units(&trimmed);
        chunks.push(trimmed);
    }
    chunks.join("\n")
}

/// `gitDiffNoIndex(a, b)`: the stdout of `git diff --no-index --no-color --
/// a b` when it exits 0 or 1 (differing files are exit 1), else `""`.
async fn git_diff_no_index(a: &str, b: &str) -> String {
    let args = ["diff", "--no-index", "--no-color", "--", a, b];
    let run = git::spawn_run(
        "git",
        &args,
        None,
        None,
        std::time::Duration::from_millis(GIT_TIMEOUT_MS),
        GIT_MAX_BUFFER,
    )
    .await;
    match run {
        Ok(run) if matches!(run.exit, git::Exit::Code(0 | 1)) => run.stdout,
        _ => String::new(),
    }
}

/// `collectUserIntent(id)`: the user-typed text of every indexed session of
/// the mirror, newest first (the index's order), to [`MAX_INTENT_CHARS`].
fn collect_user_intent(src: &str) -> String {
    let sessions = sessions_db::list_indexed_sessions(src).unwrap_or_default();
    if sessions.is_empty() {
        return String::new();
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut total = 0;
    for s in sessions.iter().take(MAX_SESSIONS) {
        if total >= MAX_INTENT_CHARS {
            break;
        }
        // The SDK reads a transcript only for a UUID string id.
        let msgs = match s.id.as_str() {
            Some(id) => sessions_store::messages(id, Some(src), false),
            None => Vec::new(),
        };
        let mut texts: Vec<String> = Vec::new();
        for m in &msgs {
            if m.get("type").and_then(Value::as_str) != Some("user") {
                continue;
            }
            let text = extract_user_text(m.get("message"));
            if text.is_empty() {
                continue;
            }
            texts.push(text);
        }
        if texts.is_empty() {
            continue;
        }
        let title = if s.title == crate::asset_list::Cell::Null {
            s.id.to_js_string()
        } else {
            s.title.to_js_string()
        };
        let piece = format!(
            "\u{2500}\u{2500} {title} \u{2500}\u{2500}\n{}\n",
            texts.join("\n\n")
        );
        let trimmed = cap_piece(&piece, MAX_INTENT_CHARS - total);
        total += units(&trimmed);
        chunks.push(trimmed);
    }
    chunks.join("\n")
}

/// `extractUserText(message)`: the human-typed text of an SDK user message,
/// reminders and bash-IO blocks stripped. A `role` that is truthy and not
/// `"user"`, and content that is neither a string nor an array, are `""`.
pub fn extract_user_text(message: Option<&Value>) -> String {
    let Some(Value::Object(m)) = message else {
        return String::new();
    };
    if let Some(role) = m.get("role")
        && js::truthy(role)
        && role != "user"
    {
        return String::new();
    }
    match m.get("content") {
        Some(Value::String(c)) => clean_bash_blocks(&clean_reminders(js::trim(c))),
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<String> = Vec::new();
            for b in blocks {
                if b.get("type").map(|t| t == "text") != Some(true) {
                    continue;
                }
                if let Some(Value::String(t)) = b.get("text") {
                    let cleaned = clean_bash_blocks(&clean_reminders(js::trim(t)));
                    if !cleaned.is_empty() {
                        parts.push(cleaned);
                    }
                }
            }
            js::trim(&parts.join("\n")).to_owned()
        }
        _ => String::new(),
    }
}

/// Remove every `<open>…<close>` run, each `close` the first one after its
/// `open` (the lazy `[\s\S]*?` of the TS regexes), left to right.
fn strip_pairs(s: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find(open) {
        let after = &rest[at + open.len()..];
        let Some(end) = after.find(close) else { break };
        out.push_str(&rest[..at]);
        rest = &after[end + close.len()..];
    }
    out.push_str(rest);
    out
}

/// `cleanReminders(s)`.
pub fn clean_reminders(s: &str) -> String {
    js::trim(&strip_pairs(s, "<system-reminder>", "</system-reminder>")).to_owned()
}

/// `cleanBashBlocks(s)`: the `<bash-input>`/`<bash-stdout>`/`<bash-stderr>`
/// run, with an optional newline between the parts. Each `[\s\S]*?` is
/// lazy but backtracks, so a section's close tag is the first one the whole
/// run can be built from, not simply the first one.
pub fn clean_bash_blocks(s: &str) -> String {
    const OPEN: &str = "<bash-input>";
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    while let Some(at) = s[pos..].find(OPEN) {
        let start = pos + at;
        match match_run(s, start + OPEN.len(), 0) {
            Some(end) => {
                out.push_str(&s[pos..start]);
                pos = end;
            }
            // No run here: the regex moves on past this `<bash-input>`
            // (no match can start inside the tag).
            None => {
                out.push_str(&s[pos..start + OPEN.len()]);
                pos = start + OPEN.len();
            }
        }
    }
    out.push_str(&s[pos..]);
    js::trim(&out).to_owned()
}

/// The end of the bash run that starts at `from` (just past section
/// `idx`'s open tag), or `None`.
fn match_run(s: &str, from: usize, idx: usize) -> Option<usize> {
    const SECTIONS: [(&str, &str); 3] = [
        ("</bash-input>", "<bash-stdout>"),
        ("</bash-stdout>", "<bash-stderr>"),
        ("</bash-stderr>", ""),
    ];
    let (close, next_open) = SECTIONS[idx];
    let mut cursor = from;
    while let Some(at) = s[cursor..].find(close) {
        let end = cursor + at + close.len();
        if next_open.is_empty() {
            return Some(end);
        }
        // `\n?` is greedy: with the newline first, then without.
        let with = s[end..].starts_with('\n').then(|| end + 1);
        for after in [with, Some(end)].into_iter().flatten() {
            if s[after..].starts_with(next_open)
                && let Some(e) = match_run(s, after + next_open.len(), idx + 1)
            {
                return Some(e);
            }
        }
        // The lazy group grows: the next close tag.
        cursor = cursor + at + 1;
    }
    None
}

/// `stripFences(s)`: the body of a whole-string ```` ``` ```` fence
/// (an ASCII-letter language tag), trimmed.
pub fn strip_fences(s: &str) -> String {
    if let Some(after) = s.strip_prefix("```")
        && let Some(nl) = after.find('\n')
        && after[..nl].chars().all(|c| c.is_ascii_alphabetic())
        && let Some(body) = after[nl + 1..].strip_suffix("\n```")
    {
        return js::trim(body).to_owned();
    }
    s.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `[\s\S]*?` of the bash-block regex is lazy but backtracks: the
    /// close tag that counts is the first one the whole run can be built
    /// from.
    #[test]
    fn bash_blocks_match_the_regex() {
        let run = |a: &str, b: &str, c: &str| {
            format!(
                "<bash-input>{a}</bash-input>\n<bash-stdout>{b}</bash-stdout>\n<bash-stderr>{c}</bash-stderr>"
            )
        };
        assert_eq!(
            clean_bash_blocks(&format!("x{}y", run("ls", "a", ""))),
            "xy"
        );
        // No newline between the parts, and several runs.
        let tight = run("ls", "a", "").replace('\n', "");
        assert_eq!(clean_bash_blocks(&format!("{tight}{tight}keep")), "keep");
        // An unfinished run stays as it is.
        assert_eq!(clean_bash_blocks("<bash-input>ls"), "<bash-input>ls");
        assert_eq!(
            clean_bash_blocks("<bash-input>a</bash-input>\n<bash-stdout>b</bash-stdout>"),
            "<bash-input>a</bash-input>\n<bash-stdout>b</bash-stdout>"
        );
        // The first `</bash-input>` can't be the one: the group grows past
        // it to the second, where the rest of the run follows.
        let nested = format!(
            "<bash-input>a</bash-input>!<bash-input>b{}",
            "</bash-input>\n<bash-stdout>o</bash-stdout><bash-stderr>e</bash-stderr>tail"
        );
        assert_eq!(clean_bash_blocks(&nested), "tail");
        // The leftmost `<bash-input>` wins: the group grows over the inner
        // one and the whole thing goes (checked against the TS regex).
        assert_eq!(
            clean_bash_blocks(&format!("<bash-input>x{}end", run("ls", "a", ""))),
            "end"
        );
    }

    #[test]
    fn reminders_and_fences() {
        assert_eq!(
            clean_reminders(" a<system-reminder>x</system-reminder>b<system-reminder>y "),
            "ab<system-reminder>y"
        );
        // The first close after an open, left to right.
        assert_eq!(
            clean_reminders("<system-reminder>a<system-reminder>b</system-reminder>c"),
            "c"
        );
        assert_eq!(strip_fences("```md\n  x  \n```"), "x");
        assert_eq!(strip_fences("```\nx\n```"), "x");
        // The group is lazy but the `$` anchors the end.
        assert_eq!(strip_fences("```\na\n```\nb\n```"), "a\n```\nb");
        assert_eq!(strip_fences("```md\nx\n``` "), "```md\nx\n``` ");
        assert_eq!(strip_fences("```m d\nx\n```"), "```m d\nx\n```");
        assert_eq!(strip_fences("x"), "x");
    }

    #[test]
    fn user_text_follows_the_ts_checks() {
        let m = |v: Value| extract_user_text(Some(&v));
        assert_eq!(m(json!({"role": "user", "content": "  hi  "})), "hi");
        assert_eq!(m(json!({"content": "hi"})), "hi");
        assert_eq!(m(json!({"role": "system", "content": "hi"})), "");
        // A falsy role is not checked.
        assert_eq!(m(json!({"role": "", "content": "hi"})), "hi");
        assert_eq!(m(json!({"content": 5})), "");
        assert_eq!(m(json!([{"type": "text", "text": "hi"}])), "");
        assert_eq!(extract_user_text(None), "");
        assert_eq!(
            m(json!({"content": [
                {"type": "text", "text": " a "},
                {"type": "tool_result", "text": "no"},
                {"type": "text", "text": 5},
                {"type": "text", "text": "  "},
                {"type": "text", "text": "b"},
            ]})),
            "a\nb"
        );
    }

    /// The budgets count UTF-16 units, and a cut inside a pair drops it.
    #[test]
    fn pieces_are_cut_like_js() {
        assert_eq!(cap_piece("abc", 3), "abc");
        assert_eq!(cap_piece("abc", 2), "ab\n[\u{2026}]\n");
        assert_eq!(cap_piece("a\u{1f600}b", 4), "a\u{1f600}b");
        assert_eq!(cap_piece("a\u{1f600}b", 2), "a\n[\u{2026}]\n");
        assert_eq!(units("a\u{1f600}"), 3);
    }

    #[test]
    fn the_hash_rejects_a_manifest_value_that_is_not_a_string() {
        let entry = |manifest: Value| SyncEntry {
            path: "a".into(),
            verdict: Verdict::UserOnly,
            manifest_hash: manifest,
            custom_hash: Some("c".into()),
            live_hash: None,
        };
        let status = |manifest: Value| SyncStatus {
            manifest_created_at: None,
            base_version: None,
            current_version: "v".into(),
            outdated: false,
            entries: vec![entry(manifest)],
        };
        assert_eq!(
            diff_hash_of(&status(json!(5))).unwrap_err().to_string(),
            "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received type number (5)"
        );
        assert!(
            diff_hash_of(&status(json!({"a": 1})))
                .unwrap_err()
                .to_string()
                .ends_with("Received an instance of Object")
        );
        assert!(
            diff_hash_of(&status(json!([])))
                .unwrap_err()
                .to_string()
                .ends_with("Received an instance of Array")
        );
        assert!(
            diff_hash_of(&status(json!(true)))
                .unwrap_err()
                .to_string()
                .ends_with("Received type boolean (true)")
        );
        // A `null` hash is the empty string, as `?? ""` makes it.
        assert_eq!(
            diff_hash_of(&status(Value::Null)).unwrap(),
            diff_hash_of(&status(json!(""))).unwrap()
        );
    }
}
