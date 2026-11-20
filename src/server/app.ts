import { Hono } from "hono";

import { DomainError } from "@/domain";
import { mapErrorToHttpResponse } from "@/server/http-error";
import { applyApiSecurityHeaders } from "@/server/security-headers";

export interface AppRouteHooks {
  readonly mountAuthRoutes?: (app: Hono) => void;
  readonly mountHumanRoutes?: (app: Hono) => void;
  readonly mountMcpRoutes?: (app: Hono) => void;
}

export function createApp(hooks: AppRouteHooks = {}): Hono {
  const app = new Hono();

  app.use("*", async (ctx, next) => {
    await next();
    ctx.res = applyApiSecurityHeaders(ctx.req.raw, ctx.res);
  });

  app.onError((error, ctx) => {
    const mapped = mapErrorToHttpResponse(error);
    if (mapped.body.details?.retryAfterSeconds !== undefined) {
      ctx.header("Retry-After", String(mapped.body.details.retryAfterSeconds));
    }
    const res = ctx.json(mapped.body, mapped.status);
    return applyApiSecurityHeaders(ctx.req.raw, res);
  });

  app.notFound((ctx) => {
    const mapped = mapErrorToHttpResponse(
      new DomainError("NOT_FOUND", `Route not found: ${ctx.req.method} ${ctx.req.path}`, false),
    );
    return ctx.json(mapped.body, mapped.status);
  });

  app.get("/api/health", (ctx) => {
    return ctx.json({
      ok: true,
      service: "bot-board",
    });
  });

  if (hooks.mountAuthRoutes !== undefined) {
    hooks.mountAuthRoutes(app);
  }
  if (hooks.mountHumanRoutes !== undefined) {
    hooks.mountHumanRoutes(app);
  }
  if (hooks.mountMcpRoutes !== undefined) {
    hooks.mountMcpRoutes(app);
  }

  return app;
}
