//! Server events (`{"type":"sdk","message":…}` and friends, as the SSE route
//! sends them) folded into transcript rows. Deliberately small: the real
//! reducer is U01's job.

use std::sync::Arc;

use gpui_kit::{Image, ImageFormat, SharedString};
use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    User,
    Assistant,
    Thinking,
    Tool,
    ToolResult,
    Meta,
}

pub struct Row {
    pub kind: Kind,
    /// Markdown source (shared, so an unchanged row is recognized by pointer).
    pub text: SharedString,
    pub title: Option<String>,
    pub image: Option<Arc<Image>>,
    pub streaming: bool,
}

impl Row {
    fn new(kind: Kind, text: String) -> Self {
        Row {
            kind,
            text: text.into(),
            title: None,
            image: None,
            streaming: false,
        }
    }
}

/// What a fold step did, so the view can update the list precisely.
pub enum Change {
    Appended,
    /// Streaming row `ix` got more text.
    Extended {
        ix: usize,
    },
    /// Streaming row `ix` was finalized with its full text.
    Finalized(usize),
    ReplayDone,
    TurnDone,
}

#[derive(Default)]
pub struct Transcript {
    pub rows: Vec<Row>,
    pub events: usize,
    pub sdk_events: usize,
    streaming_row: Option<usize>,
}

const MAX_RESULT_LINES: usize = 24;

/// `--row-cap N`: collapse any finished row longer than N bytes to its first
/// ~N bytes (whole lines), the way a transcript UI folds a huge tool input or
/// pasted prompt behind "show more". Off by default.
pub static ROW_CAP: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

fn cap_text(s: &str, cap: usize) -> Option<String> {
    if s.len() <= cap {
        return None;
    }
    let mut cut = cap;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    let cut = s[..cut].rfind('\n').unwrap_or(cut);
    let mut out = s[..cut].to_string();
    // Close a code fence the cut left open.
    if out
        .lines()
        .filter(|l| l.trim_start().starts_with("```"))
        .count()
        % 2
        == 1
    {
        out.push_str("\n```");
    }
    out.push_str(&format!("\n\n*… {} more bytes (collapsed)*", s.len() - cut));
    Some(out)
}

fn truncate_lines(s: &str, max: usize) -> String {
    let total = s.lines().count();
    if total <= max {
        return s.to_string();
    }
    let mut out: String = s.lines().take(max).collect::<Vec<_>>().join("\n");
    out.push_str(&format!("\n… {} more lines", total - max));
    out
}

fn fence(lang: &str, body: &str) -> String {
    let ticks = if body.contains("```") { "````" } else { "```" };
    format!("{ticks}{lang}\n{body}\n{ticks}")
}

fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let diff = similar::TextDiff::from_lines(old, new);
    let mut out = format!("--- a{path}\n+++ b{path}\n");
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        out.push_str(&hunk.to_string());
    }
    out
}

fn tool_row(block: &Value) -> Row {
    let name = block["name"].as_str().unwrap_or("tool");
    let input = &block["input"];
    let s = |k: &str| input[k].as_str().unwrap_or("");
    let (title, body) = match name {
        "Bash" => (
            format!("Bash · {}", s("description")),
            fence("bash", s("command")),
        ),
        "Edit" => (
            format!("Edit · {}", s("file_path")),
            fence(
                "diff",
                unified_diff(s("file_path"), s("old_string"), s("new_string")).trim_end(),
            ),
        ),
        "Write" => (
            format!("Write · {}", s("file_path")),
            fence("", &truncate_lines(s("content"), MAX_RESULT_LINES)),
        ),
        "Read" => (format!("Read · {}", s("file_path")), String::new()),
        _ => (
            name.to_string(),
            fence(
                "json",
                &serde_json::to_string_pretty(input).unwrap_or_default(),
            ),
        ),
    };
    let mut r = Row::new(Kind::Tool, body);
    r.title = Some(title);
    r
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn image_row(block: &Value) -> Option<Row> {
    use base64::Engine as _;
    let src = &block["source"];
    let data = src["data"].as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    let fmt = match src["media_type"].as_str().unwrap_or("") {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        _ => ImageFormat::Png,
    };
    let mut r = Row::new(Kind::User, String::new());
    r.image = Some(Arc::new(Image::from_bytes(fmt, bytes)));
    Some(r)
}

impl Transcript {
    pub fn fold(&mut self, ev: &Value, out: &mut Vec<Change>) {
        self.events += 1;
        match ev["type"].as_str() {
            Some("sdk") => {}
            Some("spike_replayed") => {
                out.push(Change::ReplayDone);
                return;
            }
            _ => return,
        }
        self.sdk_events += 1;
        let m = &ev["message"];
        match m["type"].as_str() {
            Some("user") => {
                if m["isMeta"].as_bool() == Some(true) {
                    return;
                }
                match &m["message"]["content"] {
                    Value::String(s) => self.push(Row::new(Kind::User, s.clone()), out),
                    Value::Array(blocks) => {
                        for b in blocks {
                            match b["type"].as_str() {
                                Some("text") => {
                                    let t = b["text"].as_str().unwrap_or("").to_string();
                                    self.push(Row::new(Kind::User, t), out)
                                }
                                Some("tool_result") => {
                                    let t = truncate_lines(
                                        &result_text(&b["content"]),
                                        MAX_RESULT_LINES,
                                    );
                                    if !t.trim().is_empty() {
                                        let mut r = Row::new(Kind::ToolResult, fence("", &t));
                                        if b["is_error"].as_bool() == Some(true) {
                                            r.title = Some("error".into());
                                        }
                                        self.push(r, out)
                                    }
                                }
                                Some("image") => {
                                    if let Some(r) = image_row(b) {
                                        self.push(r, out)
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                let blocks = m["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for b in &blocks {
                    match b["type"].as_str() {
                        Some("text") => {
                            let t = b["text"].as_str().unwrap_or("").to_string();
                            if let Some(ix) = self.streaming_row.take() {
                                self.rows[ix].streaming = false;
                                let prev = self.rows[ix].text.clone();
                                if let Some(rest) = t.strip_prefix(prev.as_ref())
                                    && !rest.is_empty()
                                {
                                    out.push(Change::Extended { ix });
                                }
                                if t != prev.as_ref() {
                                    self.rows[ix].text = t.into();
                                }
                                out.push(Change::Finalized(ix));
                            } else if !t.trim().is_empty() {
                                self.push(Row::new(Kind::Assistant, t), out)
                            }
                        }
                        Some("thinking") => {
                            let t = b["thinking"].as_str().unwrap_or("").to_string();
                            if !t.trim().is_empty() {
                                self.push(Row::new(Kind::Thinking, truncate_lines(&t, 12)), out)
                            }
                        }
                        Some("tool_use") => self.push(tool_row(b), out),
                        _ => {}
                    }
                }
            }
            Some("stream_event") => {
                let e = &m["event"];
                match e["type"].as_str() {
                    Some("content_block_start") if e["content_block"]["type"] == "text" => {
                        let mut r = Row::new(Kind::Assistant, String::new());
                        r.streaming = true;
                        self.push(r, out);
                        self.streaming_row = Some(self.rows.len() - 1);
                    }
                    Some("content_block_delta") if e["delta"]["type"] == "text_delta" => {
                        if let Some(ix) = self.streaming_row {
                            let d = e["delta"]["text"].as_str().unwrap_or("");
                            self.rows[ix].text = format!("{}{d}", self.rows[ix].text).into();
                            out.push(Change::Extended { ix });
                        }
                    }
                    _ => {}
                }
            }
            Some("result") => {
                let r = Row::new(
                    Kind::Meta,
                    format!(
                        "turn done · {} · {} turns",
                        m["subtype"].as_str().unwrap_or(""),
                        m["num_turns"].as_u64().unwrap_or(0)
                    ),
                );
                self.push(r, out);
                out.push(Change::TurnDone);
            }
            _ => {}
        }
    }

    fn push(&mut self, mut r: Row, out: &mut Vec<Change>) {
        if let Some(&cap) = ROW_CAP.get()
            && !r.streaming
            && let Some(t) = cap_text(&r.text, cap)
        {
            r.text = t.into();
        }
        self.rows.push(r);
        out.push(Change::Appended);
    }
}
