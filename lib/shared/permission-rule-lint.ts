/**
 * CC 2.1.210 parity — Claude Code added a startup warning for
 * `Write(path)`, `NotebookEdit(path)`, and `Glob(path)` permission rules,
 * pointing users at `Edit(path)` / `Read(path)` instead (those three tools
 * don't support path-scoped rules the way `Edit`/`Read` do — a rule like
 * `Write(./src/**)` silently behaves as the unscoped `Write`, which is
 * surprising).
 *
 * Claudius has no CLI startup phase to hook, so this is surfaced inline on
 * the `/permissions` page as the user types a rule. Kept pure (no React) so
 * it's unit-testable without a DOM.
 */

const UNSUPPORTED_SCOPED_TOOLS = ["Write", "NotebookEdit", "Glob"] as const;

export type UnsupportedScopedRule = {
  tool: (typeof UNSUPPORTED_SCOPED_TOOLS)[number];
  suggestion: "Edit(path)" | "Read(path)";
};

const SUGGESTIONS: Record<(typeof UNSUPPORTED_SCOPED_TOOLS)[number], "Edit(path)" | "Read(path)"> = {
  Write: "Edit(path)",
  NotebookEdit: "Edit(path)",
  Glob: "Read(path)",
};

/**
 * Returns the matched tool + suggestion when `rule` is a path-scoped form
 * of `Write`, `NotebookEdit`, or `Glob` (e.g. `Write(./src/**)`), or `null`
 * when the rule is unscoped (`Write`, bare — those are fine) or doesn't
 * match one of the three flagged tools at all.
 */
export function lintPermissionRule(rule: string): UnsupportedScopedRule | null {
  const trimmed = rule.trim();
  for (const tool of UNSUPPORTED_SCOPED_TOOLS) {
    if (trimmed.startsWith(`${tool}(`) && trimmed.endsWith(")")) {
      return { tool, suggestion: SUGGESTIONS[tool] };
    }
  }
  return null;
}

/**
 * CC 2.1.246 parity — Claude Code added a startup warning for Bash allow
 * rules with a wildcard *before* the subcommand, e.g. `Bash(git * main)`:
 * the `*` doesn't just stand in for "any subcommand", it also matches
 * options inserted between the command and the fixed trailing word (e.g.
 * `git --exec=... main`), which is rarely what the rule author intended.
 * A trailing wildcard (`Bash(npm run *)`, `Bash(git commit *)`) is the
 * common, safe pattern — "anything after this point" — so only a `*` that
 * has a literal token *after* it is flagged.
 *
 * Claudius has no CLI startup phase to hook, so — matching the
 * `lintPermissionRule` pattern above (CC 2.1.210 parity) — this is
 * surfaced inline on the `/permissions` page as the user types an
 * `allow`-kind Bash rule. Kept pure (no React) so it's unit-testable
 * without a DOM.
 */
export type BashWildcardWarning = { command: string };

export function lintBashWildcardRule(rule: string): BashWildcardWarning | null {
  const trimmed = rule.trim();
  const match = /^Bash\((.*)\)$/.exec(trimmed);
  if (!match) return null;
  const inner = match[1].trim();
  if (!inner) return null;
  const tokens = inner.split(/\s+/);
  // A `*` followed by at least one more literal token is the ambiguous
  // case — a trailing `*` (the last token) is the common "anything after
  // this point" pattern and isn't flagged.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "*") {
      return { command: inner };
    }
  }
  return null;
}

/**
 * CC 2.1.323 parity — "Added a start-up warning for Bash allow rules with a
 * `*` in a variable's value, such as `Bash(PORT=* npm run dev)`". A `*` also
 * matches spaces, so `PORT=* npm run dev` approves `PORT=1 rm -rf ~; npm run
 * dev` without a prompt. Same non-blocking inline treatment as the lints
 * above.
 *
 * Mirrors the engine's check (`Dh` in the 2.1.323 bundle): split the rule's
 * content on whitespace, find the first token that isn't a `NAME=` / `NAME+=`
 * assignment (the command), and warn when that command is not a shell
 * operator and an earlier assignment holds an unescaped `*`. `command` is the
 * command's leading text before any `*` (what the engine's warning names);
 * no warning when the command is missing or starts with `*`, or the rule is a
 * legacy `prefix:*` rule.
 */
export type BashEnvWildcardWarning = { rule: string; command: string };

const ENV_ASSIGNMENT_RE = /^[A-Za-z_]\w*\+?=/;
const SHELL_OPERATOR_RE = /^(?:[|&;<>]|\d+[<>])/;

function hasUnescapedStar(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    if (token[i] !== "*") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && token[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

export function lintBashEnvWildcardRule(rule: string): BashEnvWildcardWarning | null {
  const trimmed = rule.trim();
  const match = /^Bash\((.*)\)$/.exec(trimmed);
  if (!match) return null;
  // The engine unescapes the rule's content (`\(`, `\)`, `\\`) before
  // matching it, so the lint reads the same text.
  const content = match[1].replace(/\\([()\\])/g, "$1");
  if (content.endsWith(":*")) return null;
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  const cmdIndex = tokens.findIndex((t) => !ENV_ASSIGNMENT_RE.test(t));
  if (cmdIndex <= 0) return null; // no command, or no assignment before it
  const cmd = tokens[cmdIndex];
  if (SHELL_OPERATOR_RE.test(cmd)) return null;
  if (!tokens.slice(0, cmdIndex).some(hasUnescapedStar)) return null;
  const command = /^[^*]+/.exec(cmd)?.[0];
  return command ? { rule: trimmed, command } : null;
}

/**
 * CC 2.1.260 parity — Claude Code now reports a permission rule with text
 * after the closing parenthesis (e.g. `Bash(ls) x`) as an invalid setting,
 * instead of silently ignoring it — that trailing text never matched
 * anything, so the rule quietly did nothing.
 *
 * Claudius has no settings-file load phase to reject an invalid entry at
 * (rules are typed directly into `/permissions`), so — matching the two
 * lints above — this is surfaced as the same inline, non-blocking warning:
 * the rule still saves as typed, same as upstream's "warn" behavior for
 * the two path-scoping lints (upstream's own behavior for *this* item is
 * closer to "reject", but Claudius doesn't have a settings-file load
 * boundary to reject at — warning at the point of typing is the
 * equivalent moment here).
 *
 * CC 2.1.260's third permission-rule item — the ambiguous Windows-path
 * parenthesis (`\(` / `\)`) — is handled separately by `lintWindowsPathParen`
 * below, not here.
 *
 * CC 2.1.332 — such a rule is now also refused at Add time: the engine reads
 * it as malformed and skips it (see `validatePermissionRule`).
 */
export type TrailingGarbageWarning = { trailing: string };

/**
 * Returns the trailing text after a scoped rule's closing parenthesis, or
 * `null` when the rule is well-formed (or isn't a scoped rule at all, e.g.
 * the bare `Bash`).
 *
 * Deliberately searches from the LAST `)` in the string, not the first
 * matching one after the first `(` — a rule can legitimately contain an
 * inner `)` before its real closing paren (e.g. a Windows path with a
 * literal, unescaped-looking parenthesis: `Edit(C:\dir\(name)\**)`).
 * Anchoring on the last `)` means a well-formed rule with nothing after
 * ITS true close is correctly never flagged, no matter what's inside —
 * this is what keeps that case from being reported as trailing garbage
 * (it would need the ambiguous-escaping suggestion instead, not this
 * warning; see the module doc comment above).
 */
export function lintTrailingGarbageRule(rule: string): TrailingGarbageWarning | null {
  const trimmed = rule.trim();
  if (!trimmed.includes("(")) return null; // bare rule name (e.g. "Bash") — nothing to scope-check
  const lastClose = trimmed.lastIndexOf(")");
  if (lastClose === -1) return null; // no closing paren at all — a different malformed-rule shape, not this check
  const trailing = trimmed.slice(lastClose + 1).trim();
  if (!trailing) return null;
  return { trailing };
}

/**
 * CC 2.1.260 parity — a permission rule containing `\(` or `\)` (a backslash
 * immediately before a parenthesis) is ambiguous: in a Windows path like
 * `Edit(C:\dir\(name)\**)` the `\(` reads as a literal path segment, but the
 * rule parser can't tell it from the scope-closing parenthesis, so the rule
 * matches something other than the author intended. Upstream suggests an
 * unambiguous spelling; Claudius surfaces the same non-blocking inline
 * warning as the other lints — the rule still saves as typed.
 *
 * Forward-slash Windows paths (`C:/dir/(name)/**`) and POSIX paths don't trip
 * this; only the backslash-before-paren sequence is flagged. Pure (no React)
 * so it's unit-testable without a DOM.
 */
export type WindowsPathParenWarning = { sequence: "\\(" | "\\)" };

export function lintWindowsPathParen(rule: string): WindowsPathParenWarning | null {
  if (rule.includes("\\(")) return { sequence: "\\(" };
  if (rule.includes("\\)")) return { sequence: "\\)" };
  return null;
}

/**
 * CC 2.1.332 — "Improved `/permissions` to refuse a rule that would be skipped
 * at the next start, such as `rm -rf` with no tool name, and to show the
 * reason". The engine validates every `permissions.allow/ask/deny` entry at
 * load and drops a failing one ("Invalid permission rule … was skipped"), so a
 * deny rule typed into Claudius could look saved while protecting nothing.
 *
 * A port of the refusal branches of the engine's validator (`pme` in the
 * bundled 2.1.332 CLI, with its parser `kH`/`rr` and MCP-name split `_o`).
 * Its `valid: true` warnings are left to the lints above. One deliberate
 * omission: the engine maps legacy tool names first (Task → Agent, KillShell
 * → TaskStop, …); every alias maps a capitalized name to another, none of
 * which takes a branch below, so the mapping never changes the outcome.
 */
export type PermissionRuleKind = "allow" | "ask" | "deny";

export type PermissionRuleCheck =
  | { valid: true }
  | { valid: false; error: string; suggestion?: string; examples?: string[] };

/** The engine's `Ls`: whether `s[i]` is preceded by an odd run of backslashes. */
function isEscapedAt(s: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) n++;
  return n % 2 !== 0;
}

function firstUnescaped(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) if (s[i] === ch && !isEscapedAt(s, i)) return i;
  return -1;
}

function lastUnescaped(s: string, ch: string): number {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] === ch && !isEscapedAt(s, i)) return i;
  return -1;
}

function countUnescaped(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch && !isEscapedAt(s, i)) n++;
  return n;
}

type RuleShape = { kind: "bare" } | { kind: "malformed" } | { kind: "call"; toolName: string; rawContent: string };

/** The engine's `kH`: `Tool`, `Tool(content)` ending at the last unescaped `)`, or malformed. */
function parseRuleShape(rule: string): RuleShape {
  if (!rule.includes("(") && !rule.includes(")")) return { kind: "bare" };
  const open = firstUnescaped(rule, "(");
  const close = lastUnescaped(rule, ")");
  if (open === -1 && close === -1) return { kind: "bare" };
  const toolName = rule.substring(0, open);
  if (open === -1 || close <= open || close !== rule.length - 1 || /[()]/.test(toolName)) {
    return { kind: "malformed" };
  }
  return { kind: "call", toolName, rawContent: rule.substring(open + 1, close) };
}

/** The engine's `rr`: the tool name and unescaped content (`Tool(*)` has none). */
function parseRuleValue(rule: string): { toolName: string; ruleContent?: string } {
  const shape = parseRuleShape(rule);
  if (shape.kind !== "call" || !shape.toolName) return { toolName: rule };
  if (shape.rawContent === "" || shape.rawContent === "*") return { toolName: shape.toolName };
  const ruleContent = shape.rawContent.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\");
  return { toolName: shape.toolName, ruleContent };
}

/** The engine's `_o`: `mcp__server` / `mcp__server__tool`. */
function parseMcpToolName(name: string): { serverName: string; toolName?: string } | null {
  const prefix = "mcp__";
  if (!name.startsWith(prefix)) return null;
  const sep = name.indexOf("__", prefix.length);
  if (sep === -1) {
    const serverName = name.slice(prefix.length);
    return serverName ? { serverName } : null;
  }
  if (sep === prefix.length) return null;
  return { serverName: name.slice(prefix.length, sep), toolName: name.slice(sep + 2) };
}

/** The engine's `GZn`: an allow rule must name the scope it widens. */
function wildcardToolNameRefusal(toolName: string): PermissionRuleCheck | null {
  if (!toolName.includes("*")) return null;
  const mcp = parseMcpToolName(toolName);
  if (mcp && !mcp.serverName.includes("*")) return null;
  return {
    valid: false,
    error: `Wildcard tool name "${toolName}" is not supported in allow rules`,
    suggestion:
      "An allow pattern must name the scope it widens — globs are permitted only in the tool position after a literal mcp__<server>__ prefix. Deny and ask rules accept wildcards anywhere",
    examples: ["mcp__puppeteer__*", "mcp__github__get_*"],
  };
}

/** The engine's `zd`: a `\(` / `\)` beside an unescaped parenthesis that leaves them unbalanced. */
function hasAmbiguousEscapedParen(content: string): boolean {
  return /(?:^|[^\\])\\[()]/.test(content) && countUnescaped(content, "(") !== countUnescaped(content, ")");
}

const FILE_PATTERN_TOOLS = ["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit", "Cd"];

/** The engine's per-tool content checks (WebSearch, WebFetch). */
function customContentRefusal(toolName: string, content: string): PermissionRuleCheck | null {
  if (toolName === "WebSearch" && (content.includes("*") || content.includes("?"))) {
    return {
      valid: false,
      error: "WebSearch does not support wildcards",
      suggestion: "Use exact search terms without * or ?",
      examples: ["WebSearch(claude ai)", "WebSearch(typescript tutorial)"],
    };
  }
  if (toolName === "WebFetch") {
    if (content.includes("://") || content.startsWith("http")) {
      return {
        valid: false,
        error: "WebFetch permissions use domain format, not URLs",
        suggestion: 'Use "domain:hostname" format',
        examples: ["WebFetch(domain:example.com)", "WebFetch(domain:github.com)"],
      };
    }
    if (!content.startsWith("domain:")) {
      return {
        valid: false,
        error: 'WebFetch permissions must use "domain:" prefix',
        suggestion: 'Use "domain:hostname" format',
        examples: ["WebFetch(domain:example.com)", "WebFetch(domain:*.google.com)"],
      };
    }
  }
  return null;
}

/**
 * Whether the engine loads `rule` in the `kind` list. Mirrors `pme`: the
 * allow-only checks run for `allow`; ask and deny skip them. Callers pass the
 * rule as it will be saved (the page trims it first).
 */
export function validatePermissionRule(rule: string, kind: PermissionRuleKind): PermissionRuleCheck {
  if (!rule || rule.trim() === "") return { valid: false, error: "Permission rule cannot be empty" };
  const shape = parseRuleShape(rule);
  if (shape.kind === "malformed") {
    return {
      valid: false,
      error: "Malformed Tool(content) rule",
      suggestion:
        'Rules take the form Tool or Tool(content) and must end at the closing ")"; parentheses inside the content are literal',
    };
  }
  if (shape.kind === "call" && shape.rawContent === "") {
    if (!shape.toolName) {
      return {
        valid: false,
        error: "Empty parentheses with no tool name",
        suggestion: "Specify a tool name before the parentheses",
      };
    }
    return {
      valid: false,
      error: "Empty parentheses",
      suggestion: `Either specify a pattern or use just "${shape.toolName}" without parentheses`,
      examples: [shape.toolName, `${shape.toolName}(some-pattern)`],
    };
  }

  const value = parseRuleValue(rule);
  const mcp = parseMcpToolName(value.toolName);
  if (mcp) {
    if (shape.kind === "call") {
      const forNestedServer = mcp.toolName && !mcp.toolName.includes("*") ? `${value.toolName}__*` : undefined;
      return {
        valid: false,
        error: "MCP rules do not support patterns in parentheses",
        suggestion:
          forNestedServer === undefined
            ? `Use "${value.toolName}" without parentheses, or use "mcp__${mcp.serverName}__*" for all tools`
            : `Use "${value.toolName}" without parentheses. For all tools of a server, use "mcp__${mcp.serverName}__*" for the server "${mcp.serverName}", or "${forNestedServer}" for a server named "${mcp.serverName}__${mcp.toolName}"`,
        examples: [
          `mcp__${mcp.serverName}`,
          `mcp__${mcp.serverName}__*`,
          mcp.toolName && mcp.toolName !== "*" ? `mcp__${mcp.serverName}__${mcp.toolName}` : undefined,
          forNestedServer,
        ].filter((x): x is string => !!x),
      };
    }
    if (kind === "allow") {
      const wildcard = wildcardToolNameRefusal(value.toolName);
      if (wildcard) return wildcard;
    }
    return { valid: true };
  }

  if (!value.toolName) return { valid: false, error: "Tool name cannot be empty" };
  if (kind === "allow") {
    const wildcard = wildcardToolNameRefusal(value.toolName);
    if (wildcard) return wildcard;
  }
  const first = value.toolName[0];
  if (!value.toolName.includes("_") && first !== first?.toUpperCase()) {
    return {
      valid: false,
      error: "Tool names must start with uppercase",
      suggestion: `Use "${value.toolName.charAt(0).toUpperCase()}${value.toolName.slice(1)}"`,
    };
  }
  if (shape.kind === "call" && hasAmbiguousEscapedParen(shape.rawContent)) {
    const isFileTool = FILE_PATTERN_TOOLS.includes(value.toolName);
    return {
      valid: false,
      error: 'Ambiguous "\\(" or "\\)" beside an unescaped parenthesis',
      suggestion: isFileTool
        ? "Write a Windows path with forward slashes, or spell a literal parenthesis as [(] or [)]"
        : 'Double a backslash that is a path separator ("\\\\("), and escape literal parentheses in pairs',
      examples: isFileTool
        ? [`${value.toolName}(C:/Projects/(drafts)/**)`, `${value.toolName}(C:\\Projects\\[(]drafts)\\**)`]
        : [`${value.toolName}(C:\\tools\\\\(x86)\\run.exe *)`],
    };
  }
  if (value.ruleContent !== undefined) {
    const custom = customContentRefusal(value.toolName, value.ruleContent);
    if (custom) return custom;
    if (value.toolName === "Bash" && value.ruleContent === ":*") {
      return {
        valid: false,
        error: "Prefix cannot be empty before :*",
        suggestion: "Specify a command prefix before :*",
        examples: ["Bash(npm *)", "Bash(git *)"],
      };
    }
    if (FILE_PATTERN_TOOLS.includes(value.toolName) && value.ruleContent.includes(":*")) {
      return {
        valid: false,
        error: 'The ":*" syntax is only for Bash prefix rules',
        suggestion: 'Use glob patterns like "*" or "**" for file matching',
        examples: [
          `${value.toolName}(*.ts) - matches .ts files`,
          `${value.toolName}(src/**) - matches all files in src`,
          `${value.toolName}(**/*.test.ts) - matches test files`,
        ],
      };
    }
  }
  return { valid: true };
}

/** The reason the engine logs for a refused rule: `error. suggestion. Examples: …`. */
export function permissionRuleRefusalMessage(check: PermissionRuleCheck): string | null {
  if (check.valid) return null;
  let msg = check.error;
  if (check.suggestion) msg += `. ${check.suggestion}`;
  if (check.examples && check.examples.length > 0) msg += `. Examples: ${check.examples.join(", ")}`;
  return msg;
}
