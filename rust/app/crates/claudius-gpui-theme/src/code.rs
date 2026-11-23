//! Code-block highlighting: the React UI's Shiki theme as gpui-component
//! highlight styles.
//!
//! The React UI highlights with Shiki 4.0.2 and one theme,
//! `github-dark-default` (`lib/client/shiki.ts`), on **every** palette,
//! light ones included. Chat code blocks paint it on a fixed `bg-[#0a0a0a]`
//! (`components/chat/CodeBlock.tsx`, with `.shiki-host pre`'s background
//! forced transparent); the file editor paints it on `var(--background)`.
//! So light and dark get the same styles here, and the block background is
//! [`CODE_BLOCK_BACKGROUND`] in both.
//!
//! gpui-component's `syntect` backend doesn't color with a syntect theme. It
//! maps each TextMate scope onto one of 41 highlight names (`keyword`,
//! `string`, …; `semantic_name` in its `syntect_backend.rs`) and colors those
//! from the theme's highlight styles. [`SYNTAX`] gives each name the
//! color github-dark-default gives the scope that name stands for, matched
//! the way TextMate does (the longest dotted-prefix selector wins, later
//! rules win ties). The loss: Shiki colors per scope, gpui per name, so
//! scopes that share a name but not a color in github-dark-default collapse
//! (see the `scope` notes: `type`, `variable`, `punctuation.list_marker`).
//! Names the syntect backend never produces (`constructor`, `embedded`,
//! `enum`, `link_text`, `punctuation.special`, `string.special*`,
//! `tag.doctype`, `text.code.span`, `variant`, and the editor-only `hint`,
//! `predictive`, `primary`) are left unset.

use gpui_kit::{
    Hsla, Rgba,
    component::highlighter::{HighlightThemeStyle, SyntaxColors, ThemeStyle},
};
use serde_json::json;

/// `bg-[#0a0a0a]` on CodeBlock.tsx's container: a component literal, not a
/// palette token, and the same on every theme.
pub const CODE_BLOCK_BACKGROUND: &str = "#0a0a0a";

/// github-dark-default's `editor.foreground`: text no rule colors.
pub const FOREGROUND: &str = "#e6edf3";
/// github-dark-default's `editorLineNumber.foreground` /
/// `editorLineNumber.activeForeground` / `editor.lineHighlightBackground` /
/// `editorWhitespace.foreground` (the editor view; chat blocks have no
/// gutter).
pub const LINE_NUMBER: &str = "#6e7681";
pub const ACTIVE_LINE_NUMBER: &str = "#e6edf3";
pub const ACTIVE_LINE: &str = "#6e76811a";
pub const INVISIBLE: &str = "#484f58";

/// A font style from the theme's `fontStyle`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Plain,
    Italic,
    Bold,
}

/// One highlight name's style.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Syntax {
    /// gpui-component's highlight name.
    pub name: &'static str,
    /// The TextMate scope that name stands for in gpui-component's syntect
    /// mapping, which is what github-dark-default was matched against.
    pub scope: &'static str,
    /// The github-dark-default rule's selector that wins for `scope`, or
    /// `None` when no rule matches (the text keeps [`FOREGROUND`]).
    pub rule: Option<&'static str>,
    pub color: &'static str,
    pub style: Style,
}

const fn s(
    name: &'static str,
    scope: &'static str,
    rule: Option<&'static str>,
    color: &'static str,
    style: Style,
) -> Syntax {
    Syntax {
        name,
        scope,
        rule,
        color,
        style,
    }
}

use Style::{Bold, Italic, Plain};

/// The highlight names the syntect backend produces, in gpui-component's
/// `HIGHLIGHT_NAMES` order.
pub const SYNTAX: [Syntax; 28] = [
    s(
        "attribute",
        "entity.other.attribute-name",
        Some("entity"),
        "#79c0ff",
        Plain,
    ),
    s(
        "boolean",
        "constant.language.boolean",
        Some("constant"),
        "#79c0ff",
        Plain,
    ),
    s("comment", "comment", Some("comment"), "#8b949e", Plain),
    s(
        "comment.doc",
        "comment.block.documentation",
        Some("comment"),
        "#8b949e",
        Plain,
    ),
    s("constant", "constant", Some("constant"), "#79c0ff", Plain),
    s(
        "emphasis",
        "markup.italic",
        Some("markup.italic"),
        "#e6edf3",
        Italic,
    ),
    s(
        "emphasis.strong",
        "markup.bold",
        Some("markup.bold"),
        "#e6edf3",
        Bold,
    ),
    s(
        "function",
        "entity.name.function",
        Some("entity.name.function"),
        "#d2a8ff",
        Plain,
    ),
    s("keyword", "keyword", Some("keyword"), "#ff7b72", Plain),
    s(
        "label",
        "entity.name.label",
        Some("entity.name"),
        "#ffa657",
        Plain,
    ),
    // `markup.underline` sets only an underline, which gpui's highlight
    // style can't express: the URI keeps the text color.
    s(
        "link_uri",
        "markup.underline.link",
        Some("markup.underline"),
        "#e6edf3",
        Plain,
    ),
    s(
        "number",
        "constant.numeric",
        Some("constant"),
        "#79c0ff",
        Plain,
    ),
    s(
        "operator",
        "keyword.operator",
        Some("keyword"),
        "#ff7b72",
        Plain,
    ),
    s(
        "preproc",
        "keyword.control.import",
        Some("keyword"),
        "#ff7b72",
        Plain,
    ),
    s(
        "property",
        "variable.other.property",
        Some("variable.other"),
        "#e6edf3",
        Plain,
    ),
    s("punctuation", "punctuation", None, "#e6edf3", Plain),
    s(
        "punctuation.bracket",
        "punctuation.section",
        None,
        "#e6edf3",
        Plain,
    ),
    s(
        "punctuation.delimiter",
        "punctuation.separator",
        None,
        "#e6edf3",
        Plain,
    ),
    // Markdown list bullets are `punctuation.definition.list.begin.markdown`
    // (#ffa657 in Shiki), which gpui files under `punctuation`, so this name
    // only gets `markup.list`'s (unstyled) text.
    s(
        "punctuation.list_marker",
        "markup.list",
        None,
        "#e6edf3",
        Plain,
    ),
    s("string", "string", Some("string"), "#a5d6ff", Plain),
    s(
        "string.escape",
        "constant.character.escape",
        Some("constant.character"),
        "#ff7b72",
        Plain,
    ),
    s(
        "string.regex",
        "string.regexp",
        Some("string.regexp"),
        "#a5d6ff",
        Plain,
    ),
    s(
        "tag",
        "entity.name.tag",
        Some("entity.name.tag"),
        "#7ee787",
        Plain,
    ),
    s("text.literal", "markup.raw", None, "#e6edf3", Plain),
    s(
        "title",
        "markup.heading",
        Some("markup.heading"),
        "#79c0ff",
        Bold,
    ),
    // Shiki: `entity.name.type` #ffa657, but `storage.type` (gpui's `type`
    // for `int`, `bool`) is #ff7b72 and `support.type` #79c0ff.
    s(
        "type",
        "entity.name.type",
        Some("entity.name"),
        "#ffa657",
        Plain,
    ),
    // Shiki: `variable.other.*` (most variables) #e6edf3, but a bare
    // `variable` / `variable.parameter` is #ffa657.
    s(
        "variable",
        "variable.other.readwrite",
        Some("variable.other"),
        "#e6edf3",
        Plain,
    ),
    s(
        "variable.special",
        "variable.language",
        Some("variable.language"),
        "#79c0ff",
        Plain,
    ),
];

/// A [`Syntax`] row as gpui-component's style. Built through serde: the
/// tree-sitter build's `ThemeStyle` keeps its fields private.
fn theme_style(s: &Syntax) -> ThemeStyle {
    let mut v = json!({ "color": s.color });
    match s.style {
        Plain => {}
        Italic => v["font_style"] = "italic".into(),
        Bold => v["font_weight"] = 700.into(),
    }
    serde_json::from_value(v).expect("a valid highlight style")
}

/// The `SyntaxColors` field of a highlight name.
fn slot<'a>(syntax: &'a mut SyntaxColors, name: &str) -> &'a mut Option<ThemeStyle> {
    match name {
        "attribute" => &mut syntax.attribute,
        "boolean" => &mut syntax.boolean,
        "comment" => &mut syntax.comment,
        "comment.doc" => &mut syntax.comment_doc,
        "constant" => &mut syntax.constant,
        "emphasis" => &mut syntax.emphasis,
        "emphasis.strong" => &mut syntax.emphasis_strong,
        "function" => &mut syntax.function,
        "keyword" => &mut syntax.keyword,
        "label" => &mut syntax.label,
        "link_uri" => &mut syntax.link_uri,
        "number" => &mut syntax.number,
        "operator" => &mut syntax.operator,
        "preproc" => &mut syntax.preproc,
        "property" => &mut syntax.property,
        "punctuation" => &mut syntax.punctuation,
        "punctuation.bracket" => &mut syntax.punctuation_bracket,
        "punctuation.delimiter" => &mut syntax.punctuation_delimiter,
        "punctuation.list_marker" => &mut syntax.punctuation_list_marker,
        "string" => &mut syntax.string,
        "string.escape" => &mut syntax.string_escape,
        "string.regex" => &mut syntax.string_regex,
        "tag" => &mut syntax.tag,
        "text.literal" => &mut syntax.text_literal,
        "title" => &mut syntax.title,
        "type" => &mut syntax.type_,
        "variable" => &mut syntax.variable,
        "variable.special" => &mut syntax.variable_special,
        _ => panic!("{name} is not a highlight name the syntect backend produces"),
    }
}

fn color(hex: &str) -> Option<Hsla> {
    Some(Rgba::try_from(hex).expect("a hex color").into())
}

/// The theme's code highlighting: the editor colors and [`SYNTAX`].
///
/// Set by field, not from a theme file: with `syntect` (and not
/// `tree-sitter`), gpui-component 0.10 compiles a `HighlightThemeStyle`
/// whose editor colors and `comment_doc` have no Zed-style serde names, so a
/// theme file's `editor.background` and `comment.doc` would be dropped
/// without an error.
pub fn highlight_style() -> HighlightThemeStyle {
    let mut style = HighlightThemeStyle::default();
    style.editor_background = color(CODE_BLOCK_BACKGROUND);
    style.editor_foreground = color(FOREGROUND);
    style.editor_active_line = color(ACTIVE_LINE);
    style.editor_line_number = color(LINE_NUMBER);
    style.editor_active_line_number = color(ACTIVE_LINE_NUMBER);
    style.editor_invisible = color(INVISIBLE);
    for s in &SYNTAX {
        *slot(&mut style.syntax, s.name) = Some(theme_style(s));
    }
    style
}

/// [`slot`], for the test that a name outside [`SYNTAX`] is refused.
#[doc(hidden)]
pub fn set_style(syntax: &mut SyntaxColors, name: &str, s: &Syntax) {
    *slot(syntax, name) = Some(theme_style(s));
}
