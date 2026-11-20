import { Hono } from "hono";

import { DomainError } from "@/domain";
import { mapErrorToHttpResponse } from "@/server/http-error";

export interface AppRouteHooks {
  readonly mountAuthRoutes?: (app: Hono) => void;
  readonly mountHumanRoutes?: (app: Hono) => void;
  readonly mountMcpRoutes?: (app: Hono) => void;
}

export function createApp(hooks: AppRouteHooks = {}): Hono {
  const app = new Hono();

  app.onError((error, ctx) => {
    const mapped = mapErrorToHttpResponse(error);
    if (mapped.body.details?.retryAfterSeconds !== undefined) {
      ctx.header("Retry-After", String(mapped.body.details.retryAfterSeconds));
    }
    return ctx.json(mapped.body, mapped.status);
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
