import { afterEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { ensureOwnerWorkspace } from "@/auth/better-auth";
import { type D1LikeDatabase, schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import { MCP_BOT_TOOL_NAMES } from "@/server/routes/mcp";
import workerHandler, { type WorkerRuntimeEnv } from "@/worker";

const openDbs: SqliteAppDatabase[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

const ORIGIN = "https://board.example.test";
const OWNER_EMAIL = "owner@example.test";
const AUTH_SECRET = "plugin-interop-security-secret-key-0123456789abcdef";

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

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeDerInteger(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) {
    start += 1;
  }
  const trimmed = raw.slice(start);
  const needsZeroPad = (trimmed[0] ?? 0) >= 0x80;
  const out = new Uint8Array(2 + (needsZeroPad ? 1 : 0) + trimmed.length);
  out[0] = 0x02;
  out[1] = trimmed.length + (needsZeroPad ? 1 : 0);
  if (needsZeroPad) {
    out[2] = 0x00;
    out.set(trimmed, 3);
  } else {
    out.set(trimmed, 2);
  }
  return out;
}

function rawEcdsaSignatureToDer(rawSig: Uint8Array): Uint8Array {
  const half = rawSig.length / 2;
  const r = encodeDerInteger(rawSig.slice(0, half));
  const s = encodeDerInteger(rawSig.slice(half));
  const seq = new Uint8Array(2 + r.length + s.length);
  seq[0] = 0x30;
  seq[1] = r.length + s.length;
  seq.set(r, 2);
  seq.set(s, 2 + r.length);
  return seq;
}

async function generateTestWebAuthnP256Key(): Promise<{
  readonly privateKey: CryptoKey;
  readonly cosePublicKeyBase64: string;
}> {
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in generated) || !("publicKey" in generated)) {
    throw new Error("Expected ECDSA CryptoKeyPair");
  }
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", generated.publicKey));
  const x = rawPub.slice(1, 33);
  const y = rawPub.slice(33, 65);
  // Minimal CBOR COSE EC2 P-256 ES256 key map: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
  const cose = new Uint8Array([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...x,
    0x22,
    0x58,
    0x20,
    ...y,
  ]);
  return {
    privateKey: generated.privateKey,
    cosePublicKeyBase64: bytesToBase64(cose),
  };
}

async function buildSignedWebAuthnAssertion(params: {
  readonly credentialId: string;
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
  readonly counter: number;
  readonly privateKey: CryptoKey;
}): Promise<Record<string, unknown>> {
  const clientDataBytes = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: params.challenge,
      origin: params.origin,
      crossOrigin: false,
    }),
  );
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataBytes));
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.rpId)),
  );
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05; // UP (0x01) | UV (0x04)
  new DataView(authData.buffer).setUint32(33, params.counter, false);

  const signedPayload = new Uint8Array(authData.length + clientDataHash.length);
  signedPayload.set(authData, 0);
  signedPayload.set(clientDataHash, authData.length);

  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, params.privateKey, signedPayload),
  );
  const derSig = rawEcdsaSignatureToDer(rawSig);

  return {
    id: params.credentialId,
    rawId: params.credentialId,
    type: "public-key",
    response: {
      authenticatorData: bytesToBase64Url(authData),
      clientDataJSON: bytesToBase64Url(clientDataBytes),
      signature: bytesToBase64Url(derSig),
    },
    clientExtensionResults: {},
  };
}

function extractCookieHeader(res: Response): string {
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return cookies
    .map((entry) => entry.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair !== "")
    .join("; ");
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

async function parseJsonOrSseRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.trim().startsWith("event:") || text.includes("\ndata:")) {
    const line = text
      .split(/\r?\n/)
      .find((l) => l.startsWith("data:"))
      ?.slice(5)
      .trim();
    const parsed: unknown = line !== undefined ? JSON.parse(line) : {};
    return toRecord(parsed);
  }
  const parsed: unknown = JSON.parse(text);
  return toRecord(parsed);
}

async function setupEnv(options: { readonly seedOwner?: boolean } = {}) {
  const sqliteDb = createSqliteDatabase(":memory:");
  openDbs.push(sqliteDb);
  await sqliteDb.applyMigrations();

  const nowMs = Date.now();
  const ownerUserId = "user-plugin-owner";
  const ownerSessionToken = "sess-plugin-owner-token-1";
  let ownerCookie = "";

  if (options.seedOwner !== false) {
    await sqliteDb.orm.insert(schema.user).values({
      id: ownerUserId,
      name: "Sole Owner",
      email: OWNER_EMAIL,
      emailVerified: true,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await sqliteDb.orm.insert(schema.account).values({
      id: "acc-plugin-owner-cred",
      accountId: ownerUserId,
      providerId: "credential",
      userId: ownerUserId,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await sqliteDb.orm.insert(schema.session).values({
      id: "sess-plugin-1",
      token: ownerSessionToken,
      userId: ownerUserId,
      expiresAt: new Date(nowMs + 86_400_000),
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await ensureOwnerWorkspace(sqliteDb, ownerUserId, nowMs);
    ownerCookie = await signBetterAuthSessionCookie(ownerSessionToken);
  }

  const env: WorkerRuntimeEnv = {
    DB: createSqliteBackedD1(sqliteDb),
    DECISION_FINALIZE_QUEUE: { send: () => Promise.resolve() },
    BOT_WORK_QUEUE: { send: () => Promise.resolve() },
    BOT_WORK_DLQ: { send: () => Promise.resolve() },
    ASSETS: {
      fetch: () =>
        Promise.resolve(
          new Response("<!doctype html><html><body>bot-board</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
        ),
    },
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BETTER_AUTH_URL: ORIGIN,
    TRUSTED_ORIGINS: ORIGIN,
    OWNER_EMAIL,
    APP_ENV: "staging",
  };

  const workerFetch = async (request: Request): Promise<Response> => {
    const pending: Promise<unknown>[] = [];
    const res = await workerHandler.fetch(request, env, {
      waitUntil(promise) {
        pending.push(promise);
      },
    });
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    return res;
  };

  return { sqliteDb, env, workerFetch, ownerUserId, ownerSessionToken, ownerCookie };
}

describe("Track 2 Plugin Interoperability, CORS Boundaries, Security Headers, Non-Owner Redirect & Sign-Out", () => {
  test("enforces CORS allowlist + OPTIONS 204 on /api/mcp, /api/mcp/, and public OAuth endpoints, and forbids CORS on cookie routes (Sec-B1, Sec-M2)", async () => {
    const { workerFetch, ownerCookie } = await setupEnv();

    // 1. OPTIONS /api/mcp and /api/mcp/ -> 204 + MCP CORS headers (NEVER Allow-Credentials)
    for (const mcpPath of ["/api/mcp", "/api/mcp/"]) {
      const optRes = await workerFetch(
        new Request(`${ORIGIN}${mcpPath}`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://chatgpt.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers":
              "Authorization, Content-Type, Accept, MCP-Protocol-Version",
          },
        }),
      );
      expect(optRes.status).toBe(204);
      expect(optRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(optRes.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, HEAD, POST, DELETE, OPTIONS",
      );
      expect(optRes.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
      expect(optRes.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
      expect(optRes.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }

    // 2. Public non-cookie OAuth discovery, JWKS, DCR, token, revoke endpoints support OPTIONS 204 + CORS
    const publicGetPaths = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/openid-configuration",
      "/.well-known/openid-configuration/api/auth",
      "/api/auth/.well-known/openid-configuration",
      "/api/auth/jwks",
    ];
    for (const path of publicGetPaths) {
      const optRes = await workerFetch(new Request(`${ORIGIN}${path}`, { method: "OPTIONS" }));
      expect(optRes.status).toBe(204);
      expect(optRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(optRes.headers.get("Access-Control-Allow-Credentials")).toBeNull();

      const getRes = await workerFetch(new Request(`${ORIGIN}${path}`, { method: "GET" }));
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(getRes.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }

    // Verify trimmed grant_types_supported (Sec-m2) and path-inserted OIDC discovery (Sec-M1)
    const oidcPathRes = await workerFetch(
      new Request(`${ORIGIN}/.well-known/openid-configuration/api/auth`),
    );
    expect(oidcPathRes.status).toBe(200);
    const oidcMeta = toRecord(await oidcPathRes.json());
    expect(oidcMeta["issuer"]).toBe(`${ORIGIN}/api/auth`);
    expect(oidcMeta["grant_types_supported"]).toEqual(["authorization_code", "refresh_token"]);

    for (const postPath of [
      "/api/auth/oauth2/register",
      "/api/auth/oauth2/token",
      "/api/auth/oauth2/revoke",
    ]) {
      const optRes = await workerFetch(new Request(`${ORIGIN}${postPath}`, { method: "OPTIONS" }));
      expect(optRes.status).toBe(204);
      expect(optRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(optRes.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
      expect(optRes.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }

    // 3. Cookie-authenticated, email-auth, owner-status, and Passkey routes MUST NEVER emit CORS headers and MUST emit Cache-Control: no-store
    const cookieRoutes: ReadonlyArray<{ readonly method: string; readonly path: string }> = [
      { method: "GET", path: "/api/human/workspace" },
      { method: "GET", path: "/api/auth/get-session" },
      { method: "GET", path: "/api/auth/owner-status" },
      { method: "POST", path: "/api/auth/sign-up/email" },
      { method: "POST", path: "/api/auth/sign-in/email" },
      { method: "POST", path: "/api/auth/oauth2/consent" },
      { method: "GET", path: "/api/auth/passkey/generate-register-options" },
      { method: "POST", path: "/api/auth/passkey/verify-registration" },
      { method: "GET", path: "/api/auth/passkey/generate-authenticate-options" },
      { method: "POST", path: "/api/auth/passkey/verify-authentication" },
      { method: "GET", path: "/api/auth/passkey/list-user-passkeys" },
      { method: "POST", path: "/api/auth/passkey/delete-passkey" },
      { method: "POST", path: "/api/auth/passkey/update-passkey" },
    ];
    for (const route of cookieRoutes) {
      const res = await workerFetch(
        new Request(`${ORIGIN}${route.path}`, {
          method: route.method,
          headers: {
            Origin: "https://evil.example.com",
            Cookie: ownerCookie,
            ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          ...(route.method === "POST" ? { body: JSON.stringify({}) } : {}),
        }),
      );
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("emits RFC 9728/6750 WWW-Authenticate with/without invalid_token and enforces HTTP security headers on API + SPA assets (Sec-B3, Sec-M1)", async () => {
    const { workerFetch, ownerCookie } = await setupEnv();

    // 1. Missing Authorization -> path-aware resource_metadata + scope, NO error="invalid_token"
    const missingAuth = await workerFetch(
      new Request(`${ORIGIN}/api/mcp/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(missingAuth.status).toBe(401);
    expect(missingAuth.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write proposals:write decisions:read"`,
    );
    expect(missingAuth.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(missingAuth.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
    expect(missingAuth.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(missingAuth.headers.get("X-Frame-Options")).toBe("DENY");
    expect(missingAuth.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(missingAuth.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(missingAuth.headers.get("Cache-Control")).toBe("no-store");

    // 2. Invalid/expired Bearer token -> includes error="invalid_token"
    const invalidAuth = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid_expired_token_value",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    expect(invalidAuth.status).toBe(401);
    expect(invalidAuth.headers.get("WWW-Authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write proposals:write decisions:read"`,
    );

    // 3. Human API security headers + no-store
    const humanRes = await workerFetch(
      new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(humanRes.status).toBe(200);
    expect(humanRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(humanRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(humanRes.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(humanRes.headers.get("Cache-Control")).toBe("no-store");
    expect(humanRes.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );

    // 4. SPA assets security headers via Worker env.ASSETS.fetch (including strict /consent & /sign-in rules)
    const rootSpa = await workerFetch(new Request(`${ORIGIN}/`));
    expect(rootSpa.status).toBe(200);
    expect(rootSpa.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(rootSpa.headers.get("X-Frame-Options")).toBe("DENY");
    expect(rootSpa.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(rootSpa.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(rootSpa.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );

    for (const sensitiveSpa of ["/consent", "/sign-in"]) {
      const spaRes = await workerFetch(new Request(`${ORIGIN}${sensitiveSpa}`));
      expect(spaRes.status).toBe(200);
      expect(spaRes.headers.get("X-Frame-Options")).toBe("DENY");
      expect(spaRes.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(spaRes.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("rejects non-owner email signup with 403 (0 D1 rows), confirms GitHub social sign-in is removed, and serves GET /api/auth/owner-status without CORS or email leakage (BOT-02)", async () => {
    const { sqliteDb, workerFetch } = await setupEnv({ seedOwner: false });

    // 1. Uninitialized owner-status returns { initialized: false } with no-store & zero CORS
    const statusBefore = await workerFetch(
      new Request(`${ORIGIN}/api/auth/owner-status`, {
        method: "GET",
        headers: { Origin: "https://evil.example" },
      }),
    );
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.headers.get("Cache-Control")).toBe("no-store");
    expect(statusBefore.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const statusBeforeText = await statusBefore.text();
    expect(statusBeforeText).not.toContain(OWNER_EMAIL);
    expect(toRecord(JSON.parse(statusBeforeText))["initialized"]).toBe(false);

    // 2. GitHub OAuth social provider is completely removed (must fail with 4xx)
    const removedGithub = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: `${ORIGIN}/`,
        }),
      }),
    );
    expect(removedGithub.status).toBeGreaterThanOrEqual(400);
    expect(removedGithub.status).toBeLessThan(500);
    expect(removedGithub.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // 3. Non-owner email signup is rejected 403 NOT_AUTHORIZED with 0 D1 rows created
    const nonOwnerSignup = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          name: "Intruder",
          email: "intruder@example.test",
          password: "correct-horse-battery-staple",
        }),
      }),
    );
    expect(nonOwnerSignup.status).toBe(403);
    expect(nonOwnerSignup.headers.get("Cache-Control")).toBe("no-store");
    expect(nonOwnerSignup.headers.get("Access-Control-Allow-Origin")).toBeNull();

    expect((await sqliteDb.orm.select().from(schema.user).all()).length).toBe(0);
    expect((await sqliteDb.orm.select().from(schema.account).all()).length).toBe(0);
    expect((await sqliteDb.orm.select().from(schema.session).all()).length).toBe(0);
    expect((await sqliteDb.orm.select().from(schema.workspaces).all()).length).toBe(0);
  });

  test("bootstraps first-time owner via POST /api/auth/sign-up/email, permanently locks 2nd signup, authorizes /api/human/workspace, and serves Passkey endpoints with zero CORS (BOT-02)", async () => {
    const { sqliteDb, workerFetch } = await setupEnv({ seedOwner: false });

    // 1. Short password (<12 chars) is rejected even for OWNER_EMAIL
    const shortPwRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          name: "Sole Owner",
          email: OWNER_EMAIL,
          password: "short-pw",
        }),
      }),
    );
    expect(shortPwRes.status).toBe(400);
    expect((await sqliteDb.orm.select().from(schema.user).all()).length).toBe(0);

    // 2. First-time OWNER_EMAIL signup (case-insensitive) succeeds, creates workspace, and sets signed session cookie
    const ownerPassword = "correct-horse-battery-staple-2026";
    const signupRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          name: "Sole Owner",
          email: "Owner@Example.Test",
          password: ownerPassword,
        }),
      }),
    );
    expect(signupRes.status).toBe(200);
    expect(signupRes.headers.get("Cache-Control")).toBe("no-store");
    expect(signupRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const signupCookies =
      typeof signupRes.headers.getSetCookie === "function" ? signupRes.headers.getSetCookie() : [];
    const sessionCookieHeader = signupCookies
      .map((entry) => entry.split(";")[0]?.trim() ?? "")
      .filter((pair) => pair.includes("session_token="))
      .join("; ");
    expect(sessionCookieHeader).toContain("session_token=");

    // Verify canonical lowercase user, credential account, session, and auto-created workspace
    const users = await sqliteDb.orm.select().from(schema.user).all();
    const accounts = await sqliteDb.orm.select().from(schema.account).all();
    const sessions = await sqliteDb.orm.select().from(schema.session).all();
    const workspaces = await sqliteDb.orm.select().from(schema.workspaces).all();
    expect(users.length).toBe(1);
    expect(users[0]?.email).toBe(OWNER_EMAIL);
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.providerId).toBe("credential");
    expect(sessions.length).toBe(1);
    expect(workspaces.length).toBe(1);

    // 3. owner-status flips to { initialized: true }
    const statusAfter = await workerFetch(new Request(`${ORIGIN}/api/auth/owner-status`));
    expect(statusAfter.status).toBe(200);
    expect(toRecord(await statusAfter.json())["initialized"]).toBe(true);

    // 4. Subsequent signup attempts are permanently locked with identical 403 for OWNER_EMAIL & non-owner (zero enumeration oracle; M1)
    const duplicateOwnerSignup = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          name: "Duplicate Owner",
          email: OWNER_EMAIL,
          password: ownerPassword,
        }),
      }),
    );
    const duplicateIntruderSignup = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          name: "Duplicate Intruder",
          email: "intruder@example.test",
          password: ownerPassword,
        }),
      }),
    );
    expect(duplicateOwnerSignup.status).toBe(403);
    expect(duplicateIntruderSignup.status).toBe(403);
    const duplicateOwnerBody = await duplicateOwnerSignup.text();
    const duplicateIntruderBody = await duplicateIntruderSignup.text();
    expect(duplicateIntruderBody).toBe(duplicateOwnerBody);

    // 5. Session authorizes /api/human/workspace
    const wsRes = await workerFetch(
      new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: sessionCookieHeader },
      }),
    );
    expect(wsRes.status).toBe(200);
    const wsJson = toRecord(await wsRes.json());
    expect(wsJson["id"]).toBe(workspaces[0]?.id);

    // 6. Better Auth Passkey endpoints: unauthenticated register/list blocked (401); authenticated owner succeeds with rpID & zero CORS
    const unauthRegisterOpts = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/generate-register-options`),
    );
    expect(unauthRegisterOpts.status).toBe(401);
    expect(unauthRegisterOpts.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const unauthListPk = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/list-user-passkeys`),
    );
    expect(unauthListPk.status).toBe(401);

    const ownerRegisterOpts = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/generate-register-options?name=iPhone`, {
        headers: { Cookie: sessionCookieHeader, Origin: ORIGIN },
      }),
    );
    expect(ownerRegisterOpts.status).toBe(200);
    expect(ownerRegisterOpts.headers.get("Cache-Control")).toBe("no-store");
    expect(ownerRegisterOpts.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const regOptsJson = toRecord(await ownerRegisterOpts.json());
    expect(typeof regOptsJson["challenge"]).toBe("string");
    expect(readStr(toRecord(regOptsJson["rp"]), "id")).toBe("board.example.test");
    expect(readStr(toRecord(regOptsJson["rp"]), "name")).toBe("bot-board");
    expect(readStr(toRecord(regOptsJson["authenticatorSelection"]), "residentKey")).toBe(
      "required",
    );

    const ownerListPk = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/list-user-passkeys`, {
        headers: { Cookie: sessionCookieHeader },
      }),
    );
    expect(ownerListPk.status).toBe(200);
    expect(ownerListPk.headers.get("Cache-Control")).toBe("no-store");
    expect(ownerListPk.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await ownerListPk.json()).toEqual([]);

    const authOptsRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
        headers: { Origin: ORIGIN },
      }),
    );
    expect(authOptsRes.status).toBe(200);
    expect(authOptsRes.headers.get("Cache-Control")).toBe("no-store");
    expect(authOptsRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const authOptsJson = toRecord(await authOptsRes.json());
    expect(typeof authOptsJson["challenge"]).toBe("string");
    expect(authOptsJson["rpId"]).toBe("board.example.test");

    // 7. Sign-out + Email/Password recovery sign-in issues a fresh valid session cookie
    const signOutRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: sessionCookieHeader,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(signOutRes.status).toBe(200);

    const signInRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          email: OWNER_EMAIL,
          password: ownerPassword,
        }),
      }),
    );
    expect(signInRes.status).toBe(200);
    expect(signInRes.headers.get("Cache-Control")).toBe("no-store");
    expect(signInRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const freshCookies =
      typeof signInRes.headers.getSetCookie === "function" ? signInRes.headers.getSetCookie() : [];
    const freshSessionCookie = freshCookies
      .map((entry) => entry.split(";")[0]?.trim() ?? "")
      .filter((pair) => pair.includes("session_token="))
      .join("; ");
    expect(freshSessionCookie).toContain("session_token=");

    const wsAfterSignIn = await workerFetch(
      new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: freshSessionCookie },
      }),
    );
    expect(wsAfterSignIn.status).toBe(200);
  });

  test("enforces Passkey authz on all 5 authenticated routes (401 unauth / 403 non-owner), verifies real WebAuthn P-256 passkey + OAuth 2.1 oauth_query resumption, blocks tampered oauth_query & non-owner passkey sessions, and deletes passkeys (BOT-02, M3)", async () => {
    const { sqliteDb, workerFetch } = await setupEnv({ seedOwner: false });
    const ownerPassword = "correct-horse-battery-staple-2026";

    // 1. Bootstrap owner via real POST /api/auth/sign-up/email so scrypt credential + workspace exist
    const bootstrapRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          name: "Sole Owner",
          email: OWNER_EMAIL,
          password: ownerPassword,
        }),
      }),
    );
    expect(bootstrapRes.status).toBe(200);
    const ownerUserRow = await sqliteDb.orm
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, OWNER_EMAIL))
      .get();
    expect(ownerUserRow).toBeDefined();
    const ownerUserId = ownerUserRow?.id ?? "";

    // 2. Seed a non-owner user + signed session cookie directly into D1 to test defense-in-depth authz
    const nowMs = Date.now();
    const nonOwnerUserId = "user-intruder-defense-in-depth";
    const nonOwnerSessionToken = "sess-intruder-token-1";
    await sqliteDb.orm.insert(schema.user).values({
      id: nonOwnerUserId,
      name: "Intruder User",
      email: "intruder@example.test",
      emailVerified: true,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    await sqliteDb.orm.insert(schema.session).values({
      id: "sess-intruder-1",
      token: nonOwnerSessionToken,
      userId: nonOwnerUserId,
      expiresAt: new Date(nowMs + 86_400_000),
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });
    const nonOwnerCookie = await signBetterAuthSessionCookie(nonOwnerSessionToken);

    // 3. All 5 PASSKEY_AUTHENTICATED_PATHS MUST return 401 unauthenticated AND 403 for non-owner sessions
    const passkeyManagementRoutes: ReadonlyArray<{
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: Record<string, unknown>;
    }> = [
      { method: "GET", path: "/api/auth/passkey/generate-register-options" },
      {
        method: "POST",
        path: "/api/auth/passkey/verify-registration",
        body: { response: {} },
      },
      { method: "GET", path: "/api/auth/passkey/list-user-passkeys" },
      {
        method: "POST",
        path: "/api/auth/passkey/delete-passkey",
        body: { id: "pk_missing" },
      },
      {
        method: "POST",
        path: "/api/auth/passkey/update-passkey",
        body: { id: "pk_missing", name: "Hijacked" },
      },
    ];
    for (const route of passkeyManagementRoutes) {
      const unauthRes = await workerFetch(
        new Request(`${ORIGIN}${route.path}`, {
          method: route.method,
          headers: {
            Origin: ORIGIN,
            ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
        }),
      );
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(unauthRes.headers.get("Cache-Control")).toBe("no-store");

      const nonOwnerRes = await workerFetch(
        new Request(`${ORIGIN}${route.path}`, {
          method: route.method,
          headers: {
            Origin: ORIGIN,
            Cookie: nonOwnerCookie,
            ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
        }),
      );
      expect(nonOwnerRes.status).toBe(403);
      expect(nonOwnerRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(nonOwnerRes.headers.get("Cache-Control")).toBe("no-store");
    }

    // 4. Register DCR client and trigger unauthenticated /api/auth/oauth2/authorize -> /sign-in?<signed-oauth-query>
    const dcrRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Passkey OAuth Resume Client",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(dcrRes.status).toBe(201);
    const clientId = readStr(toRecord(await dcrRes.json()), "client_id");

    const fetchSignedOAuthQuery = async (stateTag: string): Promise<string> => {
      const verifier = `pkce-verifier-${stateTag}-0123456789abcdefghijklmnopqrstuvwxyz`;
      const challenge = await sha256Base64Url(verifier);
      const authzUrl = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
      authzUrl.searchParams.set("response_type", "code");
      authzUrl.searchParams.set("client_id", clientId);
      authzUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
      authzUrl.searchParams.set("scope", "openid tasks:read");
      authzUrl.searchParams.set("code_challenge", challenge);
      authzUrl.searchParams.set("code_challenge_method", "S256");
      authzUrl.searchParams.set("state", stateTag);

      const authzRes = await workerFetch(new Request(authzUrl.toString(), { method: "GET" }));
      expect(authzRes.status).toBe(302);
      const loc = new URL(authzRes.headers.get("Location") ?? "", ORIGIN);
      expect(loc.pathname).toBe("/sign-in");
      expect(loc.searchParams.has("sig")).toBe(true);
      return loc.search.slice(1);
    };

    const emailOAuthQuery = await fetchSignedOAuthQuery("st-email-resume");

    // 4a. Tampered oauth_query MUST be rejected (400) on POST /api/auth/sign-in/email
    const tamperedEmailRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          email: OWNER_EMAIL,
          password: ownerPassword,
          oauth_query: `${emailOAuthQuery}&scope=tampered`,
        }),
      }),
    );
    expect(tamperedEmailRes.status).toBe(400);

    // 4b. Real signed oauth_query on POST /api/auth/sign-in/email resumes OAuth -> 200 { redirect: true, url: "/consent?..." }
    const emailResumeRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN },
        body: JSON.stringify({
          email: OWNER_EMAIL,
          password: ownerPassword,
          oauth_query: emailOAuthQuery,
        }),
      }),
    );
    expect(emailResumeRes.status).toBe(200);
    const emailResumeJson = toRecord(await emailResumeRes.json());
    expect(emailResumeJson["redirect"]).toBe(true);
    expect(readStr(emailResumeJson, "url")).toStartWith("/consent?");

    // 5. Seed real P-256 ECDSA WebAuthn passkeys for owner AND non-owner
    const ownerKey = await generateTestWebAuthnP256Key();
    const nonOwnerKey = await generateTestWebAuthnP256Key();
    const ownerCredId = "cred_owner_p256_1";
    const nonOwnerCredId = "cred_intruder_p256_1";

    await sqliteDb.orm.insert(schema.passkey).values([
      {
        id: "pk_owner_real_1",
        name: "Owner iPhone (Face ID)",
        publicKey: ownerKey.cosePublicKeyBase64,
        userId: ownerUserId,
        credentialID: ownerCredId,
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
        transports: "internal,hybrid",
        createdAt: new Date(nowMs),
      },
      {
        id: "pk_intruder_real_1",
        name: "Intruder Key",
        publicKey: nonOwnerKey.cosePublicKeyBase64,
        userId: nonOwnerUserId,
        credentialID: nonOwnerCredId,
        counter: 0,
        deviceType: "multiDevice",
        backedUp: true,
        transports: "internal",
        createdAt: new Date(nowMs),
      },
    ]);

    const requestAuthChallenge = async (): Promise<{
      readonly challenge: string;
      readonly challengeCookie: string;
    }> => {
      const res = await workerFetch(
        new Request(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
          headers: { Origin: ORIGIN },
        }),
      );
      expect(res.status).toBe(200);
      const body = toRecord(await res.json());
      const challenge = readStr(body, "challenge");
      const challengeCookie = extractCookieHeader(res);
      expect(challenge).not.toBe("");
      expect(challengeCookie).toContain("passkey");
      return { challenge, challengeCookie };
    };

    const passkeyOAuthQuery = await fetchSignedOAuthQuery("st-passkey-resume");

    // 5a. Tampered oauth_query MUST be rejected (400) on POST /api/auth/passkey/verify-authentication
    const tamperedChallenge = await requestAuthChallenge();
    const tamperedAssertion = await buildSignedWebAuthnAssertion({
      credentialId: ownerCredId,
      challenge: tamperedChallenge.challenge,
      origin: ORIGIN,
      rpId: "board.example.test",
      counter: 1,
      privateKey: ownerKey.privateKey,
    });
    const tamperedPasskeyRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: tamperedChallenge.challengeCookie,
        },
        body: JSON.stringify({
          response: tamperedAssertion,
          oauth_query: `${passkeyOAuthQuery}&scope=tampered`,
        }),
      }),
    );
    expect(tamperedPasskeyRes.status).toBe(400);

    // 5b. Valid owner WebAuthn P-256 assertion + real signed oauth_query -> 200 { redirect: true, url: "/consent?..." }, sets owner session cookie, increments counter 0 -> 1
    const ownerChallenge = await requestAuthChallenge();
    const ownerAssertion = await buildSignedWebAuthnAssertion({
      credentialId: ownerCredId,
      challenge: ownerChallenge.challenge,
      origin: ORIGIN,
      rpId: "board.example.test",
      counter: 1,
      privateKey: ownerKey.privateKey,
    });
    const ownerPasskeyRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerChallenge.challengeCookie,
        },
        body: JSON.stringify({
          response: ownerAssertion,
          oauth_query: passkeyOAuthQuery,
        }),
      }),
    );
    expect(ownerPasskeyRes.status).toBe(200);
    expect(ownerPasskeyRes.headers.get("Cache-Control")).toBe("no-store");
    expect(ownerPasskeyRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const ownerPasskeyJson = toRecord(await ownerPasskeyRes.json());
    expect(ownerPasskeyJson["redirect"]).toBe(true);
    expect(readStr(ownerPasskeyJson, "url")).toStartWith("/consent?");

    const passkeySessionCookie = extractCookieHeader(ownerPasskeyRes)
      .split("; ")
      .filter((pair) => pair.includes("session_token="))
      .join("; ");
    expect(passkeySessionCookie).toContain("session_token=");

    const wsWithPasskeySession = await workerFetch(
      new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: passkeySessionCookie },
      }),
    );
    expect(wsWithPasskeySession.status).toBe(200);

    const updatedOwnerPk = await sqliteDb.orm
      .select({ counter: schema.passkey.counter })
      .from(schema.passkey)
      .where(eq(schema.passkey.id, "pk_owner_real_1"))
      .get();
    expect(updatedOwnerPk?.counter).toBe(1);

    // 5c. Non-owner WebAuthn P-256 passkey MUST be rejected 403 NOT_AUTHORIZED via session.create.before with 0 new sessions
    const intruderSessionsBefore = await sqliteDb.orm
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, nonOwnerUserId))
      .all();
    const intruderChallenge = await requestAuthChallenge();
    const intruderAssertion = await buildSignedWebAuthnAssertion({
      credentialId: nonOwnerCredId,
      challenge: intruderChallenge.challenge,
      origin: ORIGIN,
      rpId: "board.example.test",
      counter: 1,
      privateKey: nonOwnerKey.privateKey,
    });
    const intruderPasskeyRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/verify-authentication`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: intruderChallenge.challengeCookie,
        },
        body: JSON.stringify({
          response: intruderAssertion,
        }),
      }),
    );
    expect(intruderPasskeyRes.status).toBe(403);
    expect(extractCookieHeader(intruderPasskeyRes)).not.toContain("session_token=");
    const intruderSessionsAfter = await sqliteDb.orm
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(eq(schema.session.userId, nonOwnerUserId))
      .all();
    expect(intruderSessionsAfter.length).toBe(intruderSessionsBefore.length);

    // 6. Owner deletes their registered passkey via POST /api/auth/passkey/delete-passkey -> list returns []
    const deleteRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/delete-passkey`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: passkeySessionCookie,
        },
        body: JSON.stringify({ id: "pk_owner_real_1" }),
      }),
    );
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(deleteRes.headers.get("Cache-Control")).toBe("no-store");

    const listAfterDeleteRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/passkey/list-user-passkeys`, {
        headers: { Cookie: passkeySessionCookie },
      }),
    );
    expect(listAfterDeleteRes.status).toBe(200);
    expect(await listAfterDeleteRes.json()).toEqual([]);
  });

  test("supports resource-less opaque OAuth 2.1 flow + full MCP 2025-06-18 stateless handshake (initialize, initialized 202, ping, tools/list annotations, GET/DELETE 405) + trailing slash /api/mcp/ (Sec-M1, Sec-M2, Sec-m1)", async () => {
    const { workerFetch, ownerCookie } = await setupEnv();

    // 1. Dynamic Client Registration (public PKCE client)
    const dcrRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude Custom Connector",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(dcrRes.status).toBe(201);
    expect(dcrRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const clientId = readStr(toRecord(await dcrRes.json()), "client_id");
    expect(clientId).not.toBe("");

    // 2. Authorize WITHOUT `resource` parameter (simulating clients that omit RFC 8707 resource -> opaque token)
    const verifier = "plugin-interop-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    const authorizeUrl = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
    authorizeUrl.searchParams.set("scope", "openid tasks:read decisions:read");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "st-opaque-1");

    const authzRes = await workerFetch(
      new Request(authorizeUrl.toString(), {
        method: "GET",
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(authzRes.status).toBe(302);
    const consentUrl = new URL(authzRes.headers.get("Location") ?? "", ORIGIN);
    expect(consentUrl.pathname).toBe("/consent");
    const oauthQuery = consentUrl.search.slice(1);

    // 3. Owner approves consent
    const consentRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid tasks:read decisions:read",
          oauth_query: oauthQuery,
        }),
      }),
    );
    expect(consentRes.status).toBe(200);
    const consentRedirect = new URL(readStr(toRecord(await consentRes.json()), "url"));
    const authCode = consentRedirect.searchParams.get("code") ?? "";
    expect(authCode).not.toBe("");

    // 4. Exchange code WITHOUT `resource` -> receives opaque access_token (non-JWT)
    const tokenRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authCode,
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          code_verifier: verifier,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(tokenRes.headers.get("Cache-Control")).toBe("no-store");
    const opaqueToken = readStr(toRecord(await tokenRes.json()), "access_token");
    expect(opaqueToken).not.toBe("");
    expect(opaqueToken.split(".").length).not.toBe(3); // Confirm opaque (not JWT)

    // 5. MCP 2025-06-18 stateless handshake on trailing-slash `/api/mcp/`
    const mcpHeaders = {
      Authorization: `Bearer ${opaqueToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    };

    // 5a. initialize -> 200 with server instructions & CORS
    const initRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp/`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "claude-test-client", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const initRpc = await parseJsonOrSseRpc(initRes);
    const initResult = toRecord(initRpc["result"]);
    expect(readStr(initResult, "instructions")).toContain("bot-board");
    expect(readStr(initResult, "instructions")).toContain("BOT-02");

    // 5b. notifications/initialized -> 202 Accepted + CORS
    const notifRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }),
    );
    expect(notifRes.status).toBe(202);
    expect(notifRes.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // 5c. ping -> 200 + CORS
    const pingRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "ping",
        }),
      }),
    );
    expect(pingRes.status).toBe(200);
    expect(pingRes.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // 5d. tools/list -> all 12 tools carry MCP ToolAnnotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
    const listRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp/`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
        }),
      }),
    );
    expect(listRes.status).toBe(200);
    const listRpc = await parseJsonOrSseRpc(listRes);
    const listResult = toRecord(listRpc["result"]);
    const rawTools = listResult["tools"];
    expect(Array.isArray(rawTools)).toBe(true);
    if (Array.isArray(rawTools)) {
      expect(rawTools.length).toBe(MCP_BOT_TOOL_NAMES.length);
      const readOnlyNames = new Set([
        "get_workspace_context",
        "list_tasks",
        "get_task",
        "get_artifact",
        "list_decision_results",
      ]);
      for (const toolEntry of rawTools) {
        const toolObj = toRecord(toolEntry);
        const toolName = readStr(toolObj, "name");
        const annotations = toRecord(toolObj["annotations"]);
        expect(annotations["readOnlyHint"]).toBe(readOnlyNames.has(toolName));
        expect(annotations["destructiveHint"]).toBe(false);
        expect(typeof annotations["idempotentHint"]).toBe("boolean");
        expect(annotations["openWorldHint"]).toBe(false);
      }
    }

    // 5e. GET /api/mcp & DELETE /api/mcp -> 405 Method Not Allowed + CORS (stateless Streamable HTTP)
    for (const method of ["GET", "DELETE"] as const) {
      const mRes = await workerFetch(
        new Request(`${ORIGIN}/api/mcp`, {
          method,
          headers: {
            Authorization: `Bearer ${opaqueToken}`,
            Accept: "text/event-stream",
          },
        }),
      );
      expect(mRes.status).toBe(405);
      expect(mRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  test("POST /api/auth/sign-out deletes owner session row from D1 and invalidates /api/human/workspace (Sec-M4)", async () => {
    const { sqliteDb, workerFetch, ownerSessionToken, ownerCookie } = await setupEnv();

    // Confirm authenticated before sign-out
    const beforeRes = await workerFetch(
      new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(beforeRes.status).toBe(200);

    // Execute POST /api/auth/sign-out
    const signOutRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(signOutRes.status).toBe(200);
    expect(signOutRes.headers.get("Cache-Control")).toBe("no-store");
    expect(signOutRes.headers.get("Access-Control-Allow-Origin")).toBeNull();

    // Session row must be deleted from D1
    const remaining = await sqliteDb.orm
      .select()
      .from(schema.session)
      .where(eq(schema.session.token, ownerSessionToken))
      .all();
    expect(remaining.length).toBe(0);

    // Reusing old cookie must return 401
    const afterRes = await workerFetch(
      new Request(`${ORIGIN}/api/human/workspace`, {
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(afterRes.status).toBe(401);
  });

  test("Meta Muse Custom Connector OAuth 2.1 interoperability: DCR (agent.meta.ai & muse.ai callbacks), PKCE S256, refresh_token rotation, /api/mcp tool call, and malformed JSON -32700 (Issue #33)", async () => {
    const { sqliteDb, workerFetch, ownerCookie } = await setupEnv();

    // 1. RFC 7591 DCR with Meta Muse official redirect URIs
    const metaRedirectUris = [
      "https://agent.meta.ai/api/hatch/oauth/callback",
      "https://muse.ai/api/hatch/oauth/callback",
    ];
    const dcrRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Meta Muse Custom Connector",
          redirect_uris: metaRedirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(dcrRes.status).toBe(201);
    expect(dcrRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const clientId = readStr(toRecord(await dcrRes.json()), "client_id");
    expect(clientId).not.toBe("");

    // 2. Authorize with offline_access + resource + PKCE S256 using agent.meta.ai callback
    const verifier = "meta-muse-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    const authorizeUrl = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", metaRedirectUris[0] ?? "");
    authorizeUrl.searchParams.set("scope", "openid offline_access tasks:read decisions:read");
    authorizeUrl.searchParams.set("resource", `${ORIGIN}/api/mcp`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "st-meta-muse-1");

    const authzRes = await workerFetch(
      new Request(authorizeUrl.toString(), {
        method: "GET",
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(authzRes.status).toBe(302);
    const consentUrl = new URL(authzRes.headers.get("Location") ?? "", ORIGIN);
    expect(consentUrl.pathname).toBe("/consent");

    // 3. Owner approves consent
    const consentRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid offline_access tasks:read decisions:read",
          oauth_query: consentUrl.search.slice(1),
        }),
      }),
    );
    expect(consentRes.status).toBe(200);
    const consentRedirect = new URL(readStr(toRecord(await consentRes.json()), "url"));
    expect(consentRedirect.origin).toBe("https://agent.meta.ai");
    expect(consentRedirect.pathname).toBe("/api/hatch/oauth/callback");
    const authCode = consentRedirect.searchParams.get("code") ?? "";
    expect(authCode).not.toBe("");

    // 4. Token exchange returns access_token + refresh_token
    const tokenRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authCode,
          redirect_uri: metaRedirectUris[0] ?? "",
          code_verifier: verifier,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const tokenJson = toRecord(await tokenRes.json());
    const initialAccessToken = readStr(tokenJson, "access_token");
    const initialRefreshToken = readStr(tokenJson, "refresh_token");
    expect(initialAccessToken).not.toBe("");
    expect(initialRefreshToken).not.toBe("");

    // 5. Refresh token rotation -> issues fresh access_token + distinct rotated refresh_token
    const refreshRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: initialRefreshToken,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const refreshJson = toRecord(await refreshRes.json());
    const rotatedAccessToken = readStr(refreshJson, "access_token");
    const rotatedRefreshToken = readStr(refreshJson, "refresh_token");
    expect(rotatedAccessToken).not.toBe("");
    expect(rotatedRefreshToken).not.toBe("");
    expect(rotatedRefreshToken).not.toBe(initialRefreshToken);

    // 5a. Within @better-auth/mcp's 30s reuse grace window, replaying initialRefreshToken returns the SAME rotated token (no extra mint)
    const graceReplayRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: initialRefreshToken,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect(graceReplayRes.status).toBe(200);
    expect(readStr(toRecord(await graceReplayRes.json()), "refresh_token")).toBe(
      rotatedRefreshToken,
    );

    // 5b. Once the 30s grace window expires, replaying initialRefreshToken MUST be rejected (RFC 9700 §4.14)
    const refreshRows = await sqliteDb.orm
      .select()
      .from(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.clientId, clientId))
      .all();
    const rotatedRow = refreshRows.find((r) => r.revoked !== null);
    expect(rotatedRow).toBeDefined();
    if (rotatedRow !== undefined) {
      await sqliteDb.orm
        .update(schema.oauthRefreshToken)
        .set({ rotationReplayExpiresAt: new Date(Date.now() - 5_000) })
        .where(eq(schema.oauthRefreshToken.id, rotatedRow.id));
    }

    const postWindowReplayRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: initialRefreshToken,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect([400, 401]).toContain(postWindowReplayRes.status);

    // 6. Authenticated /api/mcp tool call succeeds with rotated access token (JWT resource token)
    const toolRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rotatedAccessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "get_workspace_context", arguments: {} },
        }),
      }),
    );
    expect(toolRes.status).toBe(200);
    expect(toolRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const toolRpc = await parseJsonOrSseRpc(toolRes);
    const toolResult = toRecord(toolRpc["result"]);
    expect(toolResult["isError"]).not.toBe(true);

    // 7. Malformed JSON POST to /api/mcp returns structured JSON-RPC -32700 Parse error (never HTML 500) + CORS
    const malformedRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rotatedAccessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: "{not-valid-json",
      }),
    );
    expect(malformedRes.status).toBe(400);
    expect(malformedRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(malformedRes.headers.get("Content-Type") ?? "").toContain("application/json");
    const malformedRpc = toRecord(await malformedRes.json());
    const malformedErr = toRecord(malformedRpc["error"]);
    expect(malformedErr["code"]).toBe(-32700);
  });

  test("Google Gemini MCP interoperability: unauth HEAD /api/mcp 401 WWW-Authenticate + OPTIONS Allow-Methods HEAD + DCR (googleusercontent & vertexaisearch callbacks) + MCP handshake (Issue #34)", async () => {
    const { workerFetch, ownerCookie } = await setupEnv();

    // 1. OPTIONS /api/mcp advertises HEAD in Access-Control-Allow-Methods
    const optRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://gemini.google.com",
          "Access-Control-Request-Method": "HEAD",
        },
      }),
    );
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get("Access-Control-Allow-Methods") ?? "").toContain("HEAD");
    expect(optRes.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // 2. Unauthenticated HEAD /api/mcp & /api/mcp/ discovery probes -> 401 + WWW-Authenticate + CORS + empty body (RFC 9110 §9.3.2)
    for (const headPath of ["/api/mcp", "/api/mcp/"] as const) {
      const headRes = await workerFetch(
        new Request(`${ORIGIN}${headPath}`, {
          method: "HEAD",
        }),
      );
      expect(headRes.status).toBe(401);
      expect(await headRes.text()).toBe("");
      expect(headRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(headRes.headers.get("Access-Control-Expose-Headers") ?? "").toContain(
        "WWW-Authenticate",
      );
      const headWwwAuth = headRes.headers.get("WWW-Authenticate") ?? "";
      expect(headWwwAuth).toContain("Bearer");
      expect(headWwwAuth).toContain(
        `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
      );
      expect(headWwwAuth).toContain("scope=");
    }

    // 3. RFC 7591 DCR with Gemini Web relay & Gemini Enterprise redirect URIs
    const geminiRelayUri =
      "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-botboard-test";
    const geminiEnterpriseUri = "https://vertexaisearch.cloud.google.com/oauth-redirect";
    const dcrRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Google Gemini Custom App",
          redirect_uris: [geminiRelayUri, geminiEnterpriseUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(dcrRes.status).toBe(201);
    const clientId = readStr(toRecord(await dcrRes.json()), "client_id");
    expect(clientId).not.toBe("");

    // 4. Authorize via Gemini Web relay callback with PKCE S256
    const verifier = "google-gemini-pkce-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    const authorizeUrl = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", geminiRelayUri);
    authorizeUrl.searchParams.set("scope", "openid tasks:read decisions:read");
    authorizeUrl.searchParams.set("resource", `${ORIGIN}/api/mcp`);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", "st-gemini-1");

    const authzRes = await workerFetch(
      new Request(authorizeUrl.toString(), {
        method: "GET",
        headers: { Cookie: ownerCookie },
      }),
    );
    expect(authzRes.status).toBe(302);
    const consentUrl = new URL(authzRes.headers.get("Location") ?? "", ORIGIN);
    expect(consentUrl.pathname).toBe("/consent");

    // 5. Owner approves consent -> redirects cleanly to Gemini relay URL
    const consentRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          Cookie: ownerCookie,
        },
        body: JSON.stringify({
          accept: true,
          scope: "openid tasks:read decisions:read",
          oauth_query: consentUrl.search.slice(1),
        }),
      }),
    );
    expect(consentRes.status).toBe(200);
    const consentRedirect = new URL(readStr(toRecord(await consentRes.json()), "url"));
    expect(consentRedirect.origin).toBe("https://oauth-redirect.googleusercontent.com");
    const authCode = consentRedirect.searchParams.get("code") ?? "";
    expect(authCode).not.toBe("");

    // 6. Exchange code -> JWT access token & run authenticated /api/mcp initialize + authenticated HEAD 405
    const tokenRes = await workerFetch(
      new Request(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authCode,
          redirect_uri: geminiRelayUri,
          code_verifier: verifier,
          resource: `${ORIGIN}/api/mcp`,
        }).toString(),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const accessToken = readStr(toRecord(await tokenRes.json()), "access_token");
    expect(accessToken).not.toBe("");

    // Authenticated HEAD /api/mcp -> 405 Method Not Allowed + CORS + empty body
    const authHeadRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "HEAD",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }),
    );
    expect(authHeadRes.status).toBe(405);
    expect(await authHeadRes.text()).toBe("");
    expect(authHeadRes.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const initRes = await workerFetch(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "google-gemini-test-client", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const initRpc = await parseJsonOrSseRpc(initRes);
    const initResult = toRecord(initRpc["result"]);
    expect(readStr(initResult, "instructions")).toContain("bot-board");
  });
});
