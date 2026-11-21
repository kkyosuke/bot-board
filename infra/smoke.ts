import { z } from "zod";

export type SmokeFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface SmokeCheckOptions {
  readonly baseUrl: string;
  readonly botToken?: string;
  readonly fetchImpl?: SmokeFetchLike;
  readonly timeoutMs?: number;
}

export interface SmokeCheckItemResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmokeCheckReport {
  readonly ok: boolean;
  readonly baseUrl: string;
  readonly checks: readonly SmokeCheckItemResult[];
}

const healthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("bot-board"),
});

const protectedResourceSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
});

const authServerMetaSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
});

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).min(1),
});

function normalizeBaseUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Smoke check baseUrl must use http:// or https:// (received ${parsed.protocol})`,
    );
  }
  return parsed.origin;
}

async function runSingleCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<SmokeCheckItemResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: msg };
  }
}

export async function runLiveSmokeCheck(options: SmokeCheckOptions): Promise<SmokeCheckReport> {
  const origin = normalizeBaseUrl(options.baseUrl);
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const checks: SmokeCheckItemResult[] = [];

  // 1. Health endpoint + baseline security header
  checks.push(
    await runSingleCheck("GET /api/health", async () => {
      const res = await fetchFn(`${origin}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        throw new Error(`Expected 200, got ${res.status}`);
      }
      if (res.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff") {
        throw new Error("Missing X-Content-Type-Options: nosniff on /api/health");
      }
      const parsed = healthSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error("Invalid /api/health JSON payload");
      }
      return "200 ok + nosniff";
    }),
  );

  // 2. SPA Static Assets & client route fallbacks + security headers (Sec-Fetch-Mode: navigate triggers Cloudflare edge SPA routing)
  for (const spaPath of ["/", "/board", "/sign-in", "/consent"]) {
    checks.push(
      await runSingleCheck(`GET ${spaPath} (SPA)`, async () => {
        const res = await fetchFn(`${origin}${spaPath}`, {
          redirect: "manual",
          headers: {
            "Sec-Fetch-Mode": "navigate",
            Accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}`);
        }
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.toLowerCase().includes("text/html")) {
          throw new Error(`Expected text/html, got "${ct}"`);
        }
        if (res.headers.get("x-frame-options")?.toUpperCase() !== "DENY") {
          throw new Error("Missing X-Frame-Options: DENY on SPA route");
        }
        if (spaPath === "/sign-in" || spaPath === "/consent") {
          const cacheControl = res.headers.get("cache-control") ?? "";
          if (!cacheControl.toLowerCase().includes("no-store")) {
            throw new Error(`Missing Cache-Control: no-store on ${spaPath} ("${cacheControl}")`);
          }
          const refPolicy = res.headers.get("referrer-policy") ?? "";
          if (!refPolicy.toLowerCase().includes("no-referrer")) {
            throw new Error(`Missing Referrer-Policy: no-referrer on ${spaPath} ("${refPolicy}")`);
          }
          return "200 text/html + DENY + no-store + no-referrer";
        }
        return "200 text/html + X-Frame-Options: DENY";
      }),
    );
  }

  // 3. RFC 9728 OAuth Protected Resource Metadata (root + path-aware /api/mcp) + public CORS
  for (const prmPath of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
  ]) {
    checks.push(
      await runSingleCheck(`GET ${prmPath}`, async () => {
        const res = await fetchFn(`${origin}${prmPath}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}`);
        }
        if (res.headers.get("access-control-allow-origin") !== "*") {
          throw new Error(`Missing Access-Control-Allow-Origin: * on ${prmPath}`);
        }
        const parsed = protectedResourceSchema.safeParse(await res.json());
        if (!parsed.success) {
          throw new Error("Invalid RFC 9728 protected resource metadata");
        }
        return `200 resource=${parsed.data.resource}`;
      }),
    );
  }

  // 4. RFC 8414 / OIDC Authorization Server Metadata (including path-inserted /.well-known/openid-configuration/api/auth) + public CORS
  for (const asPath of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth",
    "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/api/auth",
    "/api/auth/.well-known/openid-configuration",
  ]) {
    checks.push(
      await runSingleCheck(`GET ${asPath}`, async () => {
        const res = await fetchFn(`${origin}${asPath}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}`);
        }
        if (res.headers.get("access-control-allow-origin") !== "*") {
          throw new Error(`Missing Access-Control-Allow-Origin: * on ${asPath}`);
        }
        const parsed = authServerMetaSchema.safeParse(await res.json());
        if (!parsed.success) {
          throw new Error("Invalid OAuth AS metadata");
        }
        return `200 issuer=${parsed.data.issuer}`;
      }),
    );
  }

  // 5. Better Auth JWKS (proves D1 jwks table migrated + Workers CPU limit handles Ed25519 keygen + public CORS)
  checks.push(
    await runSingleCheck("GET /api/auth/jwks", async () => {
      const res = await fetchFn(`${origin}/api/auth/jwks`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        throw new Error(`Expected 200, got ${res.status}`);
      }
      if (res.headers.get("access-control-allow-origin") !== "*") {
        throw new Error("Missing Access-Control-Allow-Origin: * on /api/auth/jwks");
      }
      const parsed = jwksSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error("JWKS payload missing non-empty keys array");
      }
      return `200 keys=${parsed.data.keys.length}`;
    }),
  );

  // 6a. MCP CORS preflight (OPTIONS /api/mcp -> 204, no Allow-Credentials)
  checks.push(
    await runSingleCheck("OPTIONS /api/mcp (CORS preflight)", async () => {
      const res = await fetchFn(`${origin}/api/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://chatgpt.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 204) {
        throw new Error(`Expected 204, got ${res.status}`);
      }
      if (res.headers.get("access-control-allow-origin") !== "*") {
        throw new Error("Missing Access-Control-Allow-Origin: * on OPTIONS /api/mcp");
      }
      if (res.headers.get("access-control-allow-credentials") !== null) {
        throw new Error("Unexpected Access-Control-Allow-Credentials on OPTIONS /api/mcp");
      }
      const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
      if (!allowMethods.includes("POST") || !allowMethods.includes("HEAD")) {
        throw new Error(`Access-Control-Allow-Methods missing POST or HEAD: "${allowMethods}"`);
      }
      const exposeHeaders = res.headers.get("access-control-expose-headers") ?? "";
      if (!exposeHeaders.includes("WWW-Authenticate")) {
        throw new Error(
          `Access-Control-Expose-Headers missing WWW-Authenticate: "${exposeHeaders}"`,
        );
      }
      return "204 CORS preflight ok";
    }),
  );

  // 6b. MCP 401 WWW-Authenticate discovery challenge (path-aware resource_metadata + scope + CORS)
  checks.push(
    await runSingleCheck("POST /api/mcp (unauth 401 WWW-Authenticate)", async () => {
      const res = await fetchFn(`${origin}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 401) {
        throw new Error(`Expected 401, got ${res.status}`);
      }
      if (res.headers.get("access-control-allow-origin") !== "*") {
        throw new Error("Missing Access-Control-Allow-Origin: * on 401 /api/mcp");
      }
      const exposeHeaders = res.headers.get("access-control-expose-headers") ?? "";
      if (!exposeHeaders.includes("WWW-Authenticate")) {
        throw new Error(
          `Access-Control-Expose-Headers missing WWW-Authenticate: "${exposeHeaders}"`,
        );
      }
      const wwwAuth = res.headers.get("www-authenticate") ?? "";
      if (
        !wwwAuth.includes("Bearer") ||
        !wwwAuth.includes(
          `resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
        ) ||
        !wwwAuth.includes("scope=")
      ) {
        throw new Error(`Unexpected WWW-Authenticate header: "${wwwAuth}"`);
      }
      return "401 Bearer path-aware resource_metadata + scope + CORS";
    }),
  );

  // 6c. MCP HEAD discovery probe (Google Gemini Custom App sends unauth HEAD /api/mcp -> 401 WWW-Authenticate + CORS)
  checks.push(
    await runSingleCheck("HEAD /api/mcp (unauth 401 WWW-Authenticate)", async () => {
      const res = await fetchFn(`${origin}/api/mcp`, {
        method: "HEAD",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 401) {
        throw new Error(`Expected 401, got ${res.status}`);
      }
      if (res.headers.get("access-control-allow-origin") !== "*") {
        throw new Error("Missing Access-Control-Allow-Origin: * on 401 HEAD /api/mcp");
      }
      const exposeHeaders = res.headers.get("access-control-expose-headers") ?? "";
      if (!exposeHeaders.includes("WWW-Authenticate")) {
        throw new Error(
          `Access-Control-Expose-Headers missing WWW-Authenticate on HEAD: "${exposeHeaders}"`,
        );
      }
      const wwwAuth = res.headers.get("www-authenticate") ?? "";
      if (
        !wwwAuth.includes("Bearer") ||
        !wwwAuth.includes(
          `resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`,
        ) ||
        !wwwAuth.includes("scope=")
      ) {
        throw new Error(`Unexpected WWW-Authenticate header on HEAD: "${wwwAuth}"`);
      }
      return "401 HEAD discovery probe ok";
    }),
  );

  // 7. Human API unauth guard + no-store + non-CORS boundary
  checks.push(
    await runSingleCheck("GET /api/human/workspace (unauth 401)", async () => {
      const res = await fetchFn(`${origin}/api/human/workspace`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 401) {
        throw new Error(`Expected 401, got ${res.status}`);
      }
      const cacheControl = res.headers.get("cache-control") ?? "";
      if (!cacheControl.toLowerCase().includes("no-store")) {
        throw new Error(
          `Missing Cache-Control: no-store on /api/human/workspace ("${cacheControl}")`,
        );
      }
      if (res.headers.get("access-control-allow-origin") !== null) {
        throw new Error(
          "Cookie-protected /api/human/workspace must not emit Access-Control-Allow-Origin",
        );
      }
      return "401 unauthorized + no-store + non-CORS";
    }),
  );

  // 7b. Owner bootstrap status endpoint (proves D1 user table migrated + no-store + non-CORS + zero PII)
  checks.push(
    await runSingleCheck("GET /api/auth/owner-status", async () => {
      const res = await fetchFn(`${origin}/api/auth/owner-status`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        throw new Error(`Expected 200, got ${res.status}`);
      }
      const cacheControl = res.headers.get("cache-control") ?? "";
      if (!cacheControl.toLowerCase().includes("no-store")) {
        throw new Error(
          `Missing Cache-Control: no-store on /api/auth/owner-status ("${cacheControl}")`,
        );
      }
      if (res.headers.get("access-control-allow-origin") !== null) {
        throw new Error("/api/auth/owner-status must not emit Access-Control-Allow-Origin");
      }
      const parsed = z
        .object({ initialized: z.boolean() })
        .strict()
        .safeParse(await res.json());
      if (!parsed.success) {
        throw new Error("Invalid /api/auth/owner-status payload (expected strict { initialized })");
      }
      return `200 initialized=${String(parsed.data.initialized)}`;
    }),
  );

  // 8. Optional authenticated MCP tool call when SMOKE_BOT_TOKEN is provided
  const trimmedBotToken = options.botToken?.trim() ?? "";
  if (trimmedBotToken !== "") {
    checks.push(
      await runSingleCheck("POST /api/mcp (authenticated tools/list)", async () => {
        const res = await fetchFn(`${origin}/api/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${trimmedBotToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200) {
          throw new Error(`Expected 200, got ${res.status}`);
        }
        return "200 authenticated tools/list";
      }),
    );
  }

  return {
    ok: checks.every((c) => c.ok),
    baseUrl: origin,
    checks,
  };
}

function readCliFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const baseUrl = readCliFlag(args, "--base-url") ?? process.env["SMOKE_BASE_URL"] ?? "";
  if (baseUrl.trim() === "") {
    process.stderr.write("Usage: bun run smoke -- --base-url https://<your-bot-board-domain>\n");
    process.exit(1);
  }
  const botToken = process.env["SMOKE_BOT_TOKEN"];
  const report = await runLiveSmokeCheck({
    baseUrl,
    ...(botToken !== undefined && botToken.trim() !== "" ? { botToken } : {}),
  });

  for (const item of report.checks) {
    const icon = item.ok ? "✓" : "✗";
    process.stdout.write(`${icon} ${item.name}: ${item.detail}\n`);
  }

  if (!report.ok) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await runCli();
}
