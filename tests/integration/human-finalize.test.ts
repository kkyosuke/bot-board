import { afterEach, describe, expect, test } from "bun:test";

import { type Message, type MessageBatch } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";

import {
  assertAllowedOwnerGithubProfile,
  createBetterAuth,
  ensureOwnerWorkspace,
  parseTrustedOrigins,
} from "@/auth/better-auth";
import { authenticateOwnerRequest, verifyOwnerSessionContext } from "@/auth/owner";
import { hashOAuthOpaqueToken } from "@/auth/token-hash";
import { createD1Database, type D1LikeDatabase, schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import { DEFAULT_BUDGET_LIMIT, serializeBudgetLimit } from "@/domain";
import { createApp } from "@/server/app";
import { handleWorkerHttpRequest } from "@/server/http-runtime";
import { createMemoryRateLimiter } from "@/server/rate-limit";
import { mountAuthRoutes } from "@/server/routes/auth";
import { mountHumanRoutes } from "@/server/routes/human";
import { mountMcpRoutes } from "@/server/routes/mcp";
import { createHumanServicePort } from "@/services/human";
import {
  type BotWorkQueuePayload,
  type DecisionFinalizeQueuePayload,
  finalizeDecisionCard,
  type QueueSendOptions,
} from "@/services/system";
import workerHandler, { handleDecisionFinalizeBatch, type WorkerRuntimeEnv } from "@/worker";
import { createMcpBotServicePort } from "@/worker/mcp-port";

const openDbs: SqliteAppDatabase[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

const ORIGIN = "https://board.example.test";
const OWNER_GITHUB_ID = "github-owner-42";
const AUTH_SECRET = "super-secret-better-auth-test-key-0123456789";
const D1_MAX_SQL_VARIABLES = 100;

interface RecordedQueueMsg<T> {
  readonly body: T;
  readonly options?: QueueSendOptions;
}

interface HumanFixture {
  readonly db: SqliteAppDatabase;
  readonly app: ReturnType<typeof createApp>;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly ownerCookie: string;
  readonly bot1Id: string;
  readonly bot1Token: string;
  readonly finalizeSent: RecordedQueueMsg<DecisionFinalizeQueuePayload>[];
  readonly botWorkSent: RecordedQueueMsg<BotWorkQueuePayload>[];
  readonly getNow: () => number;
  readonly setNow: (ms: number) => void;
}

async function signBetterAuthSessionCookie(
  sessionToken: string,
  secret = AUTH_SECRET,
  secure = true,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionToken));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  const cookieName = secure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
  return `${cookieName}=${encodeURIComponent(`${sessionToken}.${sigB64}`)}`;
}

function normalizeTestParam(v: unknown): string | number | null | Uint8Array {
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "string" || typeof v === "number" || v instanceof Uint8Array) {
    return v;
  }
  if (v instanceof Date) {
    return v.getTime();
  }
  return JSON.stringify(v);
}

interface AtomicD1PreparedStatement {
  readonly __sql: string;
  readonly __params: readonly (string | number | null | Uint8Array)[];
  bind(...values: unknown[]): AtomicD1PreparedStatement;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
  raw(): Promise<unknown[][]>;
}

function assertD1BindParamLimit(sql: string, params: readonly unknown[]): void {
  if (params.length > D1_MAX_SQL_VARIABLES) {
    throw new Error(
      `D1 SQL variable limit exceeded (${params.length} > ${D1_MAX_SQL_VARIABLES}) for SQL: ${sql.slice(0, 120)}`,
    );
  }
}

/**
 * Atomic sqlite-backed D1 test double (Minor 4 + M2):
 * - Executes batch() inside a single SQLite transaction via db.executor.batch(...) so _batch_guard rolls back cleanly.
 * - Enforces Cloudflare D1's 100 SQL bind-parameter limit mechanically on every statement.
 */
function createSqliteBackedD1(db: SqliteAppDatabase): D1LikeDatabase {
  const buildStmt = (
    query: string,
    bound: readonly (string | number | null | Uint8Array)[] = [],
  ): AtomicD1PreparedStatement => ({
    __sql: query,
    __params: bound,
    bind(...values: unknown[]) {
      const normalized = values.map(normalizeTestParam);
      assertD1BindParamLimit(query, normalized);
      return buildStmt(query, normalized);
    },
    async run() {
      assertD1BindParamLimit(query, bound);
      const res = await db.executor.batch([{ sql: query, params: bound }]);
      return { meta: { changes: res[0]?.changes ?? 0 } };
    },
    async raw(): Promise<unknown[][]> {
      assertD1BindParamLimit(query, bound);
      const res = await db.executor.query(query, bound, "all");
      return res.rows.map((row): unknown[] => {
        if (Array.isArray(row)) {
          const typed: readonly unknown[] = row;
          return [...typed];
        }
        return [row];
      });
    },
  });

  return {
    prepare(query: string) {
      return buildStmt(query);
    },
    async batch(statements) {
      const rawBatch: {
        readonly sql: string;
        readonly params: readonly (string | number | null | Uint8Array)[];
      }[] = [];
      for (const s of statements) {
        const sql: unknown = Reflect.get(s, "__sql");
        const params: unknown = Reflect.get(s, "__params");
        if (typeof sql !== "string" || !Array.isArray(params)) {
          throw new Error("Expected statement created by createSqliteBackedD1.prepare()");
        }
        const typedParams: readonly unknown[] = params;
        const normalized = typedParams.map(normalizeTestParam);
        assertD1BindParamLimit(sql, normalized);
        rawBatch.push({ sql, params: normalized });
      }
      const batchRes = await db.executor.batch(rawBatch);
      return batchRes.map((r) => ({ meta: { changes: r.changes } }));
    },
    async exec(query: string) {
      await db.executor.exec(query);
    },
  };
}

function createMessageBatchStub(
  queue: string,
  messages: readonly Message[],
  timestampMs: number,
): MessageBatch {
  return {
    queue,
    messages: [...messages],
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: messages.length * 64,
        oldestMessageTimestamp: new Date(timestampMs),
      },
    },
    ackAll() {},
    retryAll() {},
  };
}

async function setupHumanFixture(options?: {
  readonly rateLimit?: number;
  readonly ownerGithubId?: string;
  readonly enableMcpOAuth?: boolean;
}): Promise<HumanFixture> {
  const sqliteDb = createSqliteDatabase(":memory:");
  openDbs.push(sqliteDb);
  await sqliteDb.applyMigrations();

  // Route ALL DB queries through the D1 adapter to also enforce the 100-variable limit on every test!
  const db = createD1Database(createSqliteBackedD1(sqliteDb));

  let currentNow = 1_760_100_000_000;
  const ownerUserId = "user-owner-1";
  const ownerSessionToken = "sess_owner_valid_token_real_cookie_1";
  const ownerSessionId = "session-owner-1";

  await sqliteDb.orm.insert(schema.user).values({
    id: ownerUserId,
    name: "Workspace Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt: new Date(currentNow),
    updatedAt: new Date(currentNow),
  });

  await sqliteDb.orm.insert(schema.account).values({
    id: "acc-owner-gh",
    accountId: OWNER_GITHUB_ID,
    providerId: "github",
    userId: ownerUserId,
    createdAt: new Date(currentNow),
    updatedAt: new Date(currentNow),
  });

  // Real Better Auth session expiry must be in the future relative to real Date.now()
  // because Better Auth's internal session lookup checks expiresAt > new Date()
  const realFutureExpiry = new Date(Date.now() + 86_400_000);
  await sqliteDb.orm.insert(schema.session).values({
    id: ownerSessionId,
    token: ownerSessionToken,
    userId: ownerUserId,
    expiresAt: realFutureExpiry,
    createdAt: new Date(currentNow),
    updatedAt: new Date(currentNow),
  });

  const workspaceId = await ensureOwnerWorkspace(db, ownerUserId, currentNow);
  const ownerCookie = await signBetterAuthSessionCookie(ownerSessionToken);

  const finalizeSent: RecordedQueueMsg<DecisionFinalizeQueuePayload>[] = [];
  const botWorkSent: RecordedQueueMsg<BotWorkQueuePayload>[] = [];

  const finalizeQueue = {
    send(message: DecisionFinalizeQueuePayload, sendOptions?: QueueSendOptions) {
      finalizeSent.push(
        sendOptions !== undefined ? { body: message, options: sendOptions } : { body: message },
      );
      return Promise.resolve();
    },
  };

  const botWorkQueue = {
    send(message: BotWorkQueuePayload, sendOptions?: QueueSendOptions) {
      botWorkSent.push(
        sendOptions !== undefined ? { body: message, options: sendOptions } : { body: message },
      );
      return Promise.resolve();
    },
  };

  const configuredGithubId = options?.ownerGithubId ?? OWNER_GITHUB_ID;
  const trustedOrigins = parseTrustedOrigins(ORIGIN);
  const auth = createBetterAuth(db, {
    baseUrl: ORIGIN,
    secret: AUTH_SECRET,
    trustedOrigins,
    ownerGithubId: configuredGithubId,
    enableMcpOAuth: options?.enableMcpOAuth ?? false,
    now: () => currentNow,
  });

  // REAL Better Auth cookie authentication (zero auth mocks!)
  const authenticateOwner = (request: Request) =>
    authenticateOwnerRequest({
      db,
      auth,
      request,
      ownerGithubId: configuredGithubId,
    });

  const rateLimiter =
    options?.rateLimit !== undefined
      ? createMemoryRateLimiter({
          limit: options.rateLimit,
          windowMs: 60_000,
          now: () => currentNow,
        })
      : undefined;

  const humanPort = createHumanServicePort(db, {
    finalizeQueue,
    botWorkQueue,
    now: () => currentNow,
  });
  const mcpPort = createMcpBotServicePort(db, {
    now: () => currentNow,
  });

  const app = createApp({
    mountAuthRoutes(honoApp) {
      mountAuthRoutes(honoApp, {
        auth,
        ...(rateLimiter !== undefined ? { rateLimiter } : {}),
      });
    },
    mountHumanRoutes(honoApp) {
      mountHumanRoutes(honoApp, {
        port: humanPort,
        authenticateOwner,
        trustedOrigins,
        ...(rateLimiter !== undefined ? { rateLimiter } : {}),
      });
    },
    mountMcpRoutes(honoApp) {
      mountMcpRoutes(honoApp, {
        port: mcpPort,
        ...(rateLimiter !== undefined ? { rateLimiter } : {}),
        publicBaseUrl: ORIGIN,
      });
    },
  });

  const ownerCtx = verifyOwnerSessionContext({
    userId: ownerUserId,
    workspaceId,
    sessionId: ownerSessionId,
  });
  const createdBot = await humanPort.createWorkerBot(ownerCtx, {
    request_id: "seed-bot-1",
    display_name: "Grok Worker #1",
    scopes: ["tasks:read", "tasks:write", "proposals:write", "decisions:read"],
  });

  return {
    db: sqliteDb,
    app,
    workspaceId,
    ownerUserId,
    ownerCookie,
    bot1Id: createdBot.bot_id,
    bot1Token: createdBot.bearer_token ?? "",
    finalizeSent,
    botWorkSent,
    getNow: () => currentNow,
    setNow: (ms: number) => {
      currentNow = ms;
    },
  };
}

async function humanReq(
  app: ReturnType<typeof createApp>,
  method: "GET" | "POST" | "PATCH",
  path: string,
  options: {
    readonly cookie?: string | null;
    readonly body?: unknown;
    readonly origin?: string | null;
    readonly referer?: string;
    readonly extraHeaders?: Record<string, string>;
  } = {},
): Promise<{
  readonly status: number;
  readonly headers: Headers;
  readonly json: Record<string, unknown>;
}> {
  const headers: Record<string, string> = {
    ...(options.extraHeaders ?? {}),
  };
  if (options.cookie !== null && options.cookie !== undefined) {
    headers["Cookie"] = options.cookie;
  }
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (options.origin !== null) {
      headers["Origin"] = options.origin ?? ORIGIN;
    }
  }
  if (options.referer !== undefined) {
    headers["Referer"] = options.referer;
  }

  const res = await app.request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const parsed: unknown = await res.json();
  const record =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : { value: parsed };
  return { status: res.status, headers: res.headers, json: record };
}

async function mcpCall(
  app: ReturnType<typeof createApp>,
  botToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly isError: boolean; readonly data: Record<string, unknown> }> {
  const res = await app.request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (res.status !== 200) {
    const errJson: unknown = await res.json();
    const record =
      errJson !== null && typeof errJson === "object" && !Array.isArray(errJson)
        ? Object.fromEntries(Object.entries(errJson))
        : { status: res.status };
    return { isError: true, data: record };
  }
  const text = await res.text();
  const rpc: unknown = ((): unknown => {
    if (text.trim().startsWith("event:") || text.includes("\ndata:")) {
      const line = text
        .split(/\r?\n/)
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      const parsedLine: unknown = line !== undefined ? JSON.parse(line) : null;
      return parsedLine;
    }
    const parsedBody: unknown = JSON.parse(text);
    return parsedBody;
  })();
  const result: unknown =
    rpc !== null && typeof rpc === "object" ? Reflect.get(rpc, "result") : null;
  const isError =
    result !== null && typeof result === "object" && Reflect.get(result, "isError") === true;
  const content: unknown =
    result !== null && typeof result === "object" ? Reflect.get(result, "content") : [];
  const first: unknown = Array.isArray(content) ? content[0] : null;
  const payloadText: unknown =
    first !== null && typeof first === "object" ? Reflect.get(first, "text") : "{}";
  const parsed: unknown = typeof payloadText === "string" ? JSON.parse(payloadText) : {};
  const data =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : {};
  return { isError, data };
}

describe("S3 Better Auth Single-Owner, Human API (13 endpoints), 5s Undo/Finalize & Concurrency (DEC-01..04, BOT-02)", () => {
  test("executes real Better Auth databaseHooks (single-owner, workspace bootstrap, non-GitHub/non-owner rejection) and signed cookie auth (M5, BOT-02)", async () => {
    const sqliteDb = createSqliteDatabase(":memory:");
    openDbs.push(sqliteDb);
    await sqliteDb.applyMigrations();

    const nowMs = 1_760_100_000_000;
    const auth = createBetterAuth(sqliteDb, {
      baseUrl: ORIGIN,
      secret: AUTH_SECRET,
      ownerGithubId: OWNER_GITHUB_ID,
      enableMcpOAuth: false,
      now: () => nowMs,
    });
    const internal = (await auth.getAuthContext()).internalAdapter;

    // 1. First user creation triggers user.create.after -> automatic workspace bootstrap!
    const createdOwner = await internal.createUser(
      {
        email: "sole-owner@example.test",
        name: "Sole Owner",
        emailVerified: true,
      },
      { method: "oauth" },
    );
    const bootstrappedWs = await sqliteDb.orm
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.ownerUserId, createdOwner.id))
      .get();
    expect(bootstrappedWs).toBeDefined();
    expect(bootstrappedWs?.ownerUserId).toBe(createdOwner.id);

    // 2. Second user creation is blocked by databaseHooks.user.create.before
    await expect(
      internal.createUser(
        {
          email: "second-user@example.test",
          name: "Intruder",
          emailVerified: true,
        },
        { method: "oauth" },
      ),
    ).rejects.toThrow();

    // 3. Non-GitHub account creation is blocked by databaseHooks.account.create.before
    await expect(
      internal.createAccount({
        userId: createdOwner.id,
        providerId: "google",
        accountId: OWNER_GITHUB_ID,
      }),
    ).rejects.toThrow();

    // 4. GitHub account with wrong accountId is blocked by databaseHooks.account.create.before
    await expect(
      internal.createAccount({
        userId: createdOwner.id,
        providerId: "github",
        accountId: "wrong-github-999",
      }),
    ).rejects.toThrow();

    // 5. Session creation BEFORE owner GitHub account exists is blocked by session.create.before
    await expect(internal.createSession(createdOwner.id)).rejects.toThrow();

    // 6. Matching OWNER_GITHUB_ID GitHub account succeeds, then session creation succeeds
    await internal.createAccount({
      userId: createdOwner.id,
      providerId: "github",
      accountId: OWNER_GITHUB_ID,
    });
    const realSession = await internal.createSession(createdOwner.id);
    expect(realSession.userId).toBe(createdOwner.id);

    // 7. Signed Better Auth cookie authenticates cleanly via real auth.getSession + authenticateOwnerRequest
    const realCookie = await signBetterAuthSessionCookie(realSession.token);
    const ownerCtx = await authenticateOwnerRequest({
      db: sqliteDb,
      auth,
      request: new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: realCookie },
      }),
      ownerGithubId: OWNER_GITHUB_ID,
    });
    expect(ownerCtx.userId).toBe(createdOwner.id);
    expect(ownerCtx.workspaceId).toBe(bootstrappedWs?.id ?? "");

    // Unsigned/tampered cookie is rejected with 401
    await expect(
      authenticateOwnerRequest({
        db: sqliteDb,
        auth,
        request: new Request(`${ORIGIN}/api/human/workspace`, {
          headers: { Cookie: `__Secure-better-auth.session_token=${realSession.token}.invalid` },
        }),
        ownerGithubId: OWNER_GITHUB_ID,
      }),
    ).rejects.toThrow();
  });

  test("enforces single-owner profile allowlist, 401 vs 403, trustedOrigins CSRF (before owner quota), and IP/owner rate limits (BOT-02, Minors 1-2)", async () => {
    expect(() =>
      assertAllowedOwnerGithubProfile({
        configuredOwnerGithubId: OWNER_GITHUB_ID,
        githubAccountId: OWNER_GITHUB_ID,
      }),
    ).not.toThrow();
    expect(() =>
      assertAllowedOwnerGithubProfile({
        configuredOwnerGithubId: OWNER_GITHUB_ID,
        githubAccountId: "attacker-999",
      }),
    ).toThrow();
    expect(() =>
      assertAllowedOwnerGithubProfile({
        configuredOwnerGithubId: "",
        githubAccountId: OWNER_GITHUB_ID,
      }),
    ).toThrow();

    const fx = await setupHumanFixture();

    // Email/password signup is disabled in Better Auth
    const freeSignup = await fx.app.request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        name: "Intruder",
        email: "intruder@example.test",
        password: "Password123!",
      }),
    });
    expect(freeSignup.status).toBeGreaterThanOrEqual(400);
    expect(freeSignup.status).toBeLessThan(500);

    // Unauthenticated /api/human/* returns 401 NOT_AUTHORIZED
    const unauth = await humanReq(fx.app, "GET", "/api/human/workspace", { cookie: null });
    expect(unauth.status).toBe(401);
    expect(unauth.json["code"]).toBe("NOT_AUTHORIZED");

    // Valid signed cookie for a non-owner (mismatched GitHub ID) returns 403 NOT_AUTHORIZED
    await fx.db.orm.insert(schema.user).values({
      id: "user-intruder",
      name: "Intruder",
      email: "intruder@example.test",
      emailVerified: true,
      createdAt: new Date(fx.getNow()),
      updatedAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.account).values({
      id: "acc-intruder-gh",
      accountId: "github-intruder-999",
      providerId: "github",
      userId: "user-intruder",
      createdAt: new Date(fx.getNow()),
      updatedAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.session).values({
      id: "sess-intruder",
      token: "tok-intruder-signed",
      userId: "user-intruder",
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(fx.getNow()),
      updatedAt: new Date(fx.getNow()),
    });
    const intruderCookie = await signBetterAuthSessionCookie("tok-intruder-signed");
    const nonOwner = await humanReq(fx.app, "GET", "/api/human/workspace", {
      cookie: intruderCookie,
    });
    expect(nonOwner.status).toBe(403);
    expect(nonOwner.json["code"]).toBe("NOT_AUTHORIZED");

    // Missing OWNER_GITHUB_ID fails closed with 403
    const fxNoOwner = await setupHumanFixture({ ownerGithubId: "" });
    const unconfiguredRes = await humanReq(fxNoOwner.app, "GET", "/api/human/workspace", {
      cookie: fxNoOwner.ownerCookie,
    });
    expect(unconfiguredRes.status).toBe(403);

    // CSRF checks
    const missingOrigin = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      origin: null,
      body: { request_id: "csrf-1", expected_version: 1, goal: "Hack" },
    });
    expect(missingOrigin.status).toBe(403);

    const evilOrigin = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      origin: "https://evil.example",
      body: { request_id: "csrf-2", expected_version: 1, goal: "Hack" },
    });
    expect(evilOrigin.status).toBe(403);

    const crossSiteFetch = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      origin: ORIGIN,
      extraHeaders: { "Sec-Fetch-Site": "cross-site" },
      body: { request_id: "csrf-3", expected_version: 1, goal: "Hack" },
    });
    expect(crossSiteFetch.status).toBe(403);

    const refererOk = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      origin: null,
      referer: `${ORIGIN}/settings`,
      body: { request_id: "csrf-referer-ok", expected_version: 1, goal: "Launch MVP" },
    });
    expect(refererOk.status).toBe(200);
    expect(refererOk.json["goal"]).toBe("Launch MVP");

    // Minor 1: Cross-site CSRF probes do NOT consume the owner's rate-limit quota
    const fxQuota = await setupHumanFixture({ rateLimit: 2 });
    const csrfBlocked1 = await humanReq(fxQuota.app, "PATCH", "/api/human/workspace", {
      cookie: fxQuota.ownerCookie,
      origin: "https://evil.example",
      extraHeaders: { "cf-connecting-ip": "198.51.100.10" },
      body: { request_id: "csrf-q1", expected_version: 1, goal: "Bad" },
    });
    expect(csrfBlocked1.status).toBe(403);
    const csrfBlocked2 = await humanReq(fxQuota.app, "PATCH", "/api/human/workspace", {
      cookie: fxQuota.ownerCookie,
      origin: "https://evil.example",
      extraHeaders: { "cf-connecting-ip": "198.51.100.11" },
      body: { request_id: "csrf-q2", expected_version: 1, goal: "Bad" },
    });
    expect(csrfBlocked2.status).toBe(403);
    // Legitimate owner still has their full 2-request quota intact!
    const legit1 = await humanReq(fxQuota.app, "GET", "/api/human/workspace", {
      cookie: fxQuota.ownerCookie,
      extraHeaders: { "cf-connecting-ip": "198.51.100.12" },
    });
    expect(legit1.status).toBe(200);
    const legit2 = await humanReq(fxQuota.app, "GET", "/api/human/workspace", {
      cookie: fxQuota.ownerCookie,
      extraHeaders: { "cf-connecting-ip": "198.51.100.13" },
    });
    expect(legit2.status).toBe(200);
    const legit3 = await humanReq(fxQuota.app, "GET", "/api/human/workspace", {
      cookie: fxQuota.ownerCookie,
      extraHeaders: { "cf-connecting-ip": "198.51.100.14" },
    });
    expect(legit3.status).toBe(429);
    expect(legit3.headers.get("Retry-After")).toBeTruthy();

    // Minor 2: /.well-known/* and /api/auth/* share IP rate limiting ignoring spoofed X-Forwarded-For
    const fxAuthLimit = await setupHumanFixture({ rateLimit: 2 });
    await fxAuthLimit.app.request(`${ORIGIN}/.well-known/oauth-protected-resource`, {
      headers: { "X-Forwarded-For": "203.0.113.1" },
    });
    await fxAuthLimit.app.request(`${ORIGIN}/api/auth/get-session`, {
      headers: { "X-Forwarded-For": "203.0.113.2" },
    });
    const authLimited = await fxAuthLimit.app.request(
      `${ORIGIN}/.well-known/oauth-protected-resource`,
      {
        headers: { "X-Forwarded-For": "203.0.113.3" },
      },
    );
    expect(authLimited.status).toBe(429);
    expect(authLimited.headers.get("Retry-After")).toBeTruthy();
  });

  test("manages workspace, 105+ task D1 board/cards under 100-var limit (M2), 1-time Worker Bearer, and atomic OAuth+lease revocation (BOT-02)", async () => {
    const fx = await setupHumanFixture();

    const wsGet = await humanReq(fx.app, "GET", "/api/human/workspace", { cookie: fx.ownerCookie });
    expect(wsGet.status).toBe(200);
    expect(wsGet.json["budget_limit"]).toEqual(DEFAULT_BUDGET_LIMIT);

    const badBudget = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      body: { request_id: "ws-bad-budget", expected_version: 1, budget_limit: "unlimited" },
    });
    expect(badBudget.status).toBe(400);

    const wsPatch = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      body: {
        request_id: "ws-upd-1",
        expected_version: 1,
        goal: "Ship MVP",
        allowed_scope: "research, drafting",
        budget_limit: { max_cards_per_day: 25, max_steps_per_task: 8, daily_cost_limit_cents: 300 },
        is_paused: true,
      },
    });
    expect(wsPatch.status).toBe(200);
    expect(wsPatch.json["version"]).toBe(2);

    const wsResume = await humanReq(fx.app, "PATCH", "/api/human/workspace", {
      cookie: fx.ownerCookie,
      body: { request_id: "ws-upd-2", expected_version: 2, is_paused: false },
    });
    expect(wsResume.status).toBe(200);

    // M2: Insert 105 tasks + active work_lease -> GET /api/human/board & /api/human/cards MUST stay <= 100 SQL bind vars
    const bulkTasks = Array.from({ length: 105 }, (_, i) => ({
      id: `bulk-task-${i}`,
      workspaceId: fx.workspaceId,
      title: `Bulk task ${i}`,
      description: "",
      status: i === 0 ? "running" : "done",
      requiresApproval: true,
      assignedBotId: fx.bot1Id,
      version: 1,
      createdAt: fx.getNow(),
      updatedAt: fx.getNow(),
    }));
    await fx.db.orm.insert(schema.tasks).values(bulkTasks);
    await fx.db.orm.insert(schema.workLeases).values({
      taskId: "bulk-task-0",
      botId: fx.bot1Id,
      leaseToken: "secret-lease-never-leak",
      expiresAt: fx.getNow() + 60_000,
    });

    const board105 = await humanReq(fx.app, "GET", "/api/human/board", { cookie: fx.ownerCookie });
    expect(board105.status).toBe(200);
    expect(Array.isArray(board105.json["tasks"]) && board105.json["tasks"].length === 105).toBe(
      true,
    );
    expect(JSON.stringify(board105.json)).not.toContain("secret-lease-never-leak");

    const cards105 = await humanReq(fx.app, "GET", "/api/human/cards", { cookie: fx.ownerCookie });
    expect(cards105.status).toBe(200);

    // POST /api/human/bots returns plaintext Bearer ONCE and NEVER stores plaintext in D1
    const botCreate = await humanReq(fx.app, "POST", "/api/human/bots", {
      cookie: fx.ownerCookie,
      body: {
        request_id: "bot-create-once",
        display_name: "Grok Worker #2",
        scopes: ["tasks:read", "tasks:write"],
      },
    });
    expect(botCreate.status).toBe(201);
    const createdBearer = String(botCreate.json["bearer_token"]);
    expect(createdBearer.startsWith("bbw_")).toBe(true);

    const botCreateReplay = await humanReq(fx.app, "POST", "/api/human/bots", {
      cookie: fx.ownerCookie,
      body: {
        request_id: "bot-create-once",
        display_name: "Grok Worker #2",
        scopes: ["tasks:read", "tasks:write"],
      },
    });
    expect(botCreateReplay.status).toBe(200);
    expect(botCreateReplay.json["bearer_token"]).toBeNull();

    const idempRows = await fx.db.orm.select().from(schema.idempotencyKeys).all();
    expect(JSON.stringify(idempRows)).not.toContain(createdBearer);

    // Seed OAuth Bot + tokens/consent + active WorkLease, then revoke atomically
    const opaquePlain = "oauth_opaque_revoke_target_token";
    const opaqueHash = await hashOAuthOpaqueToken(opaquePlain);
    await fx.db.orm.insert(schema.oauthClient).values({
      id: "oc-revoke",
      clientId: "client-chatgpt-revoke",
      name: "ChatGPT MCP",
      redirectUris: JSON.stringify(["https://chatgpt.com/cb"]),
      disabled: false,
      createdAt: new Date(fx.getNow()),
      updatedAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.oauthAccessToken).values({
      id: "oat-revoke",
      token: opaqueHash,
      clientId: "client-chatgpt-revoke",
      userId: fx.ownerUserId,
      scopes: JSON.stringify(["tasks:read", "tasks:write"]),
      expiresAt: new Date(fx.getNow() + 3_600_000),
      createdAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.oauthRefreshToken).values({
      id: "ort-revoke",
      token: "hashed-refresh-token",
      clientId: "client-chatgpt-revoke",
      userId: fx.ownerUserId,
      scopes: JSON.stringify(["tasks:read", "tasks:write"]),
      expiresAt: new Date(fx.getNow() + 86_400_000),
      createdAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.oauthConsent).values({
      id: "oconsent-revoke",
      clientId: "client-chatgpt-revoke",
      userId: fx.ownerUserId,
      scopes: JSON.stringify(["tasks:read", "tasks:write"]),
      createdAt: new Date(fx.getNow()),
      updatedAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.botConnections).values({
      id: "bot-oauth-revoke",
      workspaceId: fx.workspaceId,
      displayName: "ChatGPT MCP",
      channelType: "mcp_oauth",
      oauthClientId: "client-chatgpt-revoke",
      scopes: JSON.stringify(["tasks:read", "tasks:write"]),
      status: "active",
      version: 1,
      createdAt: fx.getNow(),
      updatedAt: fx.getNow(),
    });

    const tRes = await mcpCall(fx.app, opaquePlain, "create_task", {
      request_id: "oauth-t1",
      title: "Task held by OAuth bot",
    });
    const heldTaskId = String(tRes.data["task_id"]);
    await mcpCall(fx.app, opaquePlain, "claim_task", {
      request_id: "oauth-c1",
      task_id: heldTaskId,
      expected_version: 1,
    });

    const revokeRes = await humanReq(fx.app, "PATCH", "/api/human/bots/bot-oauth-revoke", {
      cookie: fx.ownerCookie,
      body: { request_id: "revoke-oauth-1", expected_version: 1, status: "revoked" },
    });
    expect(revokeRes.status).toBe(200);

    expect(
      await fx.db.orm
        .select()
        .from(schema.workLeases)
        .where(eq(schema.workLeases.taskId, heldTaskId))
        .get(),
    ).toBeUndefined();
    expect(
      (await fx.db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, heldTaskId)).get())
        ?.status,
    ).toBe("ready");
    expect(
      (
        await fx.db.orm
          .select()
          .from(schema.oauthAccessToken)
          .where(eq(schema.oauthAccessToken.id, "oat-revoke"))
          .get()
      )?.revoked,
    ).not.toBeNull();
    expect(
      (
        await fx.db.orm
          .select()
          .from(schema.oauthRefreshToken)
          .where(eq(schema.oauthRefreshToken.id, "ort-revoke"))
          .get()
      )?.revoked,
    ).not.toBeNull();
    expect(
      await fx.db.orm
        .select()
        .from(schema.oauthConsent)
        .where(eq(schema.oauthConsent.id, "oconsent-revoke"))
        .get(),
    ).toBeUndefined();
    expect((await mcpCall(fx.app, opaquePlain, "get_workspace_context", {})).isError).toBe(true);
  });

  test("enforces 5s undo exclusivity vs Queue finalization, B2 cross-workspace isolation, board/retry, and history pagination", async () => {
    const fx = await setupHumanFixture();

    // B2: Seed Workspace B with an expired provisional card and assert Workspace A cannot trigger finalize on it!
    await fx.db.orm.insert(schema.user).values({
      id: "user-ws-b",
      name: "Other Owner",
      email: "wsb@example.test",
      emailVerified: true,
      createdAt: new Date(fx.getNow()),
      updatedAt: new Date(fx.getNow()),
    });
    await fx.db.orm.insert(schema.workspaces).values({
      id: "ws-other-b",
      ownerUserId: "user-ws-b",
      goal: "Other",
      allowedScope: "Other",
      budgetLimit: serializeBudgetLimit(DEFAULT_BUDGET_LIMIT),
      isPaused: false,
      version: 1,
      createdAt: fx.getNow(),
      updatedAt: fx.getNow(),
    });
    await fx.db.orm.insert(schema.botConnections).values({
      id: "bot-ws-b",
      workspaceId: "ws-other-b",
      displayName: "Other Bot",
      channelType: "worker_bearer",
      tokenHash: "other-ws-hash-b",
      scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write"]),
      status: "active",
      version: 1,
      createdAt: fx.getNow(),
      updatedAt: fx.getNow(),
    });
    await fx.db.orm.insert(schema.tasks).values({
      id: "task-ws-b",
      workspaceId: "ws-other-b",
      title: "Private B task",
      description: "",
      status: "waiting_human",
      requiresApproval: true,
      version: 2,
      createdAt: fx.getNow(),
      updatedAt: fx.getNow(),
    });
    await fx.db.orm.insert(schema.proposals).values({
      id: "prop-ws-b",
      workspaceId: "ws-other-b",
      taskId: "task-ws-b",
      proposerBotId: "bot-ws-b",
      cardType: "policy",
      selectionMode: "binary",
      title: "Private B card",
      summary: "Private",
      onAcceptEffect: "A",
      onDeclineEffect: "B",
      onDeclinePolicy: "revise",
      factorsJson: "[]",
      targetTaskVersion: 2,
      payloadHash: "ph-b",
      createdAt: fx.getNow(),
    });
    await fx.db.orm.insert(schema.decisionCards).values({
      id: "card-ws-b-due",
      workspaceId: "ws-other-b",
      proposalId: "prop-ws-b",
      status: "provisional",
      provisionalResult: "accepted",
      provisionalUntil: fx.getNow() - 10_000,
      version: 2,
      createdAt: fx.getNow() - 15_000,
      updatedAt: fx.getNow() - 15_000,
    });
    await fx.db.orm.insert(schema.decisions).values({
      id: "dec-ws-b-due",
      cardId: "card-ws-b-due",
      actorUserId: "user-ws-b",
      result: "accepted",
      status: "provisional",
      cardVersion: 2,
      provisionalAt: fx.getNow() - 15_000,
    });

    const crossGet = await humanReq(fx.app, "GET", "/api/human/cards/card-ws-b-due", {
      cookie: fx.ownerCookie,
    });
    expect(crossGet.status).toBe(404);
    const crossDecide = await humanReq(fx.app, "POST", "/api/human/cards/card-ws-b-due/decide", {
      cookie: fx.ownerCookie,
      body: {
        request_id: "cross-ws-probe",
        expected_version: 2,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(crossDecide.status).toBe(404);
    // Workspace B card MUST STILL be provisional and zero botWorkQueue messages sent!
    const wsBCardAfter = await fx.db.orm
      .select({ status: schema.decisionCards.status })
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, "card-ws-b-due"))
      .get();
    expect(wsBCardAfter?.status).toBe("provisional");
    expect(fx.botWorkSent).toHaveLength(0);

    // Happy flow: multi-select decide -> 5s undo -> boundary race -> failed history -> retry -> deliverable done
    const created = await mcpCall(fx.app, fx.bot1Token, "create_task", {
      request_id: "t-flow-1",
      title: "App concept & competitor research",
      requires_approval: true,
    });
    const taskId = String(created.data["task_id"]);
    const claimed = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-flow-1",
      task_id: taskId,
      expected_version: 1,
    });
    const lease1 = String(claimed.data["lease_token"]);

    const submitted = await mcpCall(fx.app, fx.bot1Token, "submit_proposal", {
      request_id: "p-flow-1",
      task_id: taskId,
      expected_version: 2,
      lease_token: lease1,
      artifact: {
        title: "Competitor Analysis",
        kind: "markdown",
        summary: "3 apps compared",
        content_or_url: "# Analysis\nLine 1\nLine 2",
      },
      proposals: [
        {
          card_type: "policy",
          selection_mode: "multi",
          options: [
            {
              id: "opt-1",
              title: "5s undo",
              summary: "Safe undo",
              meta: "DEC-01",
              recommended: true,
            },
            {
              id: "opt-2",
              title: "Keyboard",
              summary: "PC keys",
              meta: "UX-05",
              recommended: true,
            },
          ],
          title: "Which safeguards to ship in MVP?",
          summary: "Select all safeguards to include",
          on_accept_effect: "Build selected safeguards",
          on_decline_effect: "Revise safeguard scope",
          on_decline_policy: "revise",
        },
      ],
    });
    const submittedCards: readonly unknown[] = Array.isArray(submitted.data["cards"])
      ? submitted.data["cards"]
      : [];
    const cardId =
      submittedCards[0] !== null && typeof submittedCards[0] === "object"
        ? String(Reflect.get(submittedCards[0], "card_id"))
        : "";

    const decided = await humanReq(fx.app, "POST", `/api/human/cards/${cardId}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dec-ok-1",
        expected_version: 1,
        payload: {
          mode: "multi",
          decision: "accepted",
          acceptedOptionIds: ["opt-1"],
          declinedOptionIds: ["opt-2"],
        },
      },
    });
    expect(decided.status).toBe(200);
    expect(fx.finalizeSent[0]).toEqual({ body: { card_id: cardId }, options: { delaySeconds: 5 } });

    // DEC-01: Bot cannot see provisional decision
    const botDuringProv = await mcpCall(fx.app, fx.bot1Token, "list_decision_results", {
      task_id: taskId,
    });
    expect(botDuringProv.data["items"]).toEqual([]);

    // Undo within 5s window -> finalize later is No-op
    fx.setNow(fx.getNow() + 3_000);
    const undone = await humanReq(fx.app, "POST", `/api/human/cards/${cardId}/undo`, {
      cookie: fx.ownerCookie,
      body: { request_id: "undo-1", expected_version: 2 },
    });
    expect(undone.status).toBe(200);
    const finAfterUndo = await finalizeDecisionCard(fx.db, cardId, {
      source: "queue",
      nowMs: fx.getNow() + 3_000,
    });
    expect(finAfterUndo.result).toBe("noop");

    // Re-decide, race undo vs finalize right at exact boundary -> finalize wins, undo returns INVALID_TRANSITION
    const decided2 = await humanReq(fx.app, "POST", `/api/human/cards/${cardId}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dec-ok-2",
        expected_version: 3,
        payload: {
          mode: "multi",
          decision: "accepted",
          acceptedOptionIds: ["opt-1", "opt-2"],
          declinedOptionIds: [],
        },
      },
    });
    const provisionalUntil = Number(decided2.json["provisional_until"]);
    fx.setNow(provisionalUntil);
    const [undoAtBoundary, finAtBoundary] = await Promise.all([
      humanReq(fx.app, "POST", `/api/human/cards/${cardId}/undo`, {
        cookie: fx.ownerCookie,
        body: { request_id: "undo-boundary", expected_version: 4 },
      }),
      finalizeDecisionCard(fx.db, cardId, {
        source: "queue",
        nowMs: provisionalUntil,
        botWorkQueue: {
          send: (msg) => {
            fx.botWorkSent.push({ body: msg });
            return Promise.resolve();
          },
        },
      }),
    ]);
    expect(undoAtBoundary.status).toBe(409);
    expect(undoAtBoundary.json["code"]).toBe("INVALID_TRANSITION");
    expect(finAtBoundary.result).toBe("accepted");
    expect(fx.botWorkSent).toHaveLength(1);

    // Bot records failed -> history separates accepted decision from failed execution -> Human retries -> ready
    const claimAgain = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-fail-1",
      task_id: taskId,
      expected_version: 4,
    });
    await mcpCall(fx.app, fx.bot1Token, "record_result", {
      request_id: "r-fail-1",
      task_id: taskId,
      expected_version: 5,
      lease_token: String(claimAgain.data["lease_token"]),
      outcome: "failed",
      status_reason: "Upstream model timeout",
    });

    const historyFailed = await humanReq(
      fx.app,
      "GET",
      "/api/human/history?filter=failed&limit=10",
      {
        cookie: fx.ownerCookie,
      },
    );
    const histItems: readonly unknown[] = Array.isArray(historyFailed.json["items"])
      ? historyFailed.json["items"]
      : [];
    expect(histItems).toHaveLength(1);
    expect(histItems[0]).toMatchObject({
      decision_result: "accepted",
      execution_status: "failed",
      execution_reason: "Upstream model timeout",
      artifact: { title: "Competitor Analysis", version: 1 },
    });

    const retryRes = await humanReq(fx.app, "POST", `/api/human/tasks/${taskId}/retry`, {
      cookie: fx.ownerCookie,
      body: { request_id: "retry-1", expected_version: 6 },
    });
    expect(retryRes.status).toBe(200);
    expect(retryRes.json["status"]).toBe("ready");
    expect(fx.botWorkSent).toHaveLength(2);
  });

  test("enforces B1 (reconfirmation preserves selection_group_id & done task never reopened), M3 (sibling expired provisional unblock), M5 (DEC-04 accept closes siblings + DEC-03 artifact version mismatch), and Minor 3 (defer expired)", async () => {
    const fx = await setupHumanFixture();

    // 1. B1 Repro: Bot submits 2-candidate group (A & B), supersedes A -> A2 (task v4), Human decides old B -> B2 preserves selection_group_id!
    const tRes = await mcpCall(fx.app, fx.bot1Token, "create_task", {
      request_id: "t-b1-1",
      title: "Deliverable architecture choice",
      requires_approval: true,
    });
    const taskId = String(tRes.data["task_id"]);
    const cRes = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-b1-1",
      task_id: taskId,
      expected_version: 1,
    });
    const gRes = await mcpCall(fx.app, fx.bot1Token, "submit_proposal", {
      request_id: "p-b1-1",
      task_id: taskId,
      expected_version: 2,
      lease_token: String(cRes.data["lease_token"]),
      selection_group_id: "grp-b1-lock",
      artifact: {
        title: "Architecture Spec",
        kind: "markdown",
        summary: "v1 spec",
        content_or_url: "# Spec v1",
      },
      proposals: [
        {
          card_type: "deliverable",
          selection_mode: "binary",
          title: "Option A Deliverable",
          summary: "Candidate A",
          on_accept_effect: "Mark done",
          on_decline_effect: "Revise",
          on_decline_policy: "revise",
        },
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Option B Policy",
          summary: "Candidate B",
          on_accept_effect: "Proceed B",
          on_decline_effect: "Revise",
          on_decline_policy: "revise",
        },
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Option C Deferred",
          summary: "Candidate C",
          on_accept_effect: "Proceed C",
          on_decline_effect: "Revise",
          on_decline_policy: "revise",
        },
      ],
    });
    const artifactId = String(gRes.data["artifact_id"]);
    const cardsArr: readonly unknown[] = Array.isArray(gRes.data["cards"])
      ? gRes.data["cards"]
      : [];
    const cardAId =
      cardsArr[0] !== null && typeof cardsArr[0] === "object"
        ? String(Reflect.get(cardsArr[0], "card_id"))
        : "";
    const cardBId =
      cardsArr[1] !== null && typeof cardsArr[1] === "object"
        ? String(Reflect.get(cardsArr[1], "card_id"))
        : "";
    const cardCId =
      cardsArr[2] !== null && typeof cardsArr[2] === "object"
        ? String(Reflect.get(cardsArr[2], "card_id"))
        : "";

    // Defer C before supersede so we also test M5 (accepted finalization closes BOTH deferred & provisional(declined) siblings!)
    const deferC = await humanReq(fx.app, "POST", `/api/human/cards/${cardCId}/defer`, {
      cookie: fx.ownerCookie,
      body: { request_id: "defer-c", expected_version: 1, action: "defer" },
    });
    expect(deferC.status).toBe(200);

    // Bot supersedes Card A -> Card A2 (task version 3 -> 4, artifact version 1 -> 2)
    const supA = await mcpCall(fx.app, fx.bot1Token, "supersede_proposal", {
      request_id: "sup-a-1",
      task_id: taskId,
      expected_version: 3,
      target_card_id: cardAId,
      artifact: {
        id: artifactId,
        expected_version: 1,
        title: "Architecture Spec",
        kind: "markdown",
        summary: "v2 spec",
        content_or_url: "# Spec v2",
      },
      replacement: {
        card_type: "deliverable",
        selection_mode: "binary",
        title: "Option A2 Deliverable",
        summary: "Updated candidate A2",
        on_accept_effect: "Mark task done",
        on_decline_effect: "Revise",
        on_decline_policy: "revise",
      },
    });
    expect(supA.isError).toBe(false);
    const cardA2Id = String(supA.data["replacement_card_id"]);

    // Human tries to decide stale Card B -> STALE_PROPOSAL creates Card B2 PRESERVING selection_group_id="grp-b1-lock" (B1!)
    const staleB = await humanReq(fx.app, "POST", `/api/human/cards/${cardBId}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "decide-stale-b",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(staleB.status).toBe(409);
    expect(staleB.json["code"]).toBe("STALE_PROPOSAL");
    const staleBDetails = staleB.json["details"];
    const cardB2Id =
      staleBDetails !== null && typeof staleBDetails === "object"
        ? String(Reflect.get(staleBDetails, "replacementCardId"))
        : "";
    const cardB2Row = await fx.db.orm
      .select({ selectionGroupId: schema.decisionCards.selectionGroupId })
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, cardB2Id))
      .get();
    expect(cardB2Row?.selectionGroupId).toBe("grp-b1-lock");

    // Put Card B2 into provisional(declined), then accept Deliverable Card A2 ->
    // Verify Card B2 cannot be accepted concurrently (DEC-04!) AND finalizing A2 closes BOTH deferred C & provisional(declined) B2 (M5!)
    const declB2 = await humanReq(fx.app, "POST", `/api/human/cards/${cardB2Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "decl-b2",
        expected_version: 1,
        payload: { mode: "binary", decision: "declined" },
      },
    });
    expect(declB2.status).toBe(200);

    const accA2 = await humanReq(fx.app, "POST", `/api/human/cards/${cardA2Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "acc-a2",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(accA2.status).toBe(200);

    // Finalize A2 -> task transitions waiting_human -> done, deferred C & provisional B2 become closed, B2's decision becomes canceled!
    fx.setNow(fx.getNow() + 5_000);
    const finA2 = await finalizeDecisionCard(fx.db, cardA2Id, {
      source: "queue",
      nowMs: fx.getNow(),
    });
    expect(finA2.result).toBe("accepted");
    expect(finA2.nextTaskStatus).toBe("done");

    const cardCAfter = await fx.db.orm
      .select({ status: schema.decisionCards.status })
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, cardCId))
      .get();
    const cardB2After = await fx.db.orm
      .select({ status: schema.decisionCards.status })
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, cardB2Id))
      .get();
    const decB2After = await fx.db.orm
      .select({ status: schema.decisions.status })
      .from(schema.decisions)
      .where(eq(schema.decisions.cardId, cardB2Id))
      .get();
    expect(cardCAfter?.status).toBe("closed");
    expect(cardB2After?.status).toBe("closed");
    expect(decB2After?.status).toBe("canceled");

    // B1: Seed an orphan stale pending/provisional card on this ALREADY DONE task -> MUST NOT spawn reconfirmation card OR reopen done!
    await fx.db.orm.insert(schema.proposals).values({
      id: "prop-orphan-done",
      workspaceId: fx.workspaceId,
      taskId,
      proposerBotId: fx.bot1Id,
      cardType: "policy",
      selectionMode: "binary",
      title: "Orphan card on done task",
      summary: "Should close without reopening done",
      onAcceptEffect: "Should never reopen",
      onDeclineEffect: "Stop",
      onDeclinePolicy: "revise",
      factorsJson: "[]",
      targetTaskVersion: 5,
      payloadHash: "ph-orphan",
      createdAt: fx.getNow(),
    });
    await fx.db.orm.insert(schema.decisionCards).values({
      id: "card-orphan-done",
      workspaceId: fx.workspaceId,
      proposalId: "prop-orphan-done",
      status: "pending",
      version: 1,
      createdAt: fx.getNow(),
      updatedAt: fx.getNow(),
    });
    const decideOnDone = await humanReq(
      fx.app,
      "POST",
      "/api/human/cards/card-orphan-done/decide",
      {
        cookie: fx.ownerCookie,
        body: {
          request_id: "decide-orphan-done",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      },
    );
    expect(decideOnDone.status).toBe(409);
    expect(decideOnDone.json["code"]).toBe("STALE_PROPOSAL");
    expect(decideOnDone.json["details"]).toBeUndefined(); // NO reconfirmation card spawned for done task!
    const doneTaskCheck = await fx.db.orm
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(doneTaskCheck?.status).toBe("done");

    // 2. M5 + DEC-03: Target Artifact version mismatch on BOTH decide AND finalize creates [再確認] card!
    const tArt = await mcpCall(fx.app, fx.bot1Token, "create_task", {
      request_id: "t-art-dec03",
      title: "Artifact version drift task",
    });
    const tArtId = String(tArt.data["task_id"]);
    const cArt = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-art-dec03",
      task_id: tArtId,
      expected_version: 1,
    });
    const subArt = await mcpCall(fx.app, fx.bot1Token, "submit_proposal", {
      request_id: "p-art-dec03",
      task_id: tArtId,
      expected_version: 2,
      lease_token: String(cArt.data["lease_token"]),
      artifact: {
        title: "Research Draft",
        kind: "markdown",
        summary: "v1",
        content_or_url: "draft v1",
      },
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Review draft v1?",
          summary: "Check draft",
          on_accept_effect: "Proceed",
          on_decline_effect: "Revise",
        },
      ],
    });
    const targetArtId = String(subArt.data["artifact_id"]);
    const artCards: readonly unknown[] = Array.isArray(subArt.data["cards"])
      ? subArt.data["cards"]
      : [];
    const artCardId =
      artCards[0] !== null && typeof artCards[0] === "object"
        ? String(Reflect.get(artCards[0], "card_id"))
        : "";

    // Decide cleanly -> then artifact version mutates during 5s window -> finalize detects artifact mismatch & creates [再確認] card
    const decArtOk = await humanReq(fx.app, "POST", `/api/human/cards/${artCardId}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dec-art-1",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(decArtOk.status).toBe(200);
    await fx.db.orm
      .update(schema.artifacts)
      .set({ version: 2 })
      .where(eq(schema.artifacts.id, targetArtId));
    fx.setNow(fx.getNow() + 5_000);
    const finArtStale = await finalizeDecisionCard(fx.db, artCardId, {
      source: "queue",
      nowMs: fx.getNow(),
    });
    expect(finArtStale.result).toBe("stale");
    const artReconfirmId = String(finArtStale.replacementCardId);
    expect(artReconfirmId.startsWith("card_")).toBe(true);

    // Mutate artifact to v3 BEFORE decide -> decide detects artifact mismatch & returns STALE_PROPOSAL + replacementCardId
    await fx.db.orm
      .update(schema.artifacts)
      .set({ version: 3 })
      .where(eq(schema.artifacts.id, targetArtId));
    const decArtStale = await humanReq(
      fx.app,
      "POST",
      `/api/human/cards/${artReconfirmId}/decide`,
      {
        cookie: fx.ownerCookie,
        body: {
          request_id: "dec-art-stale",
          expected_version: 1,
          payload: { mode: "binary", decision: "accepted" },
        },
      },
    );
    expect(decArtStale.status).toBe(409);
    expect(decArtStale.json["code"]).toBe("STALE_PROPOSAL");
    const artStaleDetails = decArtStale.json["details"];
    const artReconfirm2Id =
      artStaleDetails !== null && typeof artStaleDetails === "object"
        ? String(Reflect.get(artStaleDetails, "replacementCardId"))
        : "";
    expect(artReconfirm2Id.startsWith("card_")).toBe(true);

    // 3. M3 + Minor 3: Expired provisional(accepted) sibling unlocks sibling B via on-demand finalize on defer/decide, AND defer on expired card marks it expired!
    const tExp = await mcpCall(fx.app, fx.bot1Token, "create_task", {
      request_id: "t-exp-sib",
      title: "Sibling expiry unblock",
    });
    const tExpId = String(tExp.data["task_id"]);
    const cExp = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-exp-sib",
      task_id: tExpId,
      expected_version: 1,
    });
    const pExp = await mcpCall(fx.app, fx.bot1Token, "submit_proposal", {
      request_id: "p-exp-sib",
      task_id: tExpId,
      expected_version: 2,
      lease_token: String(cExp.data["lease_token"]),
      selection_group_id: "grp-exp-unblock",
      proposals: [
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "Expiring candidate 1",
          summary: "Will expire during provisional",
          on_accept_effect: "Go 1",
          on_decline_effect: "Revise",
          expires_in_seconds: 60,
        },
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "Fresh candidate 2",
          summary: "Should unlock after candidate 1 expires",
          on_accept_effect: "Go 2",
          on_decline_effect: "Revise",
          expires_in_seconds: 300,
        },
      ],
    });
    const expCards: readonly unknown[] = Array.isArray(pExp.data["cards"])
      ? pExp.data["cards"]
      : [];
    const expC1Id =
      expCards[0] !== null && typeof expCards[0] === "object"
        ? String(Reflect.get(expCards[0], "card_id"))
        : "";
    const expC2Id =
      expCards[1] !== null && typeof expCards[1] === "object"
        ? String(Reflect.get(expCards[1], "card_id"))
        : "";

    // Accept C1 right near its 60s expiry (at t + 58s) -> expires at t + 60s, provisionalUntil at t + 63s
    fx.setNow(fx.getNow() + 58_000);
    const decC1 = await humanReq(fx.app, "POST", `/api/human/cards/${expC1Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dec-exp-c1",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(decC1.status).toBe(200);

    // Advance to t + 64s (Queue delayed!) -> Human defers C2 -> on-demand finalize expires C1 and unlocks C2!
    fx.setNow(fx.getNow() + 6_000);
    const deferC2 = await humanReq(fx.app, "POST", `/api/human/cards/${expC2Id}/defer`, {
      cookie: fx.ownerCookie,
      body: { request_id: "defer-c2-unblocked", expected_version: 1, action: "defer" },
    });
    expect(deferC2.status).toBe(200);
    expect(deferC2.json["status"]).toBe("deferred");

    // Minor 3: Advance past C2's 300s expiry -> restore fails INVALID_TRANSITION and transitions C2 to expired!
    fx.setNow(fx.getNow() + 300_000);
    const restoreExpiredC2 = await humanReq(fx.app, "POST", `/api/human/cards/${expC2Id}/defer`, {
      cookie: fx.ownerCookie,
      body: { request_id: "restore-expired-c2", expected_version: 2, action: "restore" },
    });
    expect(restoreExpiredC2.status).toBe(409);
    expect(restoreExpiredC2.json["code"]).toBe("INVALID_TRANSITION");
    const c2After = await fx.db.orm
      .select({ status: schema.decisionCards.status })
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, expC2Id))
      .get();
    expect(c2After?.status).toBe("expired");
  });

  test("wires workerHandler.fetch (waitUntil, ASSETS fallback, M1 fail-closed without BETTER_AUTH_URL) and workerHandler.queue (prefixed queue, malformed ack, early retry)", async () => {
    const sqliteDb = createSqliteDatabase(":memory:");
    openDbs.push(sqliteDb);
    await sqliteDb.applyMigrations();

    const nowMs = 1_760_200_000_000;
    const ownerUserId = "u-worker-1";
    const sessionToken = "sess-worker-real-1";
    await sqliteDb.orm.insert(schema.user).values({
      id: ownerUserId,
      name: "Worker Owner",
      email: "worker-owner@example.test",
      emailVerified: true,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await sqliteDb.orm.insert(schema.account).values({
      id: "acc-worker-gh",
      accountId: OWNER_GITHUB_ID,
      providerId: "github",
      userId: ownerUserId,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await sqliteDb.orm.insert(schema.session).values({
      id: "sess-worker-id-1",
      token: sessionToken,
      userId: ownerUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await ensureOwnerWorkspace(sqliteDb, ownerUserId, nowMs);
    const cookie = await signBetterAuthSessionCookie(sessionToken);

    const d1Adapter = createSqliteBackedD1(sqliteDb);
    const botWorkSent: BotWorkQueuePayload[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    let assetsRequests = 0;

    const baseEnv: WorkerRuntimeEnv = {
      DB: d1Adapter,
      DECISION_FINALIZE_QUEUE: { send: () => Promise.resolve() },
      BOT_WORK_QUEUE: {
        send: (msg) => {
          botWorkSent.push(msg);
          return Promise.resolve();
        },
      },
      BOT_WORK_DLQ: { send: () => Promise.resolve() },
      ASSETS: {
        fetch: (input) => {
          assetsRequests += 1;
          const urlStr = typeof input === "string" ? input : input.url;
          return Promise.resolve(new Response(`SPA:${new URL(urlStr).pathname}`, { status: 200 }));
        },
      },
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_URL: ORIGIN,
      OWNER_GITHUB_ID,
    };

    const execCtx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };

    // 1. M1: Missing BETTER_AUTH_URL fails closed (NEVER trusts attacker Host/Origin in request.url!)
    const failClosedRes = await handleWorkerHttpRequest(
      new Request("https://evil.example/api/human/workspace", {
        method: "PATCH",
        headers: {
          Origin: "https://evil.example",
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ request_id: "m1-evil", expected_version: 1, goal: "Pwned" }),
      }),
      {
        db: d1Adapter,
        getMcpPort: () => createMcpBotServicePort(createD1Database(d1Adapter)),
        finalizeQueue: baseEnv.DECISION_FINALIZE_QUEUE,
        botWorkQueue: baseEnv.BOT_WORK_QUEUE,
        betterAuthSecret: AUTH_SECRET,
        ownerGithubId: OWNER_GITHUB_ID,
      },
    );
    expect(failClosedRes.status).toBe(404);

    // 2. M4 + M5: workerHandler.fetch routes /api/health, /api/human/workspace (real signed cookie), and ASSETS SPA fallback
    const healthRes = await workerHandler.fetch(
      new Request(`${ORIGIN}/api/health`),
      baseEnv,
      execCtx,
    );
    expect(healthRes.status).toBe(200);

    const wsRes = await workerHandler.fetch(
      new Request(`${ORIGIN}/api/human/workspace`, { headers: { Cookie: cookie } }),
      baseEnv,
      execCtx,
    );
    expect(wsRes.status).toBe(200);
    const wsBody: unknown = await wsRes.json();
    expect(wsBody).toMatchObject({ is_paused: false, version: 1 });

    const spaRes = await workerHandler.fetch(new Request(`${ORIGIN}/board`), baseEnv, execCtx);
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toBe("SPA:/board");
    expect(assetsRequests).toBe(1);

    // 3. M5 + Minor 5: workerHandler.queue handles prefixed queue name ("bot-board-staging-decision-finalize"),
    //    drops malformed payload with ack(), retries early not_due message, and finalizes due expired card!
    const wsRow = await sqliteDb.orm
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.ownerUserId, ownerUserId))
      .get();
    const wsId = wsRow?.id ?? "";
    const realNow = Date.now();

    await sqliteDb.orm.insert(schema.botConnections).values({
      id: "b-worker-q",
      workspaceId: wsId,
      displayName: "Worker Q Bot",
      channelType: "worker_bearer",
      tokenHash: "hash-worker-q",
      scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write"]),
      status: "active",
      version: 1,
      createdAt: realNow,
      updatedAt: realNow,
    });
    await sqliteDb.orm.insert(schema.tasks).values([
      {
        id: "t-early",
        workspaceId: wsId,
        title: "Early provisional task",
        description: "",
        status: "waiting_human",
        requiresApproval: true,
        version: 2,
        createdAt: realNow,
        updatedAt: realNow,
      },
      {
        id: "t-due",
        workspaceId: wsId,
        title: "Due expired task",
        description: "",
        status: "waiting_human",
        requiresApproval: true,
        version: 2,
        createdAt: realNow - 20_000,
        updatedAt: realNow - 20_000,
      },
    ]);
    await sqliteDb.orm.insert(schema.proposals).values([
      {
        id: "p-early",
        workspaceId: wsId,
        taskId: "t-early",
        proposerBotId: "b-worker-q",
        cardType: "policy",
        selectionMode: "binary",
        title: "Early card",
        summary: "Not due yet",
        onAcceptEffect: "Go",
        onDeclineEffect: "Stop",
        onDeclinePolicy: "revise",
        factorsJson: "[]",
        targetTaskVersion: 2,
        payloadHash: "ph-early",
        createdAt: realNow,
      },
      {
        id: "p-due",
        workspaceId: wsId,
        taskId: "t-due",
        proposerBotId: "b-worker-q",
        cardType: "policy",
        selectionMode: "binary",
        title: "Due card",
        summary: "Will finalize as accepted",
        onAcceptEffect: "Go",
        onDeclineEffect: "Stop",
        onDeclinePolicy: "revise",
        factorsJson: "[]",
        targetTaskVersion: 2,
        payloadHash: "ph-due",
        createdAt: realNow - 20_000,
      },
    ]);
    await sqliteDb.orm.insert(schema.decisionCards).values([
      {
        id: "c-early",
        workspaceId: wsId,
        proposalId: "p-early",
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: realNow + 4_000,
        version: 2,
        createdAt: realNow,
        updatedAt: realNow,
      },
      {
        id: "c-due",
        workspaceId: wsId,
        proposalId: "p-due",
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: realNow - 1_000,
        version: 2,
        createdAt: realNow - 10_000,
        updatedAt: realNow - 10_000,
      },
    ]);
    await sqliteDb.orm.insert(schema.decisions).values([
      {
        id: "d-early",
        cardId: "c-early",
        actorUserId: ownerUserId,
        result: "accepted",
        status: "provisional",
        cardVersion: 2,
        provisionalAt: realNow,
      },
      {
        id: "d-due",
        cardId: "c-due",
        actorUserId: ownerUserId,
        result: "accepted",
        status: "provisional",
        cardVersion: 2,
        provisionalAt: realNow - 6_000,
      },
    ]);

    const ackedIds: string[] = [];
    const retriedEntries: { readonly id: string; readonly delaySeconds: number }[] = [];
    const mkMsg = (id: string, body: unknown): Message => ({
      id,
      timestamp: new Date(realNow),
      body,
      attempts: 1,
      ack() {
        ackedIds.push(id);
      },
      retry(opts) {
        retriedEntries.push({ id, delaySeconds: opts?.delaySeconds ?? 0 });
      },
    });

    const batch = createMessageBatchStub(
      "bot-board-staging-decision-finalize",
      [
        mkMsg("m-bad", { wrong_field: 123 }),
        mkMsg("m-early", { card_id: "c-early" }),
        mkMsg("m-due", { card_id: "c-due" }),
      ],
      realNow,
    );
    await workerHandler.queue(batch, baseEnv, execCtx);

    expect(ackedIds).toEqual(["m-bad", "m-due"]);
    expect(retriedEntries).toHaveLength(1);
    expect(retriedEntries[0]?.id).toBe("m-early");
    expect(retriedEntries[0]?.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(botWorkSent).toHaveLength(1);
    expect(botWorkSent[0]?.task_id).toBe("t-due");

    // Verify early message finalizes cleanly once clock passes provisionalUntil
    const ackedAfter: string[] = [];
    const lateBatch = createMessageBatchStub(
      "decision-finalize",
      [
        {
          id: "m-early-2",
          timestamp: new Date(realNow + 5_000),
          body: { card_id: "c-early" },
          attempts: 2,
          ack() {
            ackedAfter.push("m-early-2");
          },
          retry() {},
        },
      ],
      realNow + 5_000,
    );
    await handleDecisionFinalizeBatch(lateBatch, baseEnv, realNow + 5_000);
    expect(ackedAfter).toEqual(["m-early-2"]);
    expect(botWorkSent).toHaveLength(2);
    expect(waitUntilPromises.length).toBeGreaterThanOrEqual(0);

    // M4: Verify /api/health initializes zero DB/Auth calls AND Better Auth wires waitUntil into backgroundTasks
    let d1PrepareCalls = 0;
    const countingD1: D1LikeDatabase = {
      prepare(query: string) {
        d1PrepareCalls += 1;
        return d1Adapter.prepare(query);
      },
      batch(stmts) {
        return d1Adapter.batch(stmts);
      },
      exec(query: string) {
        return d1Adapter.exec(query);
      },
    };
    const healthOnlyRes = await workerHandler.fetch(
      new Request(`${ORIGIN}/api/health`),
      { ...baseEnv, DB: countingD1 },
      execCtx,
    );
    expect(healthOnlyRes.status).toBe(200);
    expect(d1PrepareCalls).toBe(0);

    const wiredWaitUntil: Promise<unknown>[] = [];
    const authWithWaitUntil = createBetterAuth(sqliteDb, {
      baseUrl: ORIGIN,
      secret: AUTH_SECRET,
      ownerGithubId: OWNER_GITHUB_ID,
      enableMcpOAuth: false,
      waitUntil: (p) => {
        wiredWaitUntil.push(p);
      },
    });
    const authCtx = await authWithWaitUntil.getAuthContext();
    authCtx.runInBackground(Promise.resolve("bg-task-ok"));
    expect(wiredWaitUntil).toHaveLength(1);
    expect(await wiredWaitUntil[0]).toBe("bg-task-ok");
  });

  test("enforces DEC-02 (2-device decide idempotency/version conflicts), DEC-04 (GROUP_LOCKED + all-declined block policy), GET cards/detail reload recovery, and M3 concurrent task bump during decide", async () => {
    const fx = await setupHumanFixture();

    const tRes = await mcpCall(fx.app, fx.bot1Token, "create_task", {
      request_id: "t-dec0204",
      title: "Two-option blocked choice",
      requires_approval: true,
    });
    const taskId = String(tRes.data["task_id"]);
    const cRes = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-dec0204",
      task_id: taskId,
      expected_version: 1,
    });
    const pRes = await mcpCall(fx.app, fx.bot1Token, "submit_proposal", {
      request_id: "p-dec0204",
      task_id: taskId,
      expected_version: 2,
      lease_token: String(cRes.data["lease_token"]),
      selection_group_id: "grp-dec04-block",
      artifact: {
        title: "Full Plan Doc",
        kind: "markdown",
        summary: "Short preview",
        content_or_url: "# Full Plan\nDetailed body for GET /api/human/cards/:id",
      },
      proposals: [
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "Plan Alpha",
          summary: "Alpha summary",
          on_accept_effect: "Execute Alpha",
          on_decline_effect: "Block if all declined",
          on_decline_policy: "block",
        },
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "Plan Beta",
          summary: "Beta summary",
          on_accept_effect: "Execute Beta",
          on_decline_effect: "Block if all declined",
          on_decline_policy: "block",
        },
      ],
    });
    const cardsArr: readonly unknown[] = Array.isArray(pRes.data["cards"])
      ? pRes.data["cards"]
      : [];
    const card1Id =
      cardsArr[0] !== null && typeof cardsArr[0] === "object"
        ? String(Reflect.get(cardsArr[0], "card_id"))
        : "";
    const card2Id =
      cardsArr[1] !== null && typeof cardsArr[1] === "object"
        ? String(Reflect.get(cardsArr[1], "card_id"))
        : "";

    // GET /api/human/cards/:id returns full artifact content & siblings
    const detailRes = await humanReq(fx.app, "GET", `/api/human/cards/${card1Id}`, {
      cookie: fx.ownerCookie,
    });
    expect(detailRes.status).toBe(200);
    expect(detailRes.json["artifactFull"]).toMatchObject({
      title: "Full Plan Doc",
      contentOrUrl: "# Full Plan\nDetailed body for GET /api/human/cards/:id",
    });
    expect(
      Array.isArray(detailRes.json["siblings"]) && detailRes.json["siblings"].length === 1,
    ).toBe(true);

    // DEC-02: Device 1 accepts card1 -> replay same request_id + same payload succeeds (200),
    // same request_id + different payload -> 409 IDEMPOTENCY_CONFLICT,
    // Device 2 with different request_id + stale version -> 409 VERSION_CONFLICT
    const dev1Accept = await humanReq(fx.app, "POST", `/api/human/cards/${card1Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dev1-accept-req",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(dev1Accept.status).toBe(200);

    const dev1Replay = await humanReq(fx.app, "POST", `/api/human/cards/${card1Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dev1-accept-req",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(dev1Replay.status).toBe(200);
    expect(dev1Replay.json["decision_id"]).toBe(dev1Accept.json["decision_id"]);

    const dev1ConflictPayload = await humanReq(
      fx.app,
      "POST",
      `/api/human/cards/${card1Id}/decide`,
      {
        cookie: fx.ownerCookie,
        body: {
          request_id: "dev1-accept-req",
          expected_version: 1,
          payload: { mode: "binary", decision: "declined" },
        },
      },
    );
    expect(dev1ConflictPayload.status).toBe(409);
    expect(dev1ConflictPayload.json["code"]).toBe("IDEMPOTENCY_CONFLICT");

    const dev2StaleVersion = await humanReq(fx.app, "POST", `/api/human/cards/${card1Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "dev2-other-req",
        expected_version: 1,
        payload: { mode: "binary", decision: "declined" },
      },
    });
    expect(dev2StaleVersion.status).toBe(409);
    expect(dev2StaleVersion.json["code"]).toBe("VERSION_CONFLICT");

    // GET /api/human/cards restores provisional card state for reload recovery
    const listDuringProv = await humanReq(fx.app, "GET", "/api/human/cards", {
      cookie: fx.ownerCookie,
    });
    expect(listDuringProv.status).toBe(200);
    const provCards: readonly unknown[] = Array.isArray(listDuringProv.json["provisionalCards"])
      ? listDuringProv.json["provisionalCards"]
      : [];
    expect(provCards).toHaveLength(1);

    // DEC-04: Concurrent accept on sibling card2 while card1 is provisional(accepted) -> 409 GROUP_LOCKED!
    const siblingAccept = await humanReq(fx.app, "POST", `/api/human/cards/${card2Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "sib-accept-locked",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      },
    });
    expect(siblingAccept.status).toBe(409);
    expect(siblingAccept.json["code"]).toBe("GROUP_LOCKED");

    // Undo card1, then decline BOTH card1 & card2 -> on_decline_policy="block" transitions task to blocked with 0 botWorkSent!
    const undoC1 = await humanReq(fx.app, "POST", `/api/human/cards/${card1Id}/undo`, {
      cookie: fx.ownerCookie,
      body: { request_id: "undo-c1-grp", expected_version: 2 },
    });
    expect(undoC1.status).toBe(200);

    const dec1 = await humanReq(fx.app, "POST", `/api/human/cards/${card1Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "decline-c1-grp",
        expected_version: 3,
        payload: { mode: "binary", decision: "declined" },
      },
    });
    expect(dec1.status).toBe(200);
    const dec2 = await humanReq(fx.app, "POST", `/api/human/cards/${card2Id}/decide`, {
      cookie: fx.ownerCookie,
      body: {
        request_id: "decline-c2-grp",
        expected_version: 1,
        payload: { mode: "binary", decision: "declined" },
      },
    });
    expect(dec2.status).toBe(200);

    fx.setNow(fx.getNow() + 5_000);
    const finD1 = await finalizeDecisionCard(fx.db, card1Id, {
      source: "queue",
      nowMs: fx.getNow(),
    });
    expect(finD1.result).toBe("declined");
    expect(finD1.nextTaskStatus).toBe("waiting_human"); // card2 is still provisional
    const finD2 = await finalizeDecisionCard(fx.db, card2Id, {
      source: "queue",
      nowMs: fx.getNow(),
    });
    expect(finD2.result).toBe("declined");
    expect(finD2.nextTaskStatus).toBe("blocked");
    expect(fx.botWorkSent).toHaveLength(0);

    const blockedTask = await fx.db.orm
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(blockedTask?.status).toBe("blocked");

    // M3: Deterministic concurrent task version bump right during decideHumanCard -> bounded retry catches conflict and spawns [再確認] card!
    const tRace = await mcpCall(fx.app, fx.bot1Token, "create_task", {
      request_id: "t-m3-race",
      title: "Mid-decide concurrent task update",
    });
    const tRaceId = String(tRace.data["task_id"]);
    const cRace = await mcpCall(fx.app, fx.bot1Token, "claim_task", {
      request_id: "c-m3-race",
      task_id: tRaceId,
      expected_version: 1,
    });
    const pRace = await mcpCall(fx.app, fx.bot1Token, "submit_proposal", {
      request_id: "p-m3-race",
      task_id: tRaceId,
      expected_version: 2,
      lease_token: String(cRace.data["lease_token"]),
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Race card",
          summary: "Task version bumps mid-decide",
          on_accept_effect: "Go",
          on_decline_effect: "Revise",
        },
      ],
    });
    const raceCards: readonly unknown[] = Array.isArray(pRace.data["cards"])
      ? pRace.data["cards"]
      : [];
    const raceCardId =
      raceCards[0] !== null && typeof raceCards[0] === "object"
        ? String(Reflect.get(raceCards[0], "card_id"))
        : "";

    let injectedBump = false;
    const baseD1 = createSqliteBackedD1(fx.db);
    const racingD1: D1LikeDatabase = {
      prepare(query: string) {
        return baseD1.prepare(query);
      },
      async batch(statements) {
        const firstSql: unknown =
          statements[0] !== undefined ? Reflect.get(statements[0], "__sql") : "";
        if (
          !injectedBump &&
          typeof firstSql === "string" &&
          firstSql.includes("UPDATE decision_cards") &&
          firstSql.includes("status = 'provisional'")
        ) {
          injectedBump = true;
          await fx.db.orm
            .update(schema.tasks)
            .set({ version: 99, updatedAt: fx.getNow() + 1 })
            .where(eq(schema.tasks.id, tRaceId));
        }
        return baseD1.batch(statements);
      },
      exec(query: string) {
        return baseD1.exec(query);
      },
    };

    const racePort = createHumanServicePort(createD1Database(racingD1), {
      now: () => fx.getNow(),
    });
    const ownerCtx = verifyOwnerSessionContext({
      userId: fx.ownerUserId,
      workspaceId: fx.workspaceId,
      sessionId: "sess-race",
    });

    let caughtError: unknown = null;
    try {
      await racePort.decideCard(ownerCtx, raceCardId, {
        request_id: "m3-race-decide",
        expected_version: 1,
        payload: { mode: "binary", decision: "accepted" },
      });
    } catch (err) {
      caughtError = err;
    }
    expect(injectedBump).toBe(true);
    expect(caughtError).toMatchObject({
      code: "STALE_PROPOSAL",
    });
    const raceDetails: unknown =
      caughtError !== null && typeof caughtError === "object"
        ? Reflect.get(caughtError, "details")
        : null;
    const raceReplacementId =
      raceDetails !== null && typeof raceDetails === "object"
        ? String(Reflect.get(raceDetails, "replacementCardId"))
        : "";
    expect(raceReplacementId.startsWith("card_")).toBe(true);
  });
});
