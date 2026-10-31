//! The session's MCP notices (S15b): `noteMcpNeedsAuthAtStartup`,
//! `noteMcpDisconnectedAtStartup`, `recheckMcpStatusMidSession` and
//! `mcpRecheckDue` (lib/server/session.ts), over the per-cwd "already
//! announced" tables of `mcp-needs-auth-db.ts` and `mcp-disconnected-db.ts`
//! (migrations 021 and 023).
//!
//! On the first live `system/init` a session asks the CLI for its MCP status
//! twice at once, one request per check as in TS, and announces the servers
//! in `needs-auth` (`mcp_needs_auth_notice`) and in `failed`
//! (`mcp_disconnected_notice`) that this cwd hasn't been told about yet. At
//! every turn's `result` it re-runs both checks, one after the other, at most
//! once per [`MCP_RECHECK_INTERVAL_MS`]. Each check is best effort: a failed
//! status request, a reply without a server list or a database error
//! announces nothing.

use std::collections::HashSet;
use std::future::Future;
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use rusqlite::params;
use rusqlite::types::Value as SqlValue;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::db::{Mode, open_db};
use crate::session::Session;

/// `mcpRecheckDue`'s default `intervalMs`.
pub const MCP_RECHECK_INTERVAL_MS: f64 = 30_000.0;

/// `mcpRecheckDue(now, lastAt, intervalMs)`: whether a mid-session re-check
/// is due (JS number arithmetic: NaN is never due).
pub fn mcp_recheck_due(now: f64, last_at: f64, interval_ms: f64) -> bool {
    now - last_at >= interval_ms
}

/// The two notices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpNotice {
    /// `needs-auth` → `mcp_needs_auth_notice` (`mcp-needs-auth-db.ts`).
    NeedsAuth,
    /// `failed` → `mcp_disconnected_notice` (`mcp-disconnected-db.ts`).
    Disconnected,
}

impl McpNotice {
    /// The order the re-check runs them in.
    pub const ALL: [McpNotice; 2] = [McpNotice::NeedsAuth, McpNotice::Disconnected];

    /// The server status this notice announces.
    pub fn status(self) -> &'static str {
        match self {
            McpNotice::NeedsAuth => "needs-auth",
            McpNotice::Disconnected => "failed",
        }
    }

    pub fn event_type(self) -> &'static str {
        match self {
            McpNotice::NeedsAuth => "mcp_needs_auth_notice",
            McpNotice::Disconnected => "mcp_disconnected_notice",
        }
    }

    /// The "already announced" table.
    pub fn table(self) -> &'static str {
        match self {
            McpNotice::NeedsAuth => "mcp_needs_auth_notified",
            McpNotice::Disconnected => "mcp_disconnected_notified",
        }
    }
}

/// The servers a status reply (`mcpServerStatus()`'s data) shows in
/// `kind`'s status, in order and with duplicates; an entry without a string
/// `name` is `"unknown"`. `None` when the reply isn't a list: TS returns
/// there, before the database.
pub fn servers_in_status(kind: McpNotice, data: &Value) -> Option<Vec<String>> {
    let entries = data.as_array()?;
    Some(
        entries
            .iter()
            .filter(|s| s.get("status").and_then(Value::as_str) == Some(kind.status()))
            .map(|s| {
                s.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned()
            })
            .collect(),
    )
}

/// `syncNeedsAuthNotifications` / `syncDisconnectedNotifications`: of the
/// servers now in `kind`'s status, the ones this cwd hasn't been told about
/// (duplicates kept), which are recorded as announced at `now`. A server
/// announced before that has left the status is forgotten, so its next
/// episode announces again.
///
/// Fails open: without a database every server counts as unannounced. `Err`
/// when the transaction fails (TS rejects, and nothing is announced).
pub fn sync_notifications(
    kind: McpNotice,
    cwd: &str,
    current: &[String],
    now: i64,
) -> rusqlite::Result<Vec<String>> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Ok(current.to_vec());
    };
    let table = kind.table();
    db.with_mut(|c| {
        let tx = c.transaction()?;
        // A foreign writer can leave a NULL or BLOB name: neither matches a
        // server, and the delete binds it back as it came (a NULL never
        // matches `=`), like better-sqlite3.
        let already: Vec<SqlValue> = {
            let mut q = tx.prepare(&format!("SELECT server_name FROM {table}"))?;
            q.query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let announced: HashSet<&str> = already
            .iter()
            .filter_map(|v| match v {
                SqlValue::Text(s) => Some(s.as_str()),
                _ => None,
            })
            .collect();
        let still: HashSet<&str> = current.iter().map(String::as_str).collect();
        for name in &already {
            if !matches!(name, SqlValue::Text(s) if still.contains(s.as_str())) {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE server_name = ?"),
                    [name],
                )?;
            }
        }
        let to_announce: Vec<String> = current
            .iter()
            .filter(|n| !announced.contains(n.as_str()))
            .cloned()
            .collect();
        for name in &to_announce {
            tx.execute(
                &format!(
                    "INSERT INTO {table}(server_name, notified_at) VALUES (?, ?)
                     ON CONFLICT(server_name) DO UPDATE SET notified_at = excluded.notified_at"
                ),
                params![name, now],
            )?;
        }
        tx.commit()?;
        Ok(to_announce)
    })
}

/// `syncNeedsAuthNotifications(cwd, servers)`.
pub fn sync_needs_auth_notifications(
    cwd: &str,
    servers: &[String],
    now: i64,
) -> rusqlite::Result<Vec<String>> {
    sync_notifications(McpNotice::NeedsAuth, cwd, servers, now)
}

/// `syncDisconnectedNotifications(cwd, servers)`.
pub fn sync_disconnected_notifications(
    cwd: &str,
    servers: &[String],
    now: i64,
) -> rusqlite::Result<Vec<String>> {
    sync_notifications(McpNotice::Disconnected, cwd, servers, now)
}

/// The broadcast event, in the TS key order.
pub fn notice_event(kind: McpNotice, servers: &[String]) -> Value {
    json!({"type": kind.event_type(), "servers": servers})
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// A session's notice state: the startup guard and `lastMcpRecheckAt`, plus
/// two test hooks, the clock and the count of checks still running.
pub struct McpNotices {
    /// `mcpNeedsAuthNoticeFired` and `mcpDisconnectedNoticeFired`, which TS
    /// always trips together.
    startup_fired: AtomicBool,
    /// `lastMcpRecheckAt`, in ms (0 before the first re-check).
    last_recheck_at: Mutex<f64>,
    clock: Mutex<Clock>,
    running: watch::Sender<usize>,
}

impl Default for McpNotices {
    fn default() -> Self {
        McpNotices {
            startup_fired: AtomicBool::new(false),
            last_recheck_at: Mutex::new(0.0),
            clock: Mutex::new(Arc::new(crate::now_ms)),
            running: watch::channel(0).0,
        }
    }
}

/// Counts one check job as running until dropped.
struct Running(watch::Sender<usize>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

impl McpNotices {
    /// Replace `Date.now` for the re-check window and the `notified_at`
    /// stamps (tests).
    pub fn set_clock(&self, clock: impl Fn() -> i64 + Send + Sync + 'static) {
        *self.clock.lock().unwrap() = Arc::new(clock);
    }

    fn now(&self) -> i64 {
        let clock = self.clock.lock().unwrap().clone();
        clock()
    }

    /// Resolves once no check is running (tests). A check counts as running
    /// from the message that starts it, before the session broadcasts the
    /// `system/init` or ends the turn.
    pub async fn settled(&self) {
        let mut rx = self.running.subscribe();
        let _ = rx.wait_for(|n| *n == 0).await;
    }

    fn track(&self) -> Running {
        self.running.send_modify(|n| *n += 1);
        Running(self.running.clone())
    }

    /// The throttle of `recheckMcpStatusMidSession`: due → record now.
    fn take_recheck(&self) -> bool {
        let now = self.now() as f64;
        let mut last = self.last_recheck_at.lock().unwrap();
        if !mcp_recheck_due(now, *last, MCP_RECHECK_INTERVAL_MS) {
            return false;
        }
        *last = now;
        true
    }
}

/// The rest of `runMcpNeedsAuthCheck` / `runMcpDisconnectedCheck`, once the
/// status request has answered.
fn announce(session: &Session, kind: McpNotice, status: Result<Value, String>) {
    let Ok(data) = status else {
        return;
    };
    let Some(names) = servers_in_status(kind, &data) else {
        return;
    };
    let now = session.mcp_notices.now();
    let Ok(to_announce) = sync_notifications(kind, &session.cwd, &names, now) else {
        return;
    };
    if !to_announce.is_empty() {
        session.broadcast(notice_event(kind, &to_announce));
    }
}

/// `runMcpNeedsAuthCheck` / `runMcpDisconnectedCheck`.
async fn run_check(session: &Session, kind: McpNotice) {
    let status = session.mcp_server_status().await;
    announce(session, kind, status);
}

/// Runs `a` and `b` together and hands each output over as it lands. When
/// `b` lands, `a` is polled again first: on a multi-thread runtime both can
/// land between the two polls of one wake-up, and of two outputs that are
/// both in, `a`'s goes first.
async fn in_arrival_order<A: Future, B: Future>(
    a: A,
    b: B,
    mut on_a: impl FnMut(A::Output),
    mut on_b: impl FnMut(B::Output),
) {
    let (mut a, mut b) = (pin!(a), pin!(b));
    let (mut a_done, mut b_done) = (false, false);
    let mut poll_a = |cx: &mut Context<'_>, a: Pin<&mut A>| {
        if !a_done && let Poll::Ready(out) = a.poll(cx) {
            a_done = true;
            on_a(out);
        }
        a_done
    };
    std::future::poll_fn(|cx| {
        let mut a_now = poll_a(cx, a.as_mut());
        if !b_done && let Poll::Ready(out) = b.as_mut().poll(cx) {
            a_now = poll_a(cx, a.as_mut());
            b_done = true;
            on_b(out);
        }
        if a_now && b_done {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
}

/// `void this.noteMcpNeedsAuthAtStartup(); void
/// this.noteMcpDisconnectedAtStartup();` on a live `system/init`: once per
/// session, both checks at once (needs-auth's request first), each
/// announcing as its reply lands, as TS does on its one thread. A
/// needs-auth request the CLI never answers doesn't hold the other check up.
pub(crate) fn note_at_startup(session: Arc<Session>) {
    if session
        .mcp_notices
        .startup_fired
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let running = session.mcp_notices.track();
    tokio::spawn(async move {
        let _running = running;
        let s = &*session;
        in_arrival_order(
            s.mcp_server_status(),
            s.mcp_server_status(),
            |r| announce(s, McpNotice::NeedsAuth, r),
            |r| announce(s, McpNotice::Disconnected, r),
        )
        .await;
    });
}

/// `void this.recheckMcpStatusMidSession()` at a turn's `result`: when due,
/// both checks, one after the other.
pub(crate) fn recheck_mid_session(session: Arc<Session>) {
    if !session.mcp_notices.take_recheck() {
        return;
    }
    let running = session.mcp_notices.track();
    tokio::spawn(async move {
        let _running = running;
        for kind in McpNotice::ALL {
            run_check(&session, kind).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pending for its first `n` polls (waking itself), then `out`.
    struct ReadyAfter(u32, &'static str);

    impl Future for ReadyAfter {
        type Output = &'static str;
        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<&'static str> {
            if self.0 == 0 {
                return Poll::Ready(self.1);
            }
            self.0 -= 1;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }

    fn order(a: u32, b: u32) -> Vec<&'static str> {
        let seen = Mutex::new(vec![]);
        futures::executor::block_on(in_arrival_order(
            ReadyAfter(a, "a"),
            ReadyAfter(b, "b"),
            |x| seen.lock().unwrap().push(x),
            |x| seen.lock().unwrap().push(x),
        ));
        seen.into_inner().unwrap()
    }

    #[test]
    fn outputs_go_in_arrival_order_a_first_on_a_tie() {
        assert_eq!(order(0, 0), ["a", "b"]);
        // `a` lands between its poll and `b`'s (the reader thread handed
        // both replies over in between): `a` still goes first.
        assert_eq!(order(1, 0), ["a", "b"]);
        // `a` later than `b`, or never by then: `b` doesn't wait.
        assert_eq!(order(3, 0), ["b", "a"]);
        assert_eq!(order(3, 1), ["b", "a"]);
        assert_eq!(order(0, 3), ["a", "b"]);
        assert_eq!(order(2, 2), ["a", "b"]);
    }
}
