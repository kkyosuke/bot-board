import { eq } from "drizzle-orm";

import {
  type BetterAuthConfig,
  type BetterAuthRuntime,
  createBetterAuth,
  isValidOwnerEmail,
  normalizeOwnerEmail,
} from "@/auth/better-auth";
import { type OwnerContext } from "@/auth/context";
import { mintOwnerContext, type OwnerSessionInput } from "@/auth/internal/mint-context";
import { type AppDatabase, createD1Database, type D1LikeDatabase, schema } from "@/db";

export type { OwnerContext, OwnerSessionInput };

export class OwnerAuthenticationError extends Error {
  public readonly status: 401 | 403;
  public readonly code = "NOT_AUTHORIZED" as const;

  public constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "OwnerAuthenticationError";
    this.status = status;
  }
}

export function verifyOwnerSessionContext(session: OwnerSessionInput): OwnerContext {
  return mintOwnerContext(session);
}

export interface AuthenticateOwnerRequestParams {
  readonly db: AppDatabase;
  readonly auth: BetterAuthRuntime;
  readonly request: Request;
  readonly ownerEmail?: string;
}

export async function authenticateOwnerRequest(
  params: AuthenticateOwnerRequestParams,
): Promise<OwnerContext> {
  const sessionResult = await params.auth.getSession(params.request.headers).catch(() => {
    throw new OwnerAuthenticationError(401, "Owner session verification failed.");
  });

  if (sessionResult === null) {
    throw new OwnerAuthenticationError(401, "Owner authentication required.");
  }

  const expectedOwnerEmail = normalizeOwnerEmail(params.ownerEmail);
  if (!isValidOwnerEmail(expectedOwnerEmail)) {
    throw new OwnerAuthenticationError(403, "Workspace owner email is not configured.");
  }

  const ownerUser = await params.db.orm
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, sessionResult.user.id))
    .get();

  if (
    ownerUser === undefined ||
    normalizeOwnerEmail(ownerUser.email) !== expectedOwnerEmail ||
    normalizeOwnerEmail(sessionResult.user.email) !== expectedOwnerEmail
  ) {
    throw new OwnerAuthenticationError(
      403,
      "Authenticated account does not match the configured workspace owner.",
    );
  }

  const workspace = await params.db.orm
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ownerUserId, sessionResult.user.id))
    .get();

  if (workspace === undefined) {
    throw new OwnerAuthenticationError(403, "Owner workspace is not initialized.");
  }

  return mintOwnerContext({
    userId: sessionResult.user.id,
    workspaceId: workspace.id,
    sessionId: sessionResult.session.id,
  });
}

export interface LazyRequestAuthAndOwner {
  readonly auth: BetterAuthRuntime;
  readonly authenticateOwner: (request: Request) => Promise<OwnerContext>;
}

/**
 * Request-scoped lazy factory (M4): creates at most one AppDatabase + one BetterAuthRuntime
 * inside a single request closure when /api/auth/*, /.well-known/*, or /api/human/* is hit,
 * avoiding eager betterAuth() instantiation on /api/health or /api/mcp requests.
 */
export function createLazyAuthAndOwnerFromD1(
  d1: D1LikeDatabase,
  config: BetterAuthConfig,
): LazyRequestAuthAndOwner {
  let cachedDb: AppDatabase | null = null;
  let cachedAuth: BetterAuthRuntime | null = null;

  const ensureInitialized = (): {
    readonly db: AppDatabase;
    readonly auth: BetterAuthRuntime;
  } => {
    if (cachedDb === null) {
      cachedDb = createD1Database(d1);
    }
    if (cachedAuth === null) {
      cachedAuth = createBetterAuth(cachedDb, config);
    }
    return { db: cachedDb, auth: cachedAuth };
  };

  return {
    auth: {
      handler(request) {
        return ensureInitialized().auth.handler(request);
      },
      getSession(headers) {
        return ensureInitialized().auth.getSession(headers);
      },
    },
    authenticateOwner(request) {
      const { db, auth } = ensureInitialized();
      return authenticateOwnerRequest({
        db,
        auth,
        request,
        ...(config.ownerEmail !== undefined ? { ownerEmail: config.ownerEmail } : {}),
      });
    },
  };
}

export function createOwnerAuthenticatorFromD1(
  d1: D1LikeDatabase,
  config: BetterAuthConfig,
): (request: Request) => Promise<OwnerContext> {
  return createLazyAuthAndOwnerFromD1(d1, config).authenticateOwner;
}
