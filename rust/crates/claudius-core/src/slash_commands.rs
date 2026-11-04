//! The lookup half of `lib/shared/slash-commands.ts` (D22):
//! `SLASH_COMMANDS`' ids, names and aliases, and `findSlashCommand`, which
//! the doctor's prompt audit uses to tell a known `/command` from a stale
//! one. The picker, help text and categories are client-side.
//! `tests/prompt_audit_golden.rs` checks this table against the TS
//! registry, so an entry added there fails until it is copied here.

/// `SLASH_COMMANDS` as `(id, name, aliases)`, in registry order.
pub const SLASH_COMMANDS: &[(&str, &str, &[&str])] = &[
    ("clear", "clear", &["reset", "new"]),
    ("compact", "compact", &[]),
    ("resume", "resume", &["continue"]),
    ("fork", "fork", &["branch"]),
    ("rename", "rename", &[]),
    ("export", "export", &[]),
    ("rewind", "rewind", &["checkpoint", "undo"]),
    ("goal", "goal", &["objective"]),
    ("exit", "exit", &["quit"]),
    ("permissions", "permissions", &["allowed-tools"]),
    ("sandbox", "sandbox", &[]),
    ("agents", "agents", &[]),
    ("hooks", "hooks", &[]),
    ("mcp", "mcp", &[]),
    ("plugin", "plugin", &[]),
    ("reload-plugins", "reload-plugins", &[]),
    ("reload-skills", "reload-skills", &[]),
    ("tasks", "tasks", &["bashes"]),
    ("skills", "skills", &[]),
    ("memory", "memory", &[]),
    ("context", "context", &[]),
    ("skill-doctor", "skill-doctor", &[]),
    ("init", "init", &[]),
    ("recap", "recap", &[]),
    ("btw", "btw", &[]),
    ("model", "model", &[]),
    ("effort", "effort", &[]),
    ("fast", "fast", &[]),
    ("advisor", "advisor", &[]),
    ("settings", "settings", &["config"]),
    ("theme", "theme", &[]),
    ("statusline", "statusline", &[]),
    ("keybindings", "keybindings", &[]),
    ("color", "color", &[]),
    ("diff", "diff", &[]),
    ("focus", "focus", &[]),
    ("output-style", "output-style", &[]),
    ("zen", "zen", &[]),
    ("tui", "tui", &[]),
    ("cost", "cost", &[]),
    ("usage", "usage", &["stats"]),
    ("extra-usage", "extra-usage", &[]),
    ("rate-limit-options", "rate-limit-options", &[]),
    ("login", "login", &[]),
    ("logout", "logout", &[]),
    ("setup-bedrock", "setup-bedrock", &[]),
    ("setup-vertex", "setup-vertex", &[]),
    ("ide", "ide", &[]),
    ("install-github-app", "install-github-app", &[]),
    ("install-slack-app", "install-slack-app", &[]),
    ("chrome", "chrome", &[]),
    ("web-setup", "web-setup", &[]),
    ("desktop", "desktop", &["app"]),
    ("mobile", "mobile", &["ios", "android"]),
    ("passes", "passes", &[]),
    ("stickers", "stickers", &[]),
    ("teleport", "teleport", &["tp"]),
    ("remote-control", "remote-control", &["rc"]),
    ("remote-env", "remote-env", &[]),
    ("upgrade", "upgrade", &[]),
    ("voice", "voice", &[]),
    ("help", "help", &[]),
    ("status", "status", &[]),
    ("release-notes", "release-notes", &[]),
    ("feedback", "feedback", &["bug"]),
    ("insights", "insights", &[]),
    ("team-onboarding", "team-onboarding", &[]),
    ("heapdump", "heapdump", &[]),
    ("doctor", "doctor", &["checkup"]),
    ("powerup", "powerup", &[]),
    ("add-dir", "add-dir", &[]),
    ("worktrees", "worktrees", &["worktree"]),
    ("files", "files", &[]),
    ("batch", "batch", &[]),
    ("claude-api", "claude-api", &[]),
    ("debug", "debug", &[]),
    ("fewer-permission-prompts", "fewer-permission-prompts", &[]),
    ("loop", "loop", &[]),
    ("schedule", "schedule", &["routines"]),
    ("simplify", "simplify", &[]),
    ("review", "review", &["code-review"]),
    ("security-review", "security-review", &[]),
    ("ultrareview", "ultrareview", &[]),
    ("autofix-pr", "autofix-pr", &[]),
    ("plan", "plan", &[]),
    ("copy", "copy", &[]),
];

/// `findSlashCommand(nameOrAlias)`: the id of the command with that exact
/// name or alias (`ALIAS_INDEX` is last-wins, so the last entry naming it).
pub fn find_slash_command(name_or_alias: &str) -> Option<&'static str> {
    SLASH_COMMANDS
        .iter()
        .rev()
        .find(|(_, name, aliases)| *name == name_or_alias || aliases.contains(&name_or_alias))
        .map(|(id, _, _)| *id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_aliases() {
        assert_eq!(find_slash_command("clear"), Some("clear"));
        assert_eq!(find_slash_command("reset"), Some("clear"));
        assert_eq!(find_slash_command("checkup"), Some("doctor"));
        assert_eq!(find_slash_command("Clear"), None);
        assert_eq!(find_slash_command("constructor"), None);
    }
}
