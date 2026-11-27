//! AskUserQuestion: `components/chat/AskUserQuestionPrompt.tsx` (the
//! multi-question form, single / multi-select, "Other", the answer shape,
//! the modal's keys and both footers), `formatAskAsPrompt` and the reopen
//! rule from `ChatSurface.tsx` (the resurrected modal), and the preview
//! sniff. The HTML preview itself is U08b's: [`PreviewContent::Html`] is
//! the seam.

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::unicode::strip_invisible_unicode;

/// `AskQuestionOption`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskOption {
    pub label: String,
    pub description: String,
    /// HTML the model wrote to compare options (may be absent / empty).
    pub preview: Option<String>,
}

/// `AskQuestion`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskQuestion {
    pub question: String,
    /// The chip's short label.
    pub header: String,
    pub options: Vec<AskOption>,
    pub multi_select: bool,
}

impl AskQuestion {
    /// A question as `parseAskQuestions` normalized it (the server's
    /// `ask_user_question` carries them so); a missing string is `""`.
    pub fn from_json(v: &Value) -> AskQuestion {
        let s = |o: &Value, k: &str| {
            o.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        AskQuestion {
            question: s(v, "question"),
            header: s(v, "header"),
            options: v
                .get("options")
                .and_then(Value::as_array)
                .map(|opts| {
                    opts.iter()
                        .map(|o| AskOption {
                            label: s(o, "label"),
                            description: s(o, "description"),
                            preview: o.get("preview").and_then(Value::as_str).map(str::to_owned),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            multi_select: v.get("multiSelect") == Some(&Value::Bool(true)),
        }
    }

    pub fn to_json(&self) -> Value {
        let options: Vec<Value> = self
            .options
            .iter()
            .map(|o| {
                let mut m = Map::new();
                m.insert("label".into(), json!(o.label));
                m.insert("description".into(), json!(o.description));
                if let Some(p) = &o.preview {
                    m.insert("preview".into(), json!(p));
                }
                Value::Object(m)
            })
            .collect();
        json!({ "question": self.question, "header": self.header, "options": options, "multiSelect": self.multi_select })
    }
}

/// The questions of an `ask_user_question` event (or of a reopened tool
/// call's input after `parseAskQuestions`).
pub fn questions_of(list: Option<&Value>) -> Vec<AskQuestion> {
    list.and_then(Value::as_array)
        .map(|qs| qs.iter().map(AskQuestion::from_json).collect())
        .unwrap_or_default()
}

/// `AskAnswer` (events.ts:652): one per question, in order.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct AskAnswer {
    /// Single-select: `Some(Some(label))`, or `Some(None)` (`null`) when
    /// "Other" took its place.
    pub label: Option<Option<String>>,
    /// Multi-select: the picked labels.
    pub selected: Option<Vec<String>>,
    /// "Other", trimmed.
    pub custom: Option<String>,
}

impl AskAnswer {
    /// `{ label | selected, custom? }`, the key order `submit()` writes.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(sel) = &self.selected {
            m.insert("selected".into(), json!(sel));
        }
        if let Some(label) = &self.label {
            m.insert(
                "label".into(),
                label.as_ref().map_or(Value::Null, |l| json!(l)),
            );
        }
        if let Some(c) = &self.custom {
            m.insert("custom".into(), json!(c));
        }
        Value::Object(m)
    }

    /// An answer from JSON (the golden's): the fields of the right type.
    pub fn from_json(v: &Value) -> AskAnswer {
        AskAnswer {
            label: v.get("label").map(|l| l.as_str().map(str::to_owned)),
            selected: v.get("selected").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            }),
            custom: v.get("custom").and_then(Value::as_str).map(str::to_owned),
        }
    }
}

/// The answers as `submitAskAnswer` posts them.
pub fn answers_json(answers: &[AskAnswer]) -> Value {
    Value::Array(answers.iter().map(AskAnswer::to_json).collect())
}

/// `formatAskAsPrompt(questions, answers)` (ChatSurface.tsx:104): a
/// resurrected ask's answers as one follow-up prompt that quotes each
/// question.
pub fn format_ask_as_prompt(questions: &[AskQuestion], answers: &[AskAnswer]) -> String {
    let none = AskAnswer::default();
    let mut lines: Vec<String> = Vec::new();
    for (i, q) in questions.iter().enumerate() {
        let a = answers.get(i).unwrap_or(&none);
        let mut picks: Vec<String> = Vec::new();
        match (&a.selected, &a.label) {
            (Some(sel), _) if !sel.is_empty() => picks.extend(sel.iter().cloned()),
            (_, Some(Some(l))) if !l.is_empty() => picks.push(l.clone()),
            _ => {}
        }
        if let Some(c) = &a.custom {
            let t = js::trim(c);
            if !t.is_empty() {
                picks.push(format!("Other: {t}"));
            }
        }
        lines.push(format!("> {}", q.question));
        lines.push(if picks.is_empty() {
            "(declined)".to_owned()
        } else {
            picks.join(", ")
        });
        if i + 1 < questions.len() {
            lines.push(String::new());
        }
    }
    lines.join("\n")
}

/// `looksLikeHtml(s)` (AskUserQuestionPrompt.tsx:713):
/// `/<\s*\/?[a-zA-Z][^>]*>/`, by hand.
pub fn looks_like_html(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c != '<' {
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && js::is_whitespace(chars[j]) {
            j += 1;
        }
        // `\/?` then a letter; the optional slash can also be skipped.
        let starts = |k: usize| chars.get(k).is_some_and(char::is_ascii_alphabetic);
        let letter = if starts(j) {
            Some(j)
        } else if chars.get(j) == Some(&'/') && starts(j + 1) {
            Some(j + 1)
        } else {
            None
        };
        if let Some(k) = letter
            && chars[k + 1..].contains(&'>')
        {
            return true;
        }
    }
    false
}

/// What the preview pane shows for the focused option (`PreviewPane`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreviewContent {
    /// "No preview for this option."
    None,
    /// HTML: the sandboxed WebView pane is U08b's; until then the card
    /// shows the markup as text in a light box. The seam.
    Html(String),
    /// Plain text / ASCII art, monospaced with its whitespace.
    Text(String),
}

impl PreviewContent {
    pub fn of(content: &str) -> PreviewContent {
        if content.is_empty() {
            PreviewContent::None
        } else if looks_like_html(content) {
            PreviewContent::Html(content.to_owned())
        } else {
            PreviewContent::Text(content.to_owned())
        }
    }
}

/// The pane beside the options (`rightMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RightPane {
    /// An option has a preview.
    Preview,
    /// No previews, and "Other" is picked: its roomy textarea.
    Other,
    /// Nothing: the options take the full width.
    Empty,
}

/// One question's working state (`Working`).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Working {
    pub selected_labels: Vec<String>,
    pub custom: String,
    pub show_other: bool,
}

/// The form's state (AskUserQuestionPrompt.tsx:73-79).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskForm {
    pub request_id: String,
    pub questions: Vec<AskQuestion>,
    pub active: usize,
    pub working: Vec<Working>,
    pub focused_option: usize,
    /// Bumped when focus should go to the "Other" field (it was revealed,
    /// or a paste was routed into it).
    pub focus_other: u64,
}

/// Where the ask is (`inline` prop): the live one at the end of the
/// transcript, or the resurrected modal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskMode {
    Inline,
    Modal,
}

/// What the form asks the card to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AskStep {
    Stay,
    /// `onSubmit(answers)`.
    Submit(Vec<AskAnswer>),
    /// Esc / click-outside: `onMinimize ?? onCancel`.
    Dismiss,
}

/// A key the modal reads (`e.key`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskKey {
    Escape,
    /// `1`–`9`.
    Digit(u8),
    Down,
    Up,
    Enter,
    /// Tab without Shift.
    Tab,
}

impl AskForm {
    pub fn new(request_id: impl Into<String>, questions: Vec<AskQuestion>) -> Self {
        let working = vec![Working::default(); questions.len()];
        AskForm {
            request_id: request_id.into(),
            questions,
            active: 0,
            working,
            focused_option: 0,
            focus_other: 0,
        }
    }

    pub fn total(&self) -> usize {
        self.questions.len()
    }

    /// The active question (`q`).
    pub fn question(&self) -> Option<&AskQuestion> {
        self.questions.get(self.active)
    }

    /// Its working state (`w`).
    pub fn working(&self) -> Working {
        self.working.get(self.active).cloned().unwrap_or_default()
    }

    pub fn is_last(&self) -> bool {
        self.active + 1 == self.total()
    }

    /// `setActive`: a change of question puts the option focus back on the
    /// first one ("store previous props").
    pub fn set_active(&mut self, i: usize) {
        if i != self.active {
            self.focused_option = 0;
        }
        self.active = i;
    }

    /// `isReady(idx)`: "Other" with text, or a pick.
    pub fn is_ready(&self, i: usize) -> bool {
        let Some(cur) = self.working.get(i) else {
            return false;
        };
        if cur.show_other && !js::trim(&cur.custom).is_empty() {
            return true;
        }
        !cur.selected_labels.is_empty()
    }

    pub fn all_ready(&self) -> bool {
        (0..self.working.len()).all(|i| self.is_ready(i))
    }

    fn update(&mut self, f: impl FnOnce(&mut Working, bool)) {
        let multi = self.question().is_some_and(|q| q.multi_select);
        if let Some(w) = self.working.get_mut(self.active) {
            f(w, multi);
        }
    }

    /// An option row, or its digit: multi-select toggles it; single-select
    /// picks it and closes "Other".
    pub fn pick(&mut self, label: &str) {
        self.update(|cur, multi| {
            if multi {
                if let Some(at) = cur.selected_labels.iter().position(|l| l == label) {
                    cur.selected_labels.remove(at);
                } else {
                    cur.selected_labels.push(label.to_owned());
                }
            } else {
                cur.selected_labels = vec![label.to_owned()];
                cur.show_other = false;
            }
        });
    }

    /// The "Other" row: toggles it; off wipes the draft, on drops the pick
    /// of a single-select.
    pub fn pick_other(&mut self) {
        let mut opened = false;
        self.update(|cur, multi| {
            if cur.show_other {
                cur.show_other = false;
                cur.custom.clear();
            } else {
                cur.show_other = true;
                opened = true;
                if !multi {
                    cur.selected_labels.clear();
                }
            }
        });
        if opened {
            self.focus_other += 1;
        }
    }

    pub fn set_custom(&mut self, text: &str) {
        self.update(|cur, _| cur.custom = text.to_owned());
    }

    /// `appendToOther(text)` (CC 2.1.314): opens "Other" as picking it does
    /// and appends the text after a space (none after whitespace).
    pub fn append_to_other(&mut self, text: &str) {
        self.update(|cur, multi| {
            if !(cur.show_other || multi) {
                cur.selected_labels.clear();
            }
            cur.show_other = true;
            cur.custom = if cur.custom.is_empty() {
                text.to_owned()
            } else {
                let sep = if cur.custom.chars().last().is_some_and(js::is_whitespace) {
                    ""
                } else {
                    " "
                };
                format!("{}{sep}{text}", cur.custom)
            };
        });
        self.focus_other += 1;
    }

    /// A paste outside a text field (`onPaste`): CRLF / CR to LF, invisible
    /// characters stripped, then into "Other"; nothing left is ignored.
    /// Whether it was taken.
    pub fn paste(&mut self, text: &str) -> bool {
        let lf = text.replace("\r\n", "\n").replace('\r', "\n");
        let cleaned = strip_invisible_unicode(&lf).cleaned;
        if cleaned.is_empty() {
            return false;
        }
        self.append_to_other(&cleaned);
        true
    }

    /// `rightMode`.
    pub fn right_pane(&self) -> RightPane {
        let Some(q) = self.question() else {
            return RightPane::Empty;
        };
        if q.options
            .iter()
            .any(|o| o.preview.as_deref().is_some_and(|p| !p.is_empty()))
        {
            RightPane::Preview
        } else if self.working().show_other {
            RightPane::Other
        } else {
            RightPane::Empty
        }
    }

    /// `focusedOptionPreview`: the focused option's preview, else the first
    /// option's (`??`: an empty one is kept), else `""`; and its label.
    pub fn preview(&self) -> (PreviewContent, String) {
        let Some(q) = self.question() else {
            return (PreviewContent::None, String::new());
        };
        let html = q
            .options
            .get(self.focused_option)
            .and_then(|o| o.preview.clone())
            .or_else(|| q.options.first().and_then(|o| o.preview.clone()))
            .unwrap_or_default();
        let label = q
            .options
            .get(self.focused_option)
            .map(|o| o.label.clone())
            .unwrap_or_default();
        (PreviewContent::of(&html), label)
    }

    /// `submit()`: the answers, once every question is ready.
    pub fn submit(&self) -> AskStep {
        if !self.all_ready() {
            return AskStep::Stay;
        }
        let answers = self
            .working
            .iter()
            .zip(&self.questions)
            .map(|(cur, q)| {
                let mut out = AskAnswer::default();
                if q.multi_select {
                    out.selected = Some(cur.selected_labels.clone());
                } else {
                    out.label = Some(
                        cur.selected_labels
                            .first()
                            .filter(|l| !l.is_empty())
                            .cloned(),
                    );
                }
                let custom = js::trim(&cur.custom);
                if cur.show_other && !custom.is_empty() {
                    out.custom = Some(custom.to_owned());
                }
                out
            })
            .collect();
        AskStep::Submit(answers)
    }

    /// "Next" / Enter / Cmd+Enter on a question before the last: on to the
    /// next one when this one is ready.
    pub fn next(&mut self) {
        if self.is_ready(self.active) {
            let to = (self.active + 1).min(self.total().saturating_sub(1));
            self.set_active(to);
        }
    }

    /// "Back".
    pub fn back(&mut self) {
        self.set_active(self.active.saturating_sub(1));
    }

    /// Enter in the modal, and Cmd/Ctrl+Enter in an "Other" field
    /// (`onSubmitShortcut`): submit on the last question, else next.
    pub fn advance(&mut self) -> AskStep {
        if self.is_last() {
            return self.submit();
        }
        self.next();
        AskStep::Stay
    }

    /// The modal's keyboard (AskUserQuestionPrompt.tsx:290). `in_field`:
    /// the key went to a text field (only Escape counts then). The inline
    /// card has none of these: it shares the window with the composer.
    pub fn key(&mut self, key: AskKey, in_field: bool) -> AskStep {
        if key == AskKey::Escape {
            return AskStep::Dismiss;
        }
        if in_field {
            return AskStep::Stay;
        }
        let n = self.question().map_or(0, |q| q.options.len());
        match key {
            AskKey::Digit(d) => {
                let idx = usize::from(d.saturating_sub(1));
                if (1..=9).contains(&d) && idx < n {
                    let label = self.questions[self.active].options[idx].label.clone();
                    self.pick(&label);
                    self.focused_option = idx;
                }
                AskStep::Stay
            }
            AskKey::Down => {
                self.focused_option = (self.focused_option + 1).min(n.saturating_sub(1));
                AskStep::Stay
            }
            AskKey::Up => {
                self.focused_option = self.focused_option.saturating_sub(1);
                AskStep::Stay
            }
            AskKey::Enter => self.advance(),
            AskKey::Tab => {
                if self.is_ready(self.active) && self.total() > 0 {
                    let to = (self.active + 1) % self.total();
                    self.set_active(to);
                }
                AskStep::Stay
            }
            AskKey::Escape => unreachable!(),
        }
    }

    /// The footer's hint.
    pub fn hint(&self, mode: AskMode, has_minimize: bool) -> String {
        let w = self.working();
        let other_hint = if self.is_last() {
            "\u{2318}/Ctrl+Enter submit"
        } else {
            "\u{2318}/Ctrl+Enter next"
        };
        match mode {
            AskMode::Inline => {
                if w.show_other {
                    other_hint.to_owned()
                } else if self.all_ready() {
                    if self.is_last() {
                        "Ready \u{2014} press Submit".to_owned()
                    } else {
                        "Ready \u{2014} press Next".to_owned()
                    }
                } else if self.is_ready(self.active) {
                    "Pick the remaining answers".to_owned()
                } else {
                    "Pick an option to answer".to_owned()
                }
            }
            AskMode::Modal => {
                let multi = self.question().is_some_and(|q| q.multi_select);
                let nav = if multi {
                    "\u{2191}/\u{2193} navigate \u{00B7} 1\u{2013}4 toggle"
                } else {
                    "\u{2191}/\u{2193} navigate \u{00B7} 1\u{2013}4 select"
                };
                let enter = if w.show_other {
                    other_hint
                } else if self.is_last() {
                    "Enter submit"
                } else {
                    "Enter next"
                };
                let esc = if has_minimize { "hide" } else { "cancel" };
                format!("{nav} \u{00B7} {enter} \u{00B7} Esc {esc}")
            }
        }
    }

    /// The multi-select hint: `Select one or more`, and `· N selected`
    /// once something is picked (its own muted span).
    pub fn multi_hint(&self) -> Option<(String, Option<String>)> {
        let q = self.question()?;
        if !q.multi_select {
            return None;
        }
        let n = self.working().selected_labels.len();
        Some((
            "Select one or more".to_owned(),
            (n > 0).then(|| format!("\u{00B7} {n} selected")),
        ))
    }

    /// The header's `{active + 1} of {total}`.
    pub fn position(&self) -> String {
        format!("{} of {}", self.active + 1, self.total())
    }

    /// Each question's chip (`qq.header || Q{i+1}`), shown when there's
    /// more than one.
    pub fn chips(&self) -> Vec<String> {
        if self.total() <= 1 {
            return Vec::new();
        }
        self.questions
            .iter()
            .enumerate()
            .map(|(i, q)| {
                if q.header.is_empty() {
                    format!("Q{}", i + 1)
                } else {
                    q.header.clone()
                }
            })
            .collect()
    }
}

/// The header's session chip: the label when it has non-space text.
pub fn session_chip(label: Option<&str>) -> Option<&str> {
    label.filter(|l| !js::trim(l).is_empty())
}

/// A resurrected ask (ChatSurface.tsx:283): a historic AskUserQuestion row
/// reopened after its permission stream closed. Its answers go out as a
/// new prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResurrectedAsk {
    /// `resurrected:{toolUseId}`.
    pub request_id: String,
    pub tool_use_id: String,
    pub questions: Vec<AskQuestion>,
}

/// What a click on a transcript ask row's "Reopen" does
/// (ChatSurface.tsx:2765).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reopen {
    /// The live ask: it's already inline; bring it into view.
    ScrollToInline,
    /// The input isn't a question set.
    Toast(&'static str),
    Resurrect(ResurrectedAsk),
}

/// `onReopenAsk({ toolUseId, input })`.
pub fn reopen_ask(
    pending_ask_tool_use_id: Option<&str>,
    tool_use_id: &str,
    input: &Value,
) -> Reopen {
    if pending_ask_tool_use_id == Some(tool_use_id) {
        return Reopen::ScrollToInline;
    }
    let questions: Vec<AskQuestion> = claudius_core::events::parse_ask_questions(input)
        .iter()
        .map(AskQuestion::from_json)
        .collect();
    if questions.is_empty() {
        return Reopen::Toast("Couldn't recover the question \u{2014} input shape unknown");
    }
    Reopen::Resurrect(ResurrectedAsk {
        request_id: format!("resurrected:{tool_use_id}"),
        tool_use_id: tool_use_id.to_owned(),
        questions,
    })
}

/// The resurrected modal shows only while no live ask is in flight
/// (ChatSurface.tsx:3150).
pub fn resurrected_shows(live_ask: bool, resurrected: bool) -> bool {
    !live_ask && resurrected
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudius_core::js_string::stringify;

    fn q(question: &str, header: &str, labels: &[&str], multi: bool) -> AskQuestion {
        AskQuestion {
            question: question.into(),
            header: header.into(),
            options: labels
                .iter()
                .map(|l| AskOption {
                    label: (*l).into(),
                    description: String::new(),
                    preview: None,
                })
                .collect(),
            multi_select: multi,
        }
    }

    fn two() -> AskForm {
        AskForm::new(
            "r1",
            vec![
                q("Which DB?", "DB", &["Postgres", "SQLite"], false),
                q("Which features?", "", &["Auth", "Search", "Billing"], true),
            ],
        )
    }

    fn answers(step: AskStep) -> String {
        let AskStep::Submit(a) = step else {
            panic!("{step:?}")
        };
        stringify(&answers_json(&a))
    }

    #[test]
    fn submit_writes_label_or_selected_and_custom() {
        let mut f = two();
        assert_eq!(f.submit(), AskStep::Stay);
        f.pick("SQLite");
        f.pick("Postgres");
        f.set_active(1);
        f.pick("Search");
        f.pick("Auth");
        f.pick("Search");
        f.pick_other();
        f.set_custom("  Exports ");
        assert_eq!(
            answers(f.submit()),
            r#"[{"label":"Postgres"},{"selected":["Auth"],"custom":"Exports"}]"#
        );
    }

    #[test]
    fn other_on_a_single_select_replaces_the_pick_and_sends_label_null() {
        let mut f = AskForm::new("r", vec![q("Q?", "", &["A", "B"], false)]);
        f.pick("A");
        f.pick_other();
        assert!(f.working().selected_labels.is_empty());
        assert!(!f.is_ready(0), "Other without text isn't an answer");
        f.set_custom("mine");
        assert_eq!(answers(f.submit()), r#"[{"label":null,"custom":"mine"}]"#);
        // Picking an option closes Other again (and its text is no longer sent).
        f.pick("B");
        assert_eq!(answers(f.submit()), r#"[{"label":"B"}]"#);
    }

    #[test]
    fn toggling_other_off_wipes_its_draft() {
        let mut f = AskForm::new("r", vec![q("Q?", "", &["A", "B"], true)]);
        f.pick("A");
        f.pick_other();
        f.set_custom("x");
        f.pick_other();
        assert_eq!(
            f.working(),
            Working {
                selected_labels: vec!["A".into()],
                custom: String::new(),
                show_other: false
            }
        );
    }

    #[test]
    fn append_to_other_spaces_the_paste() {
        let mut f = AskForm::new("r", vec![q("Q?", "", &["A", "B"], false)]);
        f.pick("A");
        assert!(f.paste("one\r\ntwo\u{200B}"));
        assert_eq!(f.working().custom, "one\ntwo");
        assert!(
            f.working().selected_labels.is_empty(),
            "single-select drops the pick"
        );
        f.paste("three");
        assert_eq!(f.working().custom, "one\ntwo three");
        f.set_custom("x\n");
        f.paste("y");
        assert_eq!(f.working().custom, "x\ny");
        assert!(!f.paste("\u{200B}"));
        // Multi-select keeps its picks; once Other is open a single-select
        // keeps a pick made after it, too.
        let mut m = AskForm::new("r", vec![q("Q?", "", &["A", "B"], true)]);
        m.pick("A");
        m.paste("p");
        assert_eq!(m.working().selected_labels, ["A"]);
    }

    #[test]
    fn next_needs_the_question_ready_and_tab_wraps() {
        let mut f = two();
        f.next();
        assert_eq!(f.active, 0);
        f.pick("Postgres");
        f.focused_option = 1;
        assert_eq!(f.advance(), AskStep::Stay);
        assert_eq!((f.active, f.focused_option), (1, 0));
        // The last question submits only when all are ready.
        assert_eq!(f.key(AskKey::Enter, false), AskStep::Stay);
        f.pick("Billing");
        assert!(matches!(f.key(AskKey::Enter, false), AskStep::Submit(_)));
        assert_eq!(f.key(AskKey::Tab, false), AskStep::Stay);
        assert_eq!(f.active, 0, "Tab wraps");
        f.back();
        assert_eq!(f.active, 0);
    }

    #[test]
    fn modal_keys_pick_navigate_and_skip_fields() {
        let mut f = two();
        assert_eq!(f.key(AskKey::Digit(2), false), AskStep::Stay);
        assert_eq!(
            (f.working().selected_labels.clone(), f.focused_option),
            (vec!["SQLite".to_owned()], 1)
        );
        f.key(AskKey::Digit(3), false);
        assert_eq!(f.working().selected_labels, ["SQLite"], "no third option");
        f.key(AskKey::Up, false);
        f.key(AskKey::Up, false);
        assert_eq!(f.focused_option, 0);
        f.key(AskKey::Down, false);
        f.key(AskKey::Down, false);
        assert_eq!(f.focused_option, 1);
        // In a text field only Escape counts.
        f.key(AskKey::Digit(1), true);
        assert_eq!(f.working().selected_labels, ["SQLite"]);
        assert_eq!(f.key(AskKey::Escape, true), AskStep::Dismiss);
        assert_eq!(f.key(AskKey::Digit(0), false), AskStep::Stay);
    }

    #[test]
    fn the_hints_follow_readiness() {
        let mut f = two();
        assert_eq!(f.hint(AskMode::Inline, false), "Pick an option to answer");
        assert_eq!(
            f.hint(AskMode::Modal, true),
            "\u{2191}/\u{2193} navigate \u{00B7} 1\u{2013}4 select \u{00B7} Enter next \u{00B7} Esc hide"
        );
        f.pick("SQLite");
        assert_eq!(f.hint(AskMode::Inline, false), "Pick the remaining answers");
        f.set_active(1);
        assert_eq!(
            f.hint(AskMode::Modal, false),
            "\u{2191}/\u{2193} navigate \u{00B7} 1\u{2013}4 toggle \u{00B7} Enter submit \u{00B7} Esc cancel"
        );
        f.pick("Auth");
        assert_eq!(
            f.hint(AskMode::Inline, false),
            "Ready \u{2014} press Submit"
        );
        f.set_active(0);
        assert_eq!(f.hint(AskMode::Inline, false), "Ready \u{2014} press Next");
        f.pick_other();
        assert_eq!(f.hint(AskMode::Inline, false), "\u{2318}/Ctrl+Enter next");
        assert_eq!(f.multi_hint(), None);
        f.set_active(1);
        assert_eq!(
            f.multi_hint(),
            Some((
                "Select one or more".into(),
                Some("\u{00B7} 1 selected".into())
            ))
        );
        assert_eq!(f.position(), "2 of 2");
        assert_eq!(f.chips(), ["DB", "Q2"]);
    }

    #[test]
    fn the_right_pane_prefers_previews() {
        let mut f = AskForm::new("r", vec![q("Q?", "", &["A", "B"], false)]);
        assert_eq!(f.right_pane(), RightPane::Empty);
        f.pick_other();
        assert_eq!(f.right_pane(), RightPane::Other);
        f.questions[0].options[1].preview = Some("<b>B</b>".into());
        assert_eq!(f.right_pane(), RightPane::Preview);
        // The focused option has none: the first option's (also none) → "".
        assert_eq!(f.preview(), (PreviewContent::None, "A".into()));
        f.focused_option = 1;
        assert_eq!(
            f.preview(),
            (PreviewContent::Html("<b>B</b>".into()), "B".into())
        );
        f.questions[0].options[0].preview = Some("+--+\n|A |".into());
        f.focused_option = 0;
        assert_eq!(f.preview().0, PreviewContent::Text("+--+\n|A |".into()));
        // `??`: an empty preview on the focused option is kept.
        f.questions[0].options[1].preview = Some(String::new());
        f.focused_option = 1;
        assert_eq!(f.preview().0, PreviewContent::None);
    }

    #[test]
    fn looks_like_html_is_the_tag_sniff() {
        for yes in ["<b>x</b>", "a < div>", "</p>", "<x", "< /a>", "<br/>"] {
            assert_eq!(looks_like_html(yes), yes != "<x", "{yes}");
        }
        for no in ["a < b", "<1>", "</ a>", "<>", "plain", "<-->"] {
            assert!(!looks_like_html(no), "{no}");
        }
    }

    #[test]
    fn format_ask_as_prompt_quotes_each_question() {
        let qs = [
            q("Which DB?", "", &["P", "S"], false),
            q("Features?", "", &["A", "B"], true),
            q("Last?", "", &["X", "Y"], false),
        ];
        let a = [
            AskAnswer {
                label: Some(Some("P".into())),
                ..Default::default()
            },
            AskAnswer {
                selected: Some(vec!["A".into(), "B".into()]),
                custom: Some("  C ".into()),
                ..Default::default()
            },
        ];
        assert_eq!(
            format_ask_as_prompt(&qs, &a),
            "> Which DB?\nP\n\n> Features?\nA, B, Other: C\n\n> Last?\n(declined)"
        );
        let a = [AskAnswer {
            label: Some(Some(String::new())),
            selected: Some(vec![]),
            custom: Some(" ".into()),
        }];
        assert_eq!(
            format_ask_as_prompt(&qs[..1], &a),
            "> Which DB?\n(declined)"
        );
        assert_eq!(format_ask_as_prompt(&[], &[]), "");
    }

    #[test]
    fn reopen_ask_scrolls_toasts_or_resurrects() {
        let input = json!({ "questions": [{ "question": "Q?", "header": "H", "options": [{ "label": "a" }, { "label": "b" }] }] });
        assert_eq!(reopen_ask(Some("t1"), "t1", &input), Reopen::ScrollToInline);
        assert_eq!(
            reopen_ask(Some("t1"), "t2", &json!({})),
            Reopen::Toast("Couldn't recover the question \u{2014} input shape unknown")
        );
        let Reopen::Resurrect(r) = reopen_ask(None, "t2", &input) else {
            panic!()
        };
        assert_eq!(r.request_id, "resurrected:t2");
        assert_eq!(r.questions[0].options[1].label, "b");
        assert!(resurrected_shows(false, true));
        assert!(!resurrected_shows(true, true));
    }

    #[test]
    fn session_chip_needs_text() {
        assert_eq!(session_chip(Some(" t ")), Some(" t "));
        assert_eq!(session_chip(Some("  ")), None);
        assert_eq!(session_chip(None), None);
    }

    #[test]
    fn questions_round_trip_their_json() {
        let v = json!({ "question": "Q", "header": "", "options": [{ "label": "a", "description": "d", "preview": "p" }, { "label": "b", "description": "" }], "multiSelect": true });
        assert_eq!(AskQuestion::from_json(&v).to_json(), v);
        assert_eq!(questions_of(Some(&json!([v.clone()]))).len(), 1);
        assert!(questions_of(None).is_empty());
    }
}
