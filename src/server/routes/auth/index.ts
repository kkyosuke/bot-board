import { type Hono } from "hono";

import { type BetterAuthRuntime } from "@/auth/better-auth";
import { mapErrorToHttpResponse } from "@/server/http-error";
import {
  enforceRateLimit,
  extractTrustedClientIp,
  type RequestRateLimiter,
} from "@/server/rate-limit";

export interface MountAuthRoutesOptions {
  readonly auth: BetterAuthRuntime;
  readonly rateLimiter?: RequestRateLimiter;
}

const PUBLIC_OAUTH_CORS_ALLOW_HEADERS = "Authorization, Content-Type, Accept, DPoP";
const PUBLIC_OAUTH_CORS_MAX_AGE = "86400";

function getPublicNonCookieOAuthCorsMethods(pathname: string): string | null {
  if (
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/api/auth/.well-known/") ||
    pathname === "/api/auth/jwks"
  ) {
    return "GET, HEAD, OPTIONS";
  }
  if (
    pathname === "/api/auth/oauth2/register" ||
    pathname === "/api/auth/oauth2/token" ||
    pathname === "/api/auth/oauth2/revoke"
  ) {
    return "POST, OPTIONS";
  }
  return null;
}

function buildPublicOAuthPreflightResponse(allowMethods: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": allowMethods,
      "Access-Control-Allow-Headers": PUBLIC_OAUTH_CORS_ALLOW_HEADERS,
      "Access-Control-Max-Age": PUBLIC_OAUTH_CORS_MAX_AGE,
    },
  });
}

function attachPublicOAuthCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.delete("Access-Control-Allow-Credentials");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function mountAuthRoutes(app: Hono, options: MountAuthRoutesOptions): void {
  const handleAuthRequest = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const corsMethods = getPublicNonCookieOAuthCorsMethods(pathname);

    if (request.method === "OPTIONS" && corsMethods !== null) {
      return buildPublicOAuthPreflightResponse(corsMethods);
    }

    const ip = extractTrustedClientIp(request);
    try {
      await enforceRateLimit(options.rateLimiter, `auth:ip:${ip}`);
    } catch (error) {
      if (corsMethods === null) {
        throw error;
      }
      const mapped = mapErrorToHttpResponse(error);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (mapped.body.details?.retryAfterSeconds !== undefined) {
        headers.set("Retry-After", String(mapped.body.details.retryAfterSeconds));
      }
      return attachPublicOAuthCorsHeaders(
        new Response(JSON.stringify(mapped.body), {
          status: mapped.status,
          headers,
        }),
      );
    }

    const response = await options.auth.handler(request);
    if (corsMethods !== null) {
      return attachPublicOAuthCorsHeaders(response);
    }
    return response;
  };

  app.all("/api/auth/*", async (ctx) => await handleAuthRequest(ctx.req.raw));
  app.all("/.well-known/*", async (ctx) => await handleAuthRequest(ctx.req.raw));
}
