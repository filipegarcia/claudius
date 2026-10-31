//! Port of the part of yaml 2.9.0's stringifier a collection-valued map key
//! goes through: `stringifyKey` → `key.toString(strCtx)`, where `strCtx` is
//! `createStringifyContext(doc, {})` with `inFlow: true`. Everything below
//! is therefore flow style (`stringifyFlowCollection`, the flow branch of
//! `stringifyPair`, `stringifyString` without block scalars), with the
//! default options: 2-space indent, `lineWidth` 80, `minContentWidth` 20,
//! `doubleQuotedMinMultiLineLength` 40, `verifyAliasOrder`.

use std::collections::HashSet;

use super::compose::{Kind, Node, Pair, SType, SeqItem};
use super::schema::{self, Schema, Tag};
use super::tojs::Thrown;
use super::{SVal, U16s, units_to_string};

type R<T> = Result<T, Thrown>;

const LINE_WIDTH: usize = 80;
const MIN_CONTENT_WIDTH: usize = 20;
const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;
const INDENT_STEP: usize = 2;

const NL: u16 = b'\n' as u16;
const SP: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const BS: u16 = b'\\' as u16;

fn s16(s: &str) -> U16s {
    s.encode_utf16().collect()
}

fn spaces(n: usize) -> U16s {
    vec![SP; n]
}

/// The mutable part of yaml's stringify context (`inFlow` is always true
/// here; `anchors` is shared, so it lives on the [`Stringifier`]).
#[derive(Clone, Debug, Default)]
pub(super) struct Ctx {
    indent: usize,
    implicit_key: bool,
    all_null_values: bool,
    indent_at_start: Option<usize>,
}

/// A collection item: a node, or a `Pair` (map entries, `!!omap` /
/// `!!pairs` entries).
#[derive(Clone, Copy)]
enum Item<'n> {
    Node(&'n Node),
    Pair(&'n Pair),
}

pub(super) struct Stringifier<'a> {
    pub schema: Schema,
    /// The document's `%TAG` handles, for `directives.tagString`.
    pub dir_tags: &'a [(U16s, U16s)],
    /// The known tags a `core` document pushed into its schema's tags.
    pub pushed: &'a [Tag],
    /// `ctx.anchors`: anchor names seen so far.
    pub anchors: HashSet<U16s>,
}

impl Stringifier<'_> {
    /// `key.toString(strCtx)` for a collection key.
    pub(super) fn key(&mut self, node: &Node) -> R<U16s> {
        let mut ctx = Ctx::default();
        self.collection(node, &mut ctx)
    }

    /// `Alias.toString(ctx)`.
    pub(super) fn alias(&self, source: &[u16], ctx: &Ctx) -> R<U16s> {
        anchor_is_valid(source)?;
        if !self.anchors.contains(source) {
            // 'Unresolved alias (the anchor must be set before the alias)'
            return Err(Thrown);
        }
        let mut out = vec![u16::from(b'*')];
        out.extend_from_slice(source);
        if ctx.implicit_key {
            out.push(SP);
        }
        Ok(out)
    }

    fn stringify(&mut self, item: Item, ctx: &mut Ctx) -> R<U16s> {
        let node = match item {
            Item::Pair(p) => return self.pair(p, ctx),
            Item::Node(n) => n,
        };
        if let Kind::Alias(source) = &node.kind {
            return self.alias(source, ctx);
        }
        let tag_obj = self.tag_obj(node);
        // stringifyProps (before the value, for circular anchor refs)
        let mut props: U16s = Vec::new();
        if let Some(a) = node.anchor.as_ref().filter(|a| !a.is_empty()) {
            anchor_is_valid(a)?;
            self.anchors.insert(a.clone());
            props.push(u16::from(b'&'));
            props.extend_from_slice(a);
        }
        if let Some(t) = &node.tag {
            if !props.is_empty() {
                props.push(SP);
            }
            props.extend(self.tag_string(t));
        }
        if !props.is_empty() {
            ctx.indent_at_start = Some(ctx.indent_at_start.unwrap_or(0) + props.len() + 1);
        }
        let s = self.tag_stringify(node, tag_obj, ctx)?;
        if props.is_empty() {
            return Ok(s);
        }
        let is_scalar = matches!(node.kind, Kind::Scalar { .. });
        if is_scalar || matches!(s.first(), Some(&0x7b | &0x5b)) {
            props.push(SP);
        } else {
            props.push(NL);
            props.extend(spaces(ctx.indent));
        }
        props.extend(s);
        Ok(props)
    }

    /// `getTagObject(doc.schema.tags, node)`.
    fn tag_obj(&self, node: &Node) -> Tag {
        let fmt = match &node.kind {
            Kind::Scalar { rtag, .. } => rtag.format(),
            _ => None,
        };
        if let Some(t) = &node.tag {
            let matches: Vec<Tag> = self
                .schema
                .tags()
                .iter()
                .chain(self.pushed.iter())
                .copied()
                .filter(|tag| super::eq_ascii(t, tag.name()))
                .collect();
            if let Some(first) = matches.first() {
                return matches
                    .iter()
                    .copied()
                    .find(|tag| tag.format() == fmt)
                    .unwrap_or(*first);
            }
        }
        match &node.kind {
            Kind::Scalar { value, rtag, .. } => match value {
                SVal::Null => Tag::Null,
                SVal::Bool(b) if self.schema.yaml11 => {
                    if *b {
                        Tag::True11
                    } else {
                        Tag::False11
                    }
                }
                SVal::Bool(_) => Tag::Bool,
                // the tag with the resolving tag's format (same stringify)
                SVal::Num(_) => *rtag,
                // yaml-1.1's merge `identify` takes the string '<<' too, and
                // its `test` wins over str's absent one (core's pushed copy
                // has no `test`, so str, listed first, wins there)
                SVal::Str(v) if v.as_slice() == [0x3c, 0x3c] && self.schema.yaml11 => Tag::Merge,
                SVal::Str(_) => Tag::Str,
                SVal::Sym => Tag::Merge,
                SVal::Date(_) => Tag::Timestamp,
                SVal::Buffer(_) => Tag::Binary,
            },
            Kind::Map { .. } => Tag::Map,
            _ => Tag::Seq,
        }
    }

    /// `tagObj.stringify(node, ctx)`, or `stringifyString` / `toString` for
    /// tags without one.
    fn tag_stringify(&mut self, node: &Node, tag: Tag, ctx: &mut Ctx) -> R<U16s> {
        let scalar = match &node.kind {
            Kind::Scalar {
                value,
                ty,
                source,
                rtag,
                ..
            } => Some((value, *ty, source, *rtag)),
            _ => None,
        };
        // `String(item.value)` (`undefined` for a collection)
        let as_string = |v: Option<&SVal>| -> R<U16s> {
            Ok(match v {
                None => s16("undefined"),
                Some(SVal::Str(s)) => s.clone(),
                Some(SVal::Null) => s16("null"),
                Some(SVal::Bool(b)) => s16(if *b { "true" } else { "false" }),
                Some(SVal::Num(n)) => s16(&js_number_string(*n)),
                Some(SVal::Sym) => return Err(Thrown),
                Some(SVal::Date(t)) => s16(&schema::date_string(*t)),
                Some(SVal::Buffer(b)) => s16(&String::from_utf8_lossy(b)),
            })
        };
        Ok(match tag {
            Tag::Str => {
                let v = as_string(scalar.map(|s| s.0))?;
                self.string(&v, scalar.and_then(|s| s.1), ctx, true)
            }
            Tag::Null => match scalar {
                Some((_, Some(_), source, _))
                    if Schema::null_source_ok(&units_to_string(source)) =>
                {
                    source.clone()
                }
                _ => s16("null"),
            },
            Tag::Bool | Tag::True11 | Tag::False11 => {
                let truthy = match scalar.map(|s| s.0) {
                    Some(SVal::Bool(b)) => *b,
                    Some(SVal::Str(s)) => !s.is_empty(),
                    Some(SVal::Num(n)) => *n != 0.0 && !n.is_nan(),
                    Some(SVal::Null) | None => false,
                    Some(_) => true,
                };
                if let Some((value, Some(_), source, _)) = scalar
                    && !source.is_empty()
                {
                    let src = units_to_string(source);
                    let keep = if tag == Tag::Bool {
                        // `value === sv`
                        Schema { yaml11: false }.bool_source_ok(&src, true)
                            && matches!(value, SVal::Bool(true))
                            || Schema { yaml11: false }.bool_source_ok(&src, false)
                                && matches!(value, SVal::Bool(false))
                    } else {
                        Schema { yaml11: true }.bool_source_ok(&src, truthy)
                    };
                    if keep {
                        return Ok(source.clone());
                    }
                }
                s16(if truthy { "true" } else { "false" })
            }
            Tag::IntOct
            | Tag::Int
            | Tag::IntHex
            | Tag::FloatNaN
            | Tag::FloatExp
            | Tag::Float
            | Tag::IntBin11
            | Tag::IntOct11
            | Tag::Int11
            | Tag::IntHex11
            | Tag::FloatExp11
            | Tag::Float11
            | Tag::IntTime
            | Tag::FloatTime => match scalar {
                Some((SVal::Num(n), _, source, rtag)) => s16(&schema::number_string(
                    *n,
                    rtag,
                    source,
                    node.tag.as_deref(),
                )),
                // stringifyNumber of a string value: `JSON.stringify(value)`
                Some((SVal::Str(s), ..)) => {
                    let n = claudius_agent::js::to_number(&units_to_string(s));
                    if n.is_finite() {
                        json_string(s)
                    } else {
                        s16(if n.is_nan() {
                            ".nan"
                        } else if n < 0.0 {
                            "-.inf"
                        } else {
                            ".inf"
                        })
                    }
                }
                _ => s16(".nan"),
            },
            Tag::Binary => match scalar {
                Some((SVal::Buffer(b), ty, ..)) => {
                    let b64 = base64_encode(b);
                    let ty = ty.unwrap_or(SType::BlockLiteral);
                    let text = if ty == SType::QuoteDouble {
                        b64
                    } else {
                        let width = (LINE_WIDTH as i64 - ctx.indent as i64)
                            .max(MIN_CONTENT_WIDTH as i64)
                            as usize;
                        let sep = if ty == SType::BlockLiteral { "\n" } else { " " };
                        b64.as_bytes()
                            .chunks(width)
                            .map(|c| std::str::from_utf8(c).expect("base64"))
                            .collect::<Vec<_>>()
                            .join(sep)
                    };
                    self.string(&s16(&text), Some(ty), ctx, false)
                }
                _ => Vec::new(),
            },
            Tag::Merge => s16("<<"),
            Tag::Timestamp => match scalar {
                Some((SVal::Date(t), ..)) => {
                    // toISOString throws on an invalid date
                    let iso = schema::date_iso(*t).ok_or(Thrown)?;
                    let trimmed = iso
                        .strip_suffix("T00:00:00.000Z")
                        .or_else(|| iso.strip_suffix(".000Z"))
                        .unwrap_or(&iso);
                    s16(trimmed)
                }
                _ => Vec::new(),
            },
            Tag::Map | Tag::Seq | Tag::OMap | Tag::Pairs | Tag::Set => match scalar {
                Some((value, ty, ..)) => {
                    let v = as_string(Some(value))?;
                    self.string(&v, ty, ctx, false)
                }
                None => self.collection(node, ctx)?,
            },
        })
    }

    /// `YAMLMap` / `YAMLSet` / `YAMLSeq` `.toString(ctx)`.
    fn collection(&mut self, node: &Node, ctx: &mut Ctx) -> R<U16s> {
        match &node.kind {
            Kind::Map { items, set } => {
                let mut c = ctx.clone();
                if *set || (!c.all_null_values && items.iter().all(|p| p.value.is_none())) {
                    c.all_null_values = true;
                }
                let items: Vec<Item> = items.iter().map(Item::Pair).collect();
                let item_indent = c.indent;
                self.flow_collection(&items, &c, ('{', '}'), item_indent)
            }
            Kind::Seq { items, .. } => {
                let items: Vec<Item> = items
                    .iter()
                    .map(|it| match it {
                        SeqItem::Node(n) => Item::Node(n),
                        SeqItem::Pair(p) => Item::Pair(p),
                    })
                    .collect();
                self.flow_collection(&items, ctx, ('[', ']'), ctx.indent + INDENT_STEP)
            }
            _ => Ok(Vec::new()),
        }
    }

    /// `stringifyFlowCollection(collection, ctx, { flowChars, itemIndent })`.
    fn flow_collection(
        &mut self,
        items: &[Item],
        ctx: &Ctx,
        chars: (char, char),
        item_indent: usize,
    ) -> R<U16s> {
        let item_indent = item_indent + INDENT_STEP;
        let mut item_ctx = Ctx {
            indent: item_indent,
            ..ctx.clone()
        };
        let mut req_newline = false;
        let mut lines_at_value = 0;
        let mut lines: Vec<U16s> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            let mut comment: Option<&U16s> = None;
            match item {
                Item::Node(n) => {
                    if n.space_before {
                        lines.push(Vec::new());
                    }
                    add_comment_before(ctx.indent, &mut lines, &n.comment_before);
                    if !n.comment.is_empty() {
                        comment = Some(&n.comment);
                    }
                }
                Item::Pair(p) => {
                    let ik = &p.key;
                    if ik.space_before {
                        lines.push(Vec::new());
                    }
                    add_comment_before(ctx.indent, &mut lines, &ik.comment_before);
                    if !ik.comment.is_empty() {
                        req_newline = true;
                    }
                    match p.value.as_deref() {
                        Some(iv) => {
                            if !iv.comment.is_empty() {
                                comment = Some(&iv.comment);
                            }
                            if !iv.comment_before.is_empty() {
                                req_newline = true;
                            }
                        }
                        None if !ik.comment.is_empty() => comment = Some(&ik.comment),
                        None => {}
                    }
                }
            }
            if comment.is_some() {
                req_newline = true;
            }
            let mut s = self.stringify(*item, &mut item_ctx)?;
            req_newline = req_newline || lines.len() > lines_at_value || s.contains(&NL);
            if i < items.len() - 1 {
                s.push(u16::from(b','));
            }
            if let Some(c) = comment {
                let lc = line_comment(&s, item_indent, &comment_string(c));
                s.extend(lc);
            }
            lines.push(s);
            lines_at_value = lines.len();
        }
        let (start, end) = (chars.0 as u16, chars.1 as u16);
        if lines.is_empty() {
            return Ok(vec![start, end]);
        }
        if !req_newline {
            let len = lines.iter().fold(2, |sum, l| sum + l.len() + 2);
            req_newline = len > LINE_WIDTH;
        }
        let mut out = vec![start];
        if req_newline {
            for line in &lines {
                out.push(NL);
                if !line.is_empty() {
                    out.extend(spaces(INDENT_STEP + ctx.indent));
                    out.extend_from_slice(line);
                }
            }
            out.push(NL);
            out.extend(spaces(ctx.indent));
        } else {
            out.push(SP);
            for (i, line) in lines.iter().enumerate() {
                if i > 0 {
                    out.push(SP);
                }
                out.extend_from_slice(line);
            }
            out.push(SP);
        }
        out.push(end);
        Ok(out)
    }

    /// `stringifyPair(pair, ctx)` in flow.
    fn pair(&mut self, p: &Pair, ctx: &Ctx) -> R<U16s> {
        let key = &*p.key;
        let key_comment = (!key.comment.is_empty()).then_some(&key.comment);
        let explicit_key = match &key.kind {
            Kind::Map { .. } | Kind::Seq { .. } | Kind::Alias(_) => true,
            Kind::Scalar { ty, .. } => matches!(ty, Some(SType::BlockFolded | SType::BlockLiteral)),
        };
        let mut c = Ctx {
            all_null_values: false,
            implicit_key: !explicit_key && !ctx.all_null_values,
            indent: ctx.indent + INDENT_STEP,
            indent_at_start: ctx.indent_at_start,
        };
        let mut s = self.stringify(Item::Node(key), &mut c)?;
        let Some(value) = p.value.as_deref().filter(|_| !ctx.all_null_values) else {
            return Ok(if s.is_empty() {
                s16("?")
            } else if explicit_key {
                let mut out = s16("? ");
                out.extend(s);
                out
            } else {
                s
            });
        };
        if explicit_key {
            if let Some(kc) = key_comment {
                let lc = line_comment(&s, c.indent, &comment_string(kc));
                s.extend(lc);
            }
            let mut out = s16("? ");
            out.extend(s);
            out.push(NL);
            out.extend(spaces(ctx.indent));
            out.push(u16::from(b':'));
            s = out;
        } else {
            s.push(u16::from(b':'));
            if let Some(kc) = key_comment {
                let lc = line_comment(&s, c.indent, &comment_string(kc));
                s.extend(lc);
            }
        }
        let vsb = value.space_before;
        let vcb = &value.comment_before;
        c.implicit_key = false;
        if !explicit_key && key_comment.is_none() && matches!(value.kind, Kind::Scalar { .. }) {
            c.indent_at_start = Some(s.len() + 1);
        }
        let value_str = self.stringify(Item::Node(value), &mut c)?;
        let mut ws: U16s = vec![SP];
        if key_comment.is_some() || vsb || !vcb.is_empty() {
            ws = if vsb { vec![NL] } else { Vec::new() };
            if !vcb.is_empty() {
                ws.push(NL);
                ws.extend(indent_comment(&comment_string(vcb), c.indent));
            }
            ws.push(NL);
            ws.extend(spaces(c.indent));
        } else if !explicit_key && matches!(value.kind, Kind::Map { .. } | Kind::Seq { .. }) {
            if let Some(nl0) = value_str.iter().position(|u| *u == NL) {
                let vs0 = value_str.first().copied();
                let mut has_props_line = false;
                if vs0 == Some(u16::from(b'&')) || vs0 == Some(u16::from(b'!')) {
                    let mut sp0 = value_str.iter().position(|u| *u == SP);
                    if vs0 == Some(u16::from(b'&'))
                        && let Some(i) = sp0
                        && i < nl0
                        && value_str.get(i + 1) == Some(&u16::from(b'!'))
                    {
                        sp0 = value_str[i + 1..]
                            .iter()
                            .position(|u| *u == SP)
                            .map(|j| j + i + 1);
                    }
                    if sp0.is_none_or(|sp| nl0 < sp) {
                        has_props_line = true;
                    }
                }
                if !has_props_line {
                    ws = vec![NL];
                    ws.extend(spaces(c.indent));
                }
            }
        } else if value_str.is_empty() || value_str[0] == NL {
            ws = Vec::new();
        }
        s.extend(ws);
        s.extend(value_str);
        Ok(s)
    }

    /// `directives.tagString(tag)`.
    fn tag_string(&self, tag: &[u16]) -> U16s {
        for (handle, prefix) in self.dir_tags {
            if tag.starts_with(prefix) {
                let mut out = handle.clone();
                for &c in &tag[prefix.len()..] {
                    match c {
                        0x21 => out.extend(s16("%21")),
                        0x2c => out.extend(s16("%2C")),
                        0x5b => out.extend(s16("%5B")),
                        0x5d => out.extend(s16("%5D")),
                        0x7b => out.extend(s16("%7B")),
                        0x7d => out.extend(s16("%7D")),
                        _ => out.push(c),
                    }
                }
                return out;
            }
        }
        if tag.first() == Some(&0x21) {
            return tag.to_vec();
        }
        let mut out = s16("!<");
        out.extend_from_slice(tag);
        out.push(u16::from(b'>'));
        out
    }

    /// `stringifyString(item, ctx)` (`actualString`: via the `str` tag).
    fn string(&self, value: &[u16], ty: Option<SType>, ctx: &Ctx, actual_string: bool) -> U16s {
        let mut ty = ty;
        if ty != Some(SType::QuoteDouble) && needs_double_quotes(value) {
            ty = Some(SType::QuoteDouble);
        }
        match ty {
            // blocks are not valid inside flow containers
            Some(SType::BlockFolded | SType::BlockLiteral) => quoted_string(value, ctx),
            Some(SType::QuoteDouble) => double_quoted_string(value, ctx),
            Some(SType::QuoteSingle) => single_quoted_string(value, ctx),
            Some(SType::Plain) | None => self.plain_string(value, ctx, actual_string),
        }
    }

    /// `plainString(item, ctx)` in flow.
    fn plain_string(&self, value: &[u16], ctx: &Ctx, actual_string: bool) -> U16s {
        if (ctx.implicit_key && value.contains(&NL))
            || value
                .iter()
                .any(|u| matches!(*u, 0x5b | 0x5d | 0x7b | 0x7d | 0x2c))
        {
            return quoted_string(value, ctx);
        }
        static NOT_PLAIN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"^[\n\t ,\[\]{}#&*!|>'\x22%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$")
                .expect("plain regex")
        });
        if NOT_PLAIN.is_match(&units_to_string(value)) {
            return quoted_string(value, ctx);
        }
        // (a document marker at indent 0 would go to a block scalar; flow
        // items are always indented)
        if contains_document_marker(value) && ctx.implicit_key && ctx.indent == INDENT_STEP {
            return quoted_string(value, ctx);
        }
        let s = replace_newline_runs(value, ctx.indent);
        if actual_string && self.schema.reads_as_non_string(&units_to_string(&s)) {
            return quoted_string(value, ctx);
        }
        if ctx.implicit_key {
            s
        } else {
            fold_flow_lines(&s, ctx.indent, Fold::Flow, ctx.indent_at_start)
        }
    }
}

/// `/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u`: control characters
/// and unpaired surrogates (under `u`, a pair is one code point).
fn needs_double_quotes(value: &[u16]) -> bool {
    (0..value.len()).any(|i| match value[i] {
        0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f => true,
        0xD800..=0xDBFF => !matches!(value.get(i + 1), Some(0xDC00..=0xDFFF)),
        0xDC00..=0xDFFF => i == 0 || !matches!(value[i - 1], 0xD800..=0xDBFF),
        _ => false,
    })
}

/// JS `^` / `$` line terminators under the `m` flag.
fn is_line_terminator(u: u16) -> bool {
    matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// The lines of `s` as `/^…$/m` sees them.
fn js_lines(s: &[u16]) -> Vec<&[u16]> {
    s.split(|u| is_line_terminator(*u)).collect()
}

/// `/^(%|---|\.\.\.)/m.test(str)`.
fn contains_document_marker(s: &[u16]) -> bool {
    js_lines(s).iter().any(|l| {
        l.first() == Some(&u16::from(b'%'))
            || l.starts_with(&s16("---"))
            || l.starts_with(&s16("..."))
    })
}

/// `value.replace(/\n+/g, `$&\n${indent}`)`.
fn replace_newline_runs(value: &[u16], indent: usize) -> U16s {
    let mut out = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        if value[i] == NL {
            while i < value.len() && value[i] == NL {
                out.push(NL);
                i += 1;
            }
            out.push(NL);
            out.extend(spaces(indent));
        } else {
            out.push(value[i]);
            i += 1;
        }
    }
    out
}

/// Rebuilds `s` with `f(line)` before each line (`/^/gm` replacements);
/// `f` sees the line and returns what to insert.
fn per_line(s: &[u16], f: impl Fn(&[u16]) -> U16s) -> U16s {
    let mut out = Vec::with_capacity(s.len());
    let mut start = 0;
    for i in 0..=s.len() {
        if i == s.len() || is_line_terminator(s[i]) {
            let line = &s[start..i];
            out.extend(f(line));
            out.extend_from_slice(line);
            if i < s.len() {
                out.push(s[i]);
            }
            start = i + 1;
        }
    }
    out
}

/// `stringifyComment(str)`: `str.replace(/^(?!$)(?: $)?/gm, '#')`.
fn comment_string(s: &[u16]) -> U16s {
    let mut out = Vec::with_capacity(s.len() + 4);
    let mut start = 0;
    for i in 0..=s.len() {
        if i == s.len() || is_line_terminator(s[i]) {
            let line = &s[start..i];
            if line.is_empty() {
                // (?!$): left alone
            } else if line == [SP] {
                out.push(u16::from(b'#'));
            } else {
                out.push(u16::from(b'#'));
                out.extend_from_slice(line);
            }
            if i < s.len() {
                out.push(s[i]);
            }
            start = i + 1;
        }
    }
    out
}

/// `indentComment(comment, indent)`.
fn indent_comment(comment: &[u16], indent: usize) -> U16s {
    if !comment.is_empty() && comment.iter().all(|u| *u == NL) {
        return comment[1..].to_vec();
    }
    if indent == 0 {
        return comment.to_vec();
    }
    // /^(?! *$)/gm
    per_line(comment, |line| {
        if line.iter().all(|u| *u == SP) {
            Vec::new()
        } else {
            spaces(indent)
        }
    })
}

/// `lineComment(str, indent, comment)`.
fn line_comment(s: &[u16], indent: usize, comment: &[u16]) -> U16s {
    if s.last() == Some(&NL) {
        indent_comment(comment, indent)
    } else if comment.contains(&NL) {
        let mut out = vec![NL];
        out.extend(indent_comment(comment, indent));
        out
    } else {
        let mut out = if s.last() == Some(&SP) {
            Vec::new()
        } else {
            vec![SP]
        };
        out.extend_from_slice(comment);
        out
    }
}

/// `addCommentBefore(ctx, lines, comment, false)`.
fn add_comment_before(indent: usize, lines: &mut Vec<U16s>, comment: &[u16]) {
    if comment.is_empty() {
        return;
    }
    let ic = indent_comment(&comment_string(comment), indent);
    // trimStart
    let skip = ic.iter().take_while(|u| is_js_space(**u)).count();
    lines.push(ic[skip..].to_vec());
}

fn is_js_space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(claudius_agent::js::is_whitespace)
}

/// `quotedString(value, ctx)` (no `singleQuote` option).
fn quoted_string(value: &[u16], ctx: &Ctx) -> U16s {
    let has_double = value.contains(&u16::from(b'"'));
    let has_single = value.contains(&u16::from(b'\''));
    if has_double && !has_single {
        single_quoted_string(value, ctx)
    } else {
        double_quoted_string(value, ctx)
    }
}

/// `singleQuotedString(value, ctx)`.
fn single_quoted_string(value: &[u16], ctx: &Ctx) -> U16s {
    let ws_nl = value.windows(2).any(|w| {
        (matches!(w[0], SP | TAB) && w[1] == NL) || (w[0] == NL && matches!(w[1], SP | TAB))
    });
    if (ctx.implicit_key && value.contains(&NL)) || ws_nl {
        return double_quoted_string(value, ctx);
    }
    let indent = quote_indent(value, ctx);
    let mut doubled = Vec::with_capacity(value.len() + 2);
    for &c in value {
        if c == u16::from(b'\'') {
            doubled.push(c);
        }
        doubled.push(c);
    }
    let mut res = vec![u16::from(b'\'')];
    res.extend(replace_newline_runs(&doubled, indent));
    res.push(u16::from(b'\''));
    if ctx.implicit_key {
        res
    } else {
        fold_flow_lines(&res, indent, Fold::Flow, ctx.indent_at_start)
    }
}

/// `ctx.indent || (containsDocumentMarker(value) ? '  ' : '')`.
fn quote_indent(value: &[u16], ctx: &Ctx) -> usize {
    if ctx.indent > 0 {
        ctx.indent
    } else if contains_document_marker(value) {
        2
    } else {
        0
    }
}

/// `doubleQuotedString(value, ctx)`.
fn double_quoted_string(value: &[u16], ctx: &Ctx) -> U16s {
    let json = json_string(value);
    let indent = quote_indent(value, ctx);
    let at = |i: usize| json.get(i).copied();
    let mut out: U16s = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < json.len() {
        let mut ch = json[i];
        if ch == SP && at(i + 1) == Some(BS) && at(i + 2) == Some(u16::from(b'n')) {
            // space before newline needs to be escaped to not be folded
            out.extend_from_slice(&json[start..i]);
            out.extend([BS, SP]);
            i += 1;
            start = i;
            ch = BS;
        }
        if ch == BS {
            match at(i + 1) {
                Some(0x75) => {
                    // 'u'
                    out.extend_from_slice(&json[start..i]);
                    let code =
                        units_to_string(&json[(i + 2).min(json.len())..(i + 6).min(json.len())]);
                    match code.as_str() {
                        "0000" => out.extend(s16("\\0")),
                        "0007" => out.extend(s16("\\a")),
                        "000b" => out.extend(s16("\\v")),
                        "001b" => out.extend(s16("\\e")),
                        "0085" => out.extend(s16("\\N")),
                        "00a0" => out.extend(s16("\\_")),
                        "2028" => out.extend(s16("\\L")),
                        "2029" => out.extend(s16("\\P")),
                        _ if code.starts_with("00") => {
                            out.extend(s16("\\x"));
                            out.extend(s16(&code[2..]));
                        }
                        _ => out.extend_from_slice(&json[i..(i + 6).min(json.len())]),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some(0x6e) => {
                    // 'n'
                    if ctx.implicit_key
                        || at(i + 2) == Some(u16::from(b'"'))
                        || json.len() < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH
                    {
                        i += 1;
                    } else {
                        // folding will eat first newline
                        out.extend_from_slice(&json[start..i]);
                        out.extend([NL, NL]);
                        while at(i + 2) == Some(BS)
                            && at(i + 3) == Some(u16::from(b'n'))
                            && at(i + 4) != Some(u16::from(b'"'))
                        {
                            out.push(NL);
                            i += 2;
                        }
                        out.extend(spaces(indent));
                        // space after newline needs to be escaped to not be folded
                        if at(i + 2) == Some(SP) {
                            out.push(BS);
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let s = if start > 0 {
        out.extend_from_slice(&json[start.min(json.len())..]);
        out
    } else {
        json
    };
    if ctx.implicit_key {
        s
    } else {
        fold_flow_lines(&s, indent, Fold::Quoted, ctx.indent_at_start)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fold {
    Flow,
    Quoted,
}

/// `foldFlowLines(text, indent, mode, { indentAtStart, lineWidth: 80,
/// minContentWidth: 20 })` for the flow and quoted modes.
fn fold_flow_lines(
    text: &[u16],
    indent: usize,
    mode: Fold,
    indent_at_start: Option<usize>,
) -> U16s {
    let lw = LINE_WIDTH as i64;
    let indent_len = indent as i64;
    let min_content = MIN_CONTENT_WIDTH as i64;
    let end_step = (1 + min_content).max(1 + lw - indent_len);
    let len = text.len() as i64;
    if len <= end_step {
        return text.to_vec();
    }
    let at = |i: i64| -> Option<u16> {
        if i < 0 {
            None
        } else {
            text.get(i as usize).copied()
        }
    };
    let mut folds: Vec<i64> = Vec::new();
    let mut escaped_folds: HashSet<i64> = HashSet::new();
    let mut end = lw - indent_len;
    if let Some(ias) = indent_at_start {
        if ias as i64 > lw - 2i64.max(min_content) {
            folds.push(0);
        } else {
            end = lw - ias as i64;
        }
    }
    let mut split: Option<i64> = None;
    let mut prev: Option<u16> = None;
    let mut i: i64 = -1;
    let mut esc_start: i64 = -1;
    let mut esc_end: i64 = -1;
    loop {
        i += 1;
        let Some(ch) = at(i) else { break };
        let mut ch_opt = Some(ch);
        if mode == Fold::Quoted && ch == BS {
            esc_start = i;
            i += match at(i + 1) {
                Some(0x78) => 3, // x
                Some(0x75) => 5, // u
                Some(0x55) => 9, // U
                _ => 1,
            };
            esc_end = i;
        }
        if ch == NL {
            end = i + indent_len + end_step;
            split = None;
        } else {
            if ch == SP && prev.is_some_and(|p| p != SP && p != NL && p != TAB) {
                // space surrounded by non-space can be replaced with newline + indent
                if at(i + 1).is_some_and(|n| n != SP && n != NL && n != TAB) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(sp) = split.filter(|s| *s != 0) {
                    folds.push(sp);
                    end = sp + end_step;
                    split = None;
                } else if mode == Fold::Quoted {
                    // white-space collected at end may stretch past lineWidth
                    while prev == Some(SP) || prev == Some(TAB) {
                        prev = ch_opt;
                        i += 1;
                        ch_opt = at(i);
                    }
                    // Account for newline escape, but don't break preceding escape
                    let j = if i > esc_end + 1 {
                        i - 2
                    } else {
                        esc_start - 1
                    };
                    // Bail out if lineWidth & minContentWidth are shorter than an escape string
                    if escaped_folds.contains(&j) {
                        return text.to_vec();
                    }
                    folds.push(j);
                    escaped_folds.insert(j);
                    end = j + end_step;
                    split = None;
                }
            }
        }
        prev = ch_opt;
    }
    if folds.is_empty() {
        return text.to_vec();
    }
    let slice = |a: i64, b: i64| -> &[u16] {
        // String.prototype.slice
        let norm = |x: i64| if x < 0 { (len + x).max(0) } else { x.min(len) };
        let (a, b) = (norm(a), norm(b));
        if a >= b {
            &[]
        } else {
            &text[a as usize..b as usize]
        }
    };
    let mut res: U16s = slice(0, folds[0]).to_vec();
    for (k, &fold) in folds.iter().enumerate() {
        let end = folds.get(k + 1).copied().filter(|f| *f != 0).unwrap_or(len);
        if fold == 0 {
            res = vec![NL];
            res.extend(spaces(indent));
            res.extend_from_slice(slice(0, end));
        } else {
            if mode == Fold::Quoted && escaped_folds.contains(&fold) {
                match at(fold) {
                    Some(c) => res.push(c),
                    None => res.extend(s16("undefined")),
                }
                res.push(BS);
            }
            res.push(NL);
            res.extend(spaces(indent));
            res.extend_from_slice(slice(fold + 1, end));
        }
    }
    res
}

/// `JSON.stringify(value)` on UTF-16 units (lone surrogates escaped).
pub(super) fn json_string(value: &[u16]) -> U16s {
    let mut out: U16s = vec![u16::from(b'"')];
    let push_str = |out: &mut U16s, s: &str| out.extend(s.encode_utf16());
    let mut i = 0;
    while i < value.len() {
        let c = value[i];
        match c {
            0x22 => push_str(&mut out, "\\\""),
            0x5c => push_str(&mut out, "\\\\"),
            0x08 => push_str(&mut out, "\\b"),
            0x0c => push_str(&mut out, "\\f"),
            0x0a => push_str(&mut out, "\\n"),
            0x0d => push_str(&mut out, "\\r"),
            0x09 => push_str(&mut out, "\\t"),
            0x00..=0x1f => push_str(&mut out, &format!("\\u{c:04x}")),
            0xD800..=0xDBFF if matches!(value.get(i + 1), Some(0xDC00..=0xDFFF)) => {
                out.push(c);
                out.push(value[i + 1]);
                i += 1;
            }
            0xD800..=0xDFFF => push_str(&mut out, &format!("\\u{c:04x}")),
            _ => out.push(c),
        }
        i += 1;
    }
    out.push(u16::from(b'"'));
    out
}

fn base64_encode(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in b.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// `Number.prototype.toString()`: JS number text, `NaN` and `Infinity`
/// spelled out.
pub(super) fn js_number_string(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        }
    } else {
        claudius_agent::js::number_to_string(n)
    }
}

/// `anchorIsValid(anchor)`: no control characters, white space or flow
/// indicators.
pub(super) fn anchor_is_valid(a: &[u16]) -> R<()> {
    let bad = a
        .iter()
        .any(|u| *u <= 0x19 || matches!(*u, 0x2c | 0x5b | 0x5d | 0x7b | 0x7d) || is_js_space(*u));
    if bad { Err(Thrown) } else { Ok(()) }
}
