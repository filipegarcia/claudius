//! `forkSession` core: SDK 0.3.299's `tTe` (load) + `WU` (build entries) +
//! `aTe`/`kA`/`HU` (compaction-aware slicing) + `lTe`/`cTe` (uuid rewrites).
//! Minified names are in brackets so the next SDK bump can be diffed function
//! by function. The file lookup, title and write live in
//! [`crate::sessions_store::fork`].
//!
//! A fork copies the main transcript into a new session. Every message gets a
//! fresh uuid, the parent chain is kept (progress entries are dropped and
//! bridged over), the copy is optionally sliced at `upToMessageId`, and
//! trailer entries are appended (content replacements, ATIS latch, relocated
//! cwd, a `custom-title`).

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::transcript::{Obj, resolve_chain};

/// Entry types kept as transcript messages (`eTe`).
const TRANSCRIPT_TYPES: [&str; 5] = ["user", "assistant", "attachment", "system", "progress"];

/// `GU`, minus `isSidechain: false`: keys a fork sets to `undefined`, which
/// `JSON.stringify` drops.
const RESET_KEYS: [&str; 7] = [
    "teamName",
    "agentName",
    "sessionKind",
    "slug",
    "sourceToolAssistantUUID",
    "summarizedTurnPromptUuids",
    "droppedPromptUuids",
];

/// What `tTe` pulls out of a source transcript.
#[derive(Debug, Default)]
pub struct Loaded {
    pub transcript: Vec<Obj>,
    pub content_replacements: Vec<Value>,
    pub relocated_cwd: Option<String>,
    pub history_suppressed: bool,
    pub atis_latch: Option<String>,
}

fn str_field<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}
fn uuid(o: &Obj) -> &str {
    str_field(o, "uuid").unwrap_or_default()
}
fn ty(o: &Obj) -> Option<&str> {
    str_field(o, "type")
}
/// `e.parentUuid ? … : undefined`
fn parent(o: &Obj) -> Option<&str> {
    str_field(o, "parentUuid").filter(|p| !p.is_empty())
}
fn truthy(o: &Obj, k: &str) -> bool {
    o.get(k).is_some_and(claudius_agent::js::truthy)
}
fn is_system(o: &Obj, subtype: &str) -> bool {
    ty(o) == Some("system") && str_field(o, "subtype") == Some(subtype)
}

/// `tTe(buf, sessionId)`: one JSON value per line (leading bytes <= 0x20
/// skipped, unparseable lines ignored), routed like `jU`.
pub fn load(buf: &[u8], session_id: &str) -> Loaded {
    let mut out = Loaded::default();
    for raw in buf.split(|b| *b == b'\n') {
        let Some(start) = raw.iter().position(|b| *b > 32) else {
            continue;
        };
        let line = String::from_utf8_lossy(&raw[start..]);
        let Ok(Value::Object(e)) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let same_session = str_field(&e, "sessionId") == Some(session_id);
        match ty(&e) {
            Some(t)
                if TRANSCRIPT_TYPES.contains(&t) && e.get("uuid").is_some_and(Value::is_string) =>
            {
                out.transcript.push(e);
            }
            Some("history-suppression") => out.history_suppressed = true,
            Some("atis-latch") if same_session => {
                // `/^[\x21-\x7e]*$/`
                if let Some(a) =
                    str_field(&e, "atis").filter(|a| a.bytes().all(|b| (0x21..=0x7e).contains(&b)))
                {
                    out.atis_latch = Some(a.to_owned());
                }
            }
            Some("content-replacement") if same_session => {
                if let Some(Value::Array(r)) = e.get("replacements") {
                    out.content_replacements.extend(r.iter().cloned());
                }
            }
            Some("relocated") if same_session => {
                if let Some(cwd) = str_field(&e, "relocatedCwd").filter(|c| !c.is_empty()) {
                    out.relocated_cwd = Some(cwd.to_owned());
                }
            }
            _ => {}
        }
    }
    out
}

/// `Ru(e)`: a `queued_command` attachment's non-empty `source_uuid`.
fn source_uuid(e: &Obj) -> Option<&str> {
    if ty(e) != Some("attachment") {
        return None;
    }
    let att = e.get("attachment")?.as_object()?;
    if att.get("type").and_then(Value::as_str) != Some("queued_command") {
        return None;
    }
    att.get("source_uuid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// `dA(list, id)`: index by `uuid`, else by queued-command `source_uuid`.
fn find_index(list: &[&Obj], id: &str) -> Option<usize> {
    list.iter()
        .position(|e| uuid(e) == id)
        .or_else(|| list.iter().position(|e| source_uuid(e) == Some(id)))
}

/// First index of each uuid (`if (!m.has(uuid)) m.set(uuid, i)`).
fn first_index(list: &[Obj]) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    for (i, e) in list.iter().enumerate() {
        m.entry(uuid(e).to_owned()).or_insert(i);
    }
    m
}

/// `{...e, ...GU}`
fn reset(e: &Obj) -> Obj {
    let mut o = e.clone();
    o.insert("isSidechain".into(), Value::Bool(false));
    for k in RESET_KEYS {
        o.shift_remove(k);
    }
    o
}

/// `iTe`: the uuids a compact boundary preserves.
fn preserved_uuids(b: &Obj) -> Vec<&str> {
    let Some(meta) = b.get("compactMetadata").and_then(Value::as_object) else {
        return vec![];
    };
    let mut out: Vec<&str> = meta
        .get("preservedMessages")
        .and_then(Value::as_object)
        .and_then(|pm| pm.get("uuids"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if let Some(seg) = meta.get("preservedSegment").and_then(Value::as_object) {
        out.extend(
            ["headUuid", "tailUuid"]
                .iter()
                .filter_map(|k| seg.get(*k).and_then(Value::as_str)),
        );
    }
    out
}

/// The `aTe` working state (`{slice, byUuid, live, index, start, leftOut}`).
struct Slice<'a> {
    slice: &'a [Obj],
    by_uuid: HashMap<&'a str, &'a Obj>,
    live: HashSet<&'a str>,
    index: HashMap<String, usize>,
    start: usize,
    left_out: HashSet<String>,
}

impl Slice<'_> {
    /// `kA`: not on a live path, and not before the chain's first entry.
    fn droppable(&self, id: &str) -> bool {
        !self.live.contains(id) && self.index.get(id).copied().unwrap_or(self.start) >= self.start
    }

    /// `HU`: drop a dead branch from `id` towards the root, then (one forward
    /// pass in file order) everything parented on a dropped entry.
    fn leave_out(&mut self, id: &str) {
        let mut cur = self.by_uuid.get(id).copied();
        while let Some(e) = cur {
            if !self.droppable(uuid(e)) || self.left_out.contains(uuid(e)) {
                break;
            }
            self.left_out.insert(uuid(e).to_owned());
            cur = parent(e).and_then(|p| self.by_uuid.get(p).copied());
        }
        for e in self.slice {
            if parent(e).is_some_and(|p| self.left_out.contains(p)) {
                self.left_out.insert(uuid(e).to_owned());
            }
        }
    }
}

/// `aTe(slice)`: drop branches that a slice ending mid-transcript leaves
/// dead, so they aren't copied into the fork: compact boundaries off the
/// live path, and whatever made the resolved chain differ from the one that
/// ends at the slice's last entry.
fn prune_slice(e: Vec<Obj>, new_uuid: &mut dyn FnMut() -> String) -> Vec<Obj> {
    let Some(last) = e.last() else {
        return e;
    };
    let reset_all: Vec<Obj> = e.iter().map(reset).collect();
    let mut probe_input = reset_all.clone();
    let mut probe = Obj::new();
    probe.insert("type".into(), json!("system"));
    probe.insert("uuid".into(), json!(new_uuid()));
    probe.insert("parentUuid".into(), json!(uuid(last)));
    for k in ["sessionId", "timestamp"] {
        if let Some(v) = last.get(k) {
            probe.insert(k.into(), v.clone());
        }
    }
    probe_input.push(probe);
    let chain = resolve_chain(&probe_input).messages;
    let index = first_index(&e);
    let Some(start) = chain.first().and_then(|r0| index.get(uuid(r0)).copied()) else {
        return e;
    };
    let chain_ids: Vec<String> = chain.iter().map(|c| uuid(c).to_owned()).collect();
    let chain_set: HashSet<&str> = chain_ids.iter().map(String::as_str).collect();

    let mut by_uuid: HashMap<&str, &Obj> = HashMap::new();
    for x in &e {
        by_uuid.insert(uuid(x), x);
    }
    let mut live: HashSet<&str> = HashSet::new();
    for start_id in std::iter::once(uuid(last)).chain(chain_ids.iter().map(String::as_str)) {
        let mut cur = by_uuid.get(start_id).copied();
        while let Some(x) = cur {
            if !live.insert(uuid(x)) {
                break;
            }
            cur = parent(x).and_then(|p| by_uuid.get(p).copied());
        }
    }
    let mut st = Slice {
        slice: &e,
        by_uuid,
        live,
        index,
        start,
        left_out: HashSet::new(),
    };
    for b in &e {
        if is_system(b, "compact_boundary")
            && st.droppable(uuid(b))
            && !preserved_uuids(b).iter().any(|u| st.live.contains(u))
        {
            st.leave_out(uuid(b));
        }
    }
    loop {
        let kept: Vec<Obj> = reset_all
            .iter()
            .filter(|m| !st.left_out.contains(uuid(m)))
            .cloned()
            .collect();
        let found = resolve_chain(&kept);
        if found.messages.len() == chain_set.len()
            && found.messages.iter().all(|m| chain_set.contains(uuid(m)))
        {
            break;
        }
        let Some(terminal) = found.terminal else {
            break;
        };
        if !st.droppable(uuid(&terminal)) {
            break;
        }
        let before = st.left_out.len();
        st.leave_out(uuid(&terminal));
        // Can't happen (the terminal came from the kept set, so it's new),
        // but never spin.
        if st.left_out.len() == before {
            break;
        }
    }
    let left_out = st.left_out;
    if left_out.is_empty() {
        e
    } else {
        e.into_iter()
            .filter(|x| !left_out.contains(uuid(x)))
            .collect()
    }
}

/// `cTe`: a `deferred_tools_record` attachment's `nameOnlyAnnouncements`
/// mapped to the new uuids (unknown and non-string entries dropped).
fn remap_deferred_tools(e: &Obj, ids: &HashMap<String, String>) -> Option<Value> {
    if ty(e) != Some("attachment") {
        return None;
    }
    let att = e.get("attachment")?.as_object()?;
    if att.get("type").and_then(Value::as_str) != Some("deferred_tools_record") {
        return None;
    }
    let Some(Value::Array(list)) = att.get("nameOnlyAnnouncements") else {
        return None;
    };
    let mapped: Vec<Value> = list
        .iter()
        .filter_map(|o| o.as_str().and_then(|s| ids.get(s)).map(|n| json!(n)))
        .collect();
    let mut att = att.clone();
    att.insert("nameOnlyAnnouncements".into(), Value::Array(mapped));
    Some(Value::Object(att))
}

/// `lTe`: a system entry's `compactMetadata` with preserved uuids mapped to
/// the new ones (unknown strings kept) and `runningTurnSends` dropped. The
/// rest keeps its order; `preservedMessages` / `preservedSegment` move last.
fn remap_compact_metadata(e: &Obj, ids: &HashMap<&str, &str>) -> Option<Value> {
    if ty(e) != Some("system") {
        return None;
    }
    let meta = e.get("compactMetadata")?.as_object()?;
    let (pm, seg) = (meta.get("preservedMessages"), meta.get("preservedSegment"));
    if pm.is_none() && seg.is_none() && !meta.contains_key("runningTurnSends") {
        return None;
    }
    let map_one = |v: &Value| match v {
        Value::String(s) => json!(ids.get(s.as_str()).copied().unwrap_or(s)),
        other => other.clone(),
    };
    let rewrite = |v: &Value, keys: &[&str]| -> Value {
        let Value::Object(o) = v else {
            return v.clone();
        };
        let mut o = o.clone();
        for k in keys {
            if let Some(cur) = o.get(*k) {
                let next = match cur {
                    Value::Array(a) => Value::Array(a.iter().map(map_one).collect()),
                    other => map_one(other),
                };
                o.insert((*k).into(), next);
            }
        }
        Value::Object(o)
    };
    let mut out: Obj = meta
        .iter()
        .filter(|(k, _)| {
            !matches!(
                k.as_str(),
                "preservedMessages" | "preservedSegment" | "runningTurnSends"
            )
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(pm) = pm {
        out.insert(
            "preservedMessages".into(),
            rewrite(pm, &["anchorUuid", "uuids", "allUuids"]),
        );
    }
    if let Some(seg) = seg {
        out.insert(
            "preservedSegment".into(),
            rewrite(seg, &["headUuid", "anchorUuid", "tailUuid"]),
        );
    }
    Some(Value::Object(out))
}

/// Inputs to [`build`] besides the loaded transcript.
pub struct ForkRequest<'a> {
    pub session_id: &'a str,
    pub up_to_message_id: Option<&'a str>,
    pub title: Option<&'a str>,
    /// `new Date().toISOString()` for this fork.
    pub now: String,
}

/// `WU`: the forked session's entries and its new id. `derive_title` is only
/// called when `title` is missing or blank.
pub fn build(
    loaded: &Loaded,
    req: &ForkRequest<'_>,
    derive_title: impl FnOnce() -> String,
    new_uuid: &mut dyn FnMut() -> String,
) -> anyhow::Result<(Vec<Value>, String)> {
    let sid = req.session_id;
    let no_messages = || anyhow::anyhow!("Session {sid} has no messages to fork");
    let mut o: Vec<Obj> = loaded
        .transcript
        .iter()
        .filter(|g| !truthy(g, "isSidechain"))
        .cloned()
        .collect();
    if o.is_empty() {
        return Err(no_messages());
    }
    if let Some(target) = req.up_to_message_id.filter(|s| !s.is_empty()) {
        let chain = resolve_chain(&o).messages;
        let index = first_index(&o);
        let after_chain = chain
            .iter()
            .filter_map(|c| index.get(uuid(c)))
            .map(|i| i + 1)
            .max()
            .unwrap_or(0);
        let search: Vec<&Obj> = chain.iter().chain(&o[after_chain..]).collect();
        let at = match find_index(&search, target) {
            Some(i) => index.get(uuid(search[i])).copied(),
            None => find_index(&o.iter().collect::<Vec<_>>(), target),
        };
        let Some(at) = at else {
            anyhow::bail!("Message {target} not found in session {sid}");
        };
        o.truncate(at + 1);
        o = prune_slice(o, new_uuid);
    }

    let mut ids: HashMap<String, String> = HashMap::new();
    for g in &o {
        ids.insert(uuid(g).to_owned(), new_uuid());
    }
    let kept: Vec<&Obj> = o.iter().filter(|g| ty(g) != Some("progress")).collect();
    if kept.is_empty() {
        return Err(no_messages());
    }
    let kept_ids: HashMap<&str, &str> = kept
        .iter()
        .map(|g| (uuid(g), ids[uuid(g)].as_str()))
        .collect();
    let mut by_uuid: HashMap<&str, &Obj> = HashMap::new();
    for g in &o {
        by_uuid.insert(uuid(g), g);
    }

    let fork_id = new_uuid();
    let now = &req.now;
    let mut out: Vec<Value> = Vec::new();
    if loaded.history_suppressed {
        out.push(json!({"type": "history-suppression", "sessionId": fork_id, "cause": "fork_inherit", "ts": now}));
    }
    for (n, e) in kept.iter().enumerate() {
        // Nearest non-progress ancestor; a progress-only cycle maps to the
        // repeated entry's (unwritten) new id, like the SDK.
        let mut parent_id = Value::Null;
        let mut cursor = parent(e);
        let mut seen: Option<HashSet<&str>> = None;
        while let Some(pid) = cursor {
            let Some(r) = by_uuid.get(pid) else {
                break;
            };
            if ty(r) != Some("progress") {
                parent_id = ids.get(pid).map_or(Value::Null, |n| json!(n));
                break;
            }
            let seen = seen.get_or_insert_with(HashSet::new);
            if !seen.insert(uuid(r)) {
                parent_id = ids.get(uuid(r)).map_or(Value::Null, |n| json!(n));
                break;
            }
            cursor = parent(r);
        }
        let logical = match e.get("logicalParentUuid") {
            None => None,
            Some(Value::Null) => Some(Value::Null),
            Some(v) => Some(
                v.as_str()
                    .and_then(|s| ids.get(s))
                    .map_or(Value::Null, |n| json!(n)),
            ),
        };

        let mut de = (*e).clone();
        if is_system(e, "model_refusal_fallback") {
            de.insert("neutralizedByFork".into(), Value::Bool(true));
        }
        if let Some(att) = remap_deferred_tools(e, &ids) {
            de.insert("attachment".into(), att);
        }
        if let Some(meta) = remap_compact_metadata(e, &kept_ids) {
            de.insert("compactMetadata".into(), meta);
        }
        if let Some(new_source) = source_uuid(e).and_then(|s| ids.get(s)) {
            let mut att = e
                .get("attachment")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            att.insert("source_uuid".into(), json!(new_source));
            de.insert("attachment".into(), Value::Object(att));
        }
        de.insert("uuid".into(), json!(ids[uuid(e)]));
        de.insert("parentUuid".into(), parent_id);
        match logical {
            Some(v) => {
                de.insert("logicalParentUuid".into(), v);
            }
            None => {
                de.shift_remove("logicalParentUuid");
            }
        }
        de.insert("sessionId".into(), json!(fork_id));
        if n == kept.len() - 1 {
            de.insert("timestamp".into(), json!(now));
        }
        de.insert("isSidechain".into(), Value::Bool(false));
        for k in RESET_KEYS {
            de.shift_remove(k);
        }
        de.insert(
            "forkedFrom".into(),
            json!({"sessionId": sid, "messageUuid": uuid(e)}),
        );
        out.push(Value::Object(de));
    }
    if !loaded.content_replacements.is_empty() {
        out.push(json!({"type": "content-replacement", "sessionId": fork_id,
                        "replacements": loaded.content_replacements, "uuid": new_uuid(), "timestamp": now}));
    }
    if let Some(atis) = &loaded.atis_latch {
        out.push(json!({"type": "atis-latch", "sessionId": fork_id, "atis": atis}));
    }
    if let Some(cwd) = &loaded.relocated_cwd {
        out.push(json!({"type": "relocated", "sessionId": fork_id, "relocatedCwd": cwd}));
    }
    let title = match req
        .title
        .map(claudius_agent::js::trim)
        .filter(|t| !t.is_empty())
    {
        Some(t) => t.to_owned(),
        None => {
            let derived = derive_title();
            let base = if derived.is_empty() {
                "Forked session"
            } else {
                derived.as_str()
            };
            format!("{base} (fork)")
        }
    };
    out.push(
        json!({"type": "custom-title", "sessionId": fork_id, "customTitle": title,
                    "uuid": new_uuid(), "timestamp": now}),
    );
    Ok((out, fork_id))
}
