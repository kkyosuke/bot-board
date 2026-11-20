import { type Context, type Hono } from "hono";

import {
  OwnerAuthenticationError,
  type OwnerContext,
  type OwnerSessionInput,
  verifyOwnerSessionContext,
} from "@/auth/owner";
import { DomainError } from "@/domain";
import { assertTrustedCsrfOrigin, normalizeTrustedOriginSet } from "@/server/csrf";
import {
  enforceRateLimit,
  extractTrustedClientIp,
  type RequestRateLimiter,
} from "@/server/rate-limit";
import { assertOwnerWorkspaceAccess, type HumanServicePort } from "@/services/human";
import {
  createWorkerBotInputSchema,
  decideHumanCardInputSchema,
  deferHumanCardInputSchema,
  listHumanCardsQuerySchema,
  listHumanHistoryQuerySchema,
  oauthConsentContextQuerySchema,
  retryHumanTaskInputSchema,
  undoHumanCardInputSchema,
  updateHumanBotInputSchema,
  updateHumanWorkspaceInputSchema,
} from "@/services/human/schemas";

export function authorizeHumanRoute(session: OwnerSessionInput, workspaceId: string): OwnerContext {
  const ctx = verifyOwnerSessionContext(session);
  assertOwnerWorkspaceAccess(ctx, workspaceId);
  return ctx;
}

export interface MountHumanRoutesOptions {
  readonly port: HumanServicePort;
  readonly authenticateOwner: (request: Request) => Promise<OwnerContext>;
  readonly trustedOrigins: readonly string[];
  readonly rateLimiter?: RequestRateLimiter;
}

async function readJsonBody(ctx: Context): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    throw new DomainError("VALIDATION_ERROR", "Request body must be valid JSON.", false);
  }
}

function parseStrictLimitParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "limit query parameter must be a positive integer.",
      false,
    );
  }
  return Number(trimmed);
}

export function mountHumanRoutes(app: Hono, options: MountHumanRoutesOptions): void {
  const trustedOriginSet = normalizeTrustedOriginSet(options.trustedOrigins);

  async function requireOwner(
    ctx: Context,
    isMutation: boolean,
  ): Promise<{ readonly owner: OwnerContext } | { readonly earlyResponse: Response }> {
    const ip = extractTrustedClientIp(ctx.req.raw);
    await enforceRateLimit(options.rateLimiter, `human:ip:${ip}`);

    let owner: OwnerContext;
    try {
      owner = await options.authenticateOwner(ctx.req.raw);
    } catch (error) {
      if (error instanceof OwnerAuthenticationError) {
        return {
          earlyResponse: ctx.json(
            {
              code: error.code,
              message: error.message,
              retryable: false,
            },
            error.status,
          ),
        };
      }
      throw error;
    }

    if (isMutation) {
      assertTrustedCsrfOrigin(ctx.req.raw, trustedOriginSet);
    }

    await enforceRateLimit(options.rateLimiter, `human:owner:${owner.userId}`);

    return { owner };
  }

  // 1. GET /api/human/cards
  app.get("/api/human/cards", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const statusParam = ctx.req.query("status");
    const parsedQuery = listHumanCardsQuerySchema.parse(
      statusParam !== undefined ? { status: statusParam } : {},
    );
    const result = await options.port.listCards(authResult.owner, parsedQuery);
    return ctx.json(result, 200);
  });

  // 2. GET /api/human/cards/:id
  app.get("/api/human/cards/:id", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const cardId = ctx.req.param("id");
    const result = await options.port.getCardDetail(authResult.owner, cardId);
    return ctx.json(result, 200);
  });

  // 3. POST /api/human/cards/:id/decide
  app.post("/api/human/cards/:id/decide", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const cardId = ctx.req.param("id");
    const body = decideHumanCardInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.decideCard(authResult.owner, cardId, body);
    return ctx.json(result, 200);
  });

  // 4. POST /api/human/cards/:id/undo
  app.post("/api/human/cards/:id/undo", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const cardId = ctx.req.param("id");
    const body = undoHumanCardInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.undoCard(authResult.owner, cardId, body);
    return ctx.json(result, 200);
  });

  // 5. POST /api/human/cards/:id/defer
  app.post("/api/human/cards/:id/defer", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const cardId = ctx.req.param("id");
    const body = deferHumanCardInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.deferCard(authResult.owner, cardId, body);
    return ctx.json(result, 200);
  });

  // 6. GET /api/human/board (read-only Kanban + per-Bot status; zero edit/move endpoints per UX-01)
  app.get("/api/human/board", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const result = await options.port.getBoard(authResult.owner);
    return ctx.json(result, 200);
  });

  // 7. POST /api/human/tasks/:id/retry
  app.post("/api/human/tasks/:id/retry", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const taskId = ctx.req.param("id");
    const body = retryHumanTaskInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.retryTask(authResult.owner, taskId, body);
    return ctx.json(result, 200);
  });

  // 8. GET /api/human/history
  app.get("/api/human/history", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const filterParam = ctx.req.query("filter");
    const cursorParam = ctx.req.query("cursor");
    const limitParam = parseStrictLimitParam(ctx.req.query("limit"));
    const parsedQuery = listHumanHistoryQuerySchema.parse({
      ...(filterParam !== undefined ? { filter: filterParam } : {}),
      ...(cursorParam !== undefined ? { cursor: cursorParam } : {}),
      ...(limitParam !== undefined ? { limit: limitParam } : {}),
    });
    const result = await options.port.listHistory(authResult.owner, parsedQuery);
    return ctx.json(result, 200);
  });

  // 9. GET /api/human/workspace
  app.get("/api/human/workspace", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const result = await options.port.getWorkspace(authResult.owner);
    return ctx.json(result, 200);
  });

  // 10. PATCH /api/human/workspace
  app.patch("/api/human/workspace", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const body = updateHumanWorkspaceInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.updateWorkspace(authResult.owner, body);
    return ctx.json(result, 200);
  });

  // 11. GET /api/human/bots
  app.get("/api/human/bots", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const bots = await options.port.listBots(authResult.owner);
    return ctx.json({ items: bots }, 200);
  });

  // 12. POST /api/human/bots
  app.post("/api/human/bots", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const body = createWorkerBotInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.createWorkerBot(authResult.owner, body);
    return ctx.json(result, result.bearer_token !== null ? 201 : 200);
  });

  // 13. PATCH /api/human/bots/:id
  app.patch("/api/human/bots/:id", async (ctx) => {
    const authResult = await requireOwner(ctx, true);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const botId = ctx.req.param("id");
    const body = updateHumanBotInputSchema.parse(await readJsonBody(ctx));
    const result = await options.port.updateBot(authResult.owner, botId, body);
    return ctx.json(result, 200);
  });

  // 14. GET /api/human/oauth/consent-context
  app.get("/api/human/oauth/consent-context", async (ctx) => {
    const authResult = await requireOwner(ctx, false);
    if ("earlyResponse" in authResult) {
      return authResult.earlyResponse;
    }
    const clientIdParam = ctx.req.query("client_id") ?? "";
    const scopeParam = ctx.req.query("scope");
    const parsedQuery = oauthConsentContextQuerySchema.parse({
      client_id: clientIdParam,
      ...(scopeParam !== undefined ? { scope: scopeParam } : {}),
    });
    const result = await options.port.getOAuthConsentContext(authResult.owner, parsedQuery);
    return ctx.json(result, 200);
  });
}
