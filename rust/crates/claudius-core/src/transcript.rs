//! Transcript reconstruction — port of the SDK's `getSessionMessages`
//! pipeline (SDK 0.3.299 minified names in brackets, so the next bump can be
//! diffed function-by-function; checked against 0.3.312, whose only changes
//! here are one more interrupt text in `AD` and `taskKind` in `dE`):
//!
//! 1. parse entries + queued-command delivery bookkeeping   [`xve`/`aU`/`lU`]
//! 2. resolve the main chain root→leaf (compact relinks)    [`Pu`]
//! 3. splice parallel tool-call siblings back in            [`Ove`]
//! 4. collect trailing queued commands after the leaf       [`Mve`]
//! 5. local-command / queued-command synthesis              [`SA`/`Pve`/`kve`/`Ive`/`Dve`]
//! 6. filter + map to `SessionMessage`                      [`Lve`/`EA`]

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

pub type Obj = Map<String, Value>;

static RUN_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$").unwrap());

/// `AD` (0.3.312 `aL`) — synthetic tool_result / user texts that count as a
/// "reply". 0.3.312 added the second one (a subagent cut off by the session's
/// end).
const INTERRUPT_PREFIXES: &[&str] = &[
    "[Request interrupted by user]",
    "[Request interrupted: the session ended before this agent finished. Nobody asked it to stop.]",
    "[Request interrupted by user for tool use]",
    "[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]",
    "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
    "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. Check whether it took effect before relying on it or running it again.]",
    "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
    "[Tool call skipped: the turn was stopped before this call ran, by the check whose denial is on another call in this batch. Nothing refused this call and it had no effects; re-run it if still needed.]",
    "[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]",
];

// ---------- small accessors ----------

fn s<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}
fn uuid(o: &Obj) -> &str {
    s(o, "uuid").unwrap_or_default()
}
fn ty(o: &Obj) -> Option<&str> {
    s(o, "type")
}
fn is_true(o: &Obj, k: &str) -> bool {
    o.get(k) == Some(&Value::Bool(true))
}
/// JS truthiness for a field.
fn truthy(o: &Obj, k: &str) -> bool {
    match o.get(k) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn parent(o: &Obj) -> Option<&str> {
    s(o, "parentUuid").filter(|p| !p.is_empty())
}
fn is_turn(o: &Obj) -> bool {
    matches!(ty(o), Some("user" | "assistant"))
}
fn ts(o: &Obj) -> &str {
    s(o, "timestamp").unwrap_or("")
}

/// `Tm` — assistant `message.id`.
fn msg_id(o: &Obj) -> Option<&str> {
    if ty(o) != Some("assistant") {
        return None;
    }
    o.get("message")?.get("id")?.as_str()
}

/// `ku` — string fields of content blocks of a given type.
fn block_ids<'a>(o: &'a Obj, block_type: &str, field: &str) -> Vec<&'a str> {
    o.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some(block_type))
                .filter_map(|b| b.get(field).and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

/// `cU` — a user tool_result entry with a parent.
fn is_tool_result_user(o: &Obj) -> bool {
    ty(o) == Some("user")
        && parent(o).is_some()
        && o.get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
            .is_some_and(|c| {
                c.iter()
                    .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            })
}

/// `vD` — synthetic interrupt/denial user message.
fn is_interrupt_user(o: &Obj) -> bool {
    if ty(o) != Some("user") {
        return false;
    }
    let starts = |t: &str| INTERRUPT_PREFIXES.iter().any(|p| t.starts_with(p));
    match o.get("message").and_then(|m| m.get("content")) {
        Some(Value::String(t)) => starts(t),
        Some(Value::Array(blocks)) => {
            !blocks.is_empty()
                && blocks.iter().all(|b| {
                    let text = match b.get("type").and_then(Value::as_str) {
                        Some("text") => b.get("text").and_then(Value::as_str),
                        Some("tool_result") if b.get("is_error") == Some(&Value::Bool(true)) => {
                            b.get("content").and_then(Value::as_str)
                        }
                        _ => None,
                    };
                    text.is_some_and(starts)
                })
        }
        _ => false,
    }
}

/// `AN` — string field of a `queued_command` attachment.
fn queued_attr<'a>(o: &'a Obj, field: &str) -> Option<&'a str> {
    if ty(o) != Some("attachment") {
        return None;
    }
    let a = o.get("attachment")?.as_object()?;
    if a.get("type").and_then(Value::as_str) != Some("queued_command") {
        return None;
    }
    a.get(field)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

/// `pA` — origins that keep an `isMeta` entry visible.
fn origin_keeps_meta(origin: Option<&Value>) -> bool {
    matches!(
        origin.and_then(|o| o.get("kind")).and_then(Value::as_str),
        Some("channel" | "observer" | "observer-activity" | "slack-ping" | "peer")
    )
}

/// `qc`
fn valid_run_id(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| RUN_ID_RE.is_match(s))
        .map(str::to_owned)
}

/// `dE` (0.3.312 `yb`) — normalize a task-notification origin. 0.3.312 keeps
/// `taskKind`, but only when it's exactly `"mcp-task"`.
fn normalize_origin(origin: &Value) -> Value {
    if origin.get("kind").and_then(Value::as_str) != Some("task-notification") {
        return origin.clone();
    }
    let mut m = Obj::new();
    m.insert("kind".into(), json!("task-notification"));
    for k in ["subkind", "fireReason", "producer"] {
        if let Some(v) = origin.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    if let Some(r) = valid_run_id(origin.get("runId")) {
        m.insert("runId".into(), json!(r));
    }
    if origin.get("taskKind").and_then(Value::as_str) == Some("mcp-task") {
        m.insert("taskKind".into(), json!("mcp-task"));
    }
    Value::Object(m)
}

// ---------- 1. parse + delivery bookkeeping ----------

#[derive(Default)]
struct Delivery {
    counts: HashMap<String, i64>,
    copies: HashMap<String, String>,
    mixed: HashSet<String>,
    delivery_copies: Vec<(String, Vec<String>)>,
    delivery_copy_uuids: HashSet<String>,
}

impl Delivery {
    /// `aU`
    fn observe(&mut self, e: &Obj) {
        if ty(e) == Some("queue-operation")
            && s(e, "operation") == Some("remove")
            && s(e, "reason") == Some("absorbed_mid_turn")
        {
            let key = match (e.get("deliveryId"), e.get("commandUuid")) {
                (Some(Value::String(d)), _) if !d.is_empty() => Some(format!("delivery:{d}")),
                (_, Some(Value::String(c))) => Some(format!("uuid:{c}")),
                _ => None,
            };
            if (e.get("deliveryId").is_some_and(Value::is_string)
                || e.get("commandUuid").is_some_and(Value::is_string))
                && let Some(k) = key
            {
                *self.counts.entry(k).or_default() += 1;
            }
            return;
        }
        if !(e.get("type").is_some_and(Value::is_string)
            && e.get("uuid").is_some_and(Value::is_string))
        {
            return;
        }
        if let Some(d) = queued_attr(e, "delivery_id") {
            let u = uuid(e).to_owned();
            if self.delivery_copy_uuids.insert(u.clone()) {
                let key = format!("delivery:{d}");
                match self.delivery_copies.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, v)) => v.push(u),
                    None => self.delivery_copies.push((key, vec![u])),
                }
            }
            return;
        }
        let Some(src) = queued_attr(e, "source_uuid") else {
            return;
        };
        let body =
            serde_json::to_string(e.get("attachment").unwrap_or(&Value::Null)).unwrap_or_default();
        match self.copies.get(src) {
            None => {
                self.copies.insert(src.to_owned(), body);
            }
            Some(prev) if *prev != body => {
                self.mixed.insert(src.to_owned());
            }
            _ => {}
        }
    }

    /// `lU`
    fn finish(mut self) -> HashMap<String, i64> {
        for m in &self.mixed {
            self.counts.remove(&format!("uuid:{m}"));
        }
        for (key, uuids) in &self.delivery_copies {
            let r = self.counts.get(key).copied().unwrap_or(0).max(0) as usize;
            for u in &uuids[uuids.len().saturating_sub(r)..] {
                self.counts.insert(format!("entry:{u}"), 1);
            }
        }
        self.counts
    }
}

pub struct Parsed {
    pub entries: Vec<Obj>,
    delivered: HashMap<String, i64>,
}

/// `xve`
pub fn parse(text: &str) -> Parsed {
    let mut entries = Vec::new();
    let mut d = Delivery::default();
    for line in text.split('\n') {
        let line = line.trim_start_matches(|c: char| (c as u32) <= 32);
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(o)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if matches!(
            ty(&o),
            Some("user" | "assistant" | "progress" | "system" | "attachment")
        ) && o.get("uuid").is_some_and(Value::is_string)
        {
            entries.push(o.clone());
        }
        d.observe(&o);
    }
    Parsed {
        entries,
        delivered: d.finish(),
    }
}

// ---------- 2. chain ----------

/// Insertion-ordered uuid → entry map (JS `Map` semantics).
struct OrderedMap {
    order: Vec<String>,
    map: HashMap<String, Obj>,
}

impl OrderedMap {
    fn get(&self, k: &str) -> Option<&Obj> {
        self.map.get(k)
    }
    fn values(&self) -> impl Iterator<Item = &Obj> {
        self.order.iter().filter_map(|k| self.map.get(k))
    }
}

pub struct Chain {
    pub messages: Vec<Obj>,
    pub leaf: Option<Obj>,
    /// `found.terminal`: the main-chain terminal whose walk reached the
    /// leaf. `None` when the leaf came from the roots fallback.
    pub terminal: Option<Obj>,
}

/// `Pu` + `Ove`
pub fn resolve_chain(entries: &[Obj]) -> Chain {
    let mut n = OrderedMap {
        order: Vec::new(),
        map: HashMap::new(),
    };
    for e in entries {
        let id = uuid(e).to_owned();
        if !n.map.contains_key(&id) {
            n.order.push(id.clone());
        }
        n.map.insert(id, e.clone());
    }

    // Compact-boundary relinks.
    let boundaries: Vec<Obj> = n
        .values()
        .filter(|e| ty(e) == Some("system") && s(e, "subtype") == Some("compact_boundary"))
        .cloned()
        .collect();
    for b in boundaries {
        let meta = b.get("compactMetadata");
        if let Some(pm) = meta
            .and_then(|m| m.get("preservedMessages"))
            .filter(|v| v.is_object())
        {
            let uuids: Vec<String> = pm
                .get("uuids")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if uuids.is_empty() || uuids.iter().any(|u| !n.map.contains_key(u)) {
                continue;
            }
            let anchor = pm.get("anchorUuid").cloned().unwrap_or(Value::Null);
            let mut prev = anchor.clone();
            for u in &uuids {
                n.map.get_mut(u).unwrap().insert("parentUuid".into(), prev);
                prev = Value::String(u.clone());
            }
            let (first, last) = (uuids[0].clone(), uuids.last().unwrap().clone());
            for id in n.order.clone() {
                let e = n.map.get_mut(&id).unwrap();
                if e.get("parentUuid") == Some(&anchor) && id != first {
                    e.insert("parentUuid".into(), json!(last));
                }
            }
        } else if let Some(seg) = meta
            .and_then(|m| m.get("preservedSegment"))
            .filter(|v| v.is_object())
        {
            let head = seg
                .get("headUuid")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let anchor = seg.get("anchorUuid").cloned().unwrap_or(Value::Null);
            let tail = seg.get("tailUuid").cloned().unwrap_or(Value::Null);
            if let Some(h) = &head
                && let Some(e) = n.map.get_mut(h)
            {
                e.insert("parentUuid".into(), anchor.clone());
            }
            for id in n.order.clone() {
                let e = n.map.get_mut(&id).unwrap();
                if e.get("parentUuid") == Some(&anchor) && Some(&id) != head.as_ref() {
                    e.insert("parentUuid".into(), tail.clone());
                }
            }
        }
    }

    let pos: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (uuid(e), i))
        .collect();
    let pos_of = |e: &Obj| pos.get(uuid(e)).map(|p| *p as i64).unwrap_or(-1);
    let is_main = |e: &Obj| {
        !truthy(e, "isSidechain")
            && !truthy(e, "teamName")
            && ty(e) != Some("progress")
            && !(ty(e) == Some("attachment")
                && e.get("attachment")
                    .and_then(|a| a.get("type"))
                    .and_then(Value::as_str)
                    == Some("fork_briefing"))
    };
    let all_parents: HashSet<&str> = n.values().filter_map(parent).collect();
    let roots: Vec<&Obj> = n
        .values()
        .filter(|e| !all_parents.contains(uuid(e)))
        .collect();
    let main_parents: HashSet<&str> = n
        .values()
        .filter(|e| is_main(e))
        .filter_map(parent)
        .collect();
    let mut terminals: Vec<&Obj> = n
        .values()
        .filter(|e| is_main(e) && !main_parents.contains(uuid(e)))
        .collect();
    terminals.sort_by_key(|e| std::cmp::Reverse(pos_of(e)));

    let mut dead: HashSet<String> = HashSet::new();
    let mut found: Option<Obj> = None;
    let mut terminal: Option<Obj> = None;
    for t in terminals {
        let mut walked = Vec::new();
        let mut local = HashSet::new();
        let mut cur = Some(t);
        while let Some(c) = cur {
            let id = uuid(c).to_owned();
            if dead.contains(&id) || local.contains(&id) {
                break;
            }
            if is_turn(c) {
                found = Some(c.clone());
                terminal = Some(t.clone());
                break;
            }
            local.insert(id.clone());
            walked.push(id);
            cur = parent(c).and_then(|p| n.get(p));
        }
        if found.is_some() {
            break;
        }
        dead.extend(walked);
    }
    let leaf = match found {
        Some(l) => l,
        None => {
            let mut cands: Vec<&Obj> = Vec::new();
            for r in &roots {
                let mut cur = Some(*r);
                let mut seen = HashSet::new();
                while let Some(c) = cur {
                    if !seen.insert(uuid(c).to_owned()) {
                        break;
                    }
                    if is_turn(c) {
                        cands.push(c);
                        break;
                    }
                    cur = parent(c).and_then(|p| n.get(p));
                }
            }
            if cands.is_empty() {
                return Chain {
                    messages: vec![],
                    leaf: None,
                    terminal: None,
                };
            }
            let clean: Vec<&Obj> = cands
                .iter()
                .copied()
                .filter(|e| {
                    !truthy(e, "isSidechain") && !truthy(e, "teamName") && !truthy(e, "isMeta")
                })
                .collect();
            let pool = if clean.is_empty() { cands } else { clean };
            // reduce keeping the LATER position on ties-by-greater only
            let mut best = pool[0];
            for e in &pool[1..] {
                if pos_of(e) > pos_of(best) {
                    best = e;
                }
            }
            best.clone()
        }
    };

    let mut chain = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut cur = n.get(uuid(&leaf)).cloned();
    while let Some(c) = cur {
        if !visited.insert(uuid(&c).to_owned()) {
            break;
        }
        cur = parent(&c).and_then(|p| n.get(p)).cloned();
        chain.push(c);
    }
    chain.reverse();
    let messages = splice_parallel(&n, chain, &mut visited);
    Chain {
        messages,
        leaf: Some(leaf),
        terminal,
    }
}

/// `Ove` — re-insert parallel tool_use siblings / tool_results that the
/// single-parent walk skipped, right after their chain assistant.
fn splice_parallel(e: &OrderedMap, t: Vec<Obj>, n: &mut HashSet<String>) -> Vec<Obj> {
    let r: Vec<&Obj> = t.iter().filter(|x| ty(x) == Some("assistant")).collect();
    if r.is_empty() {
        return t;
    }
    let mut o: HashMap<String, String> = HashMap::new(); // msgId → last chain assistant uuid
    for x in &r {
        if let Some(c) = msg_id(x) {
            o.insert(c.to_owned(), uuid(x).to_owned());
        }
    }
    let mut by_msg: HashMap<String, Vec<&Obj>> = HashMap::new(); // `s`
    let mut tool_owner: HashMap<String, Option<&Obj>> = HashMap::new(); // `a`
    let mut results: Vec<&Obj> = Vec::new(); // `l`
    for x in e.values() {
        if let Some(c) = msg_id(x) {
            by_msg.entry(c.to_owned()).or_default().push(x);
            for id in block_ids(x, "tool_use", "id") {
                let next = match tool_owner.get(id) {
                    None => Some(x),
                    Some(Some(prev)) if msg_id(prev) == Some(c) => Some(x),
                    Some(_) => None,
                };
                tool_owner.insert(id.to_owned(), next);
            }
        } else if is_tool_result_user(x) {
            results.push(x);
        }
    }
    let same_thread = |a: &Obj, b: &Obj| {
        let side = |o: &Obj| {
            o.get("isSidechain")
                .cloned()
                .filter(|v| !v.is_null())
                .unwrap_or(Value::Bool(false))
        };
        side(a) == side(b) && a.get("agentId") == b.get("agentId")
    };
    let mut edges: Vec<(String, &Obj)> = Vec::new();
    for x in &results {
        let p = parent(x).unwrap_or_default().to_owned();
        edges.push((p.clone(), x));
        if let Some(src) = s(x, "sourceToolAssistantUUID").filter(|v| Some(*v) != parent(x))
            && let Some(c) = e.get(src)
            && same_thread(x, c)
        {
            edges.push((uuid(c).to_owned(), x));
        }
        for id in block_ids(x, "tool_result", "tool_use_id") {
            if let Some(Some(owner)) = tool_owner.get(id)
                && same_thread(x, owner)
            {
                edges.push((uuid(owner).to_owned(), x));
            }
        }
    }
    // `i` — parent uuid → result children, deduped per (parent, child) edge (`d`).
    let mut child_lists: HashMap<String, Vec<&Obj>> = HashMap::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    for (p, c) in edges {
        if seen_edges.insert((p.clone(), uuid(c).to_owned())) {
            child_lists.entry(p).or_default().push(c);
        }
    }

    let mut answered: HashSet<String> = HashSet::new(); // `f`
    for x in &t {
        for id in block_ids(x, "tool_result", "tool_use_id") {
            answered.insert(id.to_owned());
        }
    }
    let file_pos: HashMap<&str, usize> = e
        .order
        .iter()
        .enumerate()
        .map(|(i, k)| (k.as_str(), i))
        .collect();
    let g = |x: &Obj| file_pos.get(uuid(x)).copied().unwrap_or(usize::MAX);

    let mut done: HashSet<String> = HashSet::new();
    let mut inserts: HashMap<String, Vec<Obj>> = HashMap::new();
    let mut total = 0usize;
    for x in &r {
        let Some(c) = msg_id(x) else { continue };
        if !done.insert(c.to_owned()) {
            continue;
        }
        let group: Vec<&Obj> = by_msg.get(c).cloned().unwrap_or_else(|| vec![x]);
        let group_ids: HashSet<&str> = group.iter().map(|g| uuid(g)).collect();
        let mut siblings: Vec<&Obj> = group
            .iter()
            .copied()
            .filter(|d| !n.contains(uuid(d)))
            .collect();
        let (mut direct, mut indirect): (Vec<&Obj>, Vec<&Obj>) = (Vec::new(), Vec::new());
        let mut de: HashSet<&str> = HashSet::new();
        for d in &group {
            for k in child_lists.get(uuid(d)).map(Vec::as_slice).unwrap_or(&[]) {
                if n.contains(uuid(k)) || !de.insert(uuid(k)) {
                    continue;
                }
                if parent(k).is_some_and(|p| group_ids.contains(p)) {
                    direct.push(k);
                } else {
                    indirect.push(k);
                }
            }
        }
        if !indirect.is_empty() {
            let mut covered = answered.clone();
            for k in &direct {
                for id in block_ids(k, "tool_result", "tool_use_id") {
                    covered.insert(id.to_owned());
                }
            }
            indirect.sort_by_key(|k| g(k));
            for k in indirect {
                let ids = block_ids(k, "tool_result", "tool_use_id");
                let wanted = ids.iter().any(|id| {
                    !covered.contains(*id)
                        && matches!(tool_owner.get(*id), Some(Some(owner)) if group_ids.contains(uuid(owner)))
                });
                if !wanted {
                    continue;
                }
                covered.extend(ids.iter().map(|s| s.to_string()));
                direct.push(k);
            }
        }
        if siblings.is_empty() && direct.is_empty() {
            continue;
        }
        siblings.sort_by(|a, b| ts(a).cmp(ts(b)));
        direct.sort_by(|a, b| ts(a).cmp(ts(b)));
        let out: Vec<Obj> = siblings.into_iter().chain(direct).cloned().collect();
        for d in &out {
            n.insert(uuid(d).to_owned());
        }
        total += out.len();
        inserts.insert(o[c].clone(), out);
    }
    if total == 0 {
        return t;
    }
    let mut b = Vec::with_capacity(t.len() + total);
    for x in t {
        let extra = inserts.remove(uuid(&x));
        b.push(x);
        if let Some(extra) = extra {
            b.extend(extra);
        }
    }
    b
}

// ---------- 4. trailing queued commands ----------

/// `Mve`
fn trailing_queued(e: &[Obj], chain: &[Obj], leaf: Option<&Obj>) -> Vec<Obj> {
    let Some(leaf) = leaf else { return vec![] };
    let mut kids: HashMap<&str, Vec<&Obj>> = HashMap::new();
    for d in e {
        if let Some(p) = parent(d)
            && !is_turn(d)
        {
            kids.entry(p).or_default().push(d);
        }
    }
    let mut s_: HashSet<String> = chain.iter().map(|c| uuid(c).to_owned()).collect();
    let by_id: HashMap<&str, &Obj> = e.iter().map(|d| (uuid(d), d)).collect();
    let mut ancestors: HashSet<String> = HashSet::new();
    for d in e {
        if is_turn(d)
            && !truthy(d, "isSidechain")
            && !truthy(d, "teamName")
            && !s_.contains(uuid(d))
        {
            let mut p = parent(d).and_then(|p| by_id.get(p).copied());
            while let Some(pp) = p {
                if s_.contains(uuid(pp)) || ancestors.contains(uuid(pp)) {
                    break;
                }
                ancestors.insert(uuid(pp).to_owned());
                p = parent(pp).and_then(|q| by_id.get(q).copied());
            }
        }
    }
    let mut out = Vec::new();
    let mut stack: Vec<(&Obj, bool)> = vec![(leaf, true)];
    while let Some((d, is_leaf)) = stack.pop() {
        if !is_leaf {
            if s_.contains(uuid(d)) {
                continue;
            }
            s_.insert(uuid(d).to_owned());
            let is_q = ty(d) == Some("attachment")
                && d.get("attachment")
                    .and_then(|a| a.get("type"))
                    .and_then(Value::as_str)
                    == Some("queued_command");
            if is_q && !ancestors.contains(uuid(d)) {
                out.push(d.clone());
            }
        }
        let mut f: Vec<&Obj> = kids.get(uuid(d)).cloned().unwrap_or_default();
        if f.len() > 1 {
            f.sort_by(|a, b| ts(a).cmp(ts(b)));
        }
        for k in f.iter().rev() {
            if !s_.contains(uuid(k)) {
                stack.push((k, false));
            }
        }
    }
    out
}

// ---------- 5. SA ----------

/// `TN` — local-command tag kind of the last text.
fn local_command_kind(o: &Obj) -> Option<&'static str> {
    let content = o.get("message")?.get("content")?;
    let text = match content {
        Value::Array(a) => a
            .iter()
            .rev()
            .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))?
            .get("text")?
            .as_str()?,
        Value::String(s) => s.as_str(),
        _ => return None,
    };
    [
        ("<command-name>", "record"),
        ("<local-command-stdout>", "output"),
        ("<local-command-stderr>", "output"),
        ("<local-command-caveat>", "caveat"),
    ]
    .iter()
    .find(|(p, _)| text.starts_with(p))
    .map(|(_, k)| *k)
}

/// `Pve` — indices of completed local-command records/outputs.
fn completed_local_commands(e: &[Obj]) -> HashSet<usize> {
    let kind = |r: &Obj| {
        if r.get("promptSource").is_none() {
            local_command_kind(r)
        } else {
            None
        }
    };
    let mut t = HashSet::new();
    for (o, r) in e.iter().enumerate() {
        if ty(r) != Some("user") || !truthy(r, "isMeta") || kind(r) != Some("caveat") {
            continue;
        }
        let mut seen_record = false;
        for (i, a) in e.iter().enumerate().skip(o + 1) {
            if ty(a) == Some("assistant") {
                break;
            }
            if ty(a) != Some("user") || truthy(a, "isMeta") {
                continue;
            }
            let l = kind(a);
            if l == Some("record") && !seen_record {
                seen_record = true;
            } else if l != Some("output") || !seen_record {
                break;
            }
            t.insert(i);
        }
    }
    t
}

/// `kve` — is each entry followed by a reply before the next prompt?
fn followed_by_reply(e: &[Obj], completed: &HashSet<usize>) -> Vec<bool> {
    let mut out = vec![false; e.len()];
    let mut state: Option<&str> = None;
    for i in (0..e.len()).rev() {
        let x = &e[i];
        out[i] = state == Some("reply");
        if ty(x) == Some("assistant") || is_tool_result_user(x) || is_interrupt_user(x) {
            state = Some("reply");
        } else if ty(x) == Some("user")
            && !truthy(x, "isMeta")
            && !truthy(x, "isCompactSummary")
            && !completed.contains(&i)
        {
            state = Some("prompt");
        }
    }
    out
}

/// `Ive` — delivery-map verdicts per index.
fn delivery_verdicts(e: &[Obj], delivered: &HashMap<String, i64>) -> HashMap<usize, bool> {
    let mut out = HashMap::new();
    if delivered.is_empty() {
        return out;
    }
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (idx, x) in e.iter().enumerate() {
        let key = queued_attr(x, "delivery_id")
            .map(|d| format!("delivery:{d}"))
            .or_else(|| queued_attr(x, "source_uuid").map(|u| format!("uuid:{u}")));
        let Some(key) = key.filter(|k| delivered.contains_key(k)) else {
            continue;
        };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, v)) => v.push(idx),
            None => groups.push((key, vec![idx])),
        }
    }
    for (key, idxs) in groups {
        if key.starts_with("delivery:") {
            for a in idxs {
                out.insert(a, delivered.contains_key(&format!("entry:{}", uuid(&e[a]))));
            }
            continue;
        }
        let count = delivered[&key];
        let len = idxs.len() as i64;
        for (l, a) in idxs.into_iter().enumerate() {
            out.insert(a, l as i64 >= len - count);
        }
    }
    out
}

/// `Dve` + `CN` + `WI` — turn a delivered queued_command into a user message.
fn synthesize_queued(
    x: &Obj,
    delivered: bool,
    uuids: &mut HashSet<String>,
    keep_meta: bool,
) -> Obj {
    if !delivered || ty(x) != Some("attachment") {
        return x.clone();
    }
    let Some(att) = x.get("attachment").and_then(Value::as_object) else {
        return x.clone();
    };
    let origin = att
        .get("origin")
        .filter(|o| o.get("kind").is_some_and(Value::is_string));
    let prompt = att.get("prompt");
    if att.get("type").and_then(Value::as_str) != Some("queued_command")
        || (truthy(att, "isMeta") && !keep_meta && !origin_keeps_meta(origin))
        || !prompt.is_some_and(|p| p.is_string() || p.is_array())
    {
        return x.clone();
    }
    // `bN`: forwarded intents are not shown.
    if att
        .get("forwardedIntent")
        .and_then(|f| f.get("lineage"))
        .and_then(Value::as_str)
        .is_some_and(|l| !l.is_empty())
    {
        return x.clone();
    }
    let new_uuid = att
        .get("source_uuid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(uuid(x))
        .to_owned();
    let command_mode = att.get("commandMode").and_then(Value::as_str);
    let mut norm_origin = origin.map(normalize_origin);
    if norm_origin.is_none() && command_mode == Some("task-notification") {
        norm_origin = Some(json!({"kind": "task-notification"}));
    }
    if let Some(run) = valid_run_id(att.get("runId"))
        && let Some(Value::Object(o)) = &mut norm_origin
        && o.get("kind").and_then(Value::as_str) == Some("task-notification")
        && !o.contains_key("runId")
    {
        o.insert("runId".into(), json!(run));
    }
    if new_uuid != uuid(x) && uuids.contains(&new_uuid) {
        return x.clone();
    }
    uuids.insert(new_uuid.clone());
    let mut m = Obj::new();
    m.insert("type".into(), json!("user"));
    m.insert("uuid".into(), json!(new_uuid));
    for k in ["parentUuid", "sessionId", "timestamp"] {
        if let Some(v) = x.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    m.insert(
        "message".into(),
        json!({"role": "user", "content": prompt.unwrap()}),
    );
    m.insert("isMeta".into(), json!(truthy(att, "isMeta")));
    if let Some(o) = norm_origin {
        m.insert("origin".into(), o);
    }
    m.insert("isQueuedCommand".into(), json!(true));
    for k in ["isSidechain", "teamName"] {
        if let Some(v) = x.get(k) {
            m.insert(k.into(), v.clone());
        }
    }
    m
}

// ---------- public pipeline ----------

/// Full `getSessionMessages` pipeline over raw JSONL text.
pub fn session_messages(text: &str, include_system: bool) -> Vec<Value> {
    let Parsed { entries, delivered } = parse(text);
    let Chain {
        messages: chain,
        leaf,
        ..
    } = resolve_chain(&entries);
    let trailing = trailing_queued(&entries, &chain, leaf.as_ref());
    let trailing_ids: HashSet<String> = trailing.iter().map(|t| uuid(t).to_owned()).collect();
    let mut all = chain;
    all.extend(trailing);

    // SA
    let completed = completed_local_commands(&all);
    let replied = followed_by_reply(&all, &completed);
    let verdicts = delivery_verdicts(&all, &delivered);
    let mut uuids: HashSet<String> = all.iter().map(|x| uuid(x).to_owned()).collect();
    let synthesized: Vec<Obj> = all
        .iter()
        .enumerate()
        .map(|(c, x)| {
            if completed.contains(&c) {
                let mut y = x.clone();
                y.insert("isCompletedLocalCommand".into(), json!(true));
                return y;
            }
            let delivered = verdicts
                .get(&c)
                .copied()
                .unwrap_or(replied[c] || trailing_ids.contains(uuid(x)));
            synthesize_queued(x, delivered, &mut uuids, false)
        })
        .collect();

    synthesized
        .into_iter()
        .filter(|x| {
            // Lve
            let kind_ok = is_turn(x) || (ty(x) == Some("system") && include_system);
            kind_ok
                && !(truthy(x, "isMeta")
                    && !origin_keeps_meta(x.get("origin").filter(|o| !o.is_null())))
                && !truthy(x, "isSidechain")
                && !truthy(x, "teamName")
        })
        .map(|x| {
            // EA
            let mut m = Obj::new();
            m.insert("type".into(), x.get("type").cloned().unwrap_or(Value::Null));
            m.insert("uuid".into(), x.get("uuid").cloned().unwrap_or(Value::Null));
            if let Some(v) = x.get("sessionId") {
                m.insert("session_id".into(), v.clone());
            }
            if let Some(v) = x.get("message") {
                m.insert("message".into(), v.clone());
            }
            m.insert("parent_tool_use_id".into(), Value::Null);
            m.insert("parent_agent_id".into(), Value::Null);
            if is_true(&x, "interruptedByShutdown") {
                m.insert("interruptedByShutdown".into(), json!(true));
            }
            if s(&x, "toolDenialUnanswered") == Some("stream-closed") {
                m.insert("toolDenialUnanswered".into(), json!("stream-closed"));
            }
            if is_true(&x, "isCompactSummary") {
                m.insert("isCompactSummary".into(), json!(true));
            }
            if is_true(&x, "isMeta")
                || is_true(&x, "isCompactSummary")
                || is_true(&x, "isVisibleInTranscriptOnly")
            {
                m.insert("is_meta".into(), json!(true));
            }
            if is_true(&x, "isQueuedCommand") {
                m.insert("isQueuedCommand".into(), json!(true));
            }
            if is_true(&x, "isCompletedLocalCommand") {
                m.insert("isCompletedLocalCommand".into(), json!(true));
            }
            if let Some(v) = x.get("timestamp") {
                m.insert("timestamp".into(), v.clone());
            }
            if let Some(o) = x.get("origin").filter(|o| !o.is_null()) {
                let n = normalize_origin(o);
                let truthy_origin = !matches!(n, Value::Null | Value::Bool(false))
                    && !(n.is_string() && n.as_str() == Some(""))
                    && !(n.is_number() && n.as_f64() == Some(0.0));
                if truthy_origin {
                    m.insert("origin".into(), n);
                }
            }
            Value::Object(m)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn parallel_tool_results_are_spliced() {
        // assistant message `m1` split into two entries (two tool_uses);
        // results hang off each; the chain walk only follows one.
        let lines = [
            json!({"type":"user","uuid":"u0","parentUuid":null,"sessionId":"s","timestamp":"1","message":{"role":"user","content":"go"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u0","timestamp":"2","message":{"id":"m1","content":[{"type":"tool_use","id":"t1"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"a1","timestamp":"3","message":{"id":"m1","content":[{"type":"tool_use","id":"t2"}]}}),
            json!({"type":"user","uuid":"r1","parentUuid":"a1","timestamp":"4","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}),
            json!({"type":"user","uuid":"r2","parentUuid":"a2","timestamp":"5","message":{"content":[{"type":"tool_result","tool_use_id":"t2"}]}}),
            json!({"type":"assistant","uuid":"a3","parentUuid":"r2","timestamp":"6","message":{"id":"m2","content":[{"type":"text","text":"done"}]}}),
        ];
        let text = lines
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let ids: Vec<String> = session_messages(&text, false)
            .iter()
            .map(|m| m["uuid"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, vec!["u0", "a1", "a2", "r1", "r2", "a3"]);
    }

    #[test]
    fn delivered_queued_command_becomes_user_message() {
        let lines = [
            json!({"type":"user","uuid":"u0","parentUuid":null,"timestamp":"1","message":{"role":"user","content":"go"}}),
            json!({"type":"attachment","uuid":"q1","parentUuid":"u0","timestamp":"2","attachment":{"type":"queued_command","prompt":"also this"}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"q1","timestamp":"3","message":{"id":"m1","content":[{"type":"text","text":"ok"}]}}),
        ];
        let text = lines
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let out = session_messages(&text, false);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1]["isQueuedCommand"], true);
        assert_eq!(out[1]["message"]["content"], "also this");
        let _ = obj(json!({}));
    }
}
