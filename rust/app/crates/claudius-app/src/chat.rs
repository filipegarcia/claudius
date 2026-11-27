//! A live chat (U04b): one `claudius-client` [`ChatState`] and its
//! [`Driver`] on the engine's runtime, as one `useSession` mount is in the
//! React app (`ChatSurface.tsx` mounts the hook once per page and switches
//! it between the strip's sessions with `switchSession`).
//!
//! [`LiveChat::spawn`] mounts the machine with the page's URL and runs it on
//! a tokio task: the driver's fetches, timers and event streams go over the
//! workspace's transport, the caller's actions arrive in order
//! ([`LiveChat::act`]), and each change is published as a [`ChatSnapshot`].
//! Dropping the last handle unmounts it (the hook's cleanup: the stream
//! closes, the timers stop).
//!
//! **Reading it (a transcript view, U05a's `TranscriptSource`).**
//! [`LiveChat::state`] is the latest state (an `Arc`, cheap to hold while
//! drawing), [`LiveChat::session_id`] the session it is bound to, and
//! [`LiveChat::changes`] a watch receiver that wakes on every new snapshot
//! (any executor; `changed()` errs once the chat is gone). Snapshots are
//! taken at most every [`PUBLISH_EVERY`], so a burst of stream deltas
//! costs one clone per frame. A transcript source is then
//! `chat.session_id() == Some(id)` → `chat.state()`, woken by `changes()`.
//!
//! The UI's effects (`history.replaceState`, a page load, `window`
//! events, console output) come out of [`LiveChat::spawn`]'s receiver, in
//! order.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use claudius_client::effect::Effect;
use claudius_client::lifecycle::Mount;
use claudius_client::state::ChatState;
use claudius_client::{ClientEnv, MemStorage, SystemEnv};
use claudius_transport::Transport;
use claudius_transport::driver::Driver;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use tokio::sync::{mpsc, watch};

use crate::data::ActiveSessionState;

/// How often, at most, a busy chat publishes a snapshot.
pub const PUBLISH_EVERY: Duration = Duration::from_millis(16);

/// The machine's clock and uuids are the system's; `sessionStorage` is
/// this page's own, in memory (a browser tab's lives as long as the tab).
#[derive(Debug, Default)]
pub struct AppEnv {
    pub storage: MemStorage,
}

impl ClientEnv for AppEnv {
    fn now_ms(&mut self) -> f64 {
        SystemEnv.now_ms()
    }

    fn random_uuid(&mut self) -> String {
        SystemEnv.random_uuid()
    }

    fn session_storage(&mut self) -> Option<&mut dyn claudius_client::boot_guard::TabStorage> {
        Some(&mut self.storage)
    }
}

/// A chat [`crate::data::ShellData::open_chat`] mounted, and its UI
/// effects.
pub struct ChatPage {
    pub chat: LiveChat,
    pub ui: UnboundedReceiver<Effect>,
}

/// What the chat looked like after the actions up to `applied`.
#[derive(Clone, Debug)]
pub struct ChatSnapshot {
    pub state: Arc<ChatState>,
    /// The last [`LiveChat::act`] the state includes (0: none yet).
    pub applied: u64,
}

type ActFn = Box<dyn FnOnce(&mut ChatState, &mut AppEnv) -> Vec<Effect> + Send>;

struct Inner {
    workspace_id: String,
    tx: mpsc::UnboundedSender<(u64, ActFn)>,
    snapshots: watch::Receiver<ChatSnapshot>,
    next: AtomicU64,
    /// The page's own requests ([`LiveChat::fetch`]): its transport, on
    /// its runtime.
    transport: Arc<dyn Transport>,
    rt: tokio::runtime::Handle,
}

/// A handle on a running chat. Clones share it; the chat unmounts when the
/// last one drops.
#[derive(Clone)]
pub struct LiveChat {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for LiveChat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveChat")
            .field("workspace_id", &self.inner.workspace_id)
            .field("session_id", &self.session_id())
            .finish_non_exhaustive()
    }
}

/// How the session strip and a live chat follow each other. The strip
/// binding a tab switches the chat (`switchSession`); the chat binding a
/// session by itself (its boot, "+", a `?session=` page) binds it in the
/// strip. `synced` is the session the two last agreed on; `switched` is
/// the strip's last switch (its [`LiveChat::act`] number, 0 for none): a
/// snapshot taken before it still shows the old session, and must not
/// move the strip back.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChatSync {
    synced: Option<String>,
    switched: u64,
}

impl ChatSync {
    /// Agreeing on `bound` (a chat mounted on the strip's bound tab boots
    /// that session anyway).
    pub fn new(bound: Option<String>) -> Self {
        ChatSync {
            synced: bound,
            switched: 0,
        }
    }

    /// The strip binds `bound`: the session to switch the chat to, unless
    /// they agree already. The switch's [`LiveChat::act`] number goes to
    /// [`ChatSync::switching`].
    pub fn on_strip(&mut self, bound: Option<&str>) -> Option<String> {
        let id = bound.filter(|b| self.synced.as_deref() != Some(*b))?;
        self.synced = Some(id.to_owned());
        Some(id.to_owned())
    }

    /// The strip's switch went out as act `seq`.
    pub fn switching(&mut self, seq: u64) {
        self.switched = seq;
    }

    /// A new snapshot: the session the chat moved to by itself, for the
    /// strip to bind. `None` while the strip's switch is in flight, or
    /// when the chat is where they agreed.
    pub fn on_snapshot(&mut self, snap: &ChatSnapshot) -> Option<String> {
        if snap.applied < self.switched {
            return None;
        }
        let id = snap.state.session_id.clone().filter(|s| !s.is_empty())?;
        if self.synced.as_deref() == Some(id.as_str()) {
            return None;
        }
        self.synced = Some(id.clone());
        Some(id)
    }
}

/// The bound tab's state (`activeTabStatus`'s input) from the chat: the
/// chat's own once it is on the session the strip bound; until then (a
/// switch in flight) a session starting, not the one it is leaving.
pub fn bound_tab_state(chat: &ChatState, bound: Option<&str>) -> ActiveSessionState {
    if chat.session_id.as_deref() != bound {
        return ActiveSessionState::default();
    }
    ActiveSessionState {
        ready: chat.ready,
        pending: chat.pending,
        has_error: !chat.errors.is_empty(),
        needs_input: chat.needs_input,
    }
}

/// `newTabId()`: `tab-` and 16 hex digits.
/// The chat's merged session list (`useSession().sessions`: the live rows
/// over the last 25 on disk) as the strip reads it (U04e). `ChatSurface`
/// reads a tab's dot and label from that list, not from `/api/sessions`;
/// a row without an id is skipped.
pub fn session_rows(sessions: &[serde_json::Value]) -> Vec<crate::data::SessionSummary> {
    sessions
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect()
}

pub fn new_tab_id() -> String {
    let id = uuid::Uuid::new_v4();
    let hex: String = id.as_bytes()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("tab-{hex}")
}

impl LiveChat {
    /// Mounts a chat at `href` (`http://localhost/<workspace id>`, with the
    /// page's `?session=` / `?new=1` / `?prompt=` if any) on `rt`, its
    /// requests over `transport`. `pathname` is the route's (`usePathname`).
    pub fn spawn(
        rt: &tokio::runtime::Handle,
        transport: Arc<dyn Transport>,
        workspace_id: &str,
        href: &str,
        pathname: &str,
    ) -> (LiveChat, UnboundedReceiver<Effect>) {
        let mut state = ChatState::new(new_tab_id());
        state.pathname = Some(pathname.to_owned());
        let (snap_tx, snapshots) = watch::channel(ChatSnapshot {
            state: Arc::new(state.clone()),
            applied: 0,
        });
        let (tx, rx) = mpsc::unbounded_channel();
        let (ui_tx, ui_rx) = unbounded();
        let href = href.to_owned();
        rt.spawn(host(state, transport.clone(), href, rx, snap_tx, ui_tx));
        let chat = LiveChat {
            inner: Arc::new(Inner {
                workspace_id: workspace_id.to_owned(),
                tx,
                snapshots,
                next: AtomicU64::new(1),
                transport,
                rt: rt.clone(),
            }),
        };
        (chat, ui_rx)
    }

    pub fn workspace_id(&self) -> &str {
        &self.inner.workspace_id
    }

    /// The latest published state.
    pub fn state(&self) -> Arc<ChatState> {
        self.inner.snapshots.borrow().state.clone()
    }

    /// The latest snapshot, with the last action it includes.
    pub fn snapshot(&self) -> ChatSnapshot {
        self.inner.snapshots.borrow().clone()
    }

    /// The session the chat is bound to (`sessionId`).
    pub fn session_id(&self) -> Option<String> {
        self.inner.snapshots.borrow().state.session_id.clone()
    }

    /// The same mounted chat (a clone of it), not just the same session.
    pub fn ptr_eq(&self, other: &LiveChat) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// A receiver that wakes on each new snapshot.
    pub fn changes(&self) -> watch::Receiver<ChatSnapshot> {
        self.inner.snapshots.clone()
    }

    /// A request of the page's own (the status line's model list, the
    /// settings, the context poll), over the chat's transport on its
    /// runtime: `fetch(url)` as the page's other hooks make it. The
    /// receiver may be polled from any executor.
    pub fn fetch(
        &self,
        req: claudius_client::effect::FetchRequest,
    ) -> futures::channel::oneshot::Receiver<claudius_client::effect::FetchOutcome> {
        let (tx, rx) = futures::channel::oneshot::channel();
        let transport = self.inner.transport.clone();
        self.inner.rt.spawn(async move {
            let _ = tx.send(transport.fetch_outcome(&req).await);
        });
        rx
    }

    /// Runs `f` on the machine (an action, `switch_session`, ...) after
    /// every earlier call, and the effects it asks for; its sequence number
    /// (see [`ChatSnapshot::applied`]).
    pub fn act(
        &self,
        f: impl FnOnce(&mut ChatState, &mut AppEnv) -> Vec<Effect> + Send + 'static,
    ) -> u64 {
        let seq = self.inner.next.fetch_add(1, Ordering::SeqCst);
        let _ = self.inner.tx.send((seq, Box::new(f)));
        seq
    }
}

/// The chat's task: mount, then act on calls and run the driver until the
/// handles are gone, then unmount.
async fn host(
    state: ChatState,
    transport: Arc<dyn Transport>,
    href: String,
    mut rx: mpsc::UnboundedReceiver<(u64, ActFn)>,
    snap_tx: watch::Sender<ChatSnapshot>,
    ui_tx: UnboundedSender<Effect>,
) {
    let mut driver = Driver::new(state, AppEnv::default(), transport, move |e| {
        let _ = ui_tx.unbounded_send(e);
    });
    let page_load = SystemEnv.now_ms();
    driver.act(|s, env| {
        s.mount(
            Mount {
                href: &href,
                page_load,
            },
            env,
        )
    });
    let mut applied = 0;
    let publish = |driver: &Driver<AppEnv>, applied: u64| {
        snap_tx.send_replace(ChatSnapshot {
            state: Arc::new(driver.state.clone()),
            applied,
        });
    };
    publish(&driver, applied);
    let mut due: Option<tokio::time::Instant> = None;
    loop {
        let busy = driver.busy();
        tokio::select! {
            call = rx.recv() => match call {
                Some((seq, f)) => {
                    driver.act(f);
                    applied = seq;
                }
                None => break,
            },
            _ = driver.step(), if busy => {}
            _ = tokio::time::sleep_until(due.unwrap_or_else(tokio::time::Instant::now)), if due.is_some() => {
                publish(&driver, applied);
                due = None;
                continue;
            }
        }
        if due.is_none() {
            due = Some(tokio::time::Instant::now() + PUBLISH_EVERY);
        }
    }
    driver.act(|s, _| s.unmount());
    publish(&driver, applied);
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use claudius_client::state::ChatState;
    use serde_json::json;

    use super::{ChatSnapshot, ChatSync, LiveChat, bound_tab_state};
    use crate::data::ActiveSessionState;

    fn snap(session: Option<&str>, applied: u64) -> ChatSnapshot {
        let mut state = ChatState::new("tab-0");
        state.session_id = session.map(str::to_owned);
        ChatSnapshot {
            state: Arc::new(state),
            applied,
        }
    }

    #[test]
    fn the_strip_and_the_chat_follow_each_other() {
        let mut sync = ChatSync::new(Some("a".into()));
        // The chat boots the bound tab: nothing to do either way.
        assert_eq!(sync.on_strip(Some("a")), None);
        assert_eq!(sync.on_snapshot(&snap(None, 0)), None);
        assert_eq!(sync.on_snapshot(&snap(Some(""), 0)), None);
        assert_eq!(sync.on_snapshot(&snap(Some("a"), 0)), None);
        // The chat makes a session ("+"): the strip binds it, once.
        assert_eq!(sync.on_snapshot(&snap(Some("b"), 0)), Some("b".into()));
        assert_eq!(sync.on_snapshot(&snap(Some("b"), 0)), None);
        assert_eq!(sync.on_strip(Some("b")), None);
        assert_eq!(sync.on_strip(None), None);
        // A tab click: the chat switches; snapshots from before the switch
        // (still on b) don't move the strip back.
        assert_eq!(sync.on_strip(Some("a")), Some("a".into()));
        sync.switching(5);
        assert_eq!(sync.on_snapshot(&snap(Some("b"), 4)), None);
        assert_eq!(sync.on_snapshot(&snap(Some("b"), 4)), None);
        // From the switch on, the chat leads again.
        assert_eq!(sync.on_snapshot(&snap(None, 5)), None);
        assert_eq!(sync.on_snapshot(&snap(Some("a"), 6)), None);
        assert_eq!(sync.on_snapshot(&snap(Some("c"), 6)), Some("c".into()));
        // A switch that didn't take (the session is gone): the chat's own
        // pick is bound.
        assert_eq!(sync.on_strip(Some("d")), Some("d".into()));
        sync.switching(7);
        assert_eq!(sync.on_snapshot(&snap(Some("c"), 7)), Some("c".into()));
    }

    #[test]
    fn the_bound_tab_reads_the_chat_once_it_is_there() {
        let mut st = ChatState::new("tab-0");
        st.session_id = Some("a".into());
        st.ready = true;
        st.pending = true;
        st.needs_input = true;
        st.errors.push(json!({"message": "boom"}));
        let live = ActiveSessionState {
            ready: true,
            pending: true,
            has_error: true,
            needs_input: true,
        };
        assert_eq!(bound_tab_state(&st, Some("a")), live);
        st.errors.clear();
        assert!(!bound_tab_state(&st, Some("a")).has_error);
        // Mid-switch: a session starting, not the one being left.
        for bound in [Some("b"), None] {
            assert_eq!(
                bound_tab_state(&st, bound),
                ActiveSessionState::default(),
                "{bound:?}"
            );
        }
    }

    #[test]
    fn a_live_chat_can_be_shared_with_a_view() {
        fn shareable<T: Send + Sync + Clone + 'static>() {}
        shareable::<LiveChat>();
    }

    #[test]
    fn tab_ids_are_new_tab_ids() {
        let a = super::new_tab_id();
        let b = super::new_tab_id();
        assert_ne!(a, b);
        for id in [a, b] {
            let hex = id.strip_prefix("tab-").expect("the prefix");
            assert_eq!(hex.len(), 16, "{id}");
            assert!(
                hex.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            );
        }
    }
}
