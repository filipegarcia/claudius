//! `lib/client/system-entries.ts`: appending a transient system pill
//! (`init` / `status`), a run of identical ones folded into one with a
//! `×N` count.

use crate::types::SystemEntry;

/// `appendCoalescedSystemEntry(prev, incoming)`: the first entry with the
/// same `kind`, `label` and `afterMessageUuid` counts one more (`count`
/// absent reads as 1); with none, `incoming` is appended.
pub fn append_coalesced_system_entry(entries: &mut Vec<SystemEntry>, incoming: SystemEntry) {
    let same = |e: &SystemEntry| {
        e.kind == incoming.kind
            && e.label == incoming.label
            && e.after_message_uuid == incoming.after_message_uuid
    };
    match entries.iter_mut().find(|e| same(e)) {
        Some(e) => e.count = Some(e.count.unwrap_or(1.0) + 1.0),
        None => entries.push(incoming),
    }
}
