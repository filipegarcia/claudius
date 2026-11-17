//! `lib/client/prompt-queue.ts`: the FIFO queues of the prompts the agent
//! is blocked on (permission requests, AskUserQuestion forms, MCP
//! elicitations). The oldest shows first; a prompt the server re-emits
//! keeps its place.
//!
//! Each helper changes the queue in place and returns whether it did. One
//! difference from the TS: `enqueuePrompt` hands back the same array when
//! the very object already queued is enqueued again (`===`), which an
//! event off the wire never is, so here a queued id is always replaced.

use indexmap::IndexSet;

/// `{ requestId: string }`: what the queues key on.
pub trait Keyed {
    fn request_id(&self) -> &str;
}

/// `enqueuePrompt(queue, item)`: appended, or replacing the queued prompt
/// with the same `requestId` in its place.
pub fn enqueue_prompt<T: Keyed>(queue: &mut Vec<T>, item: T) -> bool {
    match queue
        .iter()
        .position(|q| q.request_id() == item.request_id())
    {
        Some(idx) => queue[idx] = item,
        None => queue.push(item),
    }
    true
}

/// `dropPrompt(queue, requestId)`: every prompt with that id removed.
pub fn drop_prompt<T: Keyed>(queue: &mut Vec<T>, request_id: &str) -> bool {
    let before = queue.len();
    queue.retain(|q| q.request_id() != request_id);
    queue.len() != before
}

/// `mergeServerPrompts(local, server, gone)`: each server prompt (oldest
/// first) this tab neither has nor saw settle (`gone`) is appended, once.
pub fn merge_server_prompts<T: Keyed + Clone>(
    local: &mut Vec<T>,
    server: &[T],
    gone: &IndexSet<String>,
) -> bool {
    let mut changed = false;
    for s in server {
        let id = s.request_id();
        if gone.contains(id) || local.iter().any(|l| l.request_id() == id) {
            continue;
        }
        local.push(s.clone());
        changed = true;
    }
    changed
}
