# Claudius (Rust)

A Rust port of Claudius, in progress. The goal is full parity and, eventually,
a pure-Rust app. The backend comes first; see **[PORT_PLAN.md](PORT_PLAN.md)**
for the strategy, module map, status and known gaps.

Today `claudius` is an HTTP front door. It runs Claude Code sessions natively
in Rust (it spawns the `claude` CLI and speaks the Agent SDK control protocol
directly; there is no Node SDK in the loop). Everything it hasn't ported yet,
including the React UI, is proxied to the existing Next.js app.

```sh
# 1. the existing app (UI + not-yet-ported routes)
bun run dev                                     # :3000

# 2. the Rust backend in front of it; open http://localhost:3100
cd rust
cargo run -p claudius-server -- --port 3100 --next http://127.0.0.1:3000
```

```sh
cargo test --workspace                          # fake-CLI + HTTP end-to-end tests
cargo clippy --workspace --all-targets
```

| Crate | Purpose |
|---|---|
| `crates/claudius-agent` | Agent SDK host: CLI transport, control protocol, hooks, SDK MCP servers, fake CLI for tests |
| `crates/claudius-core` | Session engine, session manager, SQLite stores (schema shared with the TS app), settings, workspaces |
| `crates/claudius-server` | axum server (`claudius` binary): ported `/api/sessions/**` routes, SSE, reverse proxy to Next |

Requires a Rust toolchain ≥ 1.85 (edition 2024). The `claude` binary is
resolved like the SDK resolves it: `--claude-bin` / `CLAUDIUS_CLAUDE_BIN`,
then the bundled `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude`,
then `claude` on `PATH`.
