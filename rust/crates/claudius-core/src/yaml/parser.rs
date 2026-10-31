//! Port of yaml 2.9.0's `parse/parser.js` (the CST parser) and the token
//! types of `parse/cst.js`. The JS builds a tree of plain objects whose
//! properties come and go (`it.sep`, `scalar.end`, `delete it.key`); here
//! each optional property is an `Option`, and "the array is set" (truthy
//! even when empty) is `Some(vec![])`.

use std::rc::Rc;

use super::lexer::{Lexeme, lex, unit_char};

/// `token.type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Ty {
    ByteOrderMark,
    DocMode,
    FlowErrorEnd,
    Scalar,
    DocStart,
    DocEnd,
    Newline,
    SeqItemInd,
    ExplicitKeyInd,
    MapValueInd,
    FlowMapStart,
    FlowMapEnd,
    FlowSeqStart,
    FlowSeqEnd,
    Comma,
    Space,
    Comment,
    DirectiveLine,
    Alias,
    Anchor,
    Tag,
    SingleQuotedScalar,
    DoubleQuotedScalar,
    BlockScalarHeader,
    Directive,
    Document,
    Error,
    BlockScalar,
    BlockMap,
    BlockSeq,
    FlowCollection,
}

pub(super) type Text = Rc<[u16]>;

/// `cst.tokenType(source)`.
fn token_type(s: &[u16]) -> Option<Ty> {
    let is = |want: &str| {
        s.len() == want.len() && s.iter().zip(want.bytes()).all(|(u, b)| *u == u16::from(b))
    };
    if s == [0xFEFF] {
        return Some(Ty::ByteOrderMark);
    }
    for (want, ty) in [
        ("\u{2}", Ty::DocMode),
        ("\u{18}", Ty::FlowErrorEnd),
        ("\u{1f}", Ty::Scalar),
        ("---", Ty::DocStart),
        ("...", Ty::DocEnd),
        ("", Ty::Newline),
        ("\n", Ty::Newline),
        ("\r\n", Ty::Newline),
        ("-", Ty::SeqItemInd),
        ("?", Ty::ExplicitKeyInd),
        (":", Ty::MapValueInd),
        ("{", Ty::FlowMapStart),
        ("}", Ty::FlowMapEnd),
        ("[", Ty::FlowSeqStart),
        ("]", Ty::FlowSeqEnd),
        (",", Ty::Comma),
    ] {
        if is(want) {
            return Some(ty);
        }
    }
    Some(match unit_char(s[0]) {
        ' ' | '\t' => Ty::Space,
        '#' => Ty::Comment,
        '%' => Ty::DirectiveLine,
        '*' => Ty::Alias,
        '&' => Ty::Anchor,
        '!' => Ty::Tag,
        '\'' => Ty::SingleQuotedScalar,
        '"' => Ty::DoubleQuotedScalar,
        '|' | '>' => Ty::BlockScalarHeader,
        _ => return None,
    })
}

/// A `SourceToken` (`{type, offset, indent, source}`).
#[derive(Clone, Debug)]
pub(super) struct SrcTok {
    pub ty: Ty,
    pub offset: i64,
    pub indent: i64,
    pub source: Text,
}

#[derive(Debug, Default)]
pub(super) struct Item {
    pub start: Vec<Tok>,
    pub key: Option<Box<Tok>>,
    pub sep: Option<Vec<Tok>>,
    pub value: Option<Box<Tok>>,
    pub explicit_key: bool,
}

impl Item {
    fn start(start: Vec<Tok>) -> Item {
        Item {
            start,
            ..Item::default()
        }
    }
}

#[derive(Debug)]
pub(super) enum Tok {
    Src(SrcTok),
    /// An error token (its message isn't kept: only the fact of the error
    /// reaches the caller).
    Error {
        offset: i64,
        source: Text,
    },
    Directive {
        offset: i64,
        source: Text,
    },
    Document {
        offset: i64,
        start: Vec<Tok>,
        value: Option<Box<Tok>>,
        end: Option<Vec<Tok>>,
    },
    DocEnd {
        offset: i64,
        source: Text,
        end: Option<Vec<Tok>>,
    },
    /// `alias`, `scalar`, `single-quoted-scalar`, `double-quoted-scalar`.
    FlowScalar {
        ty: Ty,
        offset: i64,
        indent: i64,
        source: Text,
        end: Option<Vec<Tok>>,
    },
    BlockScalar {
        offset: i64,
        indent: i64,
        props: Vec<Tok>,
        source: Text,
    },
    BlockMap {
        offset: i64,
        indent: i64,
        items: Vec<Item>,
    },
    BlockSeq {
        offset: i64,
        indent: i64,
        items: Vec<Item>,
    },
    FlowCollection {
        offset: i64,
        indent: i64,
        start: SrcTok,
        items: Vec<Item>,
        end: Vec<Tok>,
    },
}

impl Tok {
    pub(super) fn ty(&self) -> Ty {
        match self {
            Tok::Src(s) => s.ty,
            Tok::Error { .. } => Ty::Error,
            Tok::Directive { .. } => Ty::Directive,
            Tok::Document { .. } => Ty::Document,
            Tok::DocEnd { .. } => Ty::DocEnd,
            Tok::FlowScalar { ty, .. } => *ty,
            Tok::BlockScalar { .. } => Ty::BlockScalar,
            Tok::BlockMap { .. } => Ty::BlockMap,
            Tok::BlockSeq { .. } => Ty::BlockSeq,
            Tok::FlowCollection { .. } => Ty::FlowCollection,
        }
    }

    pub(super) fn offset(&self) -> i64 {
        match self {
            Tok::Src(s) => s.offset,
            Tok::Error { offset, .. }
            | Tok::Directive { offset, .. }
            | Tok::Document { offset, .. }
            | Tok::DocEnd { offset, .. }
            | Tok::FlowScalar { offset, .. }
            | Tok::BlockScalar { offset, .. }
            | Tok::BlockMap { offset, .. }
            | Tok::BlockSeq { offset, .. }
            | Tok::FlowCollection { offset, .. } => *offset,
        }
    }

    /// `'indent' in token ? token.indent : undefined`.
    pub(super) fn indent(&self) -> Option<i64> {
        match self {
            Tok::Src(s) => Some(s.indent),
            Tok::FlowScalar { indent, .. }
            | Tok::BlockScalar { indent, .. }
            | Tok::BlockMap { indent, .. }
            | Tok::BlockSeq { indent, .. }
            | Tok::FlowCollection { indent, .. } => Some(*indent),
            _ => None,
        }
    }

    fn set_indent(&mut self, v: i64) {
        match self {
            Tok::Src(s) => s.indent = v,
            Tok::FlowScalar { indent, .. }
            | Tok::BlockScalar { indent, .. }
            | Tok::BlockMap { indent, .. }
            | Tok::BlockSeq { indent, .. }
            | Tok::FlowCollection { indent, .. } => *indent = v,
            _ => {}
        }
    }

    /// `token.source` (`undefined` for collections and documents).
    pub(super) fn source(&self) -> Option<&Text> {
        match self {
            Tok::Src(s) => Some(&s.source),
            Tok::Error { source, .. }
            | Tok::Directive { source, .. }
            | Tok::DocEnd { source, .. }
            | Tok::FlowScalar { source, .. }
            | Tok::BlockScalar { source, .. } => Some(source),
            _ => None,
        }
    }

    /// `token.source.length`, 0 where there is none.
    pub(super) fn source_len(&self) -> i64 {
        self.source().map_or(0, |s| s.len() as i64)
    }

    /// `'end' in token ? token.end : undefined`, when it is an array.
    fn end_array_mut(&mut self) -> Option<&mut Vec<Tok>> {
        match self {
            Tok::FlowScalar { end: Some(e), .. }
            | Tok::Document { end: Some(e), .. }
            | Tok::DocEnd { end: Some(e), .. } => Some(e),
            Tok::FlowCollection { end, .. } => Some(end),
            _ => None,
        }
    }
}

fn includes_token(list: &[Tok], ty: Ty) -> bool {
    list.iter().any(|t| t.ty() == ty)
}

/// `findNonEmptyIndex(list)`, `-1` when every token is space, comment or
/// newline.
fn find_non_empty_index(list: &[Tok]) -> isize {
    list.iter()
        .position(|t| !matches!(t.ty(), Ty::Space | Ty::Comment | Ty::Newline))
        .map_or(-1, |i| i as isize)
}

fn is_flow_token(t: Option<&Tok>) -> bool {
    matches!(
        t.map(Tok::ty),
        Some(
            Ty::Alias
                | Ty::Scalar
                | Ty::SingleQuotedScalar
                | Ty::DoubleQuotedScalar
                | Ty::FlowCollection
        )
    )
}

/// `getPrevProps(parent)`: the props list the next key's properties may
/// have been collected into (`None` is the JS fresh `[]`).
fn prev_props(parent: &mut Tok) -> Option<&mut Vec<Tok>> {
    match parent {
        Tok::Document { start, .. } => Some(start),
        Tok::BlockMap { items, .. } => {
            let it = items.last_mut()?;
            Some(match &mut it.sep {
                Some(sep) => sep,
                None => &mut it.start,
            })
        }
        Tok::BlockSeq { items, .. } => items.last_mut().map(|it| &mut it.start),
        _ => None,
    }
}

/// `getFirstKeyStartProps(prev)`: splices off (and returns) the props after
/// the last indicator or newline, skipping the spaces right after it.
fn first_key_start_props(prev: Option<&mut Vec<Tok>>) -> Vec<Tok> {
    let Some(prev) = prev else { return Vec::new() };
    if prev.is_empty() {
        return Vec::new();
    }
    let mut i = prev.len() as isize;
    loop {
        i -= 1;
        if i < 0 {
            break;
        }
        if matches!(
            prev[i as usize].ty(),
            Ty::DocStart | Ty::ExplicitKeyInd | Ty::MapValueInd | Ty::SeqItemInd | Ty::Newline
        ) {
            break;
        }
    }
    loop {
        i += 1;
        if (i as usize) < prev.len() && prev[i as usize].ty() == Ty::Space {
            continue;
        }
        break;
    }
    let i = (i as usize).min(prev.len());
    prev.split_off(i)
}

fn fix_flow_seq_items(fc: &mut Tok) {
    let Tok::FlowCollection { start, items, .. } = fc else {
        return;
    };
    if start.ty != Ty::FlowSeqStart {
        return;
    }
    for it in items {
        let Some(sep) = &it.sep else { continue };
        if it.value.is_none()
            && !includes_token(&it.start, Ty::ExplicitKeyInd)
            && !includes_token(sep, Ty::MapValueInd)
        {
            if let Some(key) = it.key.take() {
                it.value = Some(key);
            }
            let sep = it.sep.take().unwrap_or_default();
            if is_flow_token(it.value.as_deref()) {
                match it.value.as_deref_mut() {
                    Some(Tok::FlowScalar { end, .. }) => match end {
                        Some(e) => e.extend(sep),
                        None => *end = Some(sep),
                    },
                    Some(Tok::FlowCollection { end, .. }) => end.extend(sep),
                    _ => {}
                }
            } else {
                it.start.extend(sep);
            }
        }
    }
}

/// When a block collection is done, its last item may be nothing but
/// trailing space / comment / newline tokens: those belong to the parent
/// (`top.end` for a document, a new item otherwise). Returns them, removed
/// from `token`.
fn take_trailing_start(token: &mut Tok) -> Option<Vec<Tok>> {
    let (indent, items) = match token {
        Tok::BlockMap { indent, items, .. } | Tok::BlockSeq { indent, items, .. } => {
            (*indent, items)
        }
        _ => return None,
    };
    let last = items.last()?;
    if last.sep.is_none()
        && last.value.is_none()
        && !last.start.is_empty()
        && find_non_empty_index(&last.start) == -1
        && (indent == 0
            || last
                .start
                .iter()
                .all(|st| st.ty() != Ty::Comment || st.indent().unwrap_or(0) < indent))
    {
        return items.pop().map(|it| it.start);
    }
    None
}

pub(super) struct Parser {
    at_new_line: bool,
    at_scalar: bool,
    indent: i64,
    offset: i64,
    on_key_line: bool,
    stack: Vec<Tok>,
    source: Text,
    ty: Ty,
    out: Vec<Tok>,
}

/// How deep the parser's stack may grow: past this, composing would give up
/// anyway (`compose::MAX_DEPTH`), so parsing stops instead of building a
/// tree too deep to drop.
const MAX_STACK: usize = super::compose::MAX_DEPTH + 16;

/// `new Parser().parse(source)`, collected: the top-level tokens (documents,
/// directives, stream-level space / comments / newlines, errors). `None`
/// when the input nests deeper than [`MAX_STACK`].
pub(super) fn parse(buf: &[u16]) -> Option<Vec<Tok>> {
    let mut p = Parser {
        at_new_line: true,
        at_scalar: false,
        indent: 0,
        offset: 0,
        on_key_line: false,
        stack: Vec::new(),
        source: Rc::from(Vec::new()),
        ty: Ty::DocMode,
        out: Vec::new(),
    };
    for lexeme in lex(buf) {
        let source: Text = match lexeme {
            Lexeme::Document => Rc::from([0x02u16].as_slice()),
            Lexeme::FlowEnd => Rc::from([0x18u16].as_slice()),
            Lexeme::Scalar => Rc::from([0x1fu16].as_slice()),
            Lexeme::Text(s, e) => Rc::from(&buf[s..e]),
        };
        p.next(source);
        if p.stack.len() > MAX_STACK {
            // The open collections are siblings on the stack, so dropping
            // it here stays shallow.
            return None;
        }
    }
    while !p.stack.is_empty() {
        p.pop(None);
    }
    Some(p.out)
}

impl Parser {
    fn src_tok(&self) -> SrcTok {
        SrcTok {
            ty: self.ty,
            offset: self.offset,
            indent: self.indent,
            source: self.source.clone(),
        }
    }

    fn src(&self) -> Tok {
        Tok::Src(self.src_tok())
    }

    fn error(&self) -> Tok {
        Tok::Error {
            offset: self.offset,
            source: self.source.clone(),
        }
    }

    fn next(&mut self, source: Text) {
        let len = source.len() as i64;
        self.source = source;
        if self.at_scalar {
            self.at_scalar = false;
            self.step();
            self.offset += len;
            return;
        }
        match token_type(&self.source) {
            None => {
                // "Not a YAML token: …"
                let err = self.error();
                self.pop(Some(err));
                self.offset += len;
            }
            Some(Ty::Scalar) => {
                self.at_new_line = false;
                self.at_scalar = true;
                self.ty = Ty::Scalar;
            }
            Some(ty) => {
                self.ty = ty;
                self.step();
                match ty {
                    Ty::Newline => {
                        self.at_new_line = true;
                        self.indent = 0;
                    }
                    Ty::Space => {
                        if self.at_new_line && self.source.first() == Some(&u16::from(b' ')) {
                            self.indent += len;
                        }
                    }
                    Ty::ExplicitKeyInd | Ty::MapValueInd | Ty::SeqItemInd => {
                        if self.at_new_line {
                            self.indent += len;
                        }
                    }
                    Ty::DocMode | Ty::FlowErrorEnd => return,
                    _ => self.at_new_line = false,
                }
                self.offset += len;
            }
        }
    }

    fn top_ty(&self) -> Option<Ty> {
        self.stack.last().map(Tok::ty)
    }

    fn step(&mut self) {
        let top = self.top_ty();
        if self.ty == Ty::DocEnd && top != Some(Ty::DocEnd) {
            while !self.stack.is_empty() {
                self.pop(None);
            }
            self.stack.push(Tok::DocEnd {
                offset: self.offset,
                source: self.source.clone(),
                end: None,
            });
            return;
        }
        match top {
            None => self.stream(),
            Some(Ty::Document) => self.document(),
            Some(Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar) => {
                self.scalar()
            }
            Some(Ty::BlockScalar) => self.block_scalar(),
            Some(Ty::BlockMap) => self.block_map(),
            Some(Ty::BlockSeq) => self.block_sequence(),
            Some(Ty::FlowCollection) => self.flow_collection(),
            Some(Ty::DocEnd) => self.document_end(),
            Some(_) => self.pop(None),
        }
    }

    fn pop(&mut self, error: Option<Tok>) {
        let mut token = match error {
            Some(e) => e,
            None => match self.stack.pop() {
                Some(t) => t,
                None => {
                    // "Tried to pop an empty stack"
                    self.out.push(Tok::Error {
                        offset: self.offset,
                        source: Rc::from(Vec::new()),
                    });
                    return;
                }
            },
        };
        let Some(top) = self.stack.last_mut() else {
            self.out.push(token);
            return;
        };
        if token.ty() == Ty::BlockScalar {
            // Block scalars use their parent rather than header indent
            token.set_indent(top.indent().unwrap_or(0));
        } else if token.ty() == Ty::FlowCollection && top.ty() == Ty::Document {
            // Ignore all indent for top-level flow collections
            token.set_indent(0);
        }
        if token.ty() == Ty::FlowCollection {
            fix_flow_seq_items(&mut token);
        }
        let top_ty = top.ty();
        let fixable = matches!(top_ty, Ty::Document | Ty::BlockMap | Ty::BlockSeq);
        match top {
            Tok::Document { value, end, .. } => {
                let moved = if fixable {
                    take_trailing_start(&mut token)
                } else {
                    None
                };
                *value = Some(Box::new(token));
                if let Some(start) = moved {
                    *end = Some(start);
                }
            }
            Tok::BlockScalar { props, .. } => props.push(token), // error
            Tok::BlockMap { items, .. } => {
                let it = items.last_mut().expect("a block map has an item");
                if it.value.is_some() {
                    items.push(Item {
                        key: Some(Box::new(token)),
                        sep: Some(Vec::new()),
                        ..Item::default()
                    });
                    self.on_key_line = true;
                } else if it.sep.is_some() {
                    let moved = take_trailing_start(&mut token);
                    it.value = Some(Box::new(token));
                    if let Some(start) = moved {
                        items.push(Item::start(start));
                    }
                } else {
                    it.key = Some(Box::new(token));
                    it.sep = Some(Vec::new());
                    self.on_key_line = !it.explicit_key;
                }
            }
            Tok::BlockSeq { items, .. } => {
                let moved = take_trailing_start(&mut token);
                let it = items.last_mut().expect("a block seq has an item");
                if it.value.is_some() {
                    items.push(Item {
                        value: Some(Box::new(token)),
                        ..Item::default()
                    });
                } else {
                    it.value = Some(Box::new(token));
                }
                if let Some(start) = moved {
                    items.push(Item::start(start));
                }
            }
            Tok::FlowCollection { items, .. } => match items.last_mut() {
                Some(it) if it.value.is_none() => {
                    if it.sep.is_some() {
                        it.value = Some(Box::new(token));
                    } else {
                        it.key = Some(Box::new(token));
                        it.sep = Some(Vec::new());
                    }
                }
                _ => items.push(Item {
                    key: Some(Box::new(token)),
                    sep: Some(Vec::new()),
                    ..Item::default()
                }),
            },
            _ => {
                // should not happen
                self.pop(None);
                self.pop(Some(token));
            }
        }
    }

    fn stream(&mut self) {
        match self.ty {
            Ty::DirectiveLine => {
                self.out.push(Tok::Directive {
                    offset: self.offset,
                    source: self.source.clone(),
                });
            }
            Ty::ByteOrderMark | Ty::Space | Ty::Comment | Ty::Newline => {
                let t = self.src();
                self.out.push(t);
            }
            Ty::DocMode | Ty::DocStart => {
                let mut start = Vec::new();
                if self.ty == Ty::DocStart {
                    start.push(self.src());
                }
                self.stack.push(Tok::Document {
                    offset: self.offset,
                    start,
                    value: None,
                    end: None,
                });
            }
            _ => {
                // "Unexpected … token in YAML stream"
                let e = self.error();
                self.out.push(e);
            }
        }
    }

    fn document(&mut self) {
        let src = self.src();
        let Some(Tok::Document { start, value, .. }) = self.stack.last_mut() else {
            return;
        };
        if value.is_some() {
            return self.line_end();
        }
        match self.ty {
            Ty::DocStart => {
                if find_non_empty_index(start) != -1 {
                    self.pop(None);
                    self.step();
                } else {
                    start.push(src);
                }
                return;
            }
            Ty::Anchor | Ty::Tag | Ty::Space | Ty::Comment | Ty::Newline => {
                start.push(src);
                return;
            }
            _ => {}
        }
        match self.start_block_value() {
            Some(bv) => self.stack.push(bv),
            None => {
                // "Unexpected … token in YAML document"
                let e = self.error();
                self.out.push(e);
            }
        }
    }

    fn scalar(&mut self) {
        if self.ty == Ty::MapValueInd {
            let n = self.stack.len();
            let start = if n >= 2 {
                first_key_start_props(prev_props(&mut self.stack[n - 2]))
            } else {
                Vec::new()
            };
            let Some(mut scalar) = self.stack.pop() else {
                return;
            };
            let src = self.src();
            let sep = match &mut scalar {
                Tok::FlowScalar { end, .. } => match end.take() {
                    Some(mut e) => {
                        e.push(src);
                        e
                    }
                    None => vec![src],
                },
                _ => vec![src],
            };
            let (offset, indent) = (scalar.offset(), scalar.indent().unwrap_or(0));
            self.on_key_line = true;
            self.stack.push(Tok::BlockMap {
                offset,
                indent,
                items: vec![Item {
                    start,
                    key: Some(Box::new(scalar)),
                    sep: Some(sep),
                    ..Item::default()
                }],
            });
        } else {
            self.line_end();
        }
    }

    fn block_scalar(&mut self) {
        let src = self.src();
        let source = self.source.clone();
        let Some(Tok::BlockScalar {
            props, source: s, ..
        }) = self.stack.last_mut()
        else {
            return;
        };
        match self.ty {
            Ty::Space | Ty::Comment | Ty::Newline => props.push(src),
            Ty::Scalar => {
                *s = source;
                // block-scalar source includes trailing newline
                self.at_new_line = true;
                self.indent = 0;
                self.pop(None);
            }
            _ => {
                self.pop(None);
                self.step();
            }
        }
    }

    fn at_indented_comment(&self, start: &[Tok], indent: i64) -> bool {
        if self.ty != Ty::Comment {
            return false;
        }
        if self.indent <= indent {
            return false;
        }
        start
            .iter()
            .all(|st| matches!(st.ty(), Ty::Newline | Ty::Space))
    }

    fn block_map(&mut self) {
        let src = self.src();
        let ty = self.ty;
        let parser_indent = self.indent;
        match ty {
            Ty::Newline => {
                self.on_key_line = false;
                let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                    return;
                };
                let it = items.last_mut().expect("item");
                if let Some(value) = it.value.as_deref_mut() {
                    let is_comment_end = value
                        .end_array_mut()
                        .and_then(|e| e.last())
                        .is_some_and(|l| l.ty() == Ty::Comment);
                    if is_comment_end {
                        value.end_array_mut().expect("end").push(src);
                    } else {
                        items.push(Item::start(vec![src]));
                    }
                } else if let Some(sep) = &mut it.sep {
                    sep.push(src);
                } else {
                    it.start.push(src);
                }
                return;
            }
            Ty::Space | Ty::Comment => {
                let at_indented = {
                    let Some(Tok::BlockMap { items, indent, .. }) = self.stack.last() else {
                        return;
                    };
                    let it = items.last().expect("item");
                    it.value.is_none()
                        && it.sep.is_none()
                        && self.at_indented_comment(&it.start, *indent)
                };
                let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                    return;
                };
                let n = items.len();
                let it = items.last_mut().expect("item");
                if it.value.is_some() {
                    items.push(Item::start(vec![src]));
                } else if let Some(sep) = &mut it.sep {
                    sep.push(src);
                } else {
                    if at_indented && n >= 2 {
                        let has_end = items[n - 2]
                            .value
                            .as_deref_mut()
                            .is_some_and(|v| v.end_array_mut().is_some());
                        if has_end {
                            let last = items.pop().expect("item");
                            let end = items[n - 2]
                                .value
                                .as_deref_mut()
                                .and_then(Tok::end_array_mut)
                                .expect("end");
                            end.extend(last.start);
                            end.push(src);
                            return;
                        }
                    }
                    items.last_mut().expect("item").start.push(src);
                }
                return;
            }
            _ => {}
        }
        let (map_indent, map_offset_unused) = match self.stack.last() {
            Some(Tok::BlockMap { indent, offset, .. }) => (*indent, *offset),
            _ => return,
        };
        let _ = map_offset_unused;
        if parser_indent >= map_indent {
            let at_map_indent = !self.on_key_line && parser_indent == map_indent;
            let mut start: Vec<Tok> = Vec::new();
            let (at_next_item, it_has_value, it_has_sep, it_explicit) = {
                let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                    return;
                };
                let it = items.last_mut().expect("item");
                let at_next_item =
                    at_map_indent && (it.sep.is_some() || it.explicit_key) && ty != Ty::SeqItemInd;
                // For empty nodes, assign newline-separated not indented empty
                // tokens to following node
                if at_next_item && it.value.is_none() {
                    if let Some(sep) = &mut it.sep {
                        let mut nl: Vec<usize> = Vec::new();
                        for (i, st) in sep.iter().enumerate() {
                            match st.ty() {
                                Ty::Newline => nl.push(i),
                                Ty::Space => {}
                                Ty::Comment => {
                                    if st.indent().unwrap_or(0) > map_indent {
                                        nl.clear();
                                    }
                                }
                                _ => nl.clear(),
                            }
                        }
                        if nl.len() >= 2 {
                            start = sep.split_off(nl[1]);
                        }
                    }
                }
                (
                    at_next_item,
                    it.value.is_some(),
                    it.sep.is_some(),
                    it.explicit_key,
                )
            };
            let offset = self.offset;
            let indent = self.indent;
            match ty {
                Ty::Anchor | Ty::Tag => {
                    let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                        return;
                    };
                    if at_next_item || it_has_value {
                        start.push(src);
                        items.push(Item::start(start));
                        self.on_key_line = true;
                    } else {
                        let it = items.last_mut().expect("item");
                        match &mut it.sep {
                            Some(sep) => sep.push(src),
                            None => it.start.push(src),
                        }
                    }
                    return;
                }
                Ty::ExplicitKeyInd => {
                    if !it_has_sep && !it_explicit {
                        let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                            return;
                        };
                        let it = items.last_mut().expect("item");
                        it.start.push(src);
                        it.explicit_key = true;
                    } else if at_next_item || it_has_value {
                        let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                            return;
                        };
                        start.push(src);
                        items.push(Item {
                            start,
                            explicit_key: true,
                            ..Item::default()
                        });
                    } else {
                        self.stack.push(Tok::BlockMap {
                            offset,
                            indent,
                            items: vec![Item {
                                start: vec![src],
                                explicit_key: true,
                                ..Item::default()
                            }],
                        });
                    }
                    self.on_key_line = true;
                    return;
                }
                Ty::MapValueInd => {
                    let mut push: Option<Tok> = None;
                    {
                        let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                            return;
                        };
                        let n = items.len();
                        let it = &mut items[n - 1];
                        if it.explicit_key {
                            if it.sep.is_none() {
                                if includes_token(&it.start, Ty::Newline) {
                                    it.key = None;
                                    it.sep = Some(vec![src]);
                                } else {
                                    let start = first_key_start_props(Some(&mut it.start));
                                    push = Some(Tok::BlockMap {
                                        offset,
                                        indent,
                                        items: vec![Item {
                                            start,
                                            key: None,
                                            sep: Some(vec![src]),
                                            ..Item::default()
                                        }],
                                    });
                                }
                            } else if it.value.is_some() {
                                items.push(Item {
                                    key: None,
                                    sep: Some(vec![src]),
                                    ..Item::default()
                                });
                            } else if includes_token(
                                it.sep.as_deref().unwrap_or(&[]),
                                Ty::MapValueInd,
                            ) {
                                push = Some(Tok::BlockMap {
                                    offset,
                                    indent,
                                    items: vec![Item {
                                        start,
                                        key: None,
                                        sep: Some(vec![src]),
                                        ..Item::default()
                                    }],
                                });
                            } else if is_flow_token(it.key.as_deref())
                                && !includes_token(it.sep.as_deref().unwrap_or(&[]), Ty::Newline)
                            {
                                let start = first_key_start_props(Some(&mut it.start));
                                let key = it.key.take();
                                let mut sep = it.sep.take().unwrap_or_default();
                                sep.push(src);
                                push = Some(Tok::BlockMap {
                                    offset,
                                    indent,
                                    items: vec![Item {
                                        start,
                                        key,
                                        sep: Some(sep),
                                        ..Item::default()
                                    }],
                                });
                            } else if !start.is_empty() {
                                // Not actually at next item
                                let sep = it.sep.get_or_insert_with(Vec::new);
                                sep.extend(start);
                                sep.push(src);
                            } else {
                                it.sep.get_or_insert_with(Vec::new).push(src);
                            }
                        } else if it.sep.is_none() {
                            it.key = None;
                            it.sep = Some(vec![src]);
                        } else if it.value.is_some() || at_next_item {
                            items.push(Item {
                                start,
                                key: None,
                                sep: Some(vec![src]),
                                ..Item::default()
                            });
                        } else if includes_token(it.sep.as_deref().unwrap_or(&[]), Ty::MapValueInd)
                        {
                            push = Some(Tok::BlockMap {
                                offset,
                                indent,
                                items: vec![Item {
                                    key: None,
                                    sep: Some(vec![src]),
                                    ..Item::default()
                                }],
                            });
                        } else {
                            it.sep.get_or_insert_with(Vec::new).push(src);
                        }
                    }
                    if let Some(p) = push {
                        self.stack.push(p);
                    }
                    self.on_key_line = true;
                    return;
                }
                Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar => {
                    let fs = self.flow_scalar(ty);
                    if at_next_item || it_has_value {
                        let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                            return;
                        };
                        items.push(Item {
                            start,
                            key: Some(Box::new(fs)),
                            sep: Some(Vec::new()),
                            ..Item::default()
                        });
                        self.on_key_line = true;
                    } else if it_has_sep {
                        self.stack.push(fs);
                    } else {
                        let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                            return;
                        };
                        let it = items.last_mut().expect("item");
                        it.key = Some(Box::new(fs));
                        it.sep = Some(Vec::new());
                        self.on_key_line = true;
                    }
                    return;
                }
                _ => {
                    if let Some(bv) = self.start_block_value() {
                        if bv.ty() == Ty::BlockSeq {
                            let same_line_key = {
                                let Some(Tok::BlockMap { items, .. }) = self.stack.last() else {
                                    return;
                                };
                                let it = items.last().expect("item");
                                !it.explicit_key
                                    && it
                                        .sep
                                        .as_deref()
                                        .is_some_and(|sep| !includes_token(sep, Ty::Newline))
                            };
                            if same_line_key {
                                // "Unexpected block-seq-ind on same line with key"
                                let e = self.error();
                                self.pop(Some(e));
                                return;
                            }
                        } else if at_map_indent {
                            let Some(Tok::BlockMap { items, .. }) = self.stack.last_mut() else {
                                return;
                            };
                            items.push(Item::start(start));
                        }
                        self.stack.push(bv);
                        return;
                    }
                }
            }
        }
        self.pop(None);
        self.step();
    }

    fn block_sequence(&mut self) {
        let src = self.src();
        let ty = self.ty;
        match ty {
            Ty::Newline => {
                let Some(Tok::BlockSeq { items, .. }) = self.stack.last_mut() else {
                    return;
                };
                let it = items.last_mut().expect("item");
                if let Some(value) = it.value.as_deref_mut() {
                    let is_comment_end = value
                        .end_array_mut()
                        .and_then(|e| e.last())
                        .is_some_and(|l| l.ty() == Ty::Comment);
                    if is_comment_end {
                        value.end_array_mut().expect("end").push(src);
                    } else {
                        items.push(Item::start(vec![src]));
                    }
                } else {
                    it.start.push(src);
                }
                return;
            }
            Ty::Space | Ty::Comment => {
                let at_indented = {
                    let Some(Tok::BlockSeq { items, indent, .. }) = self.stack.last() else {
                        return;
                    };
                    let it = items.last().expect("item");
                    it.value.is_none() && self.at_indented_comment(&it.start, *indent)
                };
                let Some(Tok::BlockSeq { items, .. }) = self.stack.last_mut() else {
                    return;
                };
                let n = items.len();
                if items[n - 1].value.is_some() {
                    items.push(Item::start(vec![src]));
                } else {
                    if at_indented && n >= 2 {
                        let has_end = items[n - 2]
                            .value
                            .as_deref_mut()
                            .is_some_and(|v| v.end_array_mut().is_some());
                        if has_end {
                            let last = items.pop().expect("item");
                            let end = items[n - 2]
                                .value
                                .as_deref_mut()
                                .and_then(Tok::end_array_mut)
                                .expect("end");
                            end.extend(last.start);
                            end.push(src);
                            return;
                        }
                    }
                    items[n - 1].start.push(src);
                }
                return;
            }
            Ty::Anchor | Ty::Tag => {
                let parser_indent = self.indent;
                let Some(Tok::BlockSeq { items, indent, .. }) = self.stack.last_mut() else {
                    return;
                };
                let it = items.last_mut().expect("item");
                if !(it.value.is_some() || parser_indent <= *indent) {
                    it.start.push(src);
                    return;
                }
            }
            Ty::SeqItemInd => {
                let parser_indent = self.indent;
                let Some(Tok::BlockSeq { items, indent, .. }) = self.stack.last_mut() else {
                    return;
                };
                if parser_indent == *indent {
                    let it = items.last_mut().expect("item");
                    if it.value.is_some() || includes_token(&it.start, Ty::SeqItemInd) {
                        items.push(Item::start(vec![src]));
                    } else {
                        it.start.push(src);
                    }
                    return;
                }
            }
            _ => {}
        }
        let seq_indent = self.stack.last().and_then(Tok::indent).unwrap_or(0);
        if self.indent > seq_indent
            && let Some(bv) = self.start_block_value()
        {
            self.stack.push(bv);
            return;
        }
        self.pop(None);
        self.step();
    }

    fn flow_collection(&mut self) {
        let src = self.src();
        let ty = self.ty;
        if ty == Ty::FlowErrorEnd {
            loop {
                self.pop(None);
                if self.top_ty() != Some(Ty::FlowCollection) {
                    break;
                }
            }
            return;
        }
        let end_empty =
            matches!(self.stack.last(), Some(Tok::FlowCollection { end, .. }) if end.is_empty());
        if end_empty {
            {
                let Some(Tok::FlowCollection { items, end, .. }) = self.stack.last_mut() else {
                    return;
                };
                match ty {
                    Ty::Comma | Ty::ExplicitKeyInd => {
                        match items.last_mut() {
                            Some(it) if it.sep.is_none() => it.start.push(src),
                            _ => items.push(Item::start(vec![src])),
                        }
                        return;
                    }
                    Ty::MapValueInd => {
                        match items.last_mut() {
                            Some(it) if it.value.is_none() => match &mut it.sep {
                                Some(sep) => sep.push(src),
                                None => {
                                    it.key = None;
                                    it.sep = Some(vec![src]);
                                }
                            },
                            _ => items.push(Item {
                                key: None,
                                sep: Some(vec![src]),
                                ..Item::default()
                            }),
                        }
                        return;
                    }
                    Ty::Space | Ty::Comment | Ty::Newline | Ty::Anchor | Ty::Tag => {
                        match items.last_mut() {
                            Some(it) if it.value.is_none() => match &mut it.sep {
                                Some(sep) => sep.push(src),
                                None => it.start.push(src),
                            },
                            _ => items.push(Item::start(vec![src])),
                        }
                        return;
                    }
                    Ty::FlowMapEnd | Ty::FlowSeqEnd => {
                        end.push(src);
                        return;
                    }
                    _ => {}
                }
            }
            if matches!(
                ty,
                Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar
            ) {
                let fs = self.flow_scalar(ty);
                let Some(Tok::FlowCollection { items, .. }) = self.stack.last_mut() else {
                    return;
                };
                match items.last_mut() {
                    Some(it) if it.value.is_none() => {
                        if it.sep.is_some() {
                            self.stack.push(fs);
                        } else {
                            it.key = Some(Box::new(fs));
                            it.sep = Some(Vec::new());
                        }
                    }
                    _ => items.push(Item {
                        key: Some(Box::new(fs)),
                        sep: Some(Vec::new()),
                        ..Item::default()
                    }),
                }
                return;
            }
            match self.start_block_value() {
                Some(bv) => self.stack.push(bv),
                None => {
                    self.pop(None);
                    self.step();
                }
            }
        } else {
            let n = self.stack.len();
            let fc_indent = self.stack[n - 1].indent().unwrap_or(0);
            let (parent_ty, parent_indent, parent_last_has_sep) = if n >= 2 {
                let parent = &self.stack[n - 2];
                let last_sep = match parent {
                    Tok::BlockMap { items, .. } => items.last().is_some_and(|it| it.sep.is_some()),
                    _ => false,
                };
                (Some(parent.ty()), parent.indent(), last_sep)
            } else {
                (None, None, false)
            };
            if parent_ty == Some(Ty::BlockMap)
                && ((ty == Ty::MapValueInd && parent_indent == Some(fc_indent))
                    || (ty == Ty::Newline && !parent_last_has_sep))
            {
                self.pop(None);
                self.step();
            } else if ty == Ty::MapValueInd && parent_ty != Some(Ty::FlowCollection) {
                let start = if n >= 2 {
                    first_key_start_props(prev_props(&mut self.stack[n - 2]))
                } else {
                    Vec::new()
                };
                let Some(mut fc) = self.stack.pop() else {
                    return;
                };
                fix_flow_seq_items(&mut fc);
                let mut sep = match &mut fc {
                    Tok::FlowCollection { end, .. } => end.split_off(1.min(end.len())),
                    _ => Vec::new(),
                };
                sep.push(src);
                let (offset, indent) = (fc.offset(), fc.indent().unwrap_or(0));
                self.on_key_line = true;
                self.stack.push(Tok::BlockMap {
                    offset,
                    indent,
                    items: vec![Item {
                        start,
                        key: Some(Box::new(fc)),
                        sep: Some(sep),
                        ..Item::default()
                    }],
                });
            } else {
                self.line_end();
            }
        }
    }

    fn flow_scalar(&self, ty: Ty) -> Tok {
        Tok::FlowScalar {
            ty,
            offset: self.offset,
            indent: self.indent,
            source: self.source.clone(),
            end: None,
        }
    }

    /// `startBlockValue(parent)`, the parent being the top of the stack.
    fn start_block_value(&mut self) -> Option<Tok> {
        let src = self.src_tok();
        match self.ty {
            Ty::Alias | Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar => {
                Some(self.flow_scalar(self.ty))
            }
            Ty::BlockScalarHeader => Some(Tok::BlockScalar {
                offset: self.offset,
                indent: self.indent,
                props: vec![Tok::Src(src)],
                source: Rc::from(Vec::new()),
            }),
            Ty::FlowMapStart | Ty::FlowSeqStart => Some(Tok::FlowCollection {
                offset: self.offset,
                indent: self.indent,
                start: src,
                items: Vec::new(),
                end: Vec::new(),
            }),
            Ty::SeqItemInd => Some(Tok::BlockSeq {
                offset: self.offset,
                indent: self.indent,
                items: vec![Item::start(vec![Tok::Src(src)])],
            }),
            Ty::ExplicitKeyInd => {
                self.on_key_line = true;
                let mut start = first_key_start_props(self.stack.last_mut().and_then(prev_props));
                start.push(Tok::Src(src));
                Some(Tok::BlockMap {
                    offset: self.offset,
                    indent: self.indent,
                    items: vec![Item {
                        start,
                        explicit_key: true,
                        ..Item::default()
                    }],
                })
            }
            Ty::MapValueInd => {
                self.on_key_line = true;
                let start = first_key_start_props(self.stack.last_mut().and_then(prev_props));
                Some(Tok::BlockMap {
                    offset: self.offset,
                    indent: self.indent,
                    items: vec![Item {
                        start,
                        key: None,
                        sep: Some(vec![Tok::Src(src)]),
                        ..Item::default()
                    }],
                })
            }
            _ => None,
        }
    }

    fn document_end(&mut self) {
        if self.ty != Ty::DocMode {
            let src = self.src();
            if let Some(Tok::DocEnd { end, .. }) = self.stack.last_mut() {
                end.get_or_insert_with(Vec::new).push(src);
            }
            if self.ty == Ty::Newline {
                self.pop(None);
            }
        }
    }

    fn line_end(&mut self) {
        match self.ty {
            Ty::Comma
            | Ty::DocStart
            | Ty::DocEnd
            | Ty::FlowSeqEnd
            | Ty::FlowMapEnd
            | Ty::MapValueInd => {
                self.pop(None);
                self.step();
            }
            ty => {
                if ty == Ty::Newline {
                    self.on_key_line = false;
                }
                let src = self.src();
                match self.stack.last_mut() {
                    Some(
                        Tok::Document { end, .. }
                        | Tok::FlowScalar { end, .. }
                        | Tok::DocEnd { end, .. },
                    ) => {
                        end.get_or_insert_with(Vec::new).push(src);
                    }
                    Some(Tok::FlowCollection { end, .. }) => end.push(src),
                    _ => {}
                }
                if ty == Ty::Newline {
                    self.pop(None);
                }
            }
        }
    }
}
