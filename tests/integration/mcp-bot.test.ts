import { afterEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { generateWorkerBearerToken, hashOAuthOpaqueToken } from "@/auth/token-hash";
import { schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import { DEFAULT_BUDGET_LIMIT, serializeBudgetLimit } from "@/domain";
import { createApp } from "@/server/app";
import { createMemoryRateLimiter } from "@/server/rate-limit";
import { MCP_BOT_TOOL_NAMES, mountMcpRoutes } from "@/server/routes/mcp";
import { createMcpBotServicePort } from "@/worker/mcp-port";

const openDbs: SqliteAppDatabase[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

interface TestFixture {
  readonly db: SqliteAppDatabase;
  readonly app: ReturnType<typeof createApp>;
  readonly workerTokenWs1: string;
  readonly worker2TokenWs1: string;
  readonly workerTokenWs2: string;
  readonly oauthTokenWs1: string;
  readonly opaqueOAuthTokenWs1: string;
  readonly opaqueOAuthTokenHashWs1: string;
  readonly setNow: (ms: number) => void;
}

async function setupMcpFixture(options?: {
  readonly rateLimit?: number;
  readonly throwOnJwt?: boolean;
}): Promise<TestFixture> {
  const db = createSqliteDatabase(":memory:");
  openDbs.push(db);
  await db.applyMigrations();

  let currentNow = 1_760_000_000_000;
  const worker1 = await generateWorkerBearerToken();
  const worker2 = await generateWorkerBearerToken();
  const workerWs2 = await generateWorkerBearerToken();
  const oauthTokenWs1 = "oauth_jwt_valid_ws1";
  const opaqueOAuthTokenWs1 = "opaque_access_token_plain_ws1_secret";
  const opaqueOAuthTokenHashWs1 = await hashOAuthOpaqueToken(opaqueOAuthTokenWs1);

  await db.orm.insert(schema.user).values([
    {
      id: "user-1",
      name: "Owner 1",
      email: "owner1@example.com",
      emailVerified: true,
      createdAt: new Date(currentNow),
      updatedAt: new Date(currentNow),
    },
    {
      id: "user-2",
      name: "Owner 2",
      email: "owner2@example.com",
      emailVerified: true,
      createdAt: new Date(currentNow),
      updatedAt: new Date(currentNow),
    },
  ]);

  await db.orm.insert(schema.oauthClient).values({
    id: "oc-1",
    clientId: "oauth-client-chatgpt",
    name: "ChatGPT Remote MCP",
    redirectUris: JSON.stringify(["https://chatgpt.com/callback"]),
    disabled: false,
    createdAt: new Date(currentNow),
    updatedAt: new Date(currentNow),
  });

  await db.orm.insert(schema.oauthAccessToken).values({
    id: "oat-1",
    token: opaqueOAuthTokenHashWs1,
    clientId: "oauth-client-chatgpt",
    userId: "user-1",
    scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
    expiresAt: new Date(currentNow + 3_600_000),
    createdAt: new Date(currentNow),
  });

  await db.orm.insert(schema.workspaces).values([
    {
      id: "ws-1",
      ownerUserId: "user-1",
      goal: "Build bot-board MVP",
      allowedScope: "research, drafting, task-breakdown",
      budgetLimit: serializeBudgetLimit(DEFAULT_BUDGET_LIMIT),
      isPaused: false,
      version: 1,
      createdAt: currentNow,
      updatedAt: currentNow,
    },
    {
      id: "ws-2",
      ownerUserId: "user-2",
      goal: "Isolated second workspace",
      allowedScope: "isolated",
      budgetLimit: serializeBudgetLimit(DEFAULT_BUDGET_LIMIT),
      isPaused: false,
      version: 1,
      createdAt: currentNow,
      updatedAt: currentNow,
    },
  ]);

  await db.orm.insert(schema.botConnections).values([
    {
      id: "bot-worker-1",
      workspaceId: "ws-1",
      displayName: "Grok Worker #1",
      channelType: "worker_bearer",
      tokenHash: worker1.tokenHash,
      scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
      status: "active",
      version: 1,
      createdAt: currentNow,
      updatedAt: currentNow,
    },
    {
      id: "bot-worker-2",
      workspaceId: "ws-1",
      displayName: "Secondary Worker",
      channelType: "worker_bearer",
      tokenHash: worker2.tokenHash,
      scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
      status: "active",
      version: 1,
      createdAt: currentNow,
      updatedAt: currentNow,
    },
    {
      id: "bot-oauth-1",
      workspaceId: "ws-1",
      displayName: "ChatGPT Remote MCP",
      channelType: "mcp_oauth",
      oauthClientId: "oauth-client-chatgpt",
      scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
      status: "active",
      version: 1,
      createdAt: currentNow,
      updatedAt: currentNow,
    },
    {
      id: "bot-worker-ws2",
      workspaceId: "ws-2",
      displayName: "Other WS Bot",
      channelType: "worker_bearer",
      tokenHash: workerWs2.tokenHash,
      scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
      status: "active",
      version: 1,
      createdAt: currentNow,
      updatedAt: currentNow,
    },
  ]);

  const port = createMcpBotServicePort(db, {
    now: () => currentNow,
    verifyOAuthJwt: (token) => {
      if (options?.throwOnJwt === true) {
        return Promise.reject(new Error("JWT signature verification failed"));
      }
      if (token === oauthTokenWs1) {
        return Promise.resolve({
          sub: "user-1",
          clientId: "oauth-client-chatgpt",
          scopes: ["tasks:read", "tasks:write", "proposals:write", "decisions:read"],
        });
      }
      return Promise.resolve(null);
    },
  });

  const rateLimiter =
    options?.rateLimit !== undefined
      ? createMemoryRateLimiter({
          limit: options.rateLimit,
          windowMs: 60_000,
          now: () => currentNow,
        })
      : undefined;

  const app = createApp({
    mountMcpRoutes(honoApp) {
      mountMcpRoutes(honoApp, {
        port,
        ...(rateLimiter !== undefined ? { rateLimiter } : {}),
        publicBaseUrl: "  https://staging.bot-board.example/  ",
      });
    },
  });

  return {
    db,
    app,
    workerTokenWs1: worker1.plaintextToken,
    worker2TokenWs1: worker2.plaintextToken,
    workerTokenWs2: workerWs2.plaintextToken,
    oauthTokenWs1,
    opaqueOAuthTokenWs1,
    opaqueOAuthTokenHashWs1,
    setNow: (ms: number) => {
      currentNow = ms;
    },
  };
}

async function mcpRpc(
  app: ReturnType<typeof createApp>,
  token: string | null,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ readonly status: number; readonly headers: Headers; readonly json: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (token !== null) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await app.request("https://staging.bot-board.example/api/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.trim().startsWith("event:") || text.includes("\ndata:")) {
    const dataLine = text
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    parsed = dataLine !== undefined ? JSON.parse(dataLine) : null;
  } else if (text.trim() !== "") {
    parsed = JSON.parse(text);
  }
  return { status: res.status, headers: res.headers, json: parsed };
}

function extractToolPayload(rpcResponse: unknown): {
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
} {
  if (rpcResponse === null || typeof rpcResponse !== "object") {
    throw new Error("Expected JSON-RPC response object.");
  }
  const result: unknown = Reflect.get(rpcResponse, "result");
  if (result === null || typeof result !== "object") {
    throw new Error(`Expected JSON-RPC result, got: ${JSON.stringify(rpcResponse)}`);
  }
  const isError = Reflect.get(result, "isError") === true;
  const content: unknown = Reflect.get(result, "content");
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`Expected MCP content array, got: ${JSON.stringify(result)}`);
  }
  const first: unknown = content[0];
  const text: unknown =
    first !== null && typeof first === "object" ? Reflect.get(first, "text") : null;
  if (typeof text !== "string") {
    throw new Error(`Expected text content block, got: ${JSON.stringify(first)}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in tool text, got: ${text}`);
  }
  return { isError, data: Object.fromEntries(Object.entries(parsed)) };
}

async function callMcpTool(
  app: ReturnType<typeof createApp>,
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Promise<{ readonly isError: boolean; readonly data: Record<string, unknown> }> {
  const res = await mcpRpc(app, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  return extractToolPayload(res.json);
}

describe("S2 Bot Services & Stateless Streamable HTTP /api/mcp (BOT-02, DEC-01, DEC-02, BOT-03)", () => {
  test("exposes exact 12 Bot tools only, enforces 401 WWW-Authenticate, and blocks X-Forwarded-For rate-limit spoofing (M1, Minor 6)", async () => {
    const fx = await setupMcpFixture({ rateLimit: 3 });

    // 1. Missing Authorization -> 401 with trimmed RFC 9728 WWW-Authenticate header
    const unauth = await mcpRpc(
      fx.app,
      null,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "X-Forwarded-For": "203.0.113.1" },
    );
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://staging.bot-board.example/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write proposals:write decisions:read"',
    );
    expect(unauth.json).toMatchObject({ code: "NOT_AUTHORIZED", retryable: false });

    // 2. Authorized tools/list returns exact 12-tool allowlist
    const listRes = await mcpRpc(
      fx.app,
      fx.oauthTokenWs1,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { "X-Forwarded-For": "203.0.113.2" },
    );
    expect(listRes.status).toBe(200);
    const resultObj: unknown =
      listRes.json !== null && typeof listRes.json === "object"
        ? Reflect.get(listRes.json, "result")
        : null;
    const tools: unknown =
      resultObj !== null && typeof resultObj === "object" ? Reflect.get(resultObj, "tools") : null;
    expect(Array.isArray(tools)).toBe(true);
    if (Array.isArray(tools)) {
      const names = tools
        .map((t: unknown): unknown =>
          t !== null && typeof t === "object" ? Reflect.get(t, "name") : null,
        )
        .filter((n): n is string => typeof n === "string")
        .sort();
      expect(names).toEqual([...MCP_BOT_TOOL_NAMES].sort());
      for (const forbidden of [
        "decide_card",
        "undo_card",
        "defer_card",
        "retry_task",
        "revoke_bot",
      ]) {
        expect(names).not.toContain(forbidden);
      }
    }

    // 3. Rotating spoofed X-Forwarded-For MUST NOT bypass rate limit (4th request -> 429 RATE_LIMITED)
    const req3 = await mcpRpc(
      fx.app,
      fx.oauthTokenWs1,
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { "X-Forwarded-For": "203.0.113.3" },
    );
    expect(req3.status).toBe(200);

    const req4 = await mcpRpc(
      fx.app,
      fx.oauthTokenWs1,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { "X-Forwarded-For": "198.51.100.99" },
    );
    expect(req4.status).toBe(429);
    expect(req4.headers.get("Retry-After")).toBeTruthy();
    expect(req4.json).toMatchObject({ code: "RATE_LIMITED", retryable: true });

    // 4. Post-auth per-bot rate limit triggers 429 even when cf-connecting-ip rotates every request (M1)
    const fxBotLimit = await setupMcpFixture({ rateLimit: 2 });
    const botReq1 = await mcpRpc(
      fxBotLimit.app,
      fxBotLimit.workerTokenWs1,
      { jsonrpc: "2.0", id: 10, method: "tools/list" },
      { "cf-connecting-ip": "198.51.100.1" },
    );
    expect(botReq1.status).toBe(200);

    const botReq2 = await mcpRpc(
      fxBotLimit.app,
      fxBotLimit.workerTokenWs1,
      { jsonrpc: "2.0", id: 11, method: "tools/list" },
      { "cf-connecting-ip": "198.51.100.2" },
    );
    expect(botReq2.status).toBe(200);

    const botReq3 = await mcpRpc(
      fxBotLimit.app,
      fxBotLimit.workerTokenWs1,
      { jsonrpc: "2.0", id: 12, method: "tools/list" },
      { "cf-connecting-ip": "198.51.100.3" },
    );
    expect(botReq3.status).toBe(429);
    expect(botReq3.headers.get("Retry-After")).toBeTruthy();
    expect(botReq3.json).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });

  test("verifies hashed opaque oauthAccessToken, blocks Pass-the-Hash, expired/revoked/disabled client, and throwing JWT verifier (B1, M7)", async () => {
    const fx = await setupMcpFixture({ throwOnJwt: true });

    // 1. Throwing verifyOAuthJwt fails closed -> 401 WWW-Authenticate (never 500)
    const badJwt = await mcpRpc(fx.app, "malformed.jwt.token", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(badJwt.status).toBe(401);
    expect(badJwt.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");

    // 2. Pass-the-Hash attack presenting stored DB hash directly MUST be rejected with 401
    const passTheHash = await mcpRpc(fx.app, fx.opaqueOAuthTokenHashWs1, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(passTheHash.status).toBe(401);

    // 3. Real plaintext opaque token hashes to stored base64url(SHA-256) and authenticates cleanly
    const validOpaque = await callMcpTool(
      fx.app,
      fx.opaqueOAuthTokenWs1,
      "get_workspace_context",
      {},
    );
    expect(validOpaque.isError).toBe(false);
    expect(validOpaque.data["workspace_id"]).toBe("ws-1");

    // 4. Disabled oauthClient rejects immediately with 401
    await fx.db.orm
      .update(schema.oauthClient)
      .set({ disabled: true })
      .where(eq(schema.oauthClient.clientId, "oauth-client-chatgpt"));
    const disabledClientRes = await mcpRpc(fx.app, fx.opaqueOAuthTokenWs1, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    });
    expect(disabledClientRes.status).toBe(401);

    await fx.db.orm
      .update(schema.oauthClient)
      .set({ disabled: false })
      .where(eq(schema.oauthClient.clientId, "oauth-client-chatgpt"));

    // 5. Expired opaque token (now >= expiresAt) rejects with 401
    fx.setNow(1_760_003_600_001);
    const expiredRes = await mcpRpc(fx.app, fx.opaqueOAuthTokenWs1, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    });
    expect(expiredRes.status).toBe(401);

    // 6. Revoked opaque token rejects even before expiry
    fx.setNow(1_760_000_100_000);
    await fx.db.orm
      .update(schema.oauthAccessToken)
      .set({ revoked: new Date(1_760_000_050_000) })
      .where(eq(schema.oauthAccessToken.id, "oat-1"));
    const revokedTokenRes = await mcpRpc(fx.app, fx.opaqueOAuthTokenWs1, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
    });
    expect(revokedTokenRes.status).toBe(401);
  });

  test("enforces live per-request D1 bot_connections scope narrowing, pause, workspace pause, worker/oauth revocation, and cross-workspace isolation (BOT-02)", async () => {
    const fx = await setupMcpFixture();

    const ws2Task = await callMcpTool(fx.app, fx.workerTokenWs2, "create_task", {
      request_id: "req-ws2-1",
      title: "Secret WS2 Task",
      requires_approval: true,
    });
    expect(ws2Task.isError).toBe(false);
    const ws2TaskId = String(ws2Task.data["task_id"]);

    const crossRead = await callMcpTool(fx.app, fx.oauthTokenWs1, "get_task", {
      task_id: ws2TaskId,
    });
    expect(crossRead.isError).toBe(true);
    expect(crossRead.data["code"]).toBe("NOT_FOUND");

    // Scope narrowing in D1 takes effect IMMEDIATELY without re-issuing OAuth JWT
    await fx.db.orm
      .update(schema.botConnections)
      .set({ scopes: JSON.stringify(["tasks:read"]) })
      .where(eq(schema.botConnections.id, "bot-oauth-1"));

    const narrowedRead = await callMcpTool(fx.app, fx.oauthTokenWs1, "get_workspace_context", {});
    expect(narrowedRead.isError).toBe(false);
    expect(narrowedRead.data["workspace_id"]).toBe("ws-1");

    const narrowedWrite = await callMcpTool(fx.app, fx.oauthTokenWs1, "create_task", {
      request_id: "req-narrow-1",
      title: "Should be denied",
    });
    expect(narrowedWrite.isError).toBe(true);
    expect(narrowedWrite.data["code"]).toBe("NOT_AUTHORIZED");

    // Paused BotConnection blocks writes, allows reads
    await fx.db.orm
      .update(schema.botConnections)
      .set({
        scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
        status: "paused",
      })
      .where(eq(schema.botConnections.id, "bot-oauth-1"));

    const pausedBotWrite = await callMcpTool(fx.app, fx.oauthTokenWs1, "create_task", {
      request_id: "req-paused-bot",
      title: "Paused bot cannot write",
    });
    expect(pausedBotWrite.isError).toBe(true);
    expect(pausedBotWrite.data["code"]).toBe("NOT_AUTHORIZED");

    // Paused Workspace blocks writes with WORKSPACE_PAUSED
    await fx.db.orm
      .update(schema.botConnections)
      .set({ status: "active" })
      .where(eq(schema.botConnections.id, "bot-oauth-1"));
    await fx.db.orm
      .update(schema.workspaces)
      .set({ isPaused: true })
      .where(eq(schema.workspaces.id, "ws-1"));

    const pausedWsWrite = await callMcpTool(fx.app, fx.oauthTokenWs1, "create_task", {
      request_id: "req-paused-ws",
      title: "Paused workspace cannot write",
    });
    expect(pausedWsWrite.isError).toBe(true);
    expect(pausedWsWrite.data["code"]).toBe("WORKSPACE_PAUSED");

    // Instant revocation for both oauth and worker_bearer -> HTTP 401
    await fx.db.orm
      .update(schema.botConnections)
      .set({ status: "revoked" })
      .where(eq(schema.botConnections.id, "bot-oauth-1"));
    await fx.db.orm
      .update(schema.botConnections)
      .set({ status: "revoked" })
      .where(eq(schema.botConnections.id, "bot-worker-1"));

    for (const tok of [fx.oauthTokenWs1, fx.workerTokenWs1, "invalid_bearer_token"]) {
      const revokedRes = await mcpRpc(fx.app, tok, {
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_workspace_context", arguments: {} },
      });
      expect(revokedRes.status).toBe(401);
      expect(revokedRes.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");
    }
  });

  test("handles VERSION_CONFLICT, LEASE_CONFLICT, concurrent Promise.all idempotency/claim races, selection_group_id collision, supersede from running, and DEC-01/M3/M5 edge cases (B2, B3, M2-M5, M9)", async () => {
    const fx = await setupMcpFixture();

    // 1. Concurrent Promise.all identical & conflicting create_task idempotency (M2)
    const [concCreateA, concCreateB] = await Promise.all([
      callMcpTool(fx.app, fx.workerTokenWs1, "create_task", {
        request_id: "req-conc-create",
        title: "Concurrent Task",
        requires_approval: true,
      }),
      callMcpTool(fx.app, fx.workerTokenWs1, "create_task", {
        request_id: "req-conc-create",
        title: "Concurrent Task",
        requires_approval: true,
      }),
    ]);
    expect(concCreateA.isError).toBe(false);
    expect(concCreateB.isError).toBe(false);
    expect(concCreateA.data["task_id"]).toBe(concCreateB.data["task_id"]);
    const taskId = String(concCreateA.data["task_id"]);

    // 2. VERSION_CONFLICT on claim_task with wrong expected_version
    const badVerClaim = await callMcpTool(fx.app, fx.workerTokenWs1, "claim_task", {
      request_id: "req-bad-ver-claim",
      task_id: taskId,
      expected_version: 99,
    });
    expect(badVerClaim.isError).toBe(true);
    expect(badVerClaim.data["code"]).toBe("VERSION_CONFLICT");

    // 3. Two bots racing to claim_task on same expected_version=1 -> exactly 1 succeeds!
    const [raceBot1, raceBot2] = await Promise.all([
      callMcpTool(fx.app, fx.workerTokenWs1, "claim_task", {
        request_id: "req-race-claim-1",
        task_id: taskId,
        expected_version: 1,
        lease_duration_seconds: 60,
      }),
      callMcpTool(fx.app, fx.worker2TokenWs1, "claim_task", {
        request_id: "req-race-claim-2",
        task_id: taskId,
        expected_version: 1,
        lease_duration_seconds: 60,
      }),
    ]);
    const winners = [raceBot1, raceBot2].filter((r) => !r.isError);
    const losers = [raceBot1, raceBot2].filter((r) => r.isError);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winnerToken = raceBot1.isError ? fx.worker2TokenWs1 : fx.workerTokenWs1;
    const loserToken = raceBot1.isError ? fx.workerTokenWs1 : fx.worker2TokenWs1;
    const activeLeaseToken = String(winners[0]?.data["lease_token"]);

    // 4. Concurrent Promise.all identical & conflicting UPDATE-based idempotency (M2)
    const [concUpdateA, concUpdateB] = await Promise.all([
      callMcpTool(fx.app, winnerToken, "update_task", {
        request_id: "req-conc-upd",
        task_id: taskId,
        expected_version: 2,
        lease_token: activeLeaseToken,
        description: "Updated concurrently",
        artifact: {
          title: "Spec v1",
          kind: "markdown",
          summary: "Initial spec",
          content_or_url: "# Spec v1",
        },
      }),
      callMcpTool(fx.app, winnerToken, "update_task", {
        request_id: "req-conc-upd",
        task_id: taskId,
        expected_version: 2,
        lease_token: activeLeaseToken,
        description: "Updated concurrently",
        artifact: {
          title: "Spec v1",
          kind: "markdown",
          summary: "Initial spec",
          content_or_url: "# Spec v1",
        },
      }),
    ]);
    expect(concUpdateA.isError).toBe(false);
    expect(concUpdateB.isError).toBe(false);
    expect(concUpdateA.data["version"]).toBe(3);
    expect(concUpdateB.data["version"]).toBe(3);
    const artId = String(concUpdateA.data["artifact_id"]);

    // Conflicting payload on same request_id -> IDEMPOTENCY_CONFLICT (NOT VERSION_CONFLICT!)
    const conflictUpdate = await callMcpTool(fx.app, winnerToken, "update_task", {
      request_id: "req-conc-upd",
      task_id: taskId,
      expected_version: 2,
      lease_token: activeLeaseToken,
      description: "Different payload",
    });
    expect(conflictUpdate.isError).toBe(true);
    expect(conflictUpdate.data["code"]).toBe("IDEMPOTENCY_CONFLICT");

    // 5. get_artifact expected_version mismatch -> VERSION_CONFLICT
    const badArtVer = await callMcpTool(fx.app, winnerToken, "get_artifact", {
      artifact_id: artId,
      expected_version: 9,
    });
    expect(badArtVer.isError).toBe(true);
    expect(badArtVer.data["code"]).toBe("VERSION_CONFLICT");

    // 6. Wrong lease_token / other bot / expired lease -> LEASE_CONFLICT
    const wrongLeaseRenew = await callMcpTool(fx.app, winnerToken, "renew_lease", {
      request_id: "req-wrong-lease",
      task_id: taskId,
      lease_token: "wrong_lease_token",
    });
    expect(wrongLeaseRenew.isError).toBe(true);
    expect(wrongLeaseRenew.data["code"]).toBe("LEASE_CONFLICT");

    const otherBotUpdate = await callMcpTool(fx.app, loserToken, "update_task", {
      request_id: "req-other-bot-upd",
      task_id: taskId,
      expected_version: 3,
      lease_token: activeLeaseToken,
      description: "Hijack attempt",
    });
    expect(otherBotUpdate.isError).toBe(true);
    expect(otherBotUpdate.data["code"]).toBe("LEASE_CONFLICT");

    // Advance clock past lease TTL -> expired lease rejected with LEASE_CONFLICT
    fx.setNow(1_760_000_070_000);
    const expiredUpdate = await callMcpTool(fx.app, winnerToken, "update_task", {
      request_id: "req-exp-upd",
      task_id: taskId,
      expected_version: 3,
      lease_token: activeLeaseToken,
      description: "After expiry",
    });
    expect(expiredUpdate.isError).toBe(true);
    expect(expiredUpdate.data["code"]).toBe("LEASE_CONFLICT");

    // Rewind clock within lease TTL, test update_task(running -> blocked) releases work_leases
    fx.setNow(1_760_000_010_000);
    const blockedRes = await callMcpTool(fx.app, winnerToken, "update_task", {
      request_id: "req-to-blocked",
      task_id: taskId,
      expected_version: 3,
      lease_token: activeLeaseToken,
      status: "blocked",
      status_reason: "Waiting on input",
    });
    expect(blockedRes.isError).toBe(false);
    expect(blockedRes.data["status"]).toBe("blocked");
    const leaseAfterBlock = await fx.db.orm
      .select()
      .from(schema.workLeases)
      .where(eq(schema.workLeases.taskId, taskId))
      .get();
    expect(leaseAfterBlock).toBeUndefined();

    // Re-ready and claim task to test selection_group_id collision (B3) + target_artifact_id (M4)
    await fx.db.orm
      .update(schema.tasks)
      .set({ status: "ready", version: 5 })
      .where(eq(schema.tasks.id, taskId));
    const claimAgain = await callMcpTool(fx.app, winnerToken, "claim_task", {
      request_id: "req-claim-again",
      task_id: taskId,
      expected_version: 5,
    });
    expect(claimAgain.isError).toBe(false);
    const lease2 = String(claimAgain.data["lease_token"]);

    // Submit proposal referencing existing target_artifact_id and explicit selection_group_id
    const sub1 = await callMcpTool(fx.app, winnerToken, "submit_proposal", {
      request_id: "req-sub-grp-1",
      task_id: taskId,
      expected_version: 6,
      lease_token: lease2,
      selection_group_id: "grp-unique-1",
      proposals: [
        {
          card_type: "choice",
          selection_mode: "binary",
          options: [],
          title: "Choice A",
          summary: "Summary A",
          on_accept_effect: "Do A",
          on_decline_effect: "Skip A",
          on_decline_policy: "revise",
          target_artifact_id: artId,
        },
      ],
    });
    expect(sub1.isError).toBe(false);
    const card1Id =
      Array.isArray(sub1.data["cards"]) &&
      sub1.data["cards"][0] !== null &&
      typeof sub1.data["cards"][0] === "object"
        ? String(Reflect.get(sub1.data["cards"][0], "card_id"))
        : "";

    // Verify binary with options: [] stored options_json = null (Minor 5)
    const storedProp = await fx.db.orm.select().from(schema.proposals).get();
    expect(storedProp?.optionsJson).toBeNull();
    expect(storedProp?.targetArtifactId).toBe(artId);
    expect(storedProp?.targetArtifactVersion).toBe(1);

    // B3: Cross-workspace bot attempting to reuse selection_group_id "grp-unique-1" MUST be rejected!
    const ws2Task = await callMcpTool(fx.app, fx.workerTokenWs2, "create_task", {
      request_id: "req-ws2-grp",
      title: "WS2 Task",
    });
    const ws2TaskId = String(ws2Task.data["task_id"]);
    const ws2Claim = await callMcpTool(fx.app, fx.workerTokenWs2, "claim_task", {
      request_id: "req-ws2-claim",
      task_id: ws2TaskId,
      expected_version: 1,
    });
    const ws2Collide = await callMcpTool(fx.app, fx.workerTokenWs2, "submit_proposal", {
      request_id: "req-ws2-collide",
      task_id: ws2TaskId,
      expected_version: 2,
      lease_token: String(ws2Claim.data["lease_token"]),
      selection_group_id: "grp-unique-1",
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Hijack group",
          summary: "Cross workspace group collision",
          on_accept_effect: "A",
          on_decline_effect: "B",
        },
      ],
    });
    expect(ws2Collide.isError).toBe(true);
    expect(ws2Collide.data["code"]).toBe("VALIDATION_ERROR");

    // B2: supersede_proposal from task.status === "running" MUST require valid lease AND delete work_leases!
    await fx.db.orm
      .update(schema.tasks)
      .set({ status: "ready", version: 8 })
      .where(eq(schema.tasks.id, taskId));
    const claimForSupersede = await callMcpTool(fx.app, winnerToken, "claim_task", {
      request_id: "req-claim-sup",
      task_id: taskId,
      expected_version: 8,
    });
    const supLease = String(claimForSupersede.data["lease_token"]);

    // Missing lease_token from running -> LEASE_CONFLICT
    const noLeaseSup = await callMcpTool(fx.app, winnerToken, "supersede_proposal", {
      request_id: "req-sup-nolease",
      task_id: taskId,
      expected_version: 9,
      target_card_id: card1Id,
      replacement: {
        card_type: "choice",
        selection_mode: "binary",
        title: "No lease",
        summary: "Fail",
        on_accept_effect: "A",
        on_decline_effect: "B",
        on_decline_policy: "revise",
      },
    });
    expect(noLeaseSup.isError).toBe(true);
    expect(noLeaseSup.data["code"]).toBe("LEASE_CONFLICT");

    // Mismatched on_decline_policy vs group ("block" vs "revise") -> VALIDATION_ERROR
    const badPolicySup = await callMcpTool(fx.app, winnerToken, "supersede_proposal", {
      request_id: "req-sup-badpol",
      task_id: taskId,
      expected_version: 9,
      target_card_id: card1Id,
      lease_token: supLease,
      replacement: {
        card_type: "choice",
        selection_mode: "binary",
        title: "Wrong policy",
        summary: "Fail",
        on_accept_effect: "A",
        on_decline_effect: "B",
        on_decline_policy: "block",
      },
    });
    expect(badPolicySup.isError).toBe(true);
    expect(badPolicySup.data["code"]).toBe("VALIDATION_ERROR");

    // Valid supersede from running -> succeeds, transitions waiting_human, AND releases work_leases!
    const validSupRunning = await callMcpTool(fx.app, winnerToken, "supersede_proposal", {
      request_id: "req-sup-running-ok",
      task_id: taskId,
      expected_version: 9,
      target_card_id: card1Id,
      lease_token: supLease,
      replacement: {
        card_type: "choice",
        selection_mode: "binary",
        title: "Choice A Revised",
        summary: "Revised",
        on_accept_effect: "Do A2",
        on_decline_effect: "Skip A2",
        on_decline_policy: "revise",
        target_artifact_id: artId,
      },
    });
    expect(validSupRunning.isError).toBe(false);
    const card2Id = String(validSupRunning.data["replacement_card_id"]);

    const leaseAfterSup = await fx.db.orm
      .select()
      .from(schema.workLeases)
      .where(eq(schema.workLeases.taskId, taskId))
      .get();
    expect(leaseAfterSup).toBeUndefined();

    // Minor 1: get_task active_cards excludes superseded card1 and includes only active card2
    const taskDetail = await callMcpTool(fx.app, winnerToken, "get_task", { task_id: taskId });
    expect(taskDetail.isError).toBe(false);
    const activeCards = taskDetail.data["active_cards"];
    expect(Array.isArray(activeCards) && activeCards.length === 1).toBe(true);

    // M3 & M5: list_decision_results pagination + canceled/provisional exclusion + record_result rejecting non-finalized/cross-task decision_id
    await fx.db.orm.insert(schema.decisions).values([
      {
        id: "dec-canceled-1",
        cardId: card1Id,
        actorUserId: "user-1",
        result: "accepted",
        status: "canceled",
        cardVersion: 2,
        provisionalAt: 1_760_000_011_000,
        canceledAt: 1_760_000_012_000,
      },
      {
        id: "dec-fin-1",
        cardId: card2Id,
        actorUserId: "user-1",
        result: "accepted",
        status: "finalized",
        cardVersion: 2,
        finalizedTaskVersion: 10,
        provisionalAt: 1_760_000_015_000,
        finalizedAt: 1_760_000_020_000,
      },
    ]);
    await fx.db.orm
      .update(schema.decisionCards)
      .set({ status: "accepted", version: 2 })
      .where(eq(schema.decisionCards.id, card2Id));

    // Add second finalized decision to test cursor pagination (limit: 1)
    await fx.db.orm.insert(schema.proposals).values({
      id: "prop-extra-fin",
      workspaceId: "ws-1",
      taskId,
      proposerBotId: "bot-worker-1",
      cardType: "policy",
      selectionMode: "binary",
      title: "Extra finalized",
      summary: "Extra",
      onAcceptEffect: "A",
      onDeclineEffect: "B",
      onDeclinePolicy: "revise",
      factorsJson: "[]",
      targetTaskVersion: 10,
      payloadHash: "h-extra",
      createdAt: 1_760_000_021_000,
    });
    await fx.db.orm.insert(schema.decisionCards).values({
      id: "card-extra-fin",
      workspaceId: "ws-1",
      proposalId: "prop-extra-fin",
      status: "declined",
      version: 2,
      createdAt: 1_760_000_021_000,
      updatedAt: 1_760_000_025_000,
    });
    await fx.db.orm.insert(schema.decisions).values({
      id: "dec-fin-2",
      cardId: "card-extra-fin",
      actorUserId: "user-1",
      result: "declined",
      status: "finalized",
      cardVersion: 2,
      finalizedTaskVersion: 10,
      provisionalAt: 1_760_000_022_000,
      finalizedAt: 1_760_000_025_000,
    });

    const decPage1 = await callMcpTool(fx.app, winnerToken, "list_decision_results", {
      task_id: taskId,
      limit: 1,
    });
    expect(decPage1.isError).toBe(false);
    expect(Array.isArray(decPage1.data["items"]) && decPage1.data["items"].length === 1).toBe(true);
    expect(typeof decPage1.data["next_cursor"]).toBe("string");

    const decPage2 = await callMcpTool(fx.app, winnerToken, "list_decision_results", {
      task_id: taskId,
      limit: 1,
      cursor: String(decPage1.data["next_cursor"]),
    });
    expect(decPage2.isError).toBe(false);
    expect(Array.isArray(decPage2.data["items"]) && decPage2.data["items"].length === 1).toBe(true);
    expect(decPage2.data["next_cursor"]).toBeNull();

    // Non-canonical cursor ("1e5:id") rejected with VALIDATION_ERROR (Minor 7)
    const badCursor = await callMcpTool(fx.app, winnerToken, "list_decision_results", {
      cursor: "1e5:dec-1",
    });
    expect(badCursor.isError).toBe(true);
    expect(badCursor.data["code"]).toBe("VALIDATION_ERROR");

    // Re-claim task and verify record_result rejects canceled decision_id & cross-workspace decision_id
    await fx.db.orm
      .update(schema.tasks)
      .set({ status: "ready", version: 11 })
      .where(eq(schema.tasks.id, taskId));
    const claimForRec = await callMcpTool(fx.app, winnerToken, "claim_task", {
      request_id: "req-claim-rec",
      task_id: taskId,
      expected_version: 11,
    });
    const recLease = String(claimForRec.data["lease_token"]);

    const canceledDecRec = await callMcpTool(fx.app, winnerToken, "record_result", {
      request_id: "req-rec-canceled",
      task_id: taskId,
      expected_version: 12,
      lease_token: recLease,
      outcome: "failed",
      decision_id: "dec-canceled-1",
    });
    expect(canceledDecRec.isError).toBe(true);
    expect(canceledDecRec.data["code"]).toBe("INVALID_TRANSITION");

    // Seed a cross-workspace finalized decision (ws-2) and verify record_result rejects it with NOT_FOUND
    const ws2TaskRes = await callMcpTool(fx.app, fx.workerTokenWs2, "create_task", {
      request_id: "req-ws2-dec-task",
      title: "WS2 private task",
    });
    expect(ws2TaskRes.isError).toBe(false);
    const ws2DecTaskId = String(ws2TaskRes.data["task_id"]);
    await fx.db.orm.insert(schema.proposals).values({
      id: "prop-ws2-fin",
      workspaceId: "ws-2",
      taskId: ws2DecTaskId,
      proposerBotId: "bot-worker-ws2",
      cardType: "policy",
      selectionMode: "binary",
      title: "WS2 proposal",
      summary: "WS2 summary",
      onAcceptEffect: "A",
      onDeclineEffect: "B",
      onDeclinePolicy: "revise",
      factorsJson: "[]",
      targetTaskVersion: 1,
      payloadHash: "h-ws2",
      createdAt: 1_760_000_021_000,
    });
    await fx.db.orm.insert(schema.decisionCards).values({
      id: "card-ws2-fin",
      workspaceId: "ws-2",
      proposalId: "prop-ws2-fin",
      status: "accepted",
      version: 2,
      createdAt: 1_760_000_021_000,
      updatedAt: 1_760_000_025_000,
    });
    await fx.db.orm.insert(schema.decisions).values({
      id: "dec-ws2-fin",
      cardId: "card-ws2-fin",
      actorUserId: "user-2",
      result: "accepted",
      status: "finalized",
      cardVersion: 2,
      finalizedTaskVersion: 1,
      provisionalAt: 1_760_000_022_000,
      finalizedAt: 1_760_000_025_000,
    });

    const crossWsDecRec = await callMcpTool(fx.app, winnerToken, "record_result", {
      request_id: "req-rec-cross-ws",
      task_id: taskId,
      expected_version: 12,
      lease_token: recLease,
      outcome: "failed",
      decision_id: "dec-ws2-fin",
    });
    expect(crossWsDecRec.isError).toBe(true);
    expect(crossWsDecRec.data["code"]).toBe("NOT_FOUND");

    // Empty status_reason falls back to non-empty failure reason (Minor 4)
    const failedFallback = await callMcpTool(fx.app, winnerToken, "record_result", {
      request_id: "req-rec-fail-fallback",
      task_id: taskId,
      expected_version: 12,
      lease_token: recLease,
      outcome: "failed",
      status_reason: "   ",
      summary: "Model step timed out",
      decision_id: "dec-fin-1",
    });
    expect(failedFallback.isError).toBe(false);
    const savedFailedTask = await fx.db.orm
      .select({ statusReason: schema.tasks.statusReason })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(savedFailedTask?.statusReason).toBe("Model step timed out");
  });

  test("executes full 12-tool happy path with pagination, renew_lease, get_artifact, single/multi proposals, DEC-01 provisional blocks, BOT-03 approval guard, and concurrent conflicting UPDATE idempotency", async () => {
    const fx = await setupMcpFixture();

    // 1. get_workspace_context
    const wsCtx = await callMcpTool(fx.app, fx.workerTokenWs1, "get_workspace_context", {});
    expect(wsCtx.isError).toBe(false);
    expect(wsCtx.data["workspace_id"]).toBe("ws-1");

    // 2. Create 3 tasks (2 approval-required, 1 auto-done) & verify list_tasks cursor pagination + status filter
    const t1 = await callMcpTool(fx.app, fx.workerTokenWs1, "create_task", {
      request_id: "req-full-t1",
      title: "App concept & competitor research",
      requires_approval: true,
    });
    expect(t1.isError).toBe(false);
    const approvalTaskId = String(t1.data["task_id"]);

    fx.setNow(1_760_000_001_000);
    const t2 = await callMcpTool(fx.app, fx.workerTokenWs1, "create_task", {
      request_id: "req-full-t2",
      title: "Collect pricing matrix",
      requires_approval: false,
    });
    expect(t2.isError).toBe(false);
    const autoDoneTaskId = String(t2.data["task_id"]);

    fx.setNow(1_760_000_002_000);
    const t3 = await callMcpTool(fx.app, fx.workerTokenWs1, "create_task", {
      request_id: "req-full-t3",
      title: "Draft onboarding copy",
      requires_approval: true,
    });
    expect(t3.isError).toBe(false);
    const thirdTaskId = String(t3.data["task_id"]);

    const listPage1 = await callMcpTool(fx.app, fx.workerTokenWs1, "list_tasks", {
      status: "ready",
      limit: 2,
    });
    expect(listPage1.isError).toBe(false);
    const page1Items: readonly unknown[] = Array.isArray(listPage1.data["items"])
      ? listPage1.data["items"]
      : [];
    expect(page1Items).toHaveLength(2);
    expect(typeof listPage1.data["next_cursor"]).toBe("string");

    const listPage2 = await callMcpTool(fx.app, fx.workerTokenWs1, "list_tasks", {
      status: "ready",
      limit: 2,
      cursor: String(listPage1.data["next_cursor"]),
    });
    expect(listPage2.isError).toBe(false);
    const page2Items: readonly unknown[] = Array.isArray(listPage2.data["items"])
      ? listPage2.data["items"]
      : [];
    expect(page2Items).toHaveLength(1);
    expect(listPage2.data["next_cursor"]).toBeNull();

    const listedIds = [...page1Items, ...page2Items].map((item: unknown) =>
      item !== null && typeof item === "object" ? String(Reflect.get(item, "id")) : "",
    );
    expect(new Set(listedIds)).toEqual(new Set([approvalTaskId, autoDoneTaskId, thirdTaskId]));

    // 3. claim_task + renew_lease happy path + get_task never leaks lease_token to another Bot
    const claimApproval = await callMcpTool(fx.app, fx.workerTokenWs1, "claim_task", {
      request_id: "req-full-claim-1",
      task_id: approvalTaskId,
      expected_version: 1,
      lease_duration_seconds: 60,
    });
    expect(claimApproval.isError).toBe(false);
    const approvalLease = String(claimApproval.data["lease_token"]);
    const initialLeaseExpiry = Number(claimApproval.data["lease_expires_at"]);

    fx.setNow(1_760_000_020_000);
    const renewed = await callMcpTool(fx.app, fx.workerTokenWs1, "renew_lease", {
      request_id: "req-full-renew-1",
      task_id: approvalTaskId,
      lease_token: approvalLease,
      lease_duration_seconds: 120,
    });
    expect(renewed.isError).toBe(false);
    expect(renewed.data["task_id"]).toBe(approvalTaskId);
    expect(Number(renewed.data["lease_expires_at"])).toBeGreaterThan(initialLeaseExpiry);

    // Other bot calls get_task -> active_lease exposes bot/expiry ONLY, never lease_token
    const otherBotRead = await callMcpTool(fx.app, fx.worker2TokenWs1, "get_task", {
      task_id: approvalTaskId,
    });
    expect(otherBotRead.isError).toBe(false);
    expect(JSON.stringify(otherBotRead.data)).not.toContain(approvalLease);
    const activeLeaseObj = otherBotRead.data["active_lease"];
    expect(activeLeaseObj !== null && typeof activeLeaseObj === "object").toBe(true);
    if (activeLeaseObj !== null && typeof activeLeaseObj === "object") {
      expect(Reflect.has(activeLeaseObj, "lease_token")).toBe(false);
      expect(Reflect.get(activeLeaseObj, "bot_id")).toBe("bot-worker-1");
    }

    // 4. Concurrent Promise.all UPDATE-based write with SAME request_id and CONFLICTING payloads -> 1 succeeds, loser gets IDEMPOTENCY_CONFLICT (never VERSION_CONFLICT)
    const [updA, updB] = await Promise.all([
      callMcpTool(fx.app, fx.workerTokenWs1, "update_task", {
        request_id: "req-full-concurrent-conflict",
        task_id: approvalTaskId,
        expected_version: 2,
        lease_token: approvalLease,
        description: "Variant A description",
        artifact: {
          title: "Competitor Research Draft",
          kind: "markdown",
          summary: "Initial draft v1",
          content_or_url: "# Draft v1\nCompetitor A vs B",
        },
      }),
      callMcpTool(fx.app, fx.workerTokenWs1, "update_task", {
        request_id: "req-full-concurrent-conflict",
        task_id: approvalTaskId,
        expected_version: 2,
        lease_token: approvalLease,
        description: "Conflicting Variant B description",
      }),
    ]);
    const conflictResults = [updA, updB];
    const updateWinner = conflictResults.find((r) => !r.isError);
    const updateLoser = conflictResults.find((r) => r.isError);
    expect(updateWinner).toBeDefined();
    expect(updateLoser).toBeDefined();
    expect(updateLoser?.data["code"]).toBe("IDEMPOTENCY_CONFLICT");

    // Ensure artifact v1 exists (if updB won race, create artifact cleanly via next update)
    let artifactId =
      typeof updateWinner?.data["artifact_id"] === "string" ? updateWinner.data["artifact_id"] : "";
    let approvalTaskVersion = Number(updateWinner?.data["version"]);
    if (artifactId === "") {
      const addArt = await callMcpTool(fx.app, fx.workerTokenWs1, "update_task", {
        request_id: "req-full-add-art",
        task_id: approvalTaskId,
        expected_version: approvalTaskVersion,
        lease_token: approvalLease,
        artifact: {
          title: "Competitor Research Draft",
          kind: "markdown",
          summary: "Initial draft v1",
          content_or_url: "# Draft v1\nCompetitor A vs B",
        },
      });
      expect(addArt.isError).toBe(false);
      artifactId = String(addArt.data["artifact_id"]);
      approvalTaskVersion = Number(addArt.data["version"]);
    }

    // 5. get_artifact happy path
    const fetchedArt = await callMcpTool(fx.app, fx.workerTokenWs1, "get_artifact", {
      artifact_id: artifactId,
    });
    expect(fetchedArt.isError).toBe(false);
    expect(fetchedArt.data["version"]).toBe(1);
    expect(fetchedArt.data["title"]).toBe("Competitor Research Draft");
    expect(fetchedArt.data["content_or_url"]).toBe("# Draft v1\nCompetitor A vs B");

    // 6. BOT-03: record_result(outcome: "success") MUST be rejected on requires_approval = true
    const illegalDone = await callMcpTool(fx.app, fx.workerTokenWs1, "record_result", {
      request_id: "req-full-illegal-done",
      task_id: approvalTaskId,
      expected_version: approvalTaskVersion,
      lease_token: approvalLease,
      outcome: "success",
      summary: "Attempt bypass approval",
    });
    expect(illegalDone.isError).toBe(true);
    expect(illegalDone.data["code"]).toBe("INVALID_TRANSITION");

    // 7. Create a ws-2 artifact to verify cross-workspace target_artifact_id rejection on submit_proposal & supersede_proposal
    const ws2Task = await callMcpTool(fx.app, fx.workerTokenWs2, "create_task", {
      request_id: "req-full-ws2-t",
      title: "WS2 Task",
    });
    const ws2TaskId = String(ws2Task.data["task_id"]);
    const ws2Claim = await callMcpTool(fx.app, fx.workerTokenWs2, "claim_task", {
      request_id: "req-full-ws2-claim",
      task_id: ws2TaskId,
      expected_version: 1,
    });
    const ws2Upd = await callMcpTool(fx.app, fx.workerTokenWs2, "update_task", {
      request_id: "req-full-ws2-art",
      task_id: ws2TaskId,
      expected_version: 2,
      lease_token: String(ws2Claim.data["lease_token"]),
      artifact: {
        title: "WS2 Secret Doc",
        kind: "markdown",
        summary: "Private",
        content_or_url: "secret",
      },
    });
    const ws2ArtifactId = String(ws2Upd.data["artifact_id"]);

    const crossWsSubmit = await callMcpTool(fx.app, fx.workerTokenWs1, "submit_proposal", {
      request_id: "req-full-cross-art-submit",
      task_id: approvalTaskId,
      expected_version: approvalTaskVersion,
      lease_token: approvalLease,
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Cross-WS artifact probe",
          summary: "Should fail NOT_FOUND",
          on_accept_effect: "Proceed",
          on_decline_effect: "Revise",
          target_artifact_id: ws2ArtifactId,
        },
      ],
    });
    expect(crossWsSubmit.isError).toBe(true);
    expect(crossWsSubmit.data["code"]).toBe("NOT_FOUND");

    // 8. submit_proposal rejects mismatched on_decline_policy in a multi-proposal group
    const mismatchedPolicy = await callMcpTool(fx.app, fx.workerTokenWs1, "submit_proposal", {
      request_id: "req-full-bad-policy",
      task_id: approvalTaskId,
      expected_version: approvalTaskVersion,
      lease_token: approvalLease,
      selection_group_id: "grp-mismatch",
      proposals: [
        {
          card_type: "choice",
          selection_mode: "single",
          options: [
            {
              id: "opt-a",
              title: "Option A",
              summary: "Primary option",
              meta: "Fast",
              recommended: true,
            },
            {
              id: "opt-b",
              title: "Option B",
              summary: "Secondary option",
              meta: "Safe",
            },
          ],
          title: "Candidate 1",
          summary: "First candidate",
          on_accept_effect: "Use A",
          on_decline_effect: "Revise",
          on_decline_policy: "revise",
        },
        {
          card_type: "choice",
          selection_mode: "multi",
          options: [
            {
              id: "f-1",
              title: "Feature 1",
              summary: "First feature",
              meta: "Low risk",
              recommended: true,
            },
            {
              id: "f-2",
              title: "Feature 2",
              summary: "Second feature",
              meta: "Medium risk",
            },
          ],
          title: "Candidate 2",
          summary: "Second candidate",
          on_accept_effect: "Adopt checked",
          on_decline_effect: "Block",
          on_decline_policy: "block",
        },
      ],
    });
    expect(mismatchedPolicy.isError).toBe(true);
    expect(mismatchedPolicy.data["code"]).toBe("VALIDATION_ERROR");

    // 9. submit_proposal happy path with single + multi selection modes AND artifact v2 update
    const groupSubmit = await callMcpTool(fx.app, fx.workerTokenWs1, "submit_proposal", {
      request_id: "req-full-submit-group",
      task_id: approvalTaskId,
      expected_version: approvalTaskVersion,
      lease_token: approvalLease,
      selection_group_id: "grp-happy-1",
      artifact: {
        id: artifactId,
        expected_version: 1,
        title: "Competitor Research Draft",
        kind: "markdown",
        summary: "Updated draft v2",
        content_or_url: "# Draft v2\nExpanded analysis",
      },
      proposals: [
        {
          card_type: "choice",
          selection_mode: "single",
          options: [
            {
              id: "opt-sp",
              title: "Mobile-first swipe",
              summary: "Optimize for 360px thumb flow",
              meta: "MVP fit",
              recommended: true,
            },
            {
              id: "opt-pc",
              title: "Desktop kanban",
              summary: "Wide multi-column view first",
              meta: "Secondary",
            },
          ],
          title: "Which UX direction first?",
          summary: "Choose primary MVP UX direction",
          on_accept_effect: "Implement selected UX direction",
          on_decline_effect: "Propose alternative",
          on_decline_policy: "revise",
        },
        {
          card_type: "policy",
          selection_mode: "multi",
          options: [
            {
              id: "chk-undo",
              title: "5s undo window",
              summary: "Allow 5-second undo before finalization",
              meta: "DEC-01",
              recommended: true,
            },
            {
              id: "chk-kbd",
              title: "Keyboard shortcuts",
              summary: "Full PC arrow & number key parity",
              meta: "UX-05",
              recommended: true,
            },
          ],
          title: "Which safeguards to bundle?",
          summary: "Select safeguards to include in v1",
          on_accept_effect: "Enable selected safeguards",
          on_decline_effect: "Re-scope safeguards",
          on_decline_policy: "revise",
        },
      ],
    });
    expect(groupSubmit.isError).toBe(false);
    expect(groupSubmit.data["artifact_version"]).toBe(2);
    const submittedCards: readonly unknown[] = Array.isArray(groupSubmit.data["cards"])
      ? groupSubmit.data["cards"]
      : [];
    expect(submittedCards).toHaveLength(2);
    const card1Id =
      submittedCards[0] !== null && typeof submittedCards[0] === "object"
        ? String(Reflect.get(submittedCards[0], "card_id"))
        : "";
    const card2Id =
      submittedCards[1] !== null && typeof submittedCards[1] === "object"
        ? String(Reflect.get(submittedCards[1], "card_id"))
        : "";
    const waitingTaskVersion = Number(groupSubmit.data["task_version"]);

    // Verify artifact v2 persisted via get_artifact
    const artV2 = await callMcpTool(fx.app, fx.workerTokenWs1, "get_artifact", {
      artifact_id: artifactId,
    });
    expect(artV2.isError).toBe(false);
    expect(artV2.data["version"]).toBe(2);
    expect(artV2.data["content_or_url"]).toBe("# Draft v2\nExpanded analysis");

    // 10. supersede_proposal rejects cross-workspace target_artifact_id (NOT_FOUND)
    const crossWsSupersede = await callMcpTool(fx.app, fx.workerTokenWs1, "supersede_proposal", {
      request_id: "req-full-cross-art-sup",
      task_id: approvalTaskId,
      target_card_id: card1Id,
      expected_version: waitingTaskVersion,
      replacement: {
        card_type: "policy",
        selection_mode: "binary",
        title: "Cross-WS supersede probe",
        summary: "Should fail NOT_FOUND",
        on_accept_effect: "Proceed",
        on_decline_effect: "Revise",
        target_artifact_id: ws2ArtifactId,
      },
    });
    expect(crossWsSupersede.isError).toBe(true);
    expect(crossWsSupersede.data["code"]).toBe("NOT_FOUND");

    // 11. DEC-01: Put card1 into provisional status + provisional decision ->
    //     (a) supersede_proposal on card1 itself fails INVALID_TRANSITION + retryable: true
    //     (b) supersede_proposal on sibling card2 in same selection_group_id ALSO fails INVALID_TRANSITION + retryable: true
    //     (c) list_decision_results excludes provisional decision
    await fx.db.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: 1_760_000_025_000,
        version: 2,
      })
      .where(eq(schema.decisionCards.id, card1Id));
    await fx.db.orm.insert(schema.decisions).values({
      id: "dec-provisional-1",
      cardId: card1Id,
      actorUserId: "user-1",
      result: "accepted",
      selectedOptionIdsJson: JSON.stringify(["opt-sp"]),
      status: "provisional",
      cardVersion: 2,
      provisionalAt: 1_760_000_020_000,
    });

    const supProvisionalSelf = await callMcpTool(fx.app, fx.workerTokenWs1, "supersede_proposal", {
      request_id: "req-full-sup-prov-self",
      task_id: approvalTaskId,
      target_card_id: card1Id,
      expected_version: waitingTaskVersion,
      replacement: {
        card_type: "policy",
        selection_mode: "binary",
        title: "Should be blocked during provisional",
        summary: "DEC-01 guard",
        on_accept_effect: "A",
        on_decline_effect: "B",
      },
    });
    expect(supProvisionalSelf.isError).toBe(true);
    expect(supProvisionalSelf.data["code"]).toBe("INVALID_TRANSITION");
    expect(supProvisionalSelf.data["retryable"]).toBe(true);

    const supProvisionalSibling = await callMcpTool(
      fx.app,
      fx.workerTokenWs1,
      "supersede_proposal",
      {
        request_id: "req-full-sup-prov-sibling",
        task_id: approvalTaskId,
        target_card_id: card2Id,
        expected_version: waitingTaskVersion,
        replacement: {
          card_type: "policy",
          selection_mode: "binary",
          title: "Sibling blocked while group has provisional card",
          summary: "DEC-01 sibling guard",
          on_accept_effect: "A",
          on_decline_effect: "B",
        },
      },
    );
    expect(supProvisionalSibling.isError).toBe(true);
    expect(supProvisionalSibling.data["code"]).toBe("INVALID_TRANSITION");
    expect(supProvisionalSibling.data["retryable"]).toBe(true);

    const decResultsWhileProvisional = await callMcpTool(
      fx.app,
      fx.workerTokenWs1,
      "list_decision_results",
      { task_id: approvalTaskId, only_unconsumed: true },
    );
    expect(decResultsWhileProvisional.isError).toBe(false);
    expect(decResultsWhileProvisional.data["items"]).toEqual([]);

    // 12. record_result rejects cross-task decision_id (NOT_FOUND) and same-task provisional decision_id (INVALID_TRANSITION, DEC-01)
    const claimAuto = await callMcpTool(fx.app, fx.workerTokenWs1, "claim_task", {
      request_id: "req-full-claim-auto",
      task_id: autoDoneTaskId,
      expected_version: 1,
    });
    expect(claimAuto.isError).toBe(false);
    const autoLease = String(claimAuto.data["lease_token"]);

    const recWrongTaskDec = await callMcpTool(fx.app, fx.workerTokenWs1, "record_result", {
      request_id: "req-full-rec-wrong-task",
      task_id: autoDoneTaskId,
      expected_version: 2,
      lease_token: autoLease,
      outcome: "ready",
      decision_id: "dec-provisional-1",
    });
    expect(recWrongTaskDec.isError).toBe(true);
    expect(recWrongTaskDec.data["code"]).toBe("NOT_FOUND");

    await fx.db.orm
      .update(schema.tasks)
      .set({ status: "ready", version: waitingTaskVersion + 1 })
      .where(eq(schema.tasks.id, approvalTaskId));
    const claimApprovalAgain = await callMcpTool(fx.app, fx.workerTokenWs1, "claim_task", {
      request_id: "req-full-claim-after-fin",
      task_id: approvalTaskId,
      expected_version: waitingTaskVersion + 1,
    });
    expect(claimApprovalAgain.isError).toBe(false);
    const approvalLease2 = String(claimApprovalAgain.data["lease_token"]);

    const recProvisionalDec = await callMcpTool(fx.app, fx.workerTokenWs1, "record_result", {
      request_id: "req-full-rec-prov-dec",
      task_id: approvalTaskId,
      expected_version: waitingTaskVersion + 2,
      lease_token: approvalLease2,
      outcome: "ready",
      decision_id: "dec-provisional-1",
    });
    expect(recProvisionalDec.isError).toBe(true);
    expect(recProvisionalDec.data["code"]).toBe("INVALID_TRANSITION");

    // 13. Finalize dec-provisional-1 -> visible in list_decision_results(only_unconsumed: true) ->
    //     consumed via record_result -> excluded from only_unconsumed: true afterward
    await fx.db.orm
      .update(schema.decisionCards)
      .set({ status: "accepted", version: 3, updatedAt: 1_760_000_026_000 })
      .where(eq(schema.decisionCards.id, card1Id));
    await fx.db.orm
      .update(schema.decisions)
      .set({
        status: "finalized",
        cardVersion: 3,
        finalizedTaskVersion: waitingTaskVersion,
        finalizedAt: 1_760_000_026_000,
      })
      .where(eq(schema.decisions.id, "dec-provisional-1"));

    const unconsumedBefore = await callMcpTool(fx.app, fx.workerTokenWs1, "list_decision_results", {
      task_id: approvalTaskId,
      only_unconsumed: true,
    });
    expect(unconsumedBefore.isError).toBe(false);
    expect(
      Array.isArray(unconsumedBefore.data["items"]) && unconsumedBefore.data["items"].length === 1,
    ).toBe(true);

    const consumeRes = await callMcpTool(fx.app, fx.workerTokenWs1, "record_result", {
      request_id: "req-full-consume-fin",
      task_id: approvalTaskId,
      expected_version: waitingTaskVersion + 2,
      lease_token: approvalLease2,
      outcome: "ready",
      summary: "Applied accepted direction and queued next step",
      decision_id: "dec-provisional-1",
    });
    expect(consumeRes.isError).toBe(false);
    expect(consumeRes.data["consumed_decision_id"]).toBe("dec-provisional-1");

    const unconsumedAfter = await callMcpTool(fx.app, fx.workerTokenWs1, "list_decision_results", {
      task_id: approvalTaskId,
      only_unconsumed: true,
    });
    expect(unconsumedAfter.isError).toBe(false);
    expect(unconsumedAfter.data["items"]).toEqual([]);

    // 14. requires_approval=false auto-done happy path with artifact creation
    const done = await callMcpTool(fx.app, fx.workerTokenWs1, "record_result", {
      request_id: "req-happy-done",
      task_id: autoDoneTaskId,
      expected_version: 2,
      lease_token: autoLease,
      outcome: "success",
      summary: "Done cleanly",
      artifact: {
        title: "Pricing CSV",
        kind: "csv",
        summary: "3 competitors",
        content_or_url: "name,price\nA,10\nB,20",
      },
    });
    expect(done.isError).toBe(false);
    expect(done.data["status"]).toBe("done");
    expect(done.data["artifact_version"]).toBe(1);
  });
});
