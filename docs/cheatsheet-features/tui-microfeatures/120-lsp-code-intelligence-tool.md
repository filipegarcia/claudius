# LSP Code-Intelligence Tool

**Source:** Claude Code TUI — tools
**Status:** MISSING

## What it is
A first-class LSP tool the agent can call to ask "where is this symbol defined?" instead of grepping for it. The `tools/LSPTool/LSPTool.ts` leak pins the operation set in a Zod enum: `operation: z.enum(['goToDefinition','findReferences','hover','documentSymbol','workspaceSymbol','goToImplementation','prepareCallHierarchy','incomingCalls','outgoingCalls']).describe('The LSP operation to perform')` — i.e. go-to-definition, find-references, hover, document/workspace symbol search, go-to-implementation, and the three call-hierarchy phases — all routed through whatever language server is attached to the workspace.

## Claudius today
Not surfaced in Claudius. There is no LSP client, no language-server spawn path, and no agent-facing tool that does symbol lookups: `lib/`, `components/`, and `app/` contain zero matches for `LSP`, `goToDefinition`, `findReferences`, `documentSymbol`, `workspaceSymbol`, `prepareCallHierarchy`, `tsserver`, `gopls`, `pylsp`, `ast-grep`, or `tree-sitter`. The agent currently does code intelligence the slow way — via the SDK's Grep / Glob / Read tools over the working tree — and Claudius's only "code-aware" plumbing is the outbound editor deep-links in `lib/client/ide.ts` (cf. `docs/cheatsheet-features/tui-microfeatures/30-ide-selection-open-file-reminder.md`). The natural home would be a new `lib/server/lsp/` module that spawns the right language server per workspace + file extension, an `app/api/sessions/[id]/lsp/route.ts` (or an SDK tool registration if we move it into the agent loop directly), and a Zod schema mirroring the leak's operation enum.

## Decision
MISSING. Claudius has no LSP-backed code-intelligence tool — the agent grep-and-reads its way around the workspace today. Per `tools/LSPTool/LSPTool.ts` the upstream surface is well-scoped (nine operations, all standard LSP requests) and would be a meaningful precision/latency win over Grep for "where is this defined / who calls this" questions, but it implies a per-workspace language-server lifecycle (spawn, initialize, shutdown, restart-on-crash) that is real infrastructure work. Worth tracking but not a quick adopt — and probably better to do once and well (covering at least TS, Python, Go) than per-language piecemeal.
