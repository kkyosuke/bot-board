import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";

import { type AppDatabase, createD1Database, type D1LikeDatabase, schema } from "@/db";
import { BOT_SCOPES, DEFAULT_BUDGET_LIMIT, DomainError, serializeBudgetLimit } from "@/domain";

export interface BetterAuthConfig {
  readonly baseUrl: string;
  readonly secret: string;
  readonly trustedOrigins?: readonly string[] | string;
  readonly githubClientId?: string;
  readonly githubClientSecret?: string;
  readonly ownerGithubId?: string;
  readonly enableMcpOAuth?: boolean;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly now?: () => number;
}

export interface BetterAuthSessionLookupResult {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
  readonly session: {
    readonly id: string;
    readonly userId: string;
    readonly expiresAt: Date;
  };
}

export interface BetterAuthRuntime {
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (headers: Headers) => Promise<BetterAuthSessionLookupResult | null>;
}

function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function parseTrustedOrigins(
  baseUrl: string,
  configured?: readonly string[] | string,
): readonly string[] {
  const origins = new Set<string>();
  const baseOrigin = normalizeOrigin(baseUrl);
  if (baseOrigin !== null) {
    origins.add(baseOrigin);
  }

  const rawList: readonly string[] =
    typeof configured === "string"
      ? configured.split(",")
      : configured !== undefined
        ? configured
        : [];

  for (const entry of rawList) {
    const normalized = normalizeOrigin(entry);
    if (normalized !== null) {
      origins.add(normalized);
    }
  }

  return Array.from(origins);
}

function generateWorkspaceId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ws_${hex}`;
}

export async function ensureOwnerWorkspace(
  db: AppDatabase,
  ownerUserId: string,
  nowMs = Date.now(),
): Promise<string> {
  if (ownerUserId.trim() === "") {
    throw new DomainError("NOT_AUTHORIZED", "Invalid owner user ID.", false);
  }

  const existing = await db.orm
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ownerUserId, ownerUserId))
    .get();
  if (existing !== undefined) {
    return existing.id;
  }

  const workspaceId = generateWorkspaceId();
  await db.executor.batch([
    {
      sql: "INSERT OR IGNORE INTO workspaces (id, owner_user_id, goal, allowed_scope, budget_limit, is_paused, version, created_at, updated_at) VALUES (?, ?, '', '', ?, 0, 1, ?, ?)",
      params: [workspaceId, ownerUserId, serializeBudgetLimit(DEFAULT_BUDGET_LIMIT), nowMs, nowMs],
    },
  ]);

  const confirmed = await db.orm
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ownerUserId, ownerUserId))
    .get();
  if (confirmed !== undefined) {
    return confirmed.id;
  }

  throw new DomainError("NOT_AUTHORIZED", "Failed to initialize owner workspace.", false);
}

export function assertAllowedOwnerGithubProfile(params: {
  readonly configuredOwnerGithubId?: string | undefined;
  readonly githubAccountId: string;
}): void {
  const allowed = params.configuredOwnerGithubId?.trim() ?? "";
  if (allowed === "") {
    throw new APIError("FORBIDDEN", {
      message: "NOT_AUTHORIZED: OWNER_GITHUB_ID is not configured.",
    });
  }
  if (params.githubAccountId.trim() !== allowed) {
    throw new APIError("FORBIDDEN", {
      message: "NOT_AUTHORIZED: Only the configured single owner GitHub account is allowed.",
    });
  }
}

export function createBetterAuth(db: AppDatabase, config: BetterAuthConfig) {
  const baseOrigin = normalizeOrigin(config.baseUrl);
  if (baseOrigin === null) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "BETTER_AUTH_URL must be a valid HTTP(S) URL.",
      false,
    );
  }
  if (config.secret.trim().length < 16) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "BETTER_AUTH_SECRET must be configured with at least 16 characters.",
      false,
    );
  }

  const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const trustedOrigins = [...parseTrustedOrigins(normalizedBaseUrl, config.trustedOrigins)];
  const nowFn = config.now ?? (() => Date.now());
  const configuredOwnerGithubId = config.ownerGithubId?.trim() ?? "";

  const githubEnabled =
    config.githubClientId !== undefined &&
    config.githubClientId.trim() !== "" &&
    config.githubClientSecret !== undefined &&
    config.githubClientSecret.trim() !== "";

  const plugins =
    config.enableMcpOAuth === false
      ? [jwt()]
      : [
          jwt(),
          mcp({
            loginPage: "/sign-in",
            consentPage: "/consent",
            resource: `${baseOrigin}/api/mcp`,
            allowDynamicClientRegistration: true,
            scopes: ["openid", "profile", "email", "offline_access", ...BOT_SCOPES],
          }),
        ];

  const auth = betterAuth({
    baseURL: normalizedBaseUrl,
    secret: config.secret,
    trustedOrigins,
    ...(config.waitUntil !== undefined
      ? {
          advanced: {
            backgroundTasks: {
              handler: config.waitUntil,
            },
          },
        }
      : {}),
    database: drizzleAdapter(db.orm, {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    emailAndPassword: {
      enabled: false,
    },
    ...(githubEnabled
      ? {
          socialProviders: {
            github: {
              clientId: config.githubClientId ?? "",
              clientSecret: config.githubClientSecret ?? "",
              mapProfileToUser(profile) {
                assertAllowedOwnerGithubProfile({
                  configuredOwnerGithubId,
                  githubAccountId: String(profile.id),
                });
                return {
                  name: profile.name || profile.login,
                  email: profile.email,
                  image: profile.avatar_url,
                };
              },
            },
          },
        }
      : {}),
    databaseHooks: {
      user: {
        create: {
          async before(newUser) {
            if (configuredOwnerGithubId === "") {
              throw new APIError("FORBIDDEN", {
                message: "NOT_AUTHORIZED: OWNER_GITHUB_ID must be configured before signup.",
              });
            }
            const existingUser = await db.orm
              .select({ id: schema.user.id })
              .from(schema.user)
              .limit(1)
              .get();
            if (existingUser !== undefined) {
              throw new APIError("FORBIDDEN", {
                message: "NOT_AUTHORIZED: Single-owner workspace forbids additional signups.",
              });
            }
            return { data: newUser };
          },
          async after(createdUser) {
            await ensureOwnerWorkspace(db, createdUser.id, nowFn());
          },
        },
      },
      account: {
        create: {
          before(newAccount) {
            if (newAccount.providerId !== "github") {
              throw new APIError("FORBIDDEN", {
                message: "NOT_AUTHORIZED: Only GitHub OAuth accounts are permitted.",
              });
            }
            assertAllowedOwnerGithubProfile({
              configuredOwnerGithubId,
              githubAccountId: newAccount.accountId,
            });
            return Promise.resolve({ data: newAccount });
          },
        },
      },
      session: {
        create: {
          async before(newSession) {
            if (configuredOwnerGithubId === "") {
              throw new APIError("FORBIDDEN", {
                message: "NOT_AUTHORIZED: OWNER_GITHUB_ID must be configured.",
              });
            }
            const ownerAccount = await db.orm
              .select({ accountId: schema.account.accountId })
              .from(schema.account)
              .where(
                and(
                  eq(schema.account.userId, newSession.userId),
                  eq(schema.account.providerId, "github"),
                ),
              )
              .get();
            if (ownerAccount === undefined || ownerAccount.accountId !== configuredOwnerGithubId) {
              throw new APIError("FORBIDDEN", {
                message: "NOT_AUTHORIZED: Session creation denied for non-owner account.",
              });
            }
            return { data: newSession };
          },
        },
      },
    },
    plugins,
  });

  return {
    handler(request: Request): Promise<Response> {
      return auth.handler(request);
    },
    async getSession(headers: Headers): Promise<BetterAuthSessionLookupResult | null> {
      const result = await auth.api.getSession({ headers });
      if (result === null) {
        return null;
      }
      return {
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
        },
        session: {
          id: result.session.id,
          userId: result.session.userId,
          expiresAt: result.session.expiresAt,
        },
      };
    },
    getAuthContext() {
      return auth.$context;
    },
  };
}

export function createBetterAuthFromD1(
  d1: D1LikeDatabase,
  config: BetterAuthConfig,
): BetterAuthRuntime {
  return createBetterAuth(createD1Database(d1), config);
}
