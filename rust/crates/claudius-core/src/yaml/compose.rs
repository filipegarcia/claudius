//! Port of yaml 2.9.0's `compose/` (the CST → node tree step) with the
//! default options `parse()` uses: `strict`, `uniqueKeys`, no `stringKeys`,
//! no `keepSourceTokens`, no custom tags or `compat` schema.
//!
//! Every `onError(…)` call is recorded by code, split into errors and
//! warnings as the JS splits them; positions and messages are not kept
//! (nothing downstream reads them: `YAML.parse` throws on the first error
//! and `parseFrontmatter` swallows it).

use super::parser::{Item, Text, Tok, Ty};
use super::schema::{self, Directives, Schema, Tag};
use super::{SVal, U16s, eq_ascii};

/// `Scalar.type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SType {
    Plain,
    QuoteSingle,
    QuoteDouble,
    BlockFolded,
    BlockLiteral,
}

#[derive(Debug)]
pub(super) struct Node {
    /// Identity, for anchors, aliases and the JS objects made from it.
    pub id: usize,
    pub kind: Kind,
    pub anchor: Option<U16s>,
    pub tag: Option<U16s>,
    pub comment: U16s,
    pub comment_before: U16s,
    /// A blank line before it (stringified keys keep it).
    pub space_before: bool,
    pub range: [i64; 3],
}

#[derive(Debug)]
pub(super) enum Kind {
    Scalar {
        value: SVal,
        ty: Option<SType>,
        /// The merge tag's `addToJSMap` (only `!!merge` / a 1.1 `<<` key).
        merge: bool,
        /// `scalar.source`: the string the tag resolved.
        source: U16s,
        /// The tag that resolved it (its `format` and `minFractionDigits`
        /// steer how a key's number is stringified).
        rtag: Tag,
    },
    Alias(U16s),
    /// A `YAMLMap`, or (`set`) a `YAMLSet`.
    Map {
        items: Vec<Pair>,
        set: bool,
    },
    /// A `YAMLSeq`, or (`omap`) a `YAMLOMap`.
    Seq {
        items: Vec<SeqItem>,
        omap: bool,
    },
}

#[derive(Debug)]
pub(super) struct Pair {
    pub key: Box<Node>,
    pub value: Option<Box<Node>>,
}

#[derive(Debug)]
pub(super) enum SeqItem {
    Node(Node),
    Pair(Pair),
}

#[derive(Debug, Default)]
pub(super) struct Report {
    pub errors: Vec<&'static str>,
    pub warnings: Vec<&'static str>,
}

impl Report {
    pub(super) fn on_error(&mut self, code: &'static str, warning: bool) {
        if warning {
            self.warnings.push(code);
        } else {
            self.errors.push(code);
        }
    }
}

/// How deep collections may nest before composing gives up, as V8 runs out
/// of stack (and yaml reports `RESOURCE_EXHAUSTION`) somewhere past ~700–1700
/// levels depending on the collection kind and the frames already in use.
pub(super) const MAX_DEPTH: usize = 1000;

pub(super) struct Composer<'a> {
    pub report: &'a mut Report,
    pub next_id: &'a mut usize,
    directives: &'a Directives,
    pub schema: &'a Schema,
    at_key: bool,
    at_root: bool,
    depth: usize,
    /// The known tags pushed into a `core` schema's tags so far.
    pub pushed: Vec<Tag>,
}

/// `resolveCollection(…, tagName)`'s tag for a collection resolved
/// without a schema tag: the class's own for `!` or its own name.
fn coll_tag(coll: &Node, tag_name: Option<U16s>) -> Option<U16s> {
    let own = match &coll.kind {
        Kind::Map { set: true, .. } => Tag::Set.name(),
        Kind::Map { .. } => schema::MAP_TAG,
        Kind::Seq { omap: true, .. } => Tag::OMap.name(),
        _ => schema::SEQ_TAG,
    };
    let name = tag_name?;
    if eq_ascii(&name, "!") || eq_ascii(&name, own) {
        Some(own.encode_utf16().collect())
    } else {
        Some(name)
    }
}

fn src_of(t: &Tok) -> &[u16] {
    t.source().map_or(&[][..], |s| &s[..])
}

fn includes(s: &[u16], c: u8) -> bool {
    s.contains(&u16::from(c))
}

/// `a ? `${a}${sep}${b}` : b` for comments.
fn join_comment(into: &mut U16s, sep: &str, more: &[u16]) {
    if into.is_empty() {
        into.extend_from_slice(more);
    } else {
        into.extend(sep.encode_utf16());
        into.extend_from_slice(more);
    }
}

pub(super) struct Props<'t> {
    pub comma: Option<&'t Tok>,
    pub found: Option<&'t Tok>,
    pub comment: U16s,
    pub space_before: bool,
    pub has_newline: bool,
    pub anchor: Option<&'t Tok>,
    pub tag: Option<&'t Tok>,
    pub newline_after_prop: Option<&'t Tok>,
    pub end: i64,
    pub start: i64,
}

struct PropsOpts<'t> {
    flow: Option<&'static str>,
    indicator: Ty,
    next: Option<&'t Tok>,
    offset: i64,
    parent_indent: i64,
    start_on_newline: bool,
}

/// `resolveProps(tokens, opts)`.
fn resolve_props<'t>(report: &mut Report, tokens: &'t [Tok], o: PropsOpts<'t>) -> Props<'t> {
    let mut at_newline = o.start_on_newline;
    let mut has_space = o.start_on_newline;
    let mut comment: U16s = Vec::new();
    let mut comment_sep: U16s = Vec::new();
    let mut has_newline = false;
    let mut space_before = false;
    let mut req_space = false;
    let mut tab: Option<&Tok> = None;
    let mut anchor: Option<&Tok> = None;
    let mut tag: Option<&Tok> = None;
    let mut newline_after_prop: Option<&Tok> = None;
    let mut comma: Option<&Tok> = None;
    let mut found: Option<&Tok> = None;
    let mut start: Option<i64> = None;
    for token in tokens {
        let ty = token.ty();
        if req_space {
            if !matches!(ty, Ty::Space | Ty::Newline | Ty::Comma) {
                report.on_error("MISSING_CHAR", false);
            }
            req_space = false;
        }
        if let Some(_t) = tab {
            if at_newline && ty != Ty::Comment && ty != Ty::Newline {
                report.on_error("TAB_AS_INDENT", false);
            }
            tab = None;
        }
        match ty {
            Ty::Space => {
                // At the doc level, tabs at line start may be parsed as
                // leading white space rather than indentation. In a flow
                // collection, only the parser handles indent.
                if o.flow.is_none()
                    && (o.indicator != Ty::DocStart
                        || o.next.map(Tok::ty) != Some(Ty::FlowCollection))
                    && includes(src_of(token), b'\t')
                {
                    tab = Some(token);
                }
                has_space = true;
            }
            Ty::Comment => {
                if !has_space {
                    report.on_error("MISSING_CHAR", false);
                }
                let src = src_of(token);
                let cb: &[u16] = if src.len() > 1 { &src[1..] } else { &[0x20] };
                if comment.is_empty() {
                    comment = cb.to_vec();
                } else {
                    comment.extend_from_slice(&comment_sep);
                    comment.extend_from_slice(cb);
                }
                comment_sep.clear();
                at_newline = false;
            }
            Ty::Newline => {
                if at_newline {
                    if !comment.is_empty() {
                        comment.extend_from_slice(src_of(token));
                    } else if found.is_none() || o.indicator != Ty::SeqItemInd {
                        space_before = true;
                    }
                } else {
                    comment_sep.extend_from_slice(src_of(token));
                }
                at_newline = true;
                has_newline = true;
                if anchor.is_some() || tag.is_some() {
                    newline_after_prop = Some(token);
                }
                has_space = true;
            }
            Ty::Anchor => {
                if anchor.is_some() {
                    report.on_error("MULTIPLE_ANCHORS", false);
                }
                if src_of(token).last() == Some(&u16::from(b':')) {
                    report.on_error("BAD_ALIAS", true);
                }
                anchor = Some(token);
                start.get_or_insert(token.offset());
                at_newline = false;
                has_space = false;
                req_space = true;
            }
            Ty::Tag => {
                if tag.is_some() {
                    report.on_error("MULTIPLE_TAGS", false);
                }
                tag = Some(token);
                start.get_or_insert(token.offset());
                at_newline = false;
                has_space = false;
                req_space = true;
            }
            t if t == o.indicator => {
                // Could here handle preceding comments differently
                if anchor.is_some() || tag.is_some() {
                    report.on_error("BAD_PROP_ORDER", false);
                }
                if found.is_some() {
                    report.on_error("UNEXPECTED_TOKEN", false);
                }
                found = Some(token);
                at_newline = matches!(o.indicator, Ty::SeqItemInd | Ty::ExplicitKeyInd);
                has_space = false;
            }
            Ty::Comma if o.flow.is_some() => {
                if comma.is_some() {
                    report.on_error("UNEXPECTED_TOKEN", false);
                }
                comma = Some(token);
                at_newline = false;
                has_space = false;
            }
            _ => {
                report.on_error("UNEXPECTED_TOKEN", false);
                at_newline = false;
                has_space = false;
            }
        }
    }
    let end = tokens
        .last()
        .map_or(o.offset, |l| l.offset() + l.source_len());
    if req_space && let Some(next) = o.next {
        let nt = next.ty();
        if nt != Ty::Space
            && nt != Ty::Newline
            && nt != Ty::Comma
            && (nt != Ty::Scalar || next.source().is_none_or(|s| !s.is_empty()))
        {
            report.on_error("MISSING_CHAR", false);
        }
    }
    if let Some(t) = tab
        && ((at_newline && t.indent().unwrap_or(0) <= o.parent_indent)
            || matches!(o.next.map(Tok::ty), Some(Ty::BlockMap | Ty::BlockSeq)))
    {
        report.on_error("TAB_AS_INDENT", false);
    }
    Props {
        comma,
        found,
        comment,
        space_before,
        has_newline,
        anchor,
        tag,
        newline_after_prop,
        end,
        start: start.unwrap_or(end),
    }
}

/// `resolveEnd(end, offset, reqSpace, onError)`.
pub(super) fn resolve_end(
    report: &mut Report,
    end: Option<&[Tok]>,
    offset: i64,
    req_space: bool,
) -> (U16s, i64) {
    resolve_end_iter(report, end.into_iter().flatten(), offset, req_space)
}

fn resolve_end_iter<'t>(
    report: &mut Report,
    end: impl IntoIterator<Item = &'t Tok>,
    mut offset: i64,
    req_space: bool,
) -> (U16s, i64) {
    let mut comment: U16s = Vec::new();
    {
        let mut has_space = false;
        let mut sep: U16s = Vec::new();
        for token in end {
            let source = src_of(token);
            match token.ty() {
                Ty::Space => has_space = true,
                Ty::Comment => {
                    if req_space && !has_space {
                        report.on_error("MISSING_CHAR", false);
                    }
                    let cb: &[u16] = if source.len() > 1 {
                        &source[1..]
                    } else {
                        &[0x20]
                    };
                    if comment.is_empty() {
                        comment = cb.to_vec();
                    } else {
                        comment.extend_from_slice(&sep);
                        comment.extend_from_slice(cb);
                    }
                    sep.clear();
                }
                Ty::Newline => {
                    if !comment.is_empty() {
                        sep.extend_from_slice(source);
                    }
                    has_space = true;
                }
                _ => report.on_error("UNEXPECTED_TOKEN", false),
            }
            offset += source.len() as i64;
        }
    }
    (comment, offset)
}

/// `containsNewline(key)`.
fn contains_newline(key: Option<&Tok>) -> bool {
    let Some(key) = key else { return false };
    match key {
        Tok::FlowScalar { source, end, .. } => {
            includes(source, b'\n')
                || end
                    .as_deref()
                    .is_some_and(|e| e.iter().any(|st| st.ty() == Ty::Newline))
        }
        Tok::FlowCollection { items, .. } => items.iter().any(|it| {
            it.start.iter().any(|st| st.ty() == Ty::Newline)
                || it
                    .sep
                    .as_deref()
                    .is_some_and(|s| s.iter().any(|st| st.ty() == Ty::Newline))
                || contains_newline(it.key.as_deref())
                || contains_newline(it.value.as_deref())
        }),
        _ => true,
    }
}

/// `emptyScalarPosition(offset, before, pos)` with `pos` unset.
fn empty_scalar_position(mut offset: i64, before: Option<&[Tok]>) -> i64 {
    let Some(before) = before else { return offset };
    let mut i = before.len() as isize - 1;
    while i >= 0 {
        let st = &before[i as usize];
        match st.ty() {
            Ty::Space | Ty::Comment | Ty::Newline => {
                offset -= st.source_len();
                i -= 1;
                continue;
            }
            _ => {}
        }
        // Technically, an empty scalar is immediately after the last
        // non-empty node, but it's more useful to place it after any
        // whitespace.
        let mut j = (i + 1) as usize;
        while let Some(st) = before.get(j) {
            if st.ty() != Ty::Space {
                break;
            }
            offset += st.source_len();
            j += 1;
        }
        break;
    }
    offset
}

/// `a.value === b.value` for two scalar nodes (strict equality; objects by
/// identity, which separately composed nodes never share).
fn same_scalar_value(a: &Node, b: &Node) -> bool {
    match (&a.kind, &b.kind) {
        (Kind::Scalar { value: x, .. }, Kind::Scalar { value: y, .. }) => match (x, y) {
            (SVal::Null, SVal::Null) => true,
            (SVal::Bool(p), SVal::Bool(q)) => p == q,
            (SVal::Num(p), SVal::Num(q)) => p == q,
            (SVal::Str(p), SVal::Str(q)) => p == q,
            _ => false,
        },
        _ => false,
    }
}

impl<'a> Composer<'a> {
    pub(super) fn new(
        report: &'a mut Report,
        next_id: &'a mut usize,
        directives: &'a Directives,
        schema: &'a Schema,
    ) -> Self {
        Composer {
            report,
            next_id,
            directives,
            schema,
            at_key: false,
            at_root: true,
            depth: 0,
            pushed: Vec::new(),
        }
    }

    /// `ctx.schema.tags.push(Object.assign({}, kt, …))` the first time a
    /// `core` document resolves a known tag.
    fn push_known(&mut self, tag: Tag) {
        if !self.schema.yaml11 && tag.is_core_known() && !self.pushed.contains(&tag) {
            self.pushed.push(tag);
        }
    }

    fn err(&mut self, code: &'static str) {
        self.report.on_error(code, false);
    }

    fn warn(&mut self, code: &'static str) {
        self.report.on_error(code, true);
    }

    fn node(&mut self, kind: Kind, range: [i64; 3]) -> Node {
        let id = *self.next_id;
        *self.next_id += 1;
        Node {
            id,
            kind,
            anchor: None,
            tag: None,
            comment: Vec::new(),
            comment_before: Vec::new(),
            space_before: false,
            range,
        }
    }

    fn props<'t>(&mut self, tokens: &'t [Tok], o: PropsOpts<'t>) -> Props<'t> {
        resolve_props(self.report, tokens, o)
    }

    /// `composeDoc(...)`'s body: the document contents and the offset the
    /// document's own end tokens start at. Returns `(contents, docStart)`.
    pub(super) fn compose_doc(
        &mut self,
        offset: i64,
        start: &[Tok],
        value: Option<&Tok>,
        end: Option<&[Tok]>,
    ) -> (Node, bool) {
        let next = value.or_else(|| end.and_then(|e| e.first()));
        let props = self.props(
            start,
            PropsOpts {
                flow: None,
                indicator: Ty::DocStart,
                next,
                offset,
                parent_indent: 0,
                start_on_newline: true,
            },
        );
        let doc_start = props.found.is_some();
        if doc_start
            && let Some(v) = value
            && matches!(v.ty(), Ty::BlockMap | Ty::BlockSeq)
            && !props.has_newline
        {
            self.err("MISSING_CHAR");
        }
        let contents = match value {
            Some(v) => self.compose_node(v, &props),
            None => self.compose_empty_node(props.end, Some(start), &props),
        };
        let content_end = contents.range[2];
        let _ = resolve_end(self.report, end, content_end, false);
        (contents, doc_start)
    }

    /// `composeNode(ctx, token, props, onError)`.
    fn compose_node(&mut self, token: &Tok, props: &Props) -> Node {
        let at_key = self.at_key;
        let _ = at_key; // only read with `stringKeys`
        let mut node: Option<Node> = None;
        match token.ty() {
            Ty::Alias => {
                node = Some(self.compose_alias(token));
                if props.anchor.is_some() || props.tag.is_some() {
                    self.err("ALIAS_PROPS");
                }
            }
            Ty::Scalar | Ty::SingleQuotedScalar | Ty::DoubleQuotedScalar | Ty::BlockScalar => {
                let mut n = self.compose_scalar(token, props.tag);
                if let Some(a) = props.anchor {
                    n.anchor = Some(src_of(a).get(1..).unwrap_or(&[]).to_vec());
                }
                node = Some(n);
            }
            Ty::BlockMap | Ty::BlockSeq | Ty::FlowCollection => {
                if self.depth >= MAX_DEPTH {
                    // Almost certainly here due to a stack overflow
                    self.err("RESOURCE_EXHAUSTION");
                } else {
                    self.depth += 1;
                    let mut n = self.compose_collection(token, props);
                    self.depth -= 1;
                    if let Some(a) = props.anchor {
                        n.anchor = Some(src_of(a).get(1..).unwrap_or(&[]).to_vec());
                    }
                    node = Some(n);
                }
            }
            _ => self.err("UNEXPECTED_TOKEN"),
        }
        let mut node = match node {
            Some(n) => n,
            None => self.compose_empty_node(token.offset(), None, props),
        };
        if props.anchor.is_some() && node.anchor.as_deref() == Some(&[]) {
            self.err("BAD_ALIAS");
        }
        if props.space_before {
            node.space_before = true;
        }
        if !props.comment.is_empty() {
            if token.ty() == Ty::Scalar && token.source().is_some_and(|s| s.is_empty()) {
                node.comment = props.comment.clone();
            } else {
                node.comment_before = props.comment.clone();
            }
        }
        node
    }

    /// `composeEmptyNode(ctx, offset, before, null, props, onError)`.
    fn compose_empty_node(&mut self, offset: i64, before: Option<&[Tok]>, props: &Props) -> Node {
        let token = Tok::FlowScalar {
            ty: Ty::Scalar,
            offset: empty_scalar_position(offset, before),
            indent: -1,
            source: Text::from(Vec::new()),
            end: None,
        };
        let mut node = self.compose_scalar(&token, props.tag);
        if let Some(a) = props.anchor {
            let anchor = src_of(a).get(1..).unwrap_or(&[]).to_vec();
            if anchor.is_empty() {
                self.err("BAD_ALIAS");
            }
            node.anchor = Some(anchor);
        }
        if props.space_before {
            node.space_before = true;
        }
        if !props.comment.is_empty() {
            node.comment = props.comment.clone();
            node.range[2] = props.end;
        }
        node
    }

    /// `composeAlias(ctx, token, onError)`.
    fn compose_alias(&mut self, token: &Tok) -> Node {
        let Tok::FlowScalar {
            offset,
            source,
            end,
            ..
        } = token
        else {
            unreachable!("aliases are flow scalars")
        };
        let name = source.get(1..).unwrap_or(&[]).to_vec();
        if name.is_empty() {
            self.err("BAD_ALIAS");
        }
        if name.last() == Some(&u16::from(b':')) {
            self.warn("BAD_ALIAS");
        }
        let value_end = offset + source.len() as i64;
        let (comment, re_offset) = resolve_end(self.report, end.as_deref(), value_end, true);
        let mut n = self.node(Kind::Alias(name), [*offset, value_end, re_offset]);
        n.comment = comment;
        n
    }

    fn tag_name(&mut self, tag_token: &Tok) -> Option<U16s> {
        let mut failures = 0;
        let name = self
            .directives
            .tag_name(src_of(tag_token), &mut || failures += 1);
        for _ in 0..failures {
            self.err("TAG_RESOLVE_FAILED");
        }
        name
    }

    /// `composeScalar(ctx, token, tagToken, onError)`.
    fn compose_scalar(&mut self, token: &Tok, tag_token: Option<&Tok>) -> Node {
        let (value, ty, comment, range) = if token.ty() == Ty::BlockScalar {
            self.resolve_block_scalar(token)
        } else {
            self.resolve_flow_scalar(token)
        };
        let tag_name = tag_token.and_then(|t| self.tag_name(t));
        let tag = match &tag_name {
            Some(name) => {
                let tag = self.find_scalar_tag_by_name(&value, name);
                self.push_known(tag);
                tag
            }
            None if token.ty() == Ty::Scalar => self.schema.find_by_test(&value, self.at_key),
            None => Tag::Str,
        };
        let (svalue, merge, rtag) = match schema::resolve_scalar(tag, &value, self.schema) {
            Ok((v, m)) => (v, m, tag),
            Err(()) => {
                self.err("TAG_RESOLVE_FAILED");
                (SVal::Str(value.clone()), false, Tag::Str)
            }
        };
        let mut n = self.node(
            Kind::Scalar {
                value: svalue,
                ty,
                merge,
                source: value,
                rtag,
            },
            range,
        );
        n.tag = tag_name;
        n.comment = comment;
        n
    }

    /// `findScalarTagByName(schema, value, tagName, tagToken, onError)`.
    fn find_scalar_tag_by_name(&mut self, value: &[u16], tag_name: &[u16]) -> Tag {
        if eq_ascii(tag_name, "!") {
            return Tag::Str; // non-specific tag
        }
        match self.schema.find_by_name(value, tag_name) {
            Some(tag) => tag,
            None => {
                let warning = !eq_ascii(tag_name, "tag:yaml.org,2002:str");
                self.report.on_error("TAG_RESOLVE_FAILED", warning);
                Tag::Str
            }
        }
    }

    /// `resolveFlowScalar(scalar, strict, onError)`.
    fn resolve_flow_scalar(&mut self, token: &Tok) -> (U16s, Option<SType>, U16s, [i64; 3]) {
        let Tok::FlowScalar {
            ty,
            offset,
            source,
            end,
            ..
        } = token
        else {
            unreachable!("flow scalar token")
        };
        let (ty, value) = match ty {
            Ty::Scalar => (SType::Plain, self.plain_value(source)),
            Ty::SingleQuotedScalar => (SType::QuoteSingle, self.single_quoted_value(source)),
            _ => (SType::QuoteDouble, self.double_quoted_value(source)),
        };
        let value_end = offset + source.len() as i64;
        let (comment, re_offset) = resolve_end(self.report, end.as_deref(), value_end, true);
        (value, Some(ty), comment, [*offset, value_end, re_offset])
    }

    fn plain_value(&mut self, source: &[u16]) -> U16s {
        if let Some(&c) = source.first()
            && matches!(c, 0x09 | 0x2c | 0x25 | 0x7c | 0x3e | 0x40 | 0x60)
        {
            self.err("BAD_SCALAR_START");
        }
        fold_lines(source)
    }

    fn single_quoted_value(&mut self, source: &[u16]) -> U16s {
        if source.last() != Some(&u16::from(b'\'')) || source.len() == 1 {
            self.err("MISSING_CHAR");
        }
        let inner = if source.len() >= 2 {
            &source[1..source.len() - 1]
        } else {
            &[][..]
        };
        let folded = fold_lines(inner);
        let mut out = Vec::with_capacity(folded.len());
        let mut i = 0;
        while i < folded.len() {
            if folded[i] == 0x27 && folded.get(i + 1) == Some(&0x27) {
                out.push(0x27);
                i += 2;
            } else {
                out.push(folded[i]);
                i += 1;
            }
        }
        out
    }

    fn double_quoted_value(&mut self, source: &[u16]) -> U16s {
        let at = |i: usize| source.get(i).copied();
        let is = |i: usize, c: u8| at(i) == Some(u16::from(c));
        let mut res: U16s = Vec::new();
        let mut i = 1usize;
        while i + 1 < source.len() {
            let ch = source[i];
            if ch == 0x0d && is(i + 1, b'\n') {
                i += 1;
                continue;
            }
            if ch == 0x0a {
                let (fold, offset) = fold_newline(source, i);
                res.extend(fold);
                i = offset;
            } else if ch == u16::from(b'\\') {
                i += 1;
                let next = at(i);
                if let Some(cc) = next.and_then(escape_code) {
                    res.extend(cc.encode_utf16(&mut [0; 2]).iter());
                } else if next == Some(0x0a) {
                    // skip escaped newlines, but still trim the following line
                    let mut n = at(i + 1);
                    while n == Some(0x20) || n == Some(0x09) {
                        i += 1;
                        n = at(i + 1);
                    }
                } else if next == Some(0x0d) && is(i + 1, b'\n') {
                    // skip escaped CRLF newlines, but still trim the following line
                    i += 1;
                    let mut n = at(i + 1);
                    while n == Some(0x20) || n == Some(0x09) {
                        i += 1;
                        n = at(i + 1);
                    }
                } else if matches!(next, Some(0x78 | 0x75 | 0x55)) {
                    let length = match next {
                        Some(0x78) => 2,
                        Some(0x75) => 4,
                        _ => 8,
                    };
                    let (s, ok) = parse_char_code(source, i + 1, length);
                    if !ok {
                        self.err("BAD_DQ_ESCAPE");
                    }
                    res.extend(s);
                    i += length;
                } else {
                    // `source.substr(i - 1, 2)`
                    self.err("BAD_DQ_ESCAPE");
                    res.extend(source[i - 1..(i + 1).min(source.len())].iter());
                }
            } else if ch == 0x20 || ch == 0x09 {
                // trim trailing whitespace
                let ws_start = i;
                let mut n = at(i + 1);
                while n == Some(0x20) || n == Some(0x09) {
                    i += 1;
                    n = at(i + 1);
                }
                if n != Some(0x0a) && !(n == Some(0x0d) && is(i + 2, b'\n')) {
                    if i > ws_start {
                        res.extend_from_slice(&source[ws_start..=i]);
                    } else {
                        res.push(ch);
                    }
                }
            } else {
                res.push(ch);
            }
            i += 1;
        }
        if source.last() != Some(&u16::from(b'"')) || source.len() == 1 {
            self.err("MISSING_CHAR");
        }
        res
    }

    /// `resolveBlockScalar(ctx, scalar, onError)`.
    fn resolve_block_scalar(&mut self, token: &Tok) -> (U16s, Option<SType>, U16s, [i64; 3]) {
        let Tok::BlockScalar {
            offset,
            indent,
            props,
            source,
        } = token
        else {
            unreachable!("block scalar token")
        };
        let start = *offset;
        let Some(header) = self.parse_block_scalar_header(*offset, props) else {
            return (Vec::new(), None, Vec::new(), [start, start, start]);
        };
        let ty = if header.mode == u16::from(b'>') {
            SType::BlockFolded
        } else {
            SType::BlockLiteral
        };
        let lines = if source.is_empty() {
            Vec::new()
        } else {
            split_lines(source)
        };
        let is_empty_content = |c: &[u16]| c.is_empty() || c == [0x0d];
        // determine the end of content & start of chomping
        let mut chomp_start = lines.len();
        for i in (0..lines.len()).rev() {
            if is_empty_content(&lines[i].1) {
                chomp_start = i;
            } else {
                break;
            }
        }
        // shortcut for empty contents
        if chomp_start == 0 {
            let value = if header.chomp == Some(b'+') && !lines.is_empty() {
                vec![0x0a; 1.max(lines.len() - 1)]
            } else {
                Vec::new()
            };
            let mut end = start + header.length;
            end += source.len() as i64;
            return (value, Some(ty), header.comment, [start, end, end]);
        }
        // find the indentation level to trim from start
        let mut trim_indent = *indent + header.indent;
        let mut offset = *offset + header.length;
        let mut content_start = 0usize;
        for (i, (ind, content)) in lines.iter().enumerate().take(chomp_start) {
            if is_empty_content(content) {
                if header.indent == 0 && ind.len() as i64 > trim_indent {
                    trim_indent = ind.len() as i64;
                }
            } else {
                if (ind.len() as i64) < trim_indent {
                    self.err("MISSING_CHAR");
                }
                if header.indent == 0 {
                    trim_indent = ind.len() as i64;
                }
                content_start = i;
                if trim_indent == 0 && !self.at_root {
                    self.err("BAD_INDENT");
                }
                break;
            }
            offset += (ind.len() + content.len() + 1) as i64;
        }
        // include trailing more-indented empty lines in content
        for i in (chomp_start..lines.len()).rev() {
            if lines[i].0.len() as i64 > trim_indent {
                chomp_start = i + 1;
            }
        }
        let ti = trim_indent.max(0) as usize;
        let slice_from = |s: &[u16]| -> U16s { s.get(ti..).unwrap_or(&[]).to_vec() };
        let mut value: U16s = Vec::new();
        let mut sep: &[u16] = &[];
        let mut prev_more_indented = false;
        // leading whitespace is kept intact
        for line in lines.iter().take(content_start) {
            value.extend(slice_from(&line.0));
            value.push(0x0a);
        }
        const NL: &[u16] = &[0x0a];
        const NL2: &[u16] = &[0x0a, 0x0a];
        const SP: &[u16] = &[0x20];
        for line in lines.iter().take(chomp_start).skip(content_start) {
            let (ind, content) = (&line.0, &line.1);
            offset += (ind.len() + content.len() + 1) as i64;
            let crlf = content.last() == Some(&0x0d);
            let content: &[u16] = if crlf {
                &content[..content.len() - 1]
            } else {
                content
            };
            let mut ind: &[u16] = ind;
            if !content.is_empty() && (ind.len() as i64) < trim_indent {
                self.err("BAD_INDENT");
                ind = &[];
            }
            if ty == SType::BlockLiteral {
                value.extend_from_slice(sep);
                value.extend(slice_from(ind));
                value.extend_from_slice(content);
                sep = NL;
            } else if ind.len() as i64 > trim_indent || content.first() == Some(&0x09) {
                // more-indented content within a folded block
                if sep == SP {
                    sep = NL;
                } else if !prev_more_indented && sep == NL {
                    sep = NL2;
                }
                value.extend_from_slice(sep);
                value.extend(slice_from(ind));
                value.extend_from_slice(content);
                sep = NL;
                prev_more_indented = true;
            } else if content.is_empty() {
                // empty line
                if sep == NL {
                    value.push(0x0a);
                } else {
                    sep = NL;
                }
            } else {
                value.extend_from_slice(sep);
                value.extend_from_slice(content);
                sep = SP;
                prev_more_indented = false;
            }
        }
        let _ = offset;
        match header.chomp {
            Some(b'-') => {}
            Some(_) => {
                for line in lines.iter().skip(chomp_start) {
                    value.push(0x0a);
                    value.extend(slice_from(&line.0));
                }
                if value.last() != Some(&0x0a) {
                    value.push(0x0a);
                }
            }
            None => value.push(0x0a),
        }
        let end = start + header.length + source.len() as i64;
        (value, Some(ty), header.comment, [start, end, end])
    }

    fn parse_block_scalar_header(&mut self, _offset: i64, props: &[Tok]) -> Option<BlockHeader> {
        let first = props.first()?;
        if first.ty() != Ty::BlockScalarHeader {
            self.err("IMPOSSIBLE");
            return None;
        }
        let source = src_of(first);
        let mode = source[0];
        let mut indent = 0i64;
        let mut chomp: Option<u8> = None;
        let mut error = false;
        for &ch in &source[1..] {
            if chomp.is_none() && (ch == u16::from(b'-') || ch == u16::from(b'+')) {
                chomp = Some(ch as u8);
            } else {
                // `Number(ch)`: only a digit 1-9 is truthy.
                let n = if (0x31..=0x39).contains(&ch) {
                    i64::from(ch - 0x30)
                } else {
                    0
                };
                if indent == 0 && n != 0 {
                    indent = n;
                } else {
                    error = true;
                }
            }
        }
        if error {
            self.err("UNEXPECTED_TOKEN");
        }
        let mut has_space = false;
        let mut comment: U16s = Vec::new();
        let mut length = source.len() as i64;
        for token in &props[1..] {
            match token.ty() {
                Ty::Space => {
                    has_space = true;
                    length += token.source_len();
                }
                Ty::Newline => length += token.source_len(),
                Ty::Comment => {
                    if !has_space {
                        self.err("MISSING_CHAR");
                    }
                    length += token.source_len();
                    comment = src_of(token).get(1..).unwrap_or(&[]).to_vec();
                }
                Ty::Error => {
                    self.err("UNEXPECTED_TOKEN");
                    length += token.source_len();
                }
                _ => {
                    self.err("UNEXPECTED_TOKEN");
                    if let Some(ts) = token.source()
                        && !ts.is_empty()
                    {
                        length += ts.len() as i64;
                    }
                }
            }
        }
        Some(BlockHeader {
            mode,
            indent,
            chomp,
            comment,
            length,
        })
    }

    /// `composeCollection(CN, ctx, token, props, onError)`.
    fn compose_collection(&mut self, token: &Tok, props: &Props) -> Node {
        let tag_token = props.tag;
        let tag_name = tag_token.and_then(|t| self.tag_name(t));
        if token.ty() == Ty::BlockSeq {
            let last_prop = match (props.anchor, tag_token) {
                (Some(a), Some(t)) => Some(if a.offset() > t.offset() { a } else { t }),
                (a, t) => a.or(t),
            };
            if let Some(lp) = last_prop
                && props
                    .newline_after_prop
                    .is_none_or(|nl| nl.offset() < lp.offset())
            {
                self.err("MISSING_CHAR");
            }
        }
        let exp_map = match token {
            Tok::BlockMap { .. } => true,
            Tok::BlockSeq { .. } => false,
            Tok::FlowCollection { start, .. } => eq_ascii(&start.source, "{"),
            _ => false,
        };
        let name = tag_name.as_deref();
        let shortcut = match (tag_token, name) {
            (None, _) | (_, None) => true,
            (_, Some(n)) => {
                eq_ascii(n, "!")
                    || (eq_ascii(n, schema::MAP_TAG) && exp_map)
                    || (eq_ascii(n, schema::SEQ_TAG) && !exp_map)
            }
        };
        if shortcut {
            let mut coll = self.resolve_collection(token, None);
            coll.tag = coll_tag(&coll, tag_name);
            return coll;
        }
        let n = name.expect("tag name");
        let tag = match self.schema.find_collection(n, exp_map) {
            Some(tag) => tag,
            None => {
                if self.schema.known_tag(n).is_some() {
                    self.warn("BAD_COLLECTION_TYPE");
                } else {
                    self.warn("TAG_RESOLVE_FAILED");
                }
                let mut coll = self.resolve_collection(token, None);
                coll.tag = coll_tag(&coll, tag_name);
                return coll;
            }
        };
        self.push_known(tag);
        let mut coll = self.resolve_collection(token, Some(tag));
        for _ in 0..schema::resolve_collection(tag, &mut coll, &mut *self.next_id) {
            self.err("TAG_RESOLVE_FAILED");
        }
        coll.tag = tag_name;
        coll
    }

    fn resolve_collection(&mut self, token: &Tok, tag: Option<Tag>) -> Node {
        match token {
            Tok::BlockMap {
                offset,
                indent,
                items,
            } => self.resolve_block_map(*offset, *indent, items, tag),
            Tok::BlockSeq {
                offset,
                indent,
                items,
            } => self.resolve_block_seq(*offset, *indent, items, tag),
            Tok::FlowCollection {
                offset,
                indent,
                start,
                items,
                end,
            } => self.resolve_flow_collection(*offset, *indent, &start.source, items, end, tag),
            _ => unreachable!("collection token"),
        }
    }

    /// `mapIncludes(ctx, items, search)` (`uniqueKeys: true`).
    fn map_includes(items: &[Pair], search: &Node) -> bool {
        items.iter().any(|p| same_scalar_value(&p.key, search))
    }

    /// `resolveBlockMap(CN, ctx, bm, onError, tag)`.
    fn resolve_block_map(
        &mut self,
        bm_offset: i64,
        bm_indent: i64,
        items: &[Item],
        tag: Option<Tag>,
    ) -> Node {
        let mut pairs: Vec<Pair> = Vec::new();
        let mut map_comment: U16s = Vec::new();
        self.at_root = false;
        let mut offset = bm_offset;
        let mut comment_end: Option<i64> = None;
        for item in items {
            let Item {
                start,
                key,
                sep,
                value,
                ..
            } = item;
            let key = key.as_deref();
            let value = value.as_deref();
            // key properties
            let key_props = self.props(
                start,
                PropsOpts {
                    flow: None,
                    indicator: Ty::ExplicitKeyInd,
                    next: key.or_else(|| sep.as_deref().and_then(|s| s.first())),
                    offset,
                    parent_indent: bm_indent,
                    start_on_newline: true,
                },
            );
            let implicit_key = key_props.found.is_none();
            if implicit_key {
                if let Some(k) = key {
                    if k.ty() == Ty::BlockSeq {
                        self.err("BLOCK_AS_IMPLICIT_KEY");
                    } else if k.indent().is_some_and(|i| i != bm_indent) {
                        self.err("BAD_INDENT");
                    }
                }
                if key_props.anchor.is_none() && key_props.tag.is_none() && sep.is_none() {
                    comment_end = Some(key_props.end);
                    if !key_props.comment.is_empty() {
                        join_comment(&mut map_comment, "\n", &key_props.comment);
                    }
                    continue;
                }
                if key_props.newline_after_prop.is_some() || contains_newline(key) {
                    self.err("MULTILINE_IMPLICIT_KEY");
                }
            } else if key_props.found.and_then(Tok::indent) != Some(bm_indent) {
                self.err("BAD_INDENT");
            }
            // key value
            self.at_key = true;
            let key_start = key_props.end;
            let mut key_node = match key {
                Some(k) => self.compose_node(k, &key_props),
                None => self.compose_empty_node(key_start, Some(start), &key_props),
            };
            self.at_key = false;
            if Self::map_includes(&pairs, &key_node) {
                self.err("DUPLICATE_KEY");
            }
            // value properties
            let value_props = self.props(
                sep.as_deref().unwrap_or(&[]),
                PropsOpts {
                    flow: None,
                    indicator: Ty::MapValueInd,
                    next: value,
                    offset: key_node.range[2],
                    parent_indent: bm_indent,
                    start_on_newline: key.is_none_or(|k| k.ty() == Ty::BlockScalar),
                },
            );
            offset = value_props.end;
            if let Some(found) = value_props.found {
                if implicit_key {
                    if value.map(Tok::ty) == Some(Ty::BlockMap) && !value_props.has_newline {
                        self.err("BLOCK_AS_IMPLICIT_KEY");
                    }
                    if key_props.start < found.offset() - 1024 {
                        self.err("KEY_OVER_1024_CHARS");
                    }
                }
                // value value
                let value_node = match value {
                    Some(v) => self.compose_node(v, &value_props),
                    None => self.compose_empty_node(offset, sep.as_deref(), &value_props),
                };
                offset = value_node.range[2];
                pairs.push(Pair {
                    key: Box::new(key_node),
                    value: Some(Box::new(value_node)),
                });
            } else {
                // key with no value
                if implicit_key {
                    self.err("MISSING_CHAR");
                }
                if !value_props.comment.is_empty() {
                    join_comment(&mut key_node.comment, "\n", &value_props.comment);
                }
                pairs.push(Pair {
                    key: Box::new(key_node),
                    value: None,
                });
            }
        }
        if let Some(ce) = comment_end
            && ce != 0
            && ce < offset
        {
            self.err("IMPOSSIBLE");
        }
        let range = [bm_offset, offset, comment_end.unwrap_or(offset)];
        let mut map = self.node(
            Kind::Map {
                items: pairs,
                set: tag == Some(Tag::Set),
            },
            range,
        );
        map.comment = map_comment;
        map
    }

    /// `resolveBlockSeq(CN, ctx, bs, onError, tag)`.
    fn resolve_block_seq(
        &mut self,
        bs_offset: i64,
        bs_indent: i64,
        items: &[Item],
        tag: Option<Tag>,
    ) -> Node {
        let mut out: Vec<SeqItem> = Vec::new();
        let mut seq_comment: U16s = Vec::new();
        self.at_root = false;
        self.at_key = false;
        let mut offset = bs_offset;
        let mut comment_end: Option<i64> = None;
        for item in items {
            let value = item.value.as_deref();
            let props = self.props(
                &item.start,
                PropsOpts {
                    flow: None,
                    indicator: Ty::SeqItemInd,
                    next: value,
                    offset,
                    parent_indent: bs_indent,
                    start_on_newline: true,
                },
            );
            if props.found.is_none() {
                if props.anchor.is_some() || props.tag.is_some() || value.is_some() {
                    if value.map(Tok::ty) == Some(Ty::BlockSeq) {
                        self.err("BAD_INDENT");
                    } else {
                        self.err("MISSING_CHAR");
                    }
                } else {
                    comment_end = Some(props.end);
                    if !props.comment.is_empty() {
                        seq_comment = props.comment.clone();
                    }
                    continue;
                }
            }
            let node = match value {
                Some(v) => self.compose_node(v, &props),
                None => self.compose_empty_node(props.end, Some(&item.start), &props),
            };
            offset = node.range[2];
            out.push(SeqItem::Node(node));
        }
        let range = [bs_offset, offset, comment_end.unwrap_or(offset)];
        let mut seq = self.node(
            Kind::Seq {
                items: out,
                omap: tag == Some(Tag::OMap),
            },
            range,
        );
        seq.comment = seq_comment;
        seq
    }

    /// `resolveFlowCollection(CN, ctx, fc, onError, tag)`.
    fn resolve_flow_collection(
        &mut self,
        fc_offset: i64,
        fc_indent: i64,
        start_source: &[u16],
        items: &[Item],
        fc_end: &[Tok],
        tag: Option<Tag>,
    ) -> Node {
        let is_map = eq_ascii(start_source, "{");
        let fc_name: &'static str = if is_map { "flow map" } else { "flow sequence" };
        let at_root = self.at_root;
        self.at_root = false;
        self.at_key = false;
        let mut map_items: Vec<Pair> = Vec::new();
        let mut seq_items: Vec<SeqItem> = Vec::new();
        let mut offset = fc_offset + start_source.len() as i64;
        let mut coll_comment: U16s = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let Item {
                start,
                key,
                sep,
                value,
                ..
            } = item;
            let key = key.as_deref();
            let value = value.as_deref();
            let mut props = self.props(
                start,
                PropsOpts {
                    flow: Some(fc_name),
                    indicator: Ty::ExplicitKeyInd,
                    next: key.or_else(|| sep.as_deref().and_then(|s| s.first())),
                    offset,
                    parent_indent: fc_indent,
                    start_on_newline: false,
                },
            );
            if props.found.is_none() {
                if props.anchor.is_none() && props.tag.is_none() && sep.is_none() && value.is_none()
                {
                    if (i == 0 && props.comma.is_some()) || i + 1 < items.len() {
                        self.err("UNEXPECTED_TOKEN");
                    }
                    if !props.comment.is_empty() {
                        join_comment(&mut coll_comment, "\n", &props.comment);
                    }
                    offset = props.end;
                    continue;
                }
                if !is_map && contains_newline(key) {
                    self.err("MULTILINE_IMPLICIT_KEY");
                }
            }
            if i == 0 {
                if props.comma.is_some() {
                    self.err("UNEXPECTED_TOKEN");
                }
            } else {
                if props.comma.is_none() {
                    self.err("MISSING_CHAR");
                }
                if !props.comment.is_empty() {
                    let mut prev_item_comment: &[u16] = &[];
                    for st in start {
                        match st.ty() {
                            Ty::Comma | Ty::Space => {}
                            Ty::Comment => {
                                prev_item_comment = src_of(st).get(1..).unwrap_or(&[]);
                                break;
                            }
                            _ => break,
                        }
                    }
                    if !prev_item_comment.is_empty() {
                        let prev: Option<&mut Node> = if is_map {
                            map_items
                                .last_mut()
                                .map(|p| p.value.as_deref_mut().unwrap_or(&mut *p.key))
                        } else {
                            match seq_items.last_mut() {
                                Some(SeqItem::Node(n)) => Some(n),
                                Some(SeqItem::Pair(p)) => {
                                    Some(p.value.as_deref_mut().unwrap_or(&mut *p.key))
                                }
                                None => None,
                            }
                        };
                        match prev {
                            Some(prev) => join_comment(&mut prev.comment, "\n", prev_item_comment),
                            // `prev.comment` of `undefined` throws a TypeError,
                            // which composeNode reports.
                            None => self.err("RESOURCE_EXHAUSTION"),
                        }
                        let cut = (prev_item_comment.len() + 1).min(props.comment.len());
                        props.comment.drain(..cut);
                    }
                }
            }
            if !is_map && sep.is_none() && props.found.is_none() {
                // item is a value in a seq
                // → key & sep are empty, start does not include ? or :
                let value_node = match value {
                    Some(v) => self.compose_node(v, &props),
                    None => self.compose_empty_node(props.end, sep.as_deref(), &props),
                };
                offset = value_node.range[2];
                if value.is_some_and(|v| matches!(v.ty(), Ty::BlockMap | Ty::BlockSeq)) {
                    self.err("BLOCK_IN_FLOW");
                }
                seq_items.push(SeqItem::Node(value_node));
            } else {
                // item is a key+value pair
                // key value
                self.at_key = true;
                let key_start = props.end;
                let mut key_node = match key {
                    Some(k) => self.compose_node(k, &props),
                    None => self.compose_empty_node(key_start, Some(start), &props),
                };
                if key.is_some_and(|k| matches!(k.ty(), Ty::BlockMap | Ty::BlockSeq)) {
                    self.err("BLOCK_IN_FLOW");
                }
                self.at_key = false;
                // value properties
                let sep_list = sep.as_deref().unwrap_or(&[]);
                let value_props = self.props(
                    sep_list,
                    PropsOpts {
                        flow: Some(fc_name),
                        indicator: Ty::MapValueInd,
                        next: value,
                        offset: key_node.range[2],
                        parent_indent: fc_indent,
                        start_on_newline: false,
                    },
                );
                if let Some(found) = value_props.found {
                    if !is_map && props.found.is_none() {
                        for st in sep_list {
                            if std::ptr::eq(st, found) {
                                break;
                            }
                            if st.ty() == Ty::Newline {
                                self.err("MULTILINE_IMPLICIT_KEY");
                                break;
                            }
                        }
                        if props.start < found.offset() - 1024 {
                            self.err("KEY_OVER_1024_CHARS");
                        }
                    }
                } else if value.is_some() {
                    // "Missing space after :" or "Missing , or : between items"
                    self.err("MISSING_CHAR");
                }
                // value value
                let value_node = match value {
                    Some(v) => Some(self.compose_node(v, &value_props)),
                    None if value_props.found.is_some() => {
                        Some(self.compose_empty_node(value_props.end, sep.as_deref(), &value_props))
                    }
                    None => None,
                };
                if value_node.is_some() {
                    if value.is_some_and(|v| matches!(v.ty(), Ty::BlockMap | Ty::BlockSeq)) {
                        self.err("BLOCK_IN_FLOW");
                    }
                } else if !value_props.comment.is_empty() {
                    join_comment(&mut key_node.comment, "\n", &value_props.comment);
                }
                offset = value_node.as_ref().map_or(value_props.end, |v| v.range[2]);
                if is_map {
                    if Self::map_includes(&map_items, &key_node) {
                        self.err("DUPLICATE_KEY");
                    }
                    map_items.push(Pair {
                        key: Box::new(key_node),
                        value: value_node.map(Box::new),
                    });
                } else {
                    let end_range = value_node.as_ref().map_or(key_node.range, |v| v.range);
                    let range = [key_node.range[0], end_range[1], end_range[2]];
                    let pair = Pair {
                        key: Box::new(key_node),
                        value: value_node.map(Box::new),
                    };
                    let map = self.node(
                        Kind::Map {
                            items: vec![pair],
                            set: false,
                        },
                        range,
                    );
                    seq_items.push(SeqItem::Node(map));
                }
            }
        }
        let mut ee: Vec<&Tok> = fc_end.iter().skip(1).collect();
        let ce = fc_end.first();
        let mut ce_pos = offset;
        if let Some(ce) = ce
            && eq_ascii(src_of(ce), if is_map { "}" } else { "]" })
        {
            ce_pos = ce.offset() + ce.source_len();
        } else {
            self.err(if at_root {
                "MISSING_CHAR"
            } else {
                "BAD_INDENT"
            });
            if let Some(ce) = ce
                && ce.source_len() != 1
            {
                ee.insert(0, ce);
            }
        }
        let range = if ee.is_empty() {
            [fc_offset, ce_pos, ce_pos]
        } else {
            let (end_comment, end_offset) = resolve_end_iter(self.report, ee, ce_pos, true);
            if !end_comment.is_empty() {
                join_comment(&mut coll_comment, "\n", &end_comment);
            }
            [fc_offset, ce_pos, end_offset]
        };
        let mut coll = if is_map {
            self.node(
                Kind::Map {
                    items: map_items,
                    set: tag == Some(Tag::Set),
                },
                range,
            )
        } else {
            self.node(
                Kind::Seq {
                    items: seq_items,
                    omap: tag == Some(Tag::OMap),
                },
                range,
            )
        };
        coll.comment = coll_comment;
        coll
    }
}

struct BlockHeader {
    mode: u16,
    indent: i64,
    chomp: Option<u8>,
    comment: U16s,
    length: i64,
}

/// `splitLines(source)`: `[indent, content]` pairs, split on `\n( *)`.
fn split_lines(source: &[u16]) -> Vec<(U16s, U16s)> {
    let mut parts: Vec<&[u16]> = Vec::new(); // alternating content, indent, content…
    let mut last = 0usize;
    let mut i = 0usize;
    while i < source.len() {
        if source[i] == 0x0a {
            parts.push(&source[last..i]);
            let mut j = i + 1;
            while j < source.len() && source[j] == 0x20 {
                j += 1;
            }
            parts.push(&source[i + 1..j]);
            last = j;
            i = j;
        } else {
            i += 1;
        }
    }
    parts.push(&source[last..]);
    let first = parts[0];
    let lead = first.iter().take_while(|c| **c == 0x20).count();
    let mut lines = vec![(first[..lead].to_vec(), first[lead..].to_vec())];
    let mut k = 1;
    while k + 1 < parts.len() {
        lines.push((parts[k].to_vec(), parts[k + 1].to_vec()));
        k += 2;
    }
    lines
}

fn is_ws(c: u16) -> bool {
    c == 0x20 || c == 0x09
}

/// The content of a line from `start` up to the `\n` at `nl`: trailing
/// `[ \t]` (before an optional `\r`) dropped, as the `(?<![ \t])[ \t]*\r?\n`
/// tail of `foldLines`' regexps does.
fn line_content(s: &[u16], start: usize, nl: usize) -> &[u16] {
    let mut e = nl;
    if e > start && s[e - 1] == 0x0d {
        e -= 1;
    }
    let mut k = e;
    while k > start && is_ws(s[k - 1]) {
        k -= 1;
    }
    &s[start..k]
}

/// `foldLines(source)` from `resolve-flow-scalar.js`.
pub(super) fn fold_lines(source: &[u16]) -> U16s {
    let Some(first_nl) = source.iter().position(|c| *c == 0x0a) else {
        return source.to_vec();
    };
    let mut res: U16s = line_content(source, 0, first_nl).to_vec();
    let mut sep: &[u16] = &[0x20];
    let mut pos = first_nl + 1;
    loop {
        // `line`: leading [ \t]*, then the content up to the next \n.
        let mut start = pos;
        while start < source.len() && is_ws(source[start]) {
            start += 1;
        }
        let Some(rel) = source[start..].iter().position(|c| *c == 0x0a) else {
            break;
        };
        let nl = start + rel;
        let content = line_content(source, start, nl);
        if content.is_empty() {
            if sep == [0x0a] {
                res.push(0x0a);
            } else {
                sep = &[0x0a];
            }
        } else {
            res.extend_from_slice(sep);
            res.extend_from_slice(content);
            sep = &[0x20];
        }
        pos = nl + 1;
    }
    let mut start = pos;
    while start < source.len() && is_ws(source[start]) {
        start += 1;
    }
    res.extend_from_slice(sep);
    res.extend_from_slice(&source[start.min(source.len())..]);
    res
}

/// `foldNewline(source, offset)`.
fn fold_newline(source: &[u16], mut offset: usize) -> (U16s, usize) {
    let mut fold: U16s = Vec::new();
    let mut ch = source.get(offset + 1).copied();
    while let Some(c) = ch {
        if !(c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) {
            break;
        }
        if c == 0x0d && source.get(offset + 2) != Some(&0x0a) {
            break;
        }
        if c == 0x0a {
            fold.push(0x0a);
        }
        offset += 1;
        ch = source.get(offset + 1).copied();
    }
    if fold.is_empty() {
        fold.push(0x20);
    }
    (fold, offset)
}

fn escape_code(c: u16) -> Option<char> {
    Some(match u8::try_from(c).ok()? {
        b'0' => '\0',
        b'a' => '\x07',
        b'b' => '\x08',
        b'e' => '\x1b',
        b'f' => '\x0c',
        b'n' => '\n',
        b'r' => '\r',
        b't' => '\t',
        b'v' => '\x0b',
        b'N' => '\u{85}',
        b'_' => '\u{a0}',
        b'L' => '\u{2028}',
        b'P' => '\u{2029}',
        b' ' => ' ',
        b'"' => '"',
        b'/' => '/',
        b'\\' => '\\',
        b'\t' => '\t',
        _ => return None,
    })
}

/// `parseCharCode(source, offset, length, onError)`: the decoded units, and
/// whether it was a valid escape (else the raw text is returned).
fn parse_char_code(source: &[u16], offset: usize, length: usize) -> (U16s, bool) {
    let end = (offset + length).min(source.len());
    let cc = source.get(offset..end).unwrap_or(&[]);
    let ok = cc.len() == length
        && cc
            .iter()
            .all(|c| (*c as u8 as u16 == *c) && (*c as u8).is_ascii_hexdigit());
    let code = if ok {
        let s: String = cc.iter().map(|c| *c as u8 as char).collect();
        u32::from_str_radix(&s, 16).ok()
    } else {
        None
    };
    match code {
        Some(cp) if cp <= 0x10FFFF => {
            // `String.fromCodePoint` (lone surrogates included)
            if cp < 0x10000 {
                (vec![cp as u16], true)
            } else {
                let c = cp - 0x10000;
                (
                    vec![0xD800 + (c >> 10) as u16, 0xDC00 + (c & 0x3FF) as u16],
                    true,
                )
            }
        }
        _ => {
            // `source.substr(offset - 2, length + 2)`
            let s = offset.saturating_sub(2);
            let e = (s + length + 2).min(source.len());
            (source[s..e].to_vec(), false)
        }
    }
}
