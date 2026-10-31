//! Port of yaml 2.9.0's `doc.toJS()` (`nodes/toJS.js`, `Alias.toJSON`,
//! `addPairToJSMap`, the merge key, `YAMLSet` / `YAMLOMap.toJSON`) into a
//! small JS value graph, plus `JSON.stringify` of that graph.

use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::compose::{Kind, Node, Pair, SType, SeqItem};
use super::schema::{self, Schema, Tag};
use super::stringify::{Stringifier, js_number_string};
use super::{SVal, U16s, units_to_string};

/// A JS value. Objects live in the [`Heap`] (`Obj` is an index); `Sym` is
/// the merge tag's `Symbol('<<')`, one per scalar node.
#[derive(Clone, Debug)]
pub(super) enum JsVal {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(Rc<[u16]>),
    Sym(usize),
    Obj(usize),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum PropKey {
    Str(Rc<[u16]>),
    Sym(usize),
}

/// A SameValueZero key, for `Map` / `Set` membership.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Svz {
    Undefined,
    Null,
    Bool(bool),
    Num(u64),
    Str(Rc<[u16]>),
    Sym(usize),
    Obj(usize),
}

fn svz(v: &JsVal) -> Svz {
    match v {
        JsVal::Undefined => Svz::Undefined,
        JsVal::Null => Svz::Null,
        JsVal::Bool(b) => Svz::Bool(*b),
        JsVal::Num(n) => Svz::Num(if n.is_nan() {
            f64::NAN.to_bits()
        } else if *n == 0.0 {
            0f64.to_bits()
        } else {
            n.to_bits()
        }),
        JsVal::Str(s) => Svz::Str(s.clone()),
        JsVal::Sym(id) => Svz::Sym(*id),
        JsVal::Obj(id) => Svz::Obj(*id),
    }
}

#[derive(Debug)]
pub(super) enum JsObj {
    Array(Vec<JsVal>),
    Object(IndexMap<PropKey, JsVal>),
    /// Insertion-ordered entries, keyed by SameValueZero (the original key
    /// object is kept).
    Map(IndexMap<Svz, (JsVal, JsVal)>),
    Set(IndexMap<Svz, JsVal>),
    Date(f64),
    Buffer(Rc<Vec<u8>>),
}

/// A thrown JS exception (an alias or merge error, a cycle in
/// `JSON.stringify`, a `TypeError` from a coercion).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Thrown;

type R<T> = Result<T, Thrown>;

struct Anchor {
    alias_count: i64,
    count: i64,
    res: Option<JsVal>,
}

const MAX_ALIAS_COUNT: i64 = 100;

pub(super) struct ToJs<'d> {
    pub heap: Vec<JsObj>,
    nodes: HashMap<usize, &'d Node>,
    /// `Alias.resolve(doc)`: the last anchored node before the alias in
    /// document (pre-)order.
    alias_target: HashMap<usize, usize>,
    anchors: HashMap<usize, Anchor>,
    /// `ctx.onCreate`, pending for the anchored node being converted.
    on_create: Option<usize>,
    /// The `Date` / `Buffer` object a scalar node holds (one per node).
    scalar_objects: HashMap<usize, usize>,
    schema: Schema,
    /// The document's `%TAG` handles and the known tags its schema picked
    /// up, for stringifying collection keys.
    dir_tags: Vec<(U16s, U16s)>,
    pushed: Vec<Tag>,
}

fn index<'d>(
    node: &'d Node,
    nodes: &mut HashMap<usize, &'d Node>,
    last_anchor: &mut HashMap<U16s, usize>,
    alias_target: &mut HashMap<usize, usize>,
) {
    nodes.insert(node.id, node);
    if let Kind::Alias(source) = &node.kind {
        if let Some(target) = last_anchor.get(source) {
            alias_target.insert(node.id, *target);
        }
    } else if let Some(a) = node.anchor.as_ref().filter(|a| !a.is_empty()) {
        last_anchor.insert(a.clone(), node.id);
    }
    let pair = |p: &'d Pair,
                nodes: &mut HashMap<usize, &'d Node>,
                la: &mut HashMap<U16s, usize>,
                at: &mut HashMap<usize, usize>| {
        index(&p.key, nodes, la, at);
        if let Some(v) = p.value.as_deref() {
            index(v, nodes, la, at);
        }
    };
    match &node.kind {
        Kind::Map { items, .. } => {
            for p in items {
                pair(p, nodes, last_anchor, alias_target);
            }
        }
        Kind::Seq { items, .. } => {
            for it in items {
                match it {
                    SeqItem::Node(n) => index(n, nodes, last_anchor, alias_target),
                    SeqItem::Pair(p) => pair(p, nodes, last_anchor, alias_target),
                }
            }
        }
        _ => {}
    }
}

fn has_anchor(node: &Node) -> bool {
    node.anchor.as_ref().is_some_and(|a| !a.is_empty())
}

/// A value to merge from: a node, a `Pair` (in a pairs / omap sequence) or
/// JS `null`.
enum MergeSrc<'d> {
    Node(&'d Node),
    Pair,
    Null,
}

fn u(s: &str) -> Rc<[u16]> {
    s.encode_utf16().collect::<Vec<_>>().into()
}

impl<'d> ToJs<'d> {
    pub(super) fn new(
        root: &'d Node,
        schema: Schema,
        dir_tags: Vec<(U16s, U16s)>,
        pushed: Vec<Tag>,
    ) -> Self {
        let mut nodes = HashMap::new();
        let mut last = HashMap::new();
        let mut alias_target = HashMap::new();
        index(root, &mut nodes, &mut last, &mut alias_target);
        ToJs {
            heap: Vec::new(),
            nodes,
            alias_target,
            anchors: HashMap::new(),
            on_create: None,
            scalar_objects: HashMap::new(),
            schema,
            dir_tags,
            pushed,
        }
    }

    fn alloc(&mut self, obj: JsObj) -> usize {
        self.heap.push(obj);
        self.heap.len() - 1
    }

    /// A collection's `ctx.onCreate(res)` right after creating it.
    fn created(&mut self, id: usize) {
        if let Some(anchor) = self.on_create.take()
            && let Some(a) = self.anchors.get_mut(&anchor)
        {
            a.res = Some(JsVal::Obj(id));
        }
    }

    fn resolve_alias(&self, alias: &Node) -> Option<&'d Node> {
        self.alias_target
            .get(&alias.id)
            .and_then(|id| self.nodes.get(id).copied())
    }

    /// `toJS(value, arg, ctx)` for a node.
    pub(super) fn js_of(&mut self, node: &'d Node) -> R<JsVal> {
        if !has_anchor(node) {
            return self.json_node(node);
        }
        self.anchors.insert(
            node.id,
            Anchor {
                alias_count: 0,
                count: 1,
                res: None,
            },
        );
        self.on_create = Some(node.id);
        let res = self.json_node(node)?;
        if let Some(anchor) = self.on_create.take()
            && let Some(a) = self.anchors.get_mut(&anchor)
        {
            a.res = Some(res.clone());
        }
        Ok(res)
    }

    fn js_of_opt(&mut self, node: Option<&'d Node>) -> R<JsVal> {
        match node {
            Some(n) => self.js_of(n),
            None => Ok(JsVal::Null),
        }
    }

    fn json_node(&mut self, node: &'d Node) -> R<JsVal> {
        match &node.kind {
            Kind::Scalar { value, .. } => Ok(match value {
                SVal::Null => JsVal::Null,
                SVal::Bool(b) => JsVal::Bool(*b),
                SVal::Num(n) => JsVal::Num(*n),
                SVal::Str(s) => JsVal::Str(s.clone().into()),
                SVal::Sym => JsVal::Sym(node.id),
                SVal::Date(t) => JsVal::Obj(self.scalar_object(node.id, || JsObj::Date(*t))),
                SVal::Buffer(b) => {
                    JsVal::Obj(self.scalar_object(node.id, || JsObj::Buffer(Rc::new(b.clone()))))
                }
            }),
            Kind::Alias(_) => self.alias_to_js(node),
            Kind::Map { items, set } => {
                let id = self.alloc(if *set {
                    JsObj::Set(IndexMap::new())
                } else {
                    JsObj::Object(IndexMap::new())
                });
                self.created(id);
                for p in items {
                    self.add_pair(id, &p.key, p.value.as_deref())?;
                }
                Ok(JsVal::Obj(id))
            }
            Kind::Seq { items, omap: false } => {
                let id = self.alloc(JsObj::Array(Vec::new()));
                self.created(id);
                for it in items {
                    let v = match it {
                        SeqItem::Node(n) => self.js_of(n)?,
                        SeqItem::Pair(p) => self.pair_to_js(p)?,
                    };
                    if let JsObj::Array(a) = &mut self.heap[id] {
                        a.push(v);
                    }
                }
                Ok(JsVal::Obj(id))
            }
            Kind::Seq { items, omap: true } => {
                let id = self.alloc(JsObj::Map(IndexMap::new()));
                self.created(id);
                for it in items {
                    let (k, v) = match it {
                        SeqItem::Pair(p) => {
                            let k = self.js_of(&p.key)?;
                            let v = self.js_of_opt(p.value.as_deref())?;
                            (k, v)
                        }
                        SeqItem::Node(n) => (self.js_of(n)?, JsVal::Undefined),
                    };
                    let JsObj::Map(m) = &mut self.heap[id] else {
                        unreachable!()
                    };
                    let key = svz(&k);
                    if m.contains_key(&key) {
                        // 'Ordered maps must not include duplicate keys'
                        return Err(Thrown);
                    }
                    m.insert(key, (k, v));
                }
                Ok(JsVal::Obj(id))
            }
        }
    }

    fn scalar_object(&mut self, node_id: usize, make: impl FnOnce() -> JsObj) -> usize {
        if let Some(id) = self.scalar_objects.get(&node_id) {
            return *id;
        }
        let id = self.alloc(make());
        self.scalar_objects.insert(node_id, id);
        id
    }

    /// `Pair.toJSON(_, ctx)`: a one-entry plain object.
    fn pair_to_js(&mut self, p: &'d Pair) -> R<JsVal> {
        let id = self.alloc(JsObj::Object(IndexMap::new()));
        self.add_pair(id, &p.key, p.value.as_deref())?;
        Ok(JsVal::Obj(id))
    }

    /// `Alias.toJSON(_arg, ctx)`.
    fn alias_to_js(&mut self, alias: &'d Node) -> R<JsVal> {
        let Some(source) = self.resolve_alias(alias) else {
            // 'Unresolved alias (the anchor must be set before the alias)'
            return Err(Thrown);
        };
        if !self.anchors.contains_key(&source.id) {
            // Resolve anchors for Node.prototype.toJS()
            self.js_of(source)?;
        }
        let res = match self.anchors.get(&source.id).and_then(|a| a.res.clone()) {
            Some(r) => r,
            None => return Err(Thrown),
        };
        let mut alias_count = self.anchors[&source.id].alias_count;
        if alias_count == 0 {
            alias_count = self.alias_count(source);
        }
        let a = self.anchors.get_mut(&source.id).expect("anchor data");
        a.count += 1;
        a.alias_count = alias_count;
        if a.count * a.alias_count > MAX_ALIAS_COUNT {
            // 'Excessive alias count indicates a resource exhaustion attack'
            return Err(Thrown);
        }
        Ok(res)
    }

    /// `getAliasCount(doc, node, anchors)`.
    fn alias_count(&self, node: &'d Node) -> i64 {
        match &node.kind {
            Kind::Alias(_) => self
                .resolve_alias(node)
                .and_then(|s| self.anchors.get(&s.id))
                .map_or(0, |a| a.count * a.alias_count),
            Kind::Map { items, .. } => items
                .iter()
                .map(|p| self.pair_alias_count(p))
                .fold(0, i64::max),
            Kind::Seq { items, .. } => items
                .iter()
                .map(|it| match it {
                    SeqItem::Node(n) => self.alias_count(n),
                    SeqItem::Pair(p) => self.pair_alias_count(p),
                })
                .fold(0, i64::max),
            Kind::Scalar { .. } => 1,
        }
    }

    fn pair_alias_count(&self, p: &'d Pair) -> i64 {
        let kc = self.alias_count(&p.key);
        let vc = p.value.as_deref().map_or(1, |v| self.alias_count(v));
        kc.max(vc)
    }

    /// `merge.isMergeKey(ctx, key)` or the key's own `addToJSMap`.
    fn is_merge_key(&self, key: &Node) -> bool {
        match &key.kind {
            Kind::Scalar { merge: true, .. } => true,
            Kind::Scalar { value, ty, .. } => {
                self.schema.merge_default()
                    && matches!(ty, None | Some(SType::Plain))
                    && match value {
                        SVal::Str(s) => s.as_slice() == [0x3c, 0x3c],
                        SVal::Sym => true,
                        _ => false,
                    }
            }
            _ => false,
        }
    }

    /// `addPairToJSMap(ctx, map, { key, value })`.
    fn add_pair(&mut self, target: usize, key: &'d Node, value: Option<&'d Node>) -> R<()> {
        if self.is_merge_key(key) {
            return self.add_merge(target, value);
        }
        let js_key = self.js_of(key)?;
        match &self.heap[target] {
            JsObj::Map(_) => {
                let v = self.js_of_opt(value)?;
                let JsObj::Map(m) = &mut self.heap[target] else {
                    unreachable!()
                };
                let k = svz(&js_key);
                match m.get_mut(&k) {
                    Some(entry) => entry.1 = v,
                    None => {
                        m.insert(k, (js_key, v));
                    }
                }
            }
            JsObj::Set(_) => {
                let JsObj::Set(s) = &mut self.heap[target] else {
                    unreachable!()
                };
                s.entry(svz(&js_key)).or_insert(js_key);
            }
            _ => {
                let string_key = self.stringify_key(key, &js_key)?;
                let v = self.js_of_opt(value)?;
                if let JsObj::Object(o) = &mut self.heap[target] {
                    o.insert(PropKey::Str(string_key.into()), v);
                }
            }
        }
        Ok(())
    }

    fn resolve_alias_value(&self, value: MergeSrc<'d>) -> MergeSrc<'d> {
        match value {
            MergeSrc::Node(n) if matches!(n.kind, Kind::Alias(_)) => match self.resolve_alias(n) {
                Some(t) => MergeSrc::Node(t),
                None => MergeSrc::Null,
            },
            other => other,
        }
    }

    /// `addMergeToJSMap(ctx, map, value)`.
    fn add_merge(&mut self, target: usize, value: Option<&'d Node>) -> R<()> {
        let value = match value {
            Some(v) => MergeSrc::Node(v),
            None => MergeSrc::Null,
        };
        match self.resolve_alias_value(value) {
            MergeSrc::Node(n) if matches!(n.kind, Kind::Seq { .. }) => {
                let Kind::Seq { items, .. } = &n.kind else {
                    unreachable!()
                };
                for it in items {
                    let src = match it {
                        SeqItem::Node(n) => MergeSrc::Node(n),
                        SeqItem::Pair(_) => MergeSrc::Pair,
                    };
                    self.merge_value(target, src)?;
                }
                Ok(())
            }
            other => self.merge_value(target, other),
        }
    }

    /// `mergeValue(ctx, map, value)`.
    fn merge_value(&mut self, target: usize, value: MergeSrc<'d>) -> R<()> {
        let MergeSrc::Node(source) = self.resolve_alias_value(value) else {
            // 'Merge sources must be maps or map aliases'
            return Err(Thrown);
        };
        let Kind::Map { items, set } = &source.kind else {
            return Err(Thrown);
        };
        // `source.toJSON(null, ctx, Map)`; a `YAMLSet` makes a `Set`.
        let src = self.alloc(if *set {
            JsObj::Set(IndexMap::new())
        } else {
            JsObj::Map(IndexMap::new())
        });
        self.created(src);
        for p in items {
            self.add_pair(src, &p.key, p.value.as_deref())?;
        }
        let entries: Vec<(JsVal, JsVal)> = match &self.heap[src] {
            JsObj::Map(m) => m.values().cloned().collect(),
            JsObj::Set(s) => {
                let elems: Vec<JsVal> = s.values().cloned().collect();
                let mut out = Vec::new();
                for e in elems {
                    out.push(self.destructure_pair(&e)?);
                }
                out
            }
            _ => unreachable!(),
        };
        for (k, v) in entries {
            match &mut self.heap[target] {
                JsObj::Map(m) => {
                    m.entry(svz(&k)).or_insert((k, v));
                }
                JsObj::Set(s) => {
                    s.entry(svz(&k)).or_insert(k);
                }
                JsObj::Object(_) => {
                    let pk = self.to_property_key(&k)?;
                    if let JsObj::Object(o) = &mut self.heap[target] {
                        o.entry(pk).or_insert(v);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// `const [key, value] = element` (iterating a `Set` of merge sources).
    fn destructure_pair(&mut self, e: &JsVal) -> R<(JsVal, JsVal)> {
        let two = |mut it: std::vec::IntoIter<JsVal>| {
            let a = it.next().unwrap_or(JsVal::Undefined);
            let b = it.next().unwrap_or(JsVal::Undefined);
            (a, b)
        };
        match e {
            JsVal::Str(s) => {
                let chars: Vec<JsVal> = char::decode_utf16(s.iter().copied())
                    .take(2)
                    .map(|c| {
                        let mut buf = [0u16; 2];
                        JsVal::Str(match c {
                            Ok(c) => c.encode_utf16(&mut buf).to_vec().into(),
                            Err(e) => vec![e.unpaired_surrogate()].into(),
                        })
                    })
                    .collect();
                Ok(two(chars.into_iter()))
            }
            JsVal::Obj(id) => match &self.heap[*id] {
                JsObj::Array(a) => Ok(two(a
                    .iter()
                    .take(2)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter())),
                JsObj::Set(s) => Ok(two(s
                    .values()
                    .take(2)
                    .cloned()
                    .collect::<Vec<_>>()
                    .into_iter())),
                JsObj::Buffer(b) => Ok(two(b
                    .iter()
                    .take(2)
                    .map(|x| JsVal::Num(f64::from(*x)))
                    .collect::<Vec<_>>()
                    .into_iter())),
                JsObj::Map(m) => {
                    let entries: Vec<(JsVal, JsVal)> = m.values().take(2).cloned().collect();
                    let mut arrs = Vec::new();
                    for (k, v) in entries {
                        arrs.push(JsVal::Obj(self.alloc(JsObj::Array(vec![k, v]))));
                    }
                    Ok(two(arrs.into_iter()))
                }
                // not iterable: TypeError
                _ => Err(Thrown),
            },
            _ => Err(Thrown),
        }
    }

    /// `ToPropertyKey(v)`.
    fn to_property_key(&self, v: &JsVal) -> R<PropKey> {
        match v {
            JsVal::Sym(id) => Ok(PropKey::Sym(*id)),
            other => Ok(PropKey::Str(
                self.js_to_string(other, &mut Vec::new())?.into(),
            )),
        }
    }

    /// `ToString(v)` (`String(v)` for everything but symbols, which throw).
    fn js_to_string(&self, v: &JsVal, seen: &mut Vec<usize>) -> R<U16s> {
        let s = |x: &str| -> U16s { x.encode_utf16().collect() };
        Ok(match v {
            JsVal::Undefined => s("undefined"),
            JsVal::Null => s("null"),
            JsVal::Bool(b) => s(if *b { "true" } else { "false" }),
            JsVal::Num(n) => s(&js_number_string(*n)),
            JsVal::Str(x) => x.to_vec(),
            JsVal::Sym(_) => return Err(Thrown),
            JsVal::Obj(id) => match &self.heap[*id] {
                JsObj::Array(a) => {
                    // Array.prototype.join, which prints a cycle as ''
                    if seen.contains(id) {
                        return Ok(Vec::new());
                    }
                    seen.push(*id);
                    let mut out: U16s = Vec::new();
                    for (i, item) in a.iter().enumerate() {
                        if i > 0 {
                            out.push(u16::from(b','));
                        }
                        if !matches!(item, JsVal::Undefined | JsVal::Null) {
                            out.extend(self.js_to_string(item, seen)?);
                        }
                    }
                    seen.pop();
                    out
                }
                JsObj::Object(o) => {
                    // An own `toString` here is never callable: TypeError.
                    if o.contains_key(&PropKey::Str(u("toString"))) {
                        return Err(Thrown);
                    }
                    s("[object Object]")
                }
                JsObj::Map(_) => s("[object Map]"),
                JsObj::Set(_) => s("[object Set]"),
                JsObj::Date(t) => s(&schema::date_string(*t)),
                JsObj::Buffer(b) => s(&String::from_utf8_lossy(b)),
            },
        })
    }

    /// `stringifyKey(key, jsKey, ctx)`.
    fn stringify_key(&self, key: &Node, js_key: &JsVal) -> R<U16s> {
        let s = |x: &str| -> U16s { x.encode_utf16().collect() };
        match js_key {
            JsVal::Null => Ok(Vec::new()),
            JsVal::Sym(_) => Ok(s("Symbol(<<)")),
            JsVal::Obj(_) => self.key_node_string(key),
            other => self.js_to_string(other, &mut Vec::new()),
        }
    }

    /// `key.toString(strCtx)` for a key whose JS value is an object
    /// (`strCtx.anchors` starts with the anchors `toJS` has seen).
    fn key_node_string(&self, key: &Node) -> R<U16s> {
        let anchors = self
            .anchors
            .keys()
            .filter_map(|id| self.nodes.get(id).and_then(|n| n.anchor.clone()))
            .collect();
        let mut st = Stringifier {
            schema: self.schema,
            dir_tags: &self.dir_tags,
            pushed: &self.pushed,
            anchors,
        };
        match &key.kind {
            Kind::Alias(source) => st.alias(source, &Default::default()),
            // `Scalar.toString()`: `String(this.value)`
            Kind::Scalar { value, .. } => Ok(match value {
                SVal::Date(t) => schema::date_string(*t).encode_utf16().collect(),
                SVal::Buffer(b) => String::from_utf8_lossy(b).encode_utf16().collect(),
                _ => Vec::new(),
            }),
            _ => st.key(key),
        }
    }
}

/// `JSON.stringify(v)` as a serde value; `Ok(None)` is `undefined`, `Err`
/// the `TypeError` for a cycle (or a value nested past `max_depth`).
pub(super) fn json_value(heap: &[JsObj], v: &JsVal, max_depth: usize) -> R<Option<Value>> {
    json_rec(heap, v, &mut Vec::new(), max_depth)
}

fn json_rec(
    heap: &[JsObj],
    v: &JsVal,
    stack: &mut Vec<usize>,
    max_depth: usize,
) -> R<Option<Value>> {
    Ok(Some(match v {
        JsVal::Undefined | JsVal::Sym(_) => return Ok(None),
        JsVal::Null => Value::Null,
        JsVal::Bool(b) => Value::Bool(*b),
        JsVal::Num(n) => {
            if n.is_finite() {
                Value::from(*n)
            } else {
                Value::Null
            }
        }
        JsVal::Str(s) => Value::String(units_to_string(s)),
        JsVal::Obj(id) => match &heap[*id] {
            JsObj::Date(t) => schema::date_iso(*t).map_or(Value::Null, Value::String),
            JsObj::Buffer(b) => {
                let mut m = Map::new();
                m.insert("type".into(), Value::String("Buffer".into()));
                m.insert(
                    "data".into(),
                    Value::Array(b.iter().map(|x| Value::from(*x)).collect()),
                );
                Value::Object(m)
            }
            JsObj::Map(_) | JsObj::Set(_) => Value::Object(Map::new()),
            JsObj::Array(a) => {
                if stack.contains(id) || stack.len() >= max_depth {
                    return Err(Thrown);
                }
                stack.push(*id);
                let mut out = Vec::with_capacity(a.len());
                for item in a {
                    out.push(json_rec(heap, item, stack, max_depth)?.unwrap_or(Value::Null));
                }
                stack.pop();
                Value::Array(out)
            }
            JsObj::Object(o) => {
                if stack.contains(id) || stack.len() >= max_depth {
                    return Err(Thrown);
                }
                stack.push(*id);
                let mut m = Map::new();
                for (k, val) in o {
                    let PropKey::Str(k) = k else { continue };
                    if let Some(j) = json_rec(heap, val, stack, max_depth)? {
                        m.insert(units_to_string(k), j);
                    }
                }
                stack.pop();
                Value::Object(m)
            }
        },
    }))
}
