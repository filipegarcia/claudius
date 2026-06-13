# Claudius — interface map

> **Generated** by `make documentation` (`scripts/gen-docs.mjs`). Do not edit by hand —
> structure is discovered from `app/**`, descriptions are written by Claude and cached in
> `docs/.sitemap-cache.json`. Re-run `make documentation` after changing the UI; only screens
> whose source changed are re-described.

This catalogs every UI screen, menu, and HTTP endpoint in Claudius: **63 screens** and **160 API endpoints**.

## Navigation menus

Two persistent rails frame every screen:

- **Left nav rail** (`components/nav/SideNav.tsx`) — workspace-scoped destinations (Chat, Git, Sessions, Files, …). Tiles are drag-reorderable and each has a user-remappable keyboard shortcut. Customization-gated tiles (Docker, Tracker, Database, Notebooks) appear only when their customization is published.
- **Workspace switcher** (`components/nav/WorkspaceSwitcher.tsx`) — switches between workspaces and holds the system-global tiles: Community, Plugins, Settings, and Account & Usage.
- **Command palette** (`components/overlays/CommandPalette.tsx`, ⌘K) — fuzzy-search across every navigation destination, slash command, and keyboard shortcut.

## Sitemap

- **Workspace screens**
  - [Chat](#workspaceid) — `/[workspaceId]`
  - [Agents](#workspaceid-agents) — `/[workspaceId]/agents`
  - [Assets](#workspaceid-assets) — `/[workspaceId]/assets`
  - [Cost](#workspaceid-cost) — `/[workspaceId]/cost`
  - [Database](#workspaceid-database) — `/[workspaceId]/database` _(requires “Database Console” customization)_
  - [Docker](#workspaceid-docker) — `/[workspaceId]/docker` _(requires “Docker Monitoring” customization)_
  - [Files](#workspaceid-files) — `/[workspaceId]/files`
  - [Git](#workspaceid-git) — `/[workspaceId]/git`
  - [Hooks](#workspaceid-hooks) — `/[workspaceId]/hooks`
  - [Keybindings](#workspaceid-keybindings) — `/[workspaceId]/keybindings`
  - [MCP](#workspaceid-mcp) — `/[workspaceId]/mcp`
  - [Memory](#workspaceid-memory) — `/[workspaceId]/memory`
  - [Notebooks](#workspaceid-notebooks) — `/[workspaceId]/notebooks` _(requires “Notebooks” customization)_
  - [Permissions](#workspaceid-permissions) — `/[workspaceId]/permissions`
  - [Pipeline](#workspaceid-pipeline) — `/[workspaceId]/pipeline`
  - [Schedule](#workspaceid-schedule) — `/[workspaceId]/schedule`
  - [Sessions](#workspaceid-sessions) — `/[workspaceId]/sessions`
  - [Sessions detail](#workspaceid-sessions-id) — `/[workspaceId]/sessions/[id]`
  - [Skills](#workspaceid-skills) — `/[workspaceId]/skills`
  - [Tracker](#workspaceid-tracker) — `/[workspaceId]/tracker` _(requires “Tracker” customization)_
  - [Workspace](#workspaceid-workspace) — `/[workspaceId]/workspace`
- **Global screens**
  - [Home (entry / redirect)](#home) — `/`
  - [Agents](#agents) — `/agents`
  - [Assets](#assets) — `/assets`
  - [Community](#community) — `/community`
  - [Cost](#cost) — `/cost`
  - [Customize](#customize) — `/customize`
  - [Customize detail](#customize-id) — `/customize/[id]`
  - [Customize settings](#customize-settings) — `/customize/settings`
  - [Database](#database) — `/database` _(requires “Database Console” customization)_
  - [Docker](#docker) — `/docker` _(requires “Docker Monitoring” customization)_
  - [Doctor](#doctor) — `/doctor`
  - [Files](#files) — `/files`
  - [Git](#git) — `/git`
  - [Hooks](#hooks) — `/hooks`
  - [Keybindings](#keybindings) — `/keybindings`
  - [MCP](#mcp) — `/mcp`
  - [Memory](#memory) — `/memory`
  - [Notebooks](#notebooks) — `/notebooks` _(requires “Notebooks” customization)_
  - [Permissions](#permissions) — `/permissions`
  - [Pipeline](#pipeline) — `/pipeline`
  - [Plugins](#plugins) — `/plugins`
  - [Release notes](#release-notes) — `/release-notes`
  - [Schedule](#schedule) — `/schedule`
  - [Sessions detail](#sessions-rest) — `/sessions/[[...rest]]`
  - [Settings](#settings) — `/settings`
  - [Skills](#skills) — `/skills`
  - [Tracker](#tracker) — `/tracker` _(requires “Tracker” customization)_
  - [Updater](#updater) — `/updater`
  - [Account & Usage](#usage) — `/usage`
  - [Welcome](#welcome) — `/welcome`
  - [Workspace](#workspace) — `/workspace`
- **Developer preview routes**
  - [Dev activity running](#workspaceid-dev-activity-running) — `/[workspaceId]/dev/activity-running`
  - [Dev ask rail preview](#workspaceid-dev-ask-rail-preview) — `/[workspaceId]/dev/ask-rail-preview`
  - [Dev chat ask](#workspaceid-dev-chat-ask) — `/[workspaceId]/dev/chat-ask`
  - [Dev chat empty](#workspaceid-dev-chat-empty) — `/[workspaceId]/dev/chat-empty`
  - [Dev chat todos](#workspaceid-dev-chat-todos) — `/[workspaceId]/dev/chat-todos`
  - [Dev chat verbose](#workspaceid-dev-chat-verbose) — `/[workspaceId]/dev/chat-verbose`
  - [Dev chat workflow](#workspaceid-dev-chat-workflow) — `/[workspaceId]/dev/chat-workflow`
  - [Dev minecraft preview](#workspaceid-dev-minecraft-preview) — `/[workspaceId]/dev/minecraft-preview`
  - [Dev tool call preview](#workspaceid-dev-tool-call-preview) — `/[workspaceId]/dev/tool-call-preview`
  - [Dev workflow states](#workspaceid-dev-workflow-states) — `/[workspaceId]/dev/workflow-states`
  - [Dev detail](#dev-rest) — `/dev/[[...rest]]`

## Workspace screens

These screens live under `/[workspaceId]/…` and operate on the active workspace.

### Chat

<a id="workspaceid"></a>`/[workspaceId]`

_(description pending — run `make documentation` with Claude access)_

### Agents

<a id="workspaceid-agents"></a>`/[workspaceId]/agents`

_(description pending — run `make documentation` with Claude access)_

### Assets

<a id="workspaceid-assets"></a>`/[workspaceId]/assets`

_(description pending — run `make documentation` with Claude access)_

### Cost

<a id="workspaceid-cost"></a>`/[workspaceId]/cost`

_(description pending — run `make documentation` with Claude access)_

### Database

<a id="workspaceid-database"></a>`/[workspaceId]/database` · requires the “Database Console” customization

_(description pending — run `make documentation` with Claude access)_

### Docker

<a id="workspaceid-docker"></a>`/[workspaceId]/docker` · requires the “Docker Monitoring” customization

_(description pending — run `make documentation` with Claude access)_

### Files

<a id="workspaceid-files"></a>`/[workspaceId]/files`

_(description pending — run `make documentation` with Claude access)_

### Git

<a id="workspaceid-git"></a>`/[workspaceId]/git`

_(description pending — run `make documentation` with Claude access)_

### Hooks

<a id="workspaceid-hooks"></a>`/[workspaceId]/hooks`

_(description pending — run `make documentation` with Claude access)_

### Keybindings

<a id="workspaceid-keybindings"></a>`/[workspaceId]/keybindings`

_(description pending — run `make documentation` with Claude access)_

### MCP

<a id="workspaceid-mcp"></a>`/[workspaceId]/mcp`

_(description pending — run `make documentation` with Claude access)_

### Memory

<a id="workspaceid-memory"></a>`/[workspaceId]/memory`

_(description pending — run `make documentation` with Claude access)_

### Notebooks

<a id="workspaceid-notebooks"></a>`/[workspaceId]/notebooks` · requires the “Notebooks” customization

_(description pending — run `make documentation` with Claude access)_

### Permissions

<a id="workspaceid-permissions"></a>`/[workspaceId]/permissions`

_(description pending — run `make documentation` with Claude access)_

### Pipeline

<a id="workspaceid-pipeline"></a>`/[workspaceId]/pipeline`

_(description pending — run `make documentation` with Claude access)_

### Schedule

<a id="workspaceid-schedule"></a>`/[workspaceId]/schedule`

_(description pending — run `make documentation` with Claude access)_

### Sessions

<a id="workspaceid-sessions"></a>`/[workspaceId]/sessions`

_(description pending — run `make documentation` with Claude access)_

### Sessions detail

<a id="workspaceid-sessions-id"></a>`/[workspaceId]/sessions/[id]`

_(description pending — run `make documentation` with Claude access)_

### Skills

<a id="workspaceid-skills"></a>`/[workspaceId]/skills`

_(description pending — run `make documentation` with Claude access)_

### Tracker

<a id="workspaceid-tracker"></a>`/[workspaceId]/tracker` · requires the “Tracker” customization

_(description pending — run `make documentation` with Claude access)_

### Workspace

<a id="workspaceid-workspace"></a>`/[workspaceId]/workspace`

_(description pending — run `make documentation` with Claude access)_

## Global screens

### Home (entry / redirect)

<a id="home"></a>`/`

_(description pending — run `make documentation` with Claude access)_

### Agents

<a id="agents"></a>`/agents`

_(description pending — run `make documentation` with Claude access)_

### Assets

<a id="assets"></a>`/assets`

_(description pending — run `make documentation` with Claude access)_

### Community

<a id="community"></a>`/community`

_(description pending — run `make documentation` with Claude access)_

### Cost

<a id="cost"></a>`/cost`

_(description pending — run `make documentation` with Claude access)_

### Customize

<a id="customize"></a>`/customize`

_(description pending — run `make documentation` with Claude access)_

### Customize detail

<a id="customize-id"></a>`/customize/[id]`

_(description pending — run `make documentation` with Claude access)_

### Customize settings

<a id="customize-settings"></a>`/customize/settings`

_(description pending — run `make documentation` with Claude access)_

### Database

<a id="database"></a>`/database` · requires the “Database Console” customization

_(description pending — run `make documentation` with Claude access)_

### Docker

<a id="docker"></a>`/docker` · requires the “Docker Monitoring” customization

_(description pending — run `make documentation` with Claude access)_

### Doctor

<a id="doctor"></a>`/doctor`

_(description pending — run `make documentation` with Claude access)_

### Files

<a id="files"></a>`/files`

_(description pending — run `make documentation` with Claude access)_

### Git

<a id="git"></a>`/git`

_(description pending — run `make documentation` with Claude access)_

### Hooks

<a id="hooks"></a>`/hooks`

_(description pending — run `make documentation` with Claude access)_

### Keybindings

<a id="keybindings"></a>`/keybindings`

_(description pending — run `make documentation` with Claude access)_

### MCP

<a id="mcp"></a>`/mcp`

_(description pending — run `make documentation` with Claude access)_

### Memory

<a id="memory"></a>`/memory`

_(description pending — run `make documentation` with Claude access)_

### Notebooks

<a id="notebooks"></a>`/notebooks` · requires the “Notebooks” customization

_(description pending — run `make documentation` with Claude access)_

### Permissions

<a id="permissions"></a>`/permissions`

_(description pending — run `make documentation` with Claude access)_

### Pipeline

<a id="pipeline"></a>`/pipeline`

_(description pending — run `make documentation` with Claude access)_

### Plugins

<a id="plugins"></a>`/plugins`

_(description pending — run `make documentation` with Claude access)_

### Release notes

<a id="release-notes"></a>`/release-notes`

_(description pending — run `make documentation` with Claude access)_

### Schedule

<a id="schedule"></a>`/schedule`

_(description pending — run `make documentation` with Claude access)_

### Sessions detail

<a id="sessions-rest"></a>`/sessions/[[...rest]]`

_(description pending — run `make documentation` with Claude access)_

### Settings

<a id="settings"></a>`/settings`

_(description pending — run `make documentation` with Claude access)_

### Skills

<a id="skills"></a>`/skills`

_(description pending — run `make documentation` with Claude access)_

### Tracker

<a id="tracker"></a>`/tracker` · requires the “Tracker” customization

_(description pending — run `make documentation` with Claude access)_

### Updater

<a id="updater"></a>`/updater`

_(description pending — run `make documentation` with Claude access)_

### Account & Usage

<a id="usage"></a>`/usage`

_(description pending — run `make documentation` with Claude access)_

### Welcome

<a id="welcome"></a>`/welcome`

_(description pending — run `make documentation` with Claude access)_

### Workspace

<a id="workspace"></a>`/workspace`

_(description pending — run `make documentation` with Claude access)_

## Developer preview routes

Internal fixtures used to preview chat/UI states in isolation. Not part of the normal navigation.

### Dev activity running

<a id="workspaceid-dev-activity-running"></a>`/[workspaceId]/dev/activity-running`

_(description pending — run `make documentation` with Claude access)_

### Dev ask rail preview

<a id="workspaceid-dev-ask-rail-preview"></a>`/[workspaceId]/dev/ask-rail-preview`

_(description pending — run `make documentation` with Claude access)_

### Dev chat ask

<a id="workspaceid-dev-chat-ask"></a>`/[workspaceId]/dev/chat-ask`

_(description pending — run `make documentation` with Claude access)_

### Dev chat empty

<a id="workspaceid-dev-chat-empty"></a>`/[workspaceId]/dev/chat-empty`

_(description pending — run `make documentation` with Claude access)_

### Dev chat todos

<a id="workspaceid-dev-chat-todos"></a>`/[workspaceId]/dev/chat-todos`

_(description pending — run `make documentation` with Claude access)_

### Dev chat verbose

<a id="workspaceid-dev-chat-verbose"></a>`/[workspaceId]/dev/chat-verbose`

_(description pending — run `make documentation` with Claude access)_

### Dev chat workflow

<a id="workspaceid-dev-chat-workflow"></a>`/[workspaceId]/dev/chat-workflow`

_(description pending — run `make documentation` with Claude access)_

### Dev minecraft preview

<a id="workspaceid-dev-minecraft-preview"></a>`/[workspaceId]/dev/minecraft-preview`

_(description pending — run `make documentation` with Claude access)_

### Dev tool call preview

<a id="workspaceid-dev-tool-call-preview"></a>`/[workspaceId]/dev/tool-call-preview`

_(description pending — run `make documentation` with Claude access)_

### Dev workflow states

<a id="workspaceid-dev-workflow-states"></a>`/[workspaceId]/dev/workflow-states`

_(description pending — run `make documentation` with Claude access)_

### Dev detail

<a id="dev-rest"></a>`/dev/[[...rest]]`

_(description pending — run `make documentation` with Claude access)_

## API endpoints

HTTP route handlers under `app/api/`, grouped by resource.

### `/api/account`

Endpoints under `/api/account` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/account`

### `/api/accounts`

Endpoints under `/api/accounts` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST, PATCH, DELETE` `/api/accounts`
- `POST` `/api/accounts/oauth`
- `GET` `/api/accounts/profile`

### `/api/agents`

Endpoints under `/api/agents` _(description pending — run `make documentation` with Claude access)_.

- `GET, PUT` `/api/agents`
- `DELETE` `/api/agents/[name]`
- `GET, PUT, DELETE` `/api/agents/db`

### `/api/assets`

Endpoints under `/api/assets` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/assets`
- `GET, DELETE` `/api/assets/[hash]`
- `GET` `/api/assets/[hash]/uses`

### `/api/claudemd`

Endpoints under `/api/claudemd` _(description pending — run `make documentation` with Claude access)_.

- `GET, PUT` `/api/claudemd`

### `/api/community`

Endpoints under `/api/community` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST, DELETE` `/api/community/admin/[...path]`
- `GET` `/api/community/admin/check`
- `GET, PUT` `/api/community/prefs`

### `/api/cost`

Endpoints under `/api/cost` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/cost`
- `GET, POST` `/api/cost/refresh-prices`

### `/api/customizations`

Endpoints under `/api/customizations` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/customizations`
- `GET, PATCH, DELETE` `/api/customizations/[id]`
- `POST` `/api/customizations/[id]/auto-fix`
- `POST` `/api/customizations/[id]/deactivate`
- `GET, POST, PATCH` `/api/customizations/[id]/description`
- `GET` `/api/customizations/[id]/diff`
- `GET, POST, DELETE` `/api/customizations/[id]/preview`
- `POST` `/api/customizations/[id]/publish`
- `GET` `/api/customizations/[id]/publishes`
- `POST` `/api/customizations/[id]/publishes/[pubId]/revert`
- `GET, POST` `/api/customizations/[id]/sync`

### `/api/customize`

Endpoints under `/api/customize` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/customize/runtime`

### `/api/customize-settings`

Endpoints under `/api/customize-settings` _(description pending — run `make documentation` with Claude access)_.

- `GET, PUT` `/api/customize-settings`

### `/api/docker`

Endpoints under `/api/docker` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/docker/containers`

### `/api/doctor`

Endpoints under `/api/doctor` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/doctor`

### `/api/feedback`

Endpoints under `/api/feedback` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/feedback`

### `/api/fs`

Endpoints under `/api/fs` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/fs/dirs`
- `GET` `/api/fs/list`

### `/api/heapdump`

Endpoints under `/api/heapdump` _(description pending — run `make documentation` with Claude access)_.

- `POST` `/api/heapdump`

### `/api/heartbeat`

Endpoints under `/api/heartbeat` _(description pending — run `make documentation` with Claude access)_.

- `GET, HEAD` `/api/heartbeat`

### `/api/heartbeatz`

Endpoints under `/api/heartbeatz` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/heartbeatz`

### `/api/hooks`

Endpoints under `/api/hooks` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST, DELETE` `/api/hooks`
- `POST` `/api/hooks/disabled`

### `/api/keybindings`

Endpoints under `/api/keybindings` _(description pending — run `make documentation` with Claude access)_.

- `GET, PUT` `/api/keybindings`

### `/api/limits`

Endpoints under `/api/limits` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST, PUT` `/api/limits`

### `/api/mcp`

Endpoints under `/api/mcp` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/mcp`
- `DELETE` `/api/mcp/[name]`
- `POST` `/api/mcp/[name]/reconnect`
- `POST` `/api/mcp/[name]/toggle`

### `/api/memory`

Endpoints under `/api/memory` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST, PATCH, DELETE` `/api/memory/auto`
- `GET, POST, PATCH, DELETE` `/api/memory/rules`

### `/api/models`

Endpoints under `/api/models` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/models`
- `GET` `/api/models/probe`

### `/api/notifications`

Endpoints under `/api/notifications` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/notifications`
- `POST` `/api/notifications/[id]/read`
- `GET` `/api/notifications/counts`
- `POST` `/api/notifications/dev-emit`
- `POST` `/api/notifications/read-all`
- `POST` `/api/notifications/read-by-kind`
- `POST` `/api/notifications/read-by-session`
- `GET` `/api/notifications/stream`

### `/api/plugins`

Endpoints under `/api/plugins` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/plugins`
- `GET` `/api/plugins/available`
- `POST` `/api/plugins/reload`

### `/api/schedule`

Endpoints under `/api/schedule` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/schedule`
- `GET, PATCH, DELETE` `/api/schedule/[id]`
- `POST` `/api/schedule/[id]/run-now`
- `GET` `/api/schedule/[id]/runs`
- `GET` `/api/schedule/[id]/runs/[runId]/stream`
- `GET` `/api/schedule/session-loops`
- `POST` `/api/schedule/session-loops/cancel`

### `/api/sessions`

Endpoints under `/api/sessions` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/sessions`
- `GET, POST` `/api/sessions/[id]/advisor`
- `GET, POST` `/api/sessions/[id]/agent`
- `GET` `/api/sessions/[id]/agents`
- `POST` `/api/sessions/[id]/ask-answer`
- `POST` `/api/sessions/[id]/background-task`
- `POST` `/api/sessions/[id]/bash`
- `POST` `/api/sessions/[id]/clear-todos`
- `GET` `/api/sessions/[id]/commands`
- `GET` `/api/sessions/[id]/context`
- `POST` `/api/sessions/[id]/dev-broadcast`
- `POST` `/api/sessions/[id]/dev-reap`
- `POST` `/api/sessions/[id]/effort`
- `POST` `/api/sessions/[id]/fast`
- `POST` `/api/sessions/[id]/goal`
- `GET` `/api/sessions/[id]/goal-messages`
- `PATCH` `/api/sessions/[id]/holder`
- `POST` `/api/sessions/[id]/input`
- `POST` `/api/sessions/[id]/interrupt`
- `POST` `/api/sessions/[id]/mcp-dynamic`
- `GET, POST` `/api/sessions/[id]/mode`
- `GET, POST` `/api/sessions/[id]/model`
- `GET, POST` `/api/sessions/[id]/notification-prefs`
- `GET` `/api/sessions/[id]/pending-prompts`
- `POST` `/api/sessions/[id]/permission`
- `POST` `/api/sessions/[id]/plan`
- `GET, PUT, DELETE` `/api/sessions/[id]/prompt-draft`
- `DELETE` `/api/sessions/[id]/queue/[uuid]`
- `POST` `/api/sessions/[id]/queue/[uuid]/move`
- `POST` `/api/sessions/[id]/queue/[uuid]/send-now`
- `POST` `/api/sessions/[id]/recap`
- `POST` `/api/sessions/[id]/rewind`
- `GET` `/api/sessions/[id]/search`
- `POST` `/api/sessions/[id]/stop-task`
- `GET` `/api/sessions/[id]/stream`
- `GET` `/api/sessions/[id]/suggested-messages`
- `POST` `/api/sessions/[id]/todos/[itemId]`
- `GET` `/api/sessions/[id]/transcript`
- `POST` `/api/sessions/[id]/ultracode`
- `GET` `/api/sessions/all`
- `GET` `/api/sessions/export/[id]`
- `DELETE` `/api/sessions/file/[id]`
- `POST` `/api/sessions/fork`
- `GET` `/api/sessions/info/[id]`
- `GET, PUT` `/api/sessions/open-tabs`
- `POST` `/api/sessions/rename`
- `GET` `/api/sessions/transcript/[id]`

### `/api/settings`

Endpoints under `/api/settings` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/settings`
- `POST` `/api/settings/additional-dirs`
- `GET` `/api/settings/export`
- `GET, PUT` `/api/settings/full`
- `POST` `/api/settings/import`
- `GET, DELETE` `/api/settings/import/[id]`
- `POST` `/api/settings/import/[id]/resolve`
- `GET, POST` `/api/settings/permissions`

### `/api/skills`

Endpoints under `/api/skills` _(description pending — run `make documentation` with Claude access)_.

- `GET, PUT` `/api/skills`
- `DELETE` `/api/skills/[name]`

### `/api/splash-examples`

Endpoints under `/api/splash-examples` _(description pending — run `make documentation` with Claude access)_.

- `GET, PUT, DELETE` `/api/splash-examples`

### `/api/updater`

Endpoints under `/api/updater` _(description pending — run `make documentation` with Claude access)_.

- `POST` `/api/updater/apply`
- `POST` `/api/updater/check`
- `POST` `/api/updater/resolve-with-claude`
- `GET, PUT` `/api/updater/settings`
- `GET` `/api/updater/status`

### `/api/voice`

Endpoints under `/api/voice` _(description pending — run `make documentation` with Claude access)_.

- `POST` `/api/voice/chunk`
- `POST` `/api/voice/close`
- `GET` `/api/voice/stream`

### `/api/workspaces`

Endpoints under `/api/workspaces` _(description pending — run `make documentation` with Claude access)_.

- `GET, POST` `/api/workspaces`
- `GET, PATCH, DELETE` `/api/workspaces/[id]`
- `GET, POST, PUT, PATCH, DELETE` `/api/workspaces/[id]/files`
- `GET` `/api/workspaces/[id]/files/preview/[...path]`
- `GET` `/api/workspaces/[id]/git/branch-compare`
- `POST` `/api/workspaces/[id]/git/branch-delete`
- `POST` `/api/workspaces/[id]/git/branch-rename`
- `GET` `/api/workspaces/[id]/git/branches`
- `POST` `/api/workspaces/[id]/git/checkout`
- `POST` `/api/workspaces/[id]/git/commit`
- `GET, POST, DELETE` `/api/workspaces/[id]/git/commit-draft`
- `POST` `/api/workspaces/[id]/git/commit-message`
- `GET` `/api/workspaces/[id]/git/diff`
- `POST` `/api/workspaces/[id]/git/merge`
- `POST` `/api/workspaces/[id]/git/pull-merge`
- `POST` `/api/workspaces/[id]/git/rebase`
- `POST` `/api/workspaces/[id]/git/remote`
- `GET` `/api/workspaces/[id]/git/show`
- `POST` `/api/workspaces/[id]/git/stage`
- `GET` `/api/workspaces/[id]/git/status`
- `GET, POST` `/api/workspaces/[id]/icon`
- `POST` `/api/workspaces/[id]/reveal`
- `GET` `/api/workspaces/[id]/roots`
- `POST` `/api/workspaces/[id]/select`
- `POST` `/api/workspaces/[id]/shell`
- `POST` `/api/workspaces/reorder`

### `/api/worktrees`

Endpoints under `/api/worktrees` _(description pending — run `make documentation` with Claude access)_.

- `GET` `/api/worktrees`
