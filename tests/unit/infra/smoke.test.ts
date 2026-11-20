import { describe, expect, test } from "bun:test";

import { type D1LikeDatabase } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import workerHandler, { type WorkerRuntimeEnv } from "@/worker";

import { runLiveSmokeCheck, type SmokeFetchLike } from "../../../infra/smoke";

type NormalizedParam = string | number | null | Uint8Array;

function normalizeParam(v: unknown): NormalizedParam {
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

function createSqliteD1(db: SqliteAppDatabase): D1LikeDatabase {
  const buildStmt = (sqlText: string, params: readonly NormalizedParam[] = []) => ({
    __sql: sqlText,
    __params: params,
    bind(...values: unknown[]) {
      return buildStmt(sqlText, values.map(normalizeParam));
    },
    async run() {
      const res = await db.executor.query(sqlText, params, "run");
      return { meta: { changes: res.changes } };
    },
    async raw(): Promise<unknown[][]> {
      const res = await db.executor.query(sqlText, params, "all");
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
    prepare(sqlText: string) {
      return buildStmt(sqlText);
    },
    async batch(statements) {
      const rawStmts: { readonly sql: string; readonly params: readonly NormalizedParam[] }[] = [];
      for (const s of statements) {
        const sqlVal: unknown = Reflect.get(s, "__sql");
        const paramsVal: unknown = Reflect.get(s, "__params");
        if (typeof sqlVal === "string" && Array.isArray(paramsVal)) {
          const typedParams: readonly unknown[] = paramsVal;
          rawStmts.push({ sql: sqlVal, params: typedParams.map(normalizeParam) });
        }
      }
      const results = await db.executor.batch(rawStmts);
      return results.map((r) => ({ meta: { changes: r.changes } }));
    },
    async exec(sqlText: string) {
      await db.executor.exec(sqlText);
      return { count: 1, duration: 0 };
    },
  };
}

function buildMockLiveFetch(options: { readonly failJwks?: boolean } = {}): SmokeFetchLike {
  return (input, init) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.pathname === "/api/health") {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, service: "bot-board" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (["/", "/board", "/sign-in", "/consent"].includes(url.pathname)) {
      return Promise.resolve(
        new Response("<!doctype html><html></html>", {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Frame-Options": "DENY",
          },
        }),
      );
    }

    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/api/mcp"
    ) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            resource: `${url.origin}/api/mcp`,
            authorization_servers: [`${url.origin}/api/auth`],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/api/auth" ||
      url.pathname === "/.well-known/openid-configuration" ||
      url.pathname === "/api/auth/.well-known/openid-configuration"
    ) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            issuer: `${url.origin}/api/auth`,
            authorization_endpoint: `${url.origin}/api/auth/oauth2/authorize`,
            token_endpoint: `${url.origin}/api/auth/oauth2/token`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (url.pathname === "/api/auth/jwks") {
      if (options.failJwks) {
        return Promise.resolve(new Response("Error 1102", { status: 503 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid: "k1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (url.pathname === "/api/mcp" && method === "POST") {
      const headers = new Headers(init?.headers);
      if (headers.get("Authorization") === "Bearer bbw_valid") {
        return Promise.resolve(
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ code: "NOT_AUTHORIZED" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          },
        }),
      );
    }

    if (url.pathname === "/api/human/workspace") {
      return Promise.resolve(
        new Response(JSON.stringify({ code: "NOT_AUTHORIZED" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

describe("Post-deploy live smoke check (infra/smoke.ts, M3, R2-B1)", () => {
  test("passes 100% against the REAL workerHandler.fetch() with migrated SQLite D1 (R2-B1 mechanical parity ratchet)", async () => {
    const sqliteDb = createSqliteDatabase(":memory:");
    await sqliteDb.applyMigrations();
    try {
      const origin = "https://staging.bot-board.example.com";
      const env: WorkerRuntimeEnv = {
        DB: createSqliteD1(sqliteDb),
        DECISION_FINALIZE_QUEUE: {
          send: () => Promise.resolve(),
        },
        BOT_WORK_QUEUE: {
          send: () => Promise.resolve(),
        },
        BOT_WORK_DLQ: {
          send: () => Promise.resolve(),
        },
        ASSETS: {
          fetch: () =>
            Promise.resolve(
              new Response("<!doctype html><html><body>bot-board</body></html>", {
                status: 200,
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "X-Frame-Options": "DENY",
                  "X-Content-Type-Options": "nosniff",
                },
              }),
            ),
        },
        BETTER_AUTH_SECRET: "smoke-test-better-auth-secret-0123456789",
        BETTER_AUTH_URL: origin,
        TRUSTED_ORIGINS: origin,
        OWNER_GITHUB_ID: "gh-owner-smoke",
        APP_ENV: "staging",
      };

      const realWorkerFetch: SmokeFetchLike = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        const pending: Promise<unknown>[] = [];
        const res = await workerHandler.fetch(req, env, {
          waitUntil(p) {
            pending.push(p);
          },
        });
        if (pending.length > 0) {
          await Promise.allSettled(pending);
        }
        return res;
      };

      const report = await runLiveSmokeCheck({
        baseUrl: origin,
        fetchImpl: realWorkerFetch,
      });

      const failed = report.checks.filter((c) => !c.ok);
      expect(failed).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.checks.length).toBe(14);
    } finally {
      sqliteDb.close();
    }
  });

  test("passes optional authenticated MCP check and detects HTTP 503 on JWKS", async () => {
    const okReport = await runLiveSmokeCheck({
      baseUrl: "https://staging.bot-board.example.com",
      botToken: "bbw_valid",
      fetchImpl: buildMockLiveFetch(),
    });
    expect(okReport.ok).toBe(true);
    expect(okReport.checks.length).toBe(15);

    const failReport = await runLiveSmokeCheck({
      baseUrl: "https://staging.bot-board.example.com",
      fetchImpl: buildMockLiveFetch({ failJwks: true }),
    });
    expect(failReport.ok).toBe(false);
    const jwksCheck = failReport.checks.find((c) => c.name === "GET /api/auth/jwks");
    expect(jwksCheck?.ok).toBe(false);
    expect(jwksCheck?.detail).toContain("503");
  });
});
