import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "../helpers/test";

/**
 * Smoke test for the MCP integration path end-to-end.
 *
 * Why this exists
 * ---------------
 * `lib/server/mcp.ts` + `app/api/mcp/route.ts` + the per-session MCP client
 * had no e2e coverage. Wiring can regress silently — a bad spawn args
 * change, a session.mcpServerStatus() refactor, or an MCP-SDK bump can all
 * leave the UI looking fine on an empty list while quietly breaking real
 * connections. This test asks the actual question: "given a configured
 * server, does Claudius spawn it, complete the protocol handshake, and
 * surface its tools to the session?"
 *
 * What it tests
 * -------------
 * Three complementary paths:
 *
 *  1. **Config persistence (user scope)** — POST /api/mcp upserts the
 *     server config under the user scope (settings.json →
 *     ${HOME}/.claude/), and a follow-up GET /api/mcp lists it back.
 *     Proves listConfigured / upsertServer / readSettings round-trip JSON
 *     correctly.
 *
 *  2. **Project-scope file config picked up at session start** — write
 *     `.mcp.json` in the repo cwd (the canonical location both Claude
 *     Code and the SDK read), open a session, and poll status. This is
 *     the path the `/mcp` page's Add button drives for the project scope
 *     and the one most users hit. Without this check a regression in
 *     how the SDK discovers file-configured servers would slip through.
 *
 *  3. **Live spawn + handshake via `mcp-dynamic`** —
 *     `POST /api/sessions/[id]/mcp-dynamic` wraps the SDK's
 *     `setMcpServers`. The SDK starts the child process, completes the
 *     MCP `initialize` + `tools/list` handshake, and `mcpServerStatus()`
 *     reflects "connected" with the tool list. This is the canonical
 *     "try a server config in one live session" path (see the route's
 *     docstring) and gives the most deterministic signal — connection
 *     happens synchronously inside the `setMcpServers` call rather than
 *     deferred until the SDK reads disk at startup.
 *
 * We use the reference server `@modelcontextprotocol/server-everything`
 * (devDependency) — it's purpose-built for protocol exercise and exposes
 * a stable subset of named tools (`echo`, `add`) we can pattern-match.
 *
 * Why API-level, not UI
 * ---------------------
 * The /mcp page has no testids today and the integration we care about is
 * the spawn/handshake/list-tools chain — all observable through the JSON
 * API. A UI assertion would add testid noise without testing anything the
 * API checks don't already cover. If the UI later grows behavior worth
 * verifying (status badges, reconnect button), add testids in that PR.
 *
 * Why no `activateClaudiusWorkspace`
 * ----------------------------------
 * Both endpoints accept an explicit `cwd` in the request body, so we never
 * need a "currently active" workspace cookie. Sidestepping the helper also
 * means we avoid the page fixture entirely — this is a pure API test, the
 * same shape `commit-draft.spec.ts` uses.
 *
 * Why a real agent isn't needed
 * -----------------------------
 * `setMcpServers` connects the server at registration time, so the SDK
 * has it up before any user message hits the agent. We never need the
 * LLM to drive a tool call — the status endpoint reflects the live MCP
 * client state directly. Keeps the test fast and deterministic.
 */

const SERVER_NAME = "everything-test";

// Resolve the entry point absolutely so the server-side spawn finds it
// regardless of where the dev server's cwd happens to land relative to
// node_modules. The package has no `main`/`exports`, only a `bin` — so
// we point straight at the dist file. stdio is its default transport.
const everythingEntry = resolve(
  process.cwd(),
  "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
);

type LiveStatus = {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  tools?: { name: string; description?: string }[];
  error?: string;
};

type McpListResp = {
  configured: { scope: string; name: string }[];
  status: LiveStatus[] | null;
  statusError: string | null;
};

test.describe("MCP integration — server-everything reference server", () => {
  test.beforeEach(async ({ request, baseURL }) => {
    // Best-effort cleanup of any leftover config from a prior aborted run.
    // 404 when nothing is configured — that's fine, we don't assert on it.
    await request.delete(`${baseURL}/api/mcp/${SERVER_NAME}?scope=user`);
  });

  // Path-injection note: cwd is process.cwd() (the test's own dir), not user
  // input. The `.mcp.json` write is for the project-scope test — we put it
  // back in afterEach so the repo working tree stays clean even when the
  // test crashes mid-run. Tracked separately from the API DELETE because
  // project scope writes to the repo, not the isolated HOME.
  const projectMcpJsonPath = resolve(process.cwd(), ".mcp.json");
  let priorProjectMcpJson: string | null = null;

  test.afterEach(async ({ request, baseURL }) => {
    // 1. Remove the user-scope config (writes under the isolated HOME).
    await request.delete(`${baseURL}/api/mcp/${SERVER_NAME}?scope=user`);
    // 2. Restore .mcp.json to whatever the dev had (or delete if nothing
    //    was there). Only the project-scope test mutates it; otherwise
    //    priorProjectMcpJson stays at its sentinel default and the
    //    unlink is a no-op when the file doesn't exist.
    if (priorProjectMcpJson === null) {
      await fs.unlink(projectMcpJsonPath).catch(() => undefined);
    } else {
      await fs.writeFile(projectMcpJsonPath, priorProjectMcpJson, "utf8");
    }
    priorProjectMcpJson = null;
  });

  test("config round-trips through POST/GET /api/mcp", async ({
    request,
    baseURL,
  }) => {
    const add = await request.post(`${baseURL}/api/mcp`, {
      data: {
        scope: "user",
        name: SERVER_NAME,
        config: {
          type: "stdio",
          command: "node",
          args: [everythingEntry],
        },
      },
    });
    expect(add.ok()).toBe(true);

    const list = (await request
      .get(`${baseURL}/api/mcp`)
      .then((r) => r.json())) as McpListResp;
    const entry = list.configured.find((s) => s.name === SERVER_NAME);
    expect(entry?.scope).toBe("user");
  });

  test("project-scope .mcp.json gets picked up at session start", async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(60_000);

    // Snapshot any existing project mcp config so cleanup can restore it
    // rather than blindly delete (the file is gitignored by default but a
    // dev may have other servers configured).
    try {
      priorProjectMcpJson = await fs.readFile(projectMcpJsonPath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
      priorProjectMcpJson = null;
    }

    await fs.writeFile(
      projectMcpJsonPath,
      JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "stdio",
              command: "node",
              args: [everythingEntry],
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    // New session — SDK reads .mcp.json at startup. cwd MUST match where
    // we just wrote the file (the repo root, process.cwd()).
    const sessResp = await request.post(`${baseURL}/api/sessions`, {
      data: { cwd: process.cwd() },
    });
    expect(sessResp.ok()).toBe(true);
    const { id: sessionId } = (await sessResp.json()) as { id: string };

    // Poll for the file-configured server to show up. The SDK may load
    // it lazily; allow up to 20s before declaring a real regression.
    let lastStatus: LiveStatus | undefined;
    await expect
      .poll(
        async () => {
          const r = (await request
            .get(`${baseURL}/api/mcp?sessionId=${sessionId}&cwd=${encodeURIComponent(process.cwd())}`)
            .then((res) => res.json())) as McpListResp;
          lastStatus = r.status?.find((s) => s.name === SERVER_NAME);
          if (lastStatus?.status === "failed") {
            throw new Error(
              `${SERVER_NAME} reported failed: ${lastStatus.error ?? "<no error>"}`,
            );
          }
          return lastStatus?.status ?? "missing";
        },
        { timeout: 20_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe("connected");

    expect((lastStatus?.tools ?? []).length).toBeGreaterThanOrEqual(5);
  });

  test("spawns, completes handshake, and exposes tools in a live session", async ({
    request,
    baseURL,
  }) => {
    // Cold node spawn + protocol handshake can push past Playwright's default.
    test.setTimeout(60_000);

    // 1. Open a real session. Explicit cwd so the session manager doesn't
    //    need an "active workspace" cookie (we never set one — this is a
    //    pure API test).
    const sessResp = await request.post(`${baseURL}/api/sessions`, {
      data: { cwd: process.cwd() },
    });
    expect(sessResp.ok()).toBe(true);
    const { id: sessionId } = (await sessResp.json()) as { id: string };
    expect(sessionId).toBeTruthy();

    // 2. Register the server dynamically. This is `Query.setMcpServers`
    //    under the hood — the SDK starts the child process, completes the
    //    `initialize` handshake, and surfaces it in mcpServerStatus().
    //    The route returns the SDK's add/remove/error report; we surface
    //    `errors` immediately so a broken spawn fails loudly instead of
    //    waiting 30s for the poll to time out.
    const reg = await request.post(
      `${baseURL}/api/sessions/${sessionId}/mcp-dynamic`,
      {
        data: {
          servers: {
            [SERVER_NAME]: {
              type: "stdio",
              command: "node",
              args: [everythingEntry],
            },
          },
        },
      },
    );
    expect(reg.ok()).toBe(true);
    const regJson = (await reg.json()) as {
      result?: { errors?: Record<string, unknown> };
    };
    expect(
      regJson.result?.errors ?? {},
      `setMcpServers reported errors for ${SERVER_NAME}`,
    ).toEqual({});

    // 3. Poll for connected status. The connect typically completes inside
    //    setMcpServers itself, but the status endpoint may take a tick to
    //    reflect — poll briefly. Bail on `failed` immediately so the SDK's
    //    error surfaces in the test output instead of being masked by the
    //    poll timeout.
    let lastStatus: LiveStatus | undefined;
    await expect
      .poll(
        async () => {
          const r = (await request
            .get(`${baseURL}/api/mcp?sessionId=${sessionId}`)
            .then((res) => res.json())) as McpListResp;
          lastStatus = r.status?.find((s) => s.name === SERVER_NAME);
          if (lastStatus?.status === "failed") {
            throw new Error(
              `${SERVER_NAME} reported failed: ${lastStatus.error ?? "<no error>"}`,
            );
          }
          return lastStatus?.status ?? "missing";
        },
        { timeout: 15_000, intervals: [200, 500, 1_000] },
      )
      .toBe("connected");

    // 4. `echo` is the most stable tool name across server-everything
    //    versions (others have renamed between snapshots — e.g. add →
    //    get-sum). Plus a sanity floor: server-everything ships ~10 tools;
    //    if we see fewer than 5 the SDK probably truncated tools/list.
    const toolNames = (lastStatus?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("echo");
    expect(toolNames.length).toBeGreaterThanOrEqual(5);
  });
});
