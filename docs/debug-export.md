# Claudius Debug Export

`make debug-export` generates a portable JSON file that helps maintainers
reproduce a bug without access to your machine.

## Quick start

```bash
# Run from the Claudius project directory.
# Claudius does NOT need to be running.
make debug-export
```

This writes `claudius-debug-YYYY-MM-DD.json` to the current directory.
Attach it to your [GitHub bug report][issues].

---

## What the file contains

The debug bundle is a superset of a normal Claudius settings backup.

| Section | Contents |
|---------|----------|
| `version`, `exportedAt`, `exportedFrom` | Bundle schema version, timestamp, source platform |
| `system` | Install-wide settings: `~/.claude/settings.json`, keybindings, updater config, auto-fix prompt |
| `workspaces` | Per-workspace metadata, project/local settings, custom icons |
| `customizations` | Self-modify overlay source files (wand-badge), one entry per active customization; only the files from the most recent publish, not the full src/ mirror |
| `debug` | Diagnostic info: Claudius version, runtime (Node/Bun), which env vars are **present** (never their values), per-workspace session count |

### What is NOT included

| Item | Reason |
|------|--------|
| API keys, tokens, passwords | Redacted automatically — any string-valued field whose name matches `key`, `secret`, `token`, `password`, `auth`, `credential`, `bearer`, or `passphrase` is replaced with `[REDACTED]` |
| Session transcripts | Only counts are included; full conversation content stays on your disk |
| Environment variable values | Only the *names* of relevant vars that are set are recorded |

---

## The file is also a settings backup

Because the bundle follows the same format as the built-in Settings → Export,
the maintainer can import it directly via **Settings → Import** to spin up a
Claudius instance that matches your configuration exactly (minus the API keys).

On import, Claudius restores:
- All workspace settings, project/local configs, and custom icons
- Keybindings and install-wide settings
- Customization overlay source files into `~/.claude/.claudius/customizations/<id>/src/` — the maintainer can then hit **Publish** in the Customize UI to apply them to the live source (only the bundled files are published; unrelated live-source files are untouched)

API keys redacted to `[REDACTED]` must be re-entered before MCP servers or other
credential-dependent features will work on the target machine.

This means one file serves both purposes:

```
user runs `make debug-export`
       │
       ├─▶ maintainer imports it to reproduce the environment
       └─▶ maintainer reads the `debug` field for diagnostic info
```

---

## Review before sharing

The file includes:
- Workspace paths (e.g. `/Users/yourname/Projects/myapp`) and your machine hostname — needed for the maintainer to recreate your workspace structure
- MCP server `command` and `args` fields — the scrubber strips credential-named env vars but **cannot detect inline tokens** in command strings (e.g. `curl -H "Authorization: Bearer <token>"`)
- Customization source files — the user-authored code from your published overlays

Scan the file in a text editor before attaching if any of the above is a concern.

---

## Troubleshooting

**`bun: command not found`**

Bun is required. Install it from <https://bun.sh>:

```bash
curl -fsSL https://bun.sh/install | bash
```

**`Error reading Claudius settings`**

The script reads `~/.claude/settings.json` and
`~/.claude/.claudius/workspaces.json`. Make sure those exist and are readable.
If Claudius has never been started, there may be nothing to export yet — include
a description of your setup in the bug report instead.

**The import fails on the maintainer's side**

The bundle references workspace `rootPath`s from your machine. The import UI
will offer a "heal" flow to remap them to the maintainer's filesystem.

---

[issues]: https://github.com/filipegarcia/claudius/issues/new?template=bug_report.yml
