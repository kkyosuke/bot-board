import { type Hono } from "hono";

import { type BetterAuthRuntime } from "@/auth/better-auth";
import {
  enforceRateLimit,
  extractTrustedClientIp,
  type RequestRateLimiter,
} from "@/server/rate-limit";

export interface MountAuthRoutesOptions {
  readonly auth: BetterAuthRuntime;
  readonly rateLimiter?: RequestRateLimiter;
}

export function mountAuthRoutes(app: Hono, options: MountAuthRoutesOptions): void {
  app.all("/api/auth/*", async (ctx) => {
    const ip = extractTrustedClientIp(ctx.req.raw);
    await enforceRateLimit(options.rateLimiter, `auth:ip:${ip}`);
    return await options.auth.handler(ctx.req.raw);
  });

  app.all("/.well-known/*", async (ctx) => {
    const ip = extractTrustedClientIp(ctx.req.raw);
    await enforceRateLimit(options.rateLimiter, `auth:ip:${ip}`);
    return await options.auth.handler(ctx.req.raw);
  });
}
