import { afterEach, describe, expect, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { ensureOwnerWorkspace } from "@/auth/better-auth";
import { type D1LikeDatabase, schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import workerHandler, { type WorkerRuntimeEnv } from "@/worker";

const openDbs: SqliteAppDatabase[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

const ORIGIN = "https://board.example.test";
const OWNER_GITHUB_ID = "github-owner-s4-77";
const AUTH_SECRET = "super-secret-s4-oauth-better-auth-key-0123456789";

function normalizeParam(v: unknown): string | number | null | Uint8Array {
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

interface AtomicD1Stmt {
  readonly __sql: string;
  readonly __params: readonly (string | number | null | Uint8Array)[];
  bind(...values: unknown[]): AtomicD1Stmt;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
  raw(): Promise<unknown[][]>;
}

function createSqliteBackedD1(db: SqliteAppDatabase): D1LikeDatabase {
  const buildStmt = (
    query: string,
    bound: readonly (string | number | null | Uint8Array)[] = [],
  ): AtomicD1Stmt => ({
    __sql: query,
    __params: bound,
    bind(...values: unknown[]) {
      return buildStmt(query, values.map(normalizeParam));
    },
    async run() {
      const res = await db.executor.batch([{ sql: query, params: bound }]);
      return { meta: { changes: res[0]?.changes ?? 0 } };
    },
    async raw(): Promise<unknown[][]> {
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
        rawBatch.push({ sql, params: typedParams.map(normalizeParam) });
      }
      const batchRes = await db.executor.batch(rawBatch);
      return batchRes.map((r) => ({ meta: { changes: r.changes } }));
    },
    async exec(query: string) {
      await db.executor.exec(query);
    },
  };
}

async function signBetterAuthSessionCookie(
  sessionToken: string,
  secret = AUTH_SECRET,
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
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${sessionToken}.${sigB64}`)}`;
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  return {};
}

function readStr(record: Record<string, unknown>, key: string): string {
  const val = record[key];
  return typeof val === "string" ? val : "";
}

async function parseMcpToolResponse(res: Response): Promise<{
  readonly status: number;
  readonly isError: boolean;
  readonly data: Record<string, unknown>;
}> {
  if (res.status !== 200) {
    const errJson: unknown = await res.json();
    return { status: res.status, isError: true, data: toRecord(errJson) };
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
  return { status: res.status, isError, data: toRecord(parsed) };
}

describe("S4 OAuth 2.1 MCP Discovery (RFC 9728/8414), DCR, Consent bot_connections Upsert, JWT Verification & Instant Revocation (BOT-02)", () => {
  test("executes complete OAuth 2.1 + PKCE + DCR + Consent narrowing + JWT /api/mcp + live D1 scope narrowing + instant revocation + revoked re-consent block", async () => {
    const sqliteDb = createSqliteDatabase(":memory:");
    openDbs.push(sqliteDb);
    await sqliteDb.applyMigrations();

    const nowMs = Date.now();
    const ownerUserId = "user-s4-owner";
    const ownerSessionToken = "sess-s4-owner-real-token";
    const intruderUserId = "user-s4-intruder";
    const intruderSessionToken = "sess-s4-intruder-token";

    await sqliteDb.orm.insert(schema.user).values([
      {
        id: ownerUserId,
        name: "Sole Owner",
        email: "owner@example.test",
        emailVerified: true,
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      },
      {
        id: intruderUserId,
        name: "Intruder",
        email: "intruder@example.test",
        emailVerified: true,
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      },
    ]);
    await sqliteDb.orm.insert(schema.account).values([
      {
        id: "acc-s4-owner-gh",
        accountId: OWNER_GITHUB_ID,
        providerId: "github",
        userId: ownerUserId,
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      },
      {
        id: "acc-s4-intruder-gh",
        accountId: "github-intruder-999",
        providerId: "github",
        userId: intruderUserId,
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      },
    ]);
    await sqliteDb.orm.insert(schema.session).values([
      {
        id: "sess-s4-1",
        token: ownerSessionToken,
        userId: ownerUserId,
        expiresAt: new Date(nowMs + 86_400_000),
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      },
      {
        id: "sess-s4-2",
        token: intruderSessionToken,
        userId: intruderUserId,
        expiresAt: new Date(nowMs + 86_400_000),
        createdAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      },
    ]);

    const workspaceId = await ensureOwnerWorkspace(sqliteDb, ownerUserId, nowMs);
    const ownerCookie = await signBetterAuthSessionCookie(ownerSessionToken);
    const intruderCookie = await signBetterAuthSessionCookie(intruderSessionToken);

    const env: WorkerRuntimeEnv = {
      DB: createSqliteBackedD1(sqliteDb),
      DECISION_FINALIZE_QUEUE: { send: () => Promise.resolve() },
      BOT_WORK_QUEUE: { send: () => Promise.resolve() },
      BOT_WORK_DLQ: { send: () => Promise.resolve() },
      BETTER_AUTH_SECRET: AUTH_SECRET,
      BETTER_AUTH_URL: ORIGIN,
      OWNER_GITHUB_ID,
    };
    const execCtx = { waitUntil: () => {} };

    const workerFetch = (request: Request) => workerHandler.fetch(request, env, execCtx);

    // 1. Unauthenticated /api/mcp returns 401 + RFC 9728 WWW-Authenticate header
    const unauthMcp = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(unauthMcp.status).toBe(401);
    expect(unauthMcp.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
    );

    // 2. RFC 9728 Protected Resource Metadata (both root & /api/mcp suffixed)
    const prmRootRes = await workerFetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource`),
    );
    expect(prmRootRes.status).toBe(200);
    const prmRoot = toRecord(await prmRootRes.json());
    expect(prmRoot["resource"]).toBe(`${ORIGIN}/api/mcp`);
    expect(prmRoot["authorization_servers"]).toEqual([`${ORIGIN}/api/auth`]);
    expect(prmRoot["scopes_supported"]).toEqual([
      "tasks:read",
      "tasks:write",
      "proposals:write",
      "decisions:read",
    ]);

    const prmPathRes = await workerFetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`),
    );
    expect(prmPathRes.status).toBe(200);
    const prmPathJson = toRecord(await prmPathRes.json());
    expect(prmPathJson["resource"]).toBe(`${ORIGIN}/api/mcp`);
    expect(prmPathJson["authorization_servers"]).toEqual([`${ORIGIN}/api/auth`]);

    // 3. RFC 8414 Authorization Server Metadata & OIDC Discovery (both root fallback & /api/auth path)
    const asMetaRootRes = await workerFetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    expect(asMetaRootRes.status).toBe(200);
    const asMeta = toRecord(await asMetaRootRes.json());
    expect(asMeta["issuer"]).toBe(`${ORIGIN}/api/auth`);
    expect(asMeta["registration_endpoint"]).toBe(`${ORIGIN}/api/auth/oauth2/register`);
    expect(asMeta["authorization_endpoint"]).toBe(`${ORIGIN}/api/auth/oauth2/authorize`);
    expect(asMeta["token_endpoint"]).toBe(`${ORIGIN}/api/auth/oauth2/token`);
    expect(asMeta["jwks_uri"]).toBe(`${ORIGIN}/api/auth/jwks`);

    const asMetaPathRes = await workerFetch(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
    );
    expect(asMetaPathRes.status).toBe(200);

    const oidcRootRes = await workerFetch(
      new Request(`${ORIGIN}/.well-known/openid-configuration`),
    );
    expect(oidcRootRes.status).toBe(200);
    const oidcRoot = toRecord(await oidcRootRes.json());
    expect(oidcRoot["issuer"]).toBe(`${ORIGIN}/api/auth`);

    // 4. Unauthenticated Dynamic Client Registration (RFC 7591)
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const dcrRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT Remote MCP",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "openid offline_access tasks:read tasks:write proposals:write decisions:read",
        }),
      }),
    );
    expect(dcrRes.status).toBe(201);
    const dcrBody = toRecord(await dcrRes.json());
    const clientId = readStr(dcrBody, "client_id");
    expect(clientId.length).toBeGreaterThan(5);

    // 5. Authorize endpoint -> unauthenticated redirects to /sign-in, authenticated redirects to /consent
    const codeVerifier = "s4-pkce-code-verifier-secret-string-0123456789-abcdef";
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const authorizeParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid offline_access tasks:read tasks:write proposals:write decisions:read",
      state: "state-xyz-123",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/api/mcp`,
    });

    const unauthAuthorize = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/authorize?${authorizeParams.toString()}`),
    );
    expect(unauthAuthorize.status).toBe(302);
    expect(unauthAuthorize.headers.get("Location")).toContain("/sign-in");

    const ownerAuthorize = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/authorize?${authorizeParams.toString()}`, {
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(ownerAuthorize.status).toBe(302);
    const consentLocation = ownerAuthorize.headers.get("Location") ?? "";
    expect(consentLocation).toContain("/consent");
    const consentUrl = new URL(consentLocation, ORIGIN);
    const signedOAuthQuery = consentUrl.search.slice(1);
    expect(signedOAuthQuery).toContain("sig=");

    // 6. GET /api/human/oauth/consent-context enforces 401/403, returns metadata for owner, and preserves empty bot scopes when explicitly non-bot (Minor 1)
    const ctxUnauth = await workerFetch(
      new Request(
        `${ORIGIN}/api/human/oauth/consent-context?client_id=${encodeURIComponent(clientId)}`,
      ),
    );
    expect(ctxUnauth.status).toBe(401);

    const ctxIntruder = await workerFetch(
      new Request(
        `${ORIGIN}/api/human/oauth/consent-context?client_id=${encodeURIComponent(clientId)}`,
        {
          headers: { Cookie: intruderCookie },
        },
      ),
    );
    expect(ctxIntruder.status).toBe(403);

    const ctxZeroBotScope = await workerFetch(
      new Request(
        `${ORIGIN}/api/human/oauth/consent-context?client_id=${encodeURIComponent(clientId)}&scope=openid`,
        { headers: { Cookie: ownerCookie } },
      ),
    );
    expect(ctxZeroBotScope.status).toBe(200);
    expect(toRecord(await ctxZeroBotScope.json())["requested_bot_scopes"]).toEqual([]);

    const ctxOwner = await workerFetch(
      new Request(
        `${ORIGIN}/api/human/oauth/consent-context?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent("openid offline_access tasks:read tasks:write proposals:write")}`,
        { headers: { Cookie: ownerCookie } },
      ),
    );
    expect(ctxOwner.status).toBe(200);
    const ctxOwnerJson = toRecord(await ctxOwner.json());
    expect(ctxOwnerJson["client_name"]).toBe("ChatGPT Remote MCP");
    expect(ctxOwnerJson["requested_bot_scopes"]).toEqual([
      "tasks:read",
      "tasks:write",
      "proposals:write",
    ]);
    expect(ctxOwnerJson["other_requested_scopes"]).toEqual(["openid", "offline_access"]);
    expect(ctxOwnerJson["existing_status"]).toBeNull();

    // 7. Non-owner consent submission is blocked with 403
    const intruderConsent = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: intruderCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid tasks:read",
          oauth_query: signedOAuthQuery,
        }),
      }),
    );
    expect(intruderConsent.status).toBe(403);

    // 8. Owner denying consent returns access_denied redirect and creates ZERO bot_connections rows
    const denyConsent = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: false,
          oauth_query: signedOAuthQuery,
        }),
      }),
    );
    expect(denyConsent.status).toBe(200);
    const denyJson = toRecord(await denyConsent.json());
    expect(String(denyJson["url"])).toContain("error=access_denied");
    const botsAfterDeny = await sqliteDb.orm
      .select()
      .from(schema.botConnections)
      .where(eq(schema.botConnections.workspaceId, workspaceId))
      .all();
    expect(botsAfterDeny).toHaveLength(0);

    // 9. Owner approving with 0 Bot scopes (only "openid") is rejected with 400
    const zeroBotScopeConsent = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid",
          oauth_query: signedOAuthQuery,
        }),
      }),
    );
    expect(zeroBotScopeConsent.status).toBe(400);

    // 10. Owner approves with narrowed scopes ("openid offline_access tasks:read tasks:write") -> upserts bot_connections in D1!
    const approveConsent = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid offline_access tasks:read tasks:write",
          oauth_query: signedOAuthQuery,
        }),
      }),
    );
    expect(approveConsent.status).toBe(200);
    const approveJson = toRecord(await approveConsent.json());
    expect(approveJson["redirect"]).toBe(true);
    const callbackUrl = new URL(String(approveJson["url"]));
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(redirectUri);
    const authCode = callbackUrl.searchParams.get("code") ?? "";
    expect(authCode.length).toBeGreaterThan(5);
    expect(callbackUrl.searchParams.get("state")).toBe("state-xyz-123");

    const upsertedBot = await sqliteDb.orm
      .select()
      .from(schema.botConnections)
      .where(
        and(
          eq(schema.botConnections.workspaceId, workspaceId),
          eq(schema.botConnections.oauthClientId, clientId),
        ),
      )
      .get();
    expect(upsertedBot).toBeDefined();
    expect(upsertedBot?.channelType).toBe("mcp_oauth");
    expect(upsertedBot?.status).toBe("active");
    expect(JSON.parse(upsertedBot?.scopes ?? "[]")).toEqual(["tasks:read", "tasks:write"]);

    // 11. Exchange PKCE code at /api/auth/oauth2/token -> receive signed JWT access_token
    const tokenRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: codeVerifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokenJson = toRecord(await tokenRes.json());
    const accessToken = readStr(tokenJson, "access_token");
    const refreshToken = readStr(tokenJson, "refresh_token");
    const idToken = readStr(tokenJson, "id_token");
    expect(accessToken.split(".")).toHaveLength(3); // Signed JWS/JWT bound to resource /api/mcp
    expect(refreshToken.length).toBeGreaterThan(5);
    expect(idToken.split(".")).toHaveLength(3);

    // M2 negative JWT security checks on /api/mcp:
    // 1) Presenting OIDC id_token (wrong typ + wrong aud) as Bearer token MUST fail 401
    const idTokenMcp = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/list" }),
      }),
    );
    expect(idTokenMcp.status).toBe(401);

    // 2) Tampered JWT signature MUST fail 401
    const jwtParts = accessToken.split(".");
    const tamperedSig =
      (jwtParts[2] ?? "").slice(0, -4) + ((jwtParts[2] ?? "").endsWith("AAAA") ? "BBBB" : "AAAA");
    const tamperedJwt = `${jwtParts[0] ?? ""}.${jwtParts[1] ?? ""}.${tamperedSig}`;
    const tamperedMcp = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tamperedJwt}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/list" }),
      }),
    );
    expect(tamperedMcp.status).toBe(401);

    // 12. Call /api/mcp with issued JWT through workerHandler.fetch!
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      const res = await workerFetch(
        new Request(`${ORIGIN}/api/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
      return await parseMcpToolResponse(res);
    };

    const wsCtxRes = await callMcp("get_workspace_context", {});
    expect(wsCtxRes.status).toBe(200);
    expect(wsCtxRes.isError).toBe(false);
    expect(wsCtxRes.data["workspace_id"]).toBe(workspaceId);

    const createTaskRes = await callMcp("create_task", {
      request_id: "oauth-jwt-task-1",
      title: "Created via real OAuth 2.1 JWT",
    });
    expect(createTaskRes.isError).toBe(false);
    const taskId = String(createTaskRes.data["task_id"]);
    const claimRes = await callMcp("claim_task", {
      request_id: "oauth-jwt-claim-1",
      task_id: taskId,
      expected_version: 1,
    });
    expect(claimRes.isError).toBe(false);

    // Excluded scope ("proposals:write") is strictly rejected with NOT_AUTHORIZED!
    const deniedProposal = await callMcp("submit_proposal", {
      request_id: "oauth-jwt-prop-1",
      task_id: taskId,
      expected_version: 2,
      lease_token: String(claimRes.data["lease_token"]),
      proposals: [
        {
          card_type: "policy",
          selection_mode: "binary",
          title: "Should be denied",
          summary: "No proposals:write scope",
          on_accept_effect: "A",
          on_decline_effect: "B",
        },
      ],
    });
    expect(deniedProposal.isError).toBe(true);
    expect(deniedProposal.data["code"]).toBe("NOT_AUTHORIZED");

    // 13. Active re-consent updates existing bot_connections row (scopes updated, version incremented, zero duplicate rows!)
    const reAuthActive = await workerFetch(
      new Request(
        `${ORIGIN}/api/auth/oauth2/authorize?${authorizeParams.toString()}&prompt=consent`,
        {
          headers: { Cookie: ownerCookie },
        },
      ),
    );
    expect(reAuthActive.status).toBe(302);
    const reAuthConsentQuery = new URL(
      reAuthActive.headers.get("Location") ?? "",
      ORIGIN,
    ).search.slice(1);
    const reConsentActiveRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid offline_access tasks:read tasks:write decisions:read",
          oauth_query: reAuthConsentQuery,
        }),
      }),
    );
    expect(reConsentActiveRes.status).toBe(200);
    const botsAfterReconsent = await sqliteDb.orm
      .select()
      .from(schema.botConnections)
      .where(
        and(
          eq(schema.botConnections.workspaceId, workspaceId),
          eq(schema.botConnections.oauthClientId, clientId),
        ),
      )
      .all();
    expect(botsAfterReconsent).toHaveLength(1);
    expect(botsAfterReconsent[0]?.version).toBe(2);
    expect(JSON.parse(botsAfterReconsent[0]?.scopes ?? "[]")).toEqual([
      "tasks:read",
      "tasks:write",
      "decisions:read",
    ]);

    // Rotate refresh token once BEFORE revocation to populate rotationReplayResponse/rotationReplayExpiresAt (M2)
    const preRevokeRefreshRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect(preRevokeRefreshRes.status).toBe(200);
    const rotatedRefreshToken = readStr(
      toRecord(await preRevokeRefreshRes.json()),
      "refresh_token",
    );
    expect(rotatedRefreshToken.length).toBeGreaterThan(5);

    // 14. Owner narrows D1 bot_connections scopes to ["tasks:read"] -> ALREADY-ISSUED JWT loses tasks:write immediately!
    const botId = upsertedBot?.id ?? "";
    const narrowRes = await workerFetch(
      new Request(`${ORIGIN}/api/human/bots/${botId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          request_id: "narrow-oauth-bot-1",
          expected_version: 2,
          scopes: ["tasks:read"],
        }),
      }),
    );
    expect(narrowRes.status).toBe(200);

    const readStillOk = await callMcp("get_workspace_context", {});
    expect(readStillOk.isError).toBe(false);

    const writeNowDenied = await callMcp("create_task", {
      request_id: "oauth-jwt-task-denied",
      title: "Should fail after D1 scope narrowing",
    });
    expect(writeNowDenied.isError).toBe(true);
    expect(writeNowDenied.data["code"]).toBe("NOT_AUTHORIZED");

    // 15. Owner revokes bot -> ALREADY-ISSUED JWT is IMMEDIATELY rejected with 401, ALL refresh tokens + rotation replay cleared,
    //     consent-context reports "revoked", and re-authorizing / token exchange (form, Basic, private_key_jwt) are HARD BLOCKED (BOT-02, M2)!
    const revokeRes = await workerFetch(
      new Request(`${ORIGIN}/api/human/bots/${botId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          request_id: "revoke-oauth-bot-1",
          expected_version: 3,
          status: "revoked",
        }),
      }),
    );
    expect(revokeRes.status).toBe(200);

    // M2: Verify rotationReplayResponse and rotationReplayExpiresAt were cleared on ALL refresh token rows for this client
    const refreshRowsAfterRevoke = await sqliteDb.orm
      .select()
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.clientId, clientId))
      .all();
    expect(refreshRowsAfterRevoke.length).toBeGreaterThanOrEqual(2);
    for (const row of refreshRowsAfterRevoke) {
      expect(row.revoked).not.toBeNull();
      expect(row.rotationReplayResponse).toBeNull();
      expect(row.rotationReplayExpiresAt).toBeNull();
    }

    const revokedMcpRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_workspace_context", arguments: {} },
        }),
      }),
    );
    expect(revokedMcpRes.status).toBe(401);
    expect(revokedMcpRes.headers.get("WWW-Authenticate")).toContain("oauth-protected-resource");

    const ctxAfterRevoke = await workerFetch(
      new Request(
        `${ORIGIN}/api/human/oauth/consent-context?client_id=${encodeURIComponent(clientId)}`,
        {
          headers: { Cookie: ownerCookie },
        },
      ),
    );
    expect(ctxAfterRevoke.status).toBe(200);
    expect(toRecord(await ctxAfterRevoke.json())["existing_status"]).toBe("revoked");

    // Re-consent attempt for revoked client is rejected with 403 and leaves ZERO oauthConsent rows
    const reAuthorize = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/authorize?${authorizeParams.toString()}`, {
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(reAuthorize.status).toBe(302);
    const reConsentQuery = new URL(reAuthorize.headers.get("Location") ?? "", ORIGIN).search.slice(
      1,
    );
    const reConsentRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid tasks:read",
          oauth_query: reConsentQuery,
        }),
      }),
    );
    expect(reConsentRes.status).toBe(403);
    const remainingConsents = await sqliteDb.orm
      .select()
      .from(schema.oauthConsent)
      .where(eq(schema.oauthConsent.clientId, clientId))
      .all();
    expect(remainingConsents).toHaveLength(0);

    // Real revoked refresh token via form body, Basic auth, AND private_key_jwt client_assertion are ALL blocked with 403 (M2)
    const revokedTokenBodyRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rotatedRefreshToken,
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(revokedTokenBodyRes.status).toBe(403);

    const revokedTokenBasicRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${btoa(`${clientId}:unused-secret`)}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rotatedRefreshToken,
        }).toString(),
      }),
    );
    expect(revokedTokenBasicRes.status).toBe(403);

    const fakeHeader = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const fakePayload = btoa(JSON.stringify({ iss: clientId, sub: clientId }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const revokedTokenAssertionRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rotatedRefreshToken,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: `${fakeHeader}.${fakePayload}.sig`,
        }).toString(),
      }),
    );
    expect(revokedTokenAssertionRes.status).toBe(403);
  });
});
