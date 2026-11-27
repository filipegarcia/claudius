//! `components/git/BranchSwitcher.tsx`: the popover's state (the list, its
//! filter, the open submenu, the busy row and the errors), its sections
//! and each row's actions. The page runs the branch requests; the outcome
//! comes back through [`BranchSwitcher::op_done`].

use crate::types::{BranchInfo, js_trim};

/// What a menu item (or a row pick) asks the page to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchAction {
    Checkout(String),
    /// "New Branch from '<b>'…" / "New branch…": asks for the name.
    NewBranch {
        start_point: Option<String>,
    },
    CheckoutAndRebase {
        branch: String,
        onto: String,
    },
    Compare {
        base: String,
        head: String,
    },
    ShowDiff(String),
    RebaseCurrentOnto(String),
    Merge(String),
    Update,
    Push,
    /// "Rename…": asks for the new name.
    Rename(String),
    /// "Delete": asks first.
    DeleteLocal(String),
    /// "Delete (remote)": asks first.
    DeleteRemote(String),
}

/// One submenu item (`actionsFor`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuItem {
    pub label: String,
    pub disabled: bool,
    pub danger: bool,
    pub action: BranchAction,
}

/// `actionsFor` (BranchSwitcher.tsx:338): Checkout (disabled on the
/// current one), New Branch from it, and against a current branch the
/// rebase / compare / diff / merge items; Update / Push on the current one;
/// Rename / Delete on a local, Delete (remote) on a remote.
pub fn actions_for(b: &BranchInfo, current: Option<&str>) -> Vec<MenuItem> {
    let item = |label: String, action: BranchAction| MenuItem {
        label,
        disabled: false,
        danger: false,
        action,
    };
    let is_cur = b.current;
    let mut items = vec![
        MenuItem {
            disabled: is_cur,
            ..item("Checkout".into(), BranchAction::Checkout(b.name.clone()))
        },
        item(
            format!("New Branch from '{}'…", b.name),
            BranchAction::NewBranch {
                start_point: Some(b.name.clone()),
            },
        ),
    ];
    if let (false, Some(cur)) = (is_cur, current) {
        items.push(item(
            format!("Checkout and Rebase onto '{cur}'"),
            BranchAction::CheckoutAndRebase {
                branch: b.name.clone(),
                onto: cur.into(),
            },
        ));
        items.push(item(
            format!("Compare with '{cur}'"),
            BranchAction::Compare {
                base: cur.into(),
                head: b.name.clone(),
            },
        ));
        items.push(item(
            "Show Diff with Working Tree".into(),
            BranchAction::ShowDiff(b.name.clone()),
        ));
        items.push(item(
            format!("Rebase '{cur}' onto '{}'", b.name),
            BranchAction::RebaseCurrentOnto(b.name.clone()),
        ));
        items.push(item(
            format!("Merge '{}' into '{cur}'", b.name),
            BranchAction::Merge(b.name.clone()),
        ));
    }
    if is_cur {
        items.push(item("Update".into(), BranchAction::Update));
        items.push(item("Push…".into(), BranchAction::Push));
    }
    if b.is_local() {
        items.push(item("Rename…".into(), BranchAction::Rename(b.name.clone())));
        items.push(MenuItem {
            danger: true,
            disabled: is_cur,
            ..item("Delete".into(), BranchAction::DeleteLocal(b.name.clone()))
        });
    } else {
        items.push(MenuItem {
            danger: true,
            ..item(
                "Delete (remote)".into(),
                BranchAction::DeleteRemote(b.name.clone()),
            )
        });
    }
    items
}

/// `runOp`'s key for an action (the row that shows busy is the one whose
/// key is its name).
pub fn op_key(action: &BranchAction) -> String {
    match action {
        BranchAction::Checkout(n) => n.clone(),
        BranchAction::NewBranch { .. } => "__new__".into(),
        BranchAction::CheckoutAndRebase { branch, .. } => format!("__cor__:{branch}"),
        BranchAction::Compare { head, .. } => format!("__cmp__:{head}"),
        BranchAction::ShowDiff(n) => format!("__diff__:{n}"),
        BranchAction::RebaseCurrentOnto(n) => format!("__rb__:{n}"),
        BranchAction::Merge(n) => format!("__mg__:{n}"),
        BranchAction::Update => "__update__".into(),
        BranchAction::Push => "__push__".into(),
        BranchAction::Rename(n) => format!("__rename__:{n}"),
        BranchAction::DeleteLocal(n) | BranchAction::DeleteRemote(n) => format!("__delete__:{n}"),
    }
}

/// Read-only actions keep the popover open (`closeOnOk: false`).
pub fn closes_on_ok(action: &BranchAction) -> bool {
    !matches!(
        action,
        BranchAction::Compare { .. } | BranchAction::ShowDiff(_)
    )
}

/// `/not fully merged|not yet been merged/i`: `git branch -d`'s refusal.
pub fn is_not_fully_merged(error: &str) -> bool {
    let e = error.to_lowercase();
    e.contains("not fully merged") || e.contains("not yet been merged")
}

/// The visible rows (`useMemo` at BranchSwitcher.tsx:209): the current
/// branch (never filtered), then the locals and remotes matching the
/// filter (name or upstream, case-insensitive, trimmed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sections {
    pub current: Option<BranchInfo>,
    /// Matching locals, the current one included (the section renders the
    /// others).
    pub locals: Vec<BranchInfo>,
    pub remotes: Vec<BranchInfo>,
}

impl Sections {
    pub fn other_locals(&self) -> impl Iterator<Item = &BranchInfo> {
        self.locals.iter().filter(|b| !b.current)
    }
}

pub fn sections(branches: &[BranchInfo], filter: &str) -> Sections {
    let current = branches.iter().find(|b| b.current).cloned();
    let q = js_trim(filter).to_lowercase();
    let matches = |b: &BranchInfo| {
        q.is_empty()
            || b.name.to_lowercase().contains(&q)
            || b.upstream
                .as_deref()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&q)
    };
    Sections {
        current,
        locals: branches
            .iter()
            .filter(|b| b.is_local() && matches(b))
            .cloned()
            .collect(),
        remotes: branches
            .iter()
            .filter(|b| b.is_remote() && matches(b))
            .cloned()
            .collect(),
    }
}

/// The popover's local section label.
pub fn local_label(detached: bool) -> &'static str {
    if detached { "Local" } else { "Local · others" }
}

/// The text a prompt asks with (`window.prompt`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchPrompt {
    New { start_point: Option<String> },
    Rename { old_name: String },
}

impl BranchPrompt {
    pub fn label(&self) -> String {
        match self {
            BranchPrompt::New {
                start_point: Some(sp),
            } => format!("New branch name (starting from '{sp}'):"),
            BranchPrompt::New { start_point: None } => "New branch name:".into(),
            BranchPrompt::Rename { old_name } => format!("Rename branch '{old_name}' to:"),
        }
    }

    /// The prompt's default value.
    pub fn default_value(&self) -> String {
        match self {
            BranchPrompt::New { .. } => String::new(),
            BranchPrompt::Rename { old_name } => old_name.clone(),
        }
    }

    /// The answer as the action to run: trimmed, empty (or the old name,
    /// for a rename) is nothing.
    pub fn answer(&self, value: &str) -> Option<(String, BranchOp)> {
        let t = js_trim(value);
        if t.is_empty() {
            return None;
        }
        match self {
            BranchPrompt::New { start_point } => Some((
                format!("__new__:{t}"),
                BranchOp::Create {
                    name: t.into(),
                    start_point: start_point.clone(),
                },
            )),
            BranchPrompt::Rename { old_name } => (t != old_name).then(|| {
                (
                    format!("__rename__:{old_name}"),
                    BranchOp::Rename {
                        old_name: old_name.clone(),
                        new_name: t.into(),
                    },
                )
            }),
        }
    }
}

/// A branch request the page runs for the popover.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchOp {
    Checkout(String),
    Create {
        name: String,
        start_point: Option<String>,
    },
    CheckoutAndRebase {
        branch: String,
        onto: String,
    },
    RebaseCurrentOnto(String),
    Merge(String),
    Compare {
        base: String,
        head: String,
    },
    ShowDiff(String),
    Update,
    Push,
    Rename {
        old_name: String,
        new_name: String,
    },
    DeleteLocal {
        name: String,
        force: bool,
    },
    DeleteRemote(String),
}

/// The popover (BranchSwitcher.tsx:110).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BranchSwitcher {
    pub open: bool,
    pub branches: Vec<BranchInfo>,
    pub loading: bool,
    pub load_error: Option<String>,
    pub action_error: Option<String>,
    pub busy_name: Option<String>,
    pub filter: String,
    /// The open submenu's key (`current:` / `local:` / `remote:` + name).
    pub menu_for: Option<String>,
    /// Bumped by each load: an older answer is dropped (`cancelled`).
    load_gen: u64,
    /// The op in flight: whether a success closes the popover, and the
    /// delete flow's stage.
    pending: Option<Pending>,
    pub prompt: Option<BranchPrompt>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Pending {
    Run { close_on_ok: bool },
    DeleteLocal { name: String, forced: bool },
    DeleteRemote,
}

/// What the page does after an op answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AfterOp {
    Nothing,
    /// Reload the list (`refresh()`).
    Reload,
    /// Ask to force-delete a branch that isn't fully merged.
    AskForce {
        name: String,
        error: String,
    },
}

impl BranchSwitcher {
    /// The chip's click: opening loads the list (the load's generation).
    pub fn toggle(&mut self) -> Option<u64> {
        if self.open {
            self.close();
            None
        } else {
            self.open = true;
            self.loading = true;
            self.filter.clear();
            self.action_error = None;
            self.menu_for = None;
            self.prompt = None;
            Some(self.next_load())
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.menu_for = None;
        self.prompt = None;
        self.load_gen += 1;
    }

    fn next_load(&mut self) -> u64 {
        self.load_gen += 1;
        self.load_gen
    }

    /// The refresh button (and a delete's reload): `None` while closed
    /// (the effect only runs open; `loading` stays set, as in TS).
    pub fn reload(&mut self) -> Option<u64> {
        self.loading = true;
        if !self.open {
            return None;
        }
        Some(self.next_load())
    }

    /// The list (or its error) arrived for load `generation`.
    pub fn loaded(&mut self, generation: u64, result: Result<Vec<BranchInfo>, String>) {
        if generation != self.load_gen || !self.open {
            return;
        }
        match result {
            Ok(b) => {
                self.branches = b;
                self.load_error = None;
            }
            Err(e) => self.load_error = Some(e),
        }
        self.loading = false;
    }

    /// Escape: the submenu first, then the popover.
    pub fn escape(&mut self) {
        if self.prompt.is_some() {
            self.prompt = None;
        } else if self.menu_for.is_some() {
            self.menu_for = None;
        } else {
            self.close();
        }
    }

    /// Opens (or closes) a row's submenu.
    pub fn toggle_menu(&mut self, key: &str) {
        if self.menu_for.as_deref() == Some(key) {
            self.menu_for = None;
        } else {
            self.menu_for = Some(key.to_owned());
        }
    }

    /// `branchForKey` (BranchSwitcher.tsx:322).
    pub fn branch_for_key(&self, key: &str) -> Option<&BranchInfo> {
        let (tag, name) = key.split_once(':')?;
        if tag.is_empty() {
            return None;
        }
        self.branches.iter().find(|b| {
            b.name == name
                && match tag {
                    "current" => b.current,
                    "local" => b.is_local(),
                    "remote" => b.is_remote(),
                    _ => false,
                }
        })
    }

    pub fn sections(&self) -> Sections {
        sections(&self.branches, &self.filter)
    }

    /// "No branches found." / `No matches for “…”.`.
    pub fn empty_text(&self) -> Option<String> {
        if self.loading {
            return None;
        }
        if self.branches.is_empty() {
            return self
                .load_error
                .is_none()
                .then(|| "No branches found.".into());
        }
        let s = self.sections();
        (s.locals.is_empty() && s.remotes.is_empty() && s.current.is_none())
            .then(|| format!("No matches for “{}”.", self.filter))
    }

    /// `runOp`'s start: the op to run now, or the prompt / confirm the
    /// action asks first (the caller shows it).
    pub fn start(&mut self, action: &BranchAction) -> Option<BranchOp> {
        let op = match action {
            BranchAction::NewBranch { start_point } => {
                self.prompt = Some(BranchPrompt::New {
                    start_point: start_point.clone(),
                });
                return None;
            }
            BranchAction::Rename(n) => {
                self.prompt = Some(BranchPrompt::Rename {
                    old_name: n.clone(),
                });
                return None;
            }
            BranchAction::DeleteLocal(_) | BranchAction::DeleteRemote(_) => return None,
            BranchAction::Checkout(n) => BranchOp::Checkout(n.clone()),
            BranchAction::CheckoutAndRebase { branch, onto } => BranchOp::CheckoutAndRebase {
                branch: branch.clone(),
                onto: onto.clone(),
            },
            BranchAction::Compare { base, head } => BranchOp::Compare {
                base: base.clone(),
                head: head.clone(),
            },
            BranchAction::ShowDiff(n) => BranchOp::ShowDiff(n.clone()),
            BranchAction::RebaseCurrentOnto(n) => BranchOp::RebaseCurrentOnto(n.clone()),
            BranchAction::Merge(n) => BranchOp::Merge(n.clone()),
            BranchAction::Update => BranchOp::Update,
            BranchAction::Push => BranchOp::Push,
        };
        self.begin(op_key(action), closes_on_ok(action));
        Some(op)
    }

    /// A prompt's answer: the op to run, if any.
    pub fn answer_prompt(&mut self, value: Option<&str>) -> Option<BranchOp> {
        let prompt = self.prompt.take()?;
        let (key, op) = prompt.answer(value?)?;
        self.begin(key, true);
        Some(op)
    }

    fn begin(&mut self, key: String, close_on_ok: bool) {
        self.busy_name = Some(key);
        self.action_error = None;
        self.pending = Some(Pending::Run { close_on_ok });
    }

    /// The delete was confirmed: the op to run.
    pub fn begin_delete_local(&mut self, name: &str, force: bool) -> BranchOp {
        self.busy_name = Some(format!("__delete__:{name}"));
        self.action_error = None;
        self.pending = Some(Pending::DeleteLocal {
            name: name.to_owned(),
            forced: force,
        });
        BranchOp::DeleteLocal {
            name: name.to_owned(),
            force,
        }
    }

    pub fn begin_delete_remote(&mut self, name: &str) -> BranchOp {
        self.busy_name = Some(format!("__delete__:{name}"));
        self.action_error = None;
        self.pending = Some(Pending::DeleteRemote);
        BranchOp::DeleteRemote(name.to_owned())
    }

    /// The force question was declined: the first refusal shows.
    pub fn force_declined(&mut self, error: &str) {
        self.action_error = Some(error.to_owned());
        self.busy_name = None;
    }

    /// The op answered (the page's `OpResult`).
    pub fn op_done(&mut self, result: Result<(), String>) -> AfterOp {
        let pending = self.pending.take();
        let mut after = AfterOp::Nothing;
        match (pending, result) {
            (Some(Pending::Run { close_on_ok }), Ok(())) => {
                if close_on_ok {
                    self.close();
                } else {
                    self.menu_for = None;
                }
            }
            (Some(Pending::DeleteLocal { .. }), Ok(())) => {
                self.menu_for = None;
                after = AfterOp::Reload;
            }
            (Some(Pending::DeleteLocal { name, forced }), Err(e)) => {
                if !forced && is_not_fully_merged(&e) {
                    // `busyName` stays until the question is answered.
                    return AfterOp::AskForce { name, error: e };
                }
                self.action_error = Some(e);
            }
            (Some(Pending::DeleteRemote), r) => {
                match r {
                    Ok(()) => self.close(),
                    Err(e) => self.action_error = Some(e),
                }
                after = AfterOp::Reload;
            }
            (_, Err(e)) => self.action_error = Some(e),
            (None, Ok(())) => {}
        }
        self.busy_name = None;
        after
    }

    /// Is a menu item clickable (`a.disabled || busyName`).
    pub fn item_enabled(&self, item: &MenuItem) -> bool {
        !item.disabled && self.busy_name.is_none()
    }
}

/// The chip's text and tooltip.
pub fn chip_label(current: Option<&str>) -> String {
    current.unwrap_or("—").to_owned()
}

pub fn chip_title(current: Option<&str>) -> String {
    match current {
        Some(c) => format!("Branch: {c} · click to switch"),
        None => "No branch".into(),
    }
}

/// The delete questions (`window.confirm`).
pub fn delete_local_question(name: &str) -> String {
    format!("Delete local branch '{name}'?")
}

pub fn force_delete_question(name: &str) -> String {
    format!("'{name}' is not fully merged. Force-delete anyway? Unmerged commits will be lost.")
}

pub fn delete_remote_question(name: &str) -> String {
    format!(
        "Delete remote branch '{name}'? Runs `git push --delete` — this is published to the remote and cannot be undone here."
    )
}
