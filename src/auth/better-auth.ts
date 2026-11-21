import { mcp } from "@better-auth/mcp";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { verifyBearerToken } from "better-auth/oauth2";
import { jwt } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";

import { type OAuthJwtVerifier, parseBotScopes, type VerifiedOAuthTokenClaims } from "@/auth/bot";
import {
  type AppDatabase,
  createD1Database,
  type D1LikeDatabase,
  guardedBatch,
  schema,
} from "@/db";
import {
  BOT_SCOPES,
  type BotScope,
  DEFAULT_BUDGET_LIMIT,
  DomainError,
  serializeBudgetLimit,
} from "@/domain";

export interface BetterAuthConfig {
  readonly baseUrl: string;
  readonly secret: string;
  readonly trustedOrigins?: readonly string[] | string;
  readonly ownerEmail?: string;
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

const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeOwnerEmail(raw?: string): string {
  return raw?.trim().toLowerCase() ?? "";
}

export function isValidOwnerEmail(raw?: string): boolean {
  const normalized = normalizeOwnerEmail(raw);
  return normalized !== "" && BASIC_EMAIL_PATTERN.test(normalized);
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

function generatePrefixedId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
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

  const workspaceId = generatePrefixedId("ws");
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

export function assertAllowedOwnerEmail(params: {
  readonly configuredOwnerEmail?: string | undefined;
  readonly candidateEmail: string;
}): void {
  const allowed = normalizeOwnerEmail(params.configuredOwnerEmail);
  if (!isValidOwnerEmail(allowed)) {
    throw new APIError("FORBIDDEN", {
      code: "NOT_AUTHORIZED",
      message: "NOT_AUTHORIZED: OWNER_EMAIL is not configured.",
    });
  }
  const candidate = normalizeOwnerEmail(params.candidateEmail);
  if (candidate === "" || candidate !== allowed) {
    throw new APIError("FORBIDDEN", {
      code: "NOT_AUTHORIZED",
      message: "NOT_AUTHORIZED: Only the configured single owner email is allowed.",
    });
  }
}

function readStringField(obj: unknown, key: string): string | null {
  if (obj === null || typeof obj !== "object") {
    return null;
  }
  const value: unknown = Reflect.get(obj, key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readBooleanField(obj: unknown, key: string): boolean | null {
  if (obj === null || typeof obj !== "object") {
    return null;
  }
  const value: unknown = Reflect.get(obj, key);
  return typeof value === "boolean" ? value : null;
}

function extractClientIdFromQueryString(query: string | null): string | null {
  if (query === null || query.trim() === "") {
    return null;
  }
  const normalized = query.startsWith("?") ? query.slice(1) : query;
  const params = new URLSearchParams(normalized);
  const clientId = params.get("client_id")?.trim() ?? "";
  return clientId !== "" ? clientId : null;
}

export interface UpsertOAuthBotConnectionInput {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly scopes: readonly BotScope[];
  readonly nowMs: number;
}

/**
 * Atomically upserts an `mcp_oauth` row in `bot_connections` upon owner OAuth 2.1 consent.
 * Never revives a `revoked` connection (BOT-02).
 */
export async function upsertOAuthBotConnection(
  db: AppDatabase,
  input: UpsertOAuthBotConnectionInput,
): Promise<{ readonly botId: string; readonly created: boolean }> {
  if (input.scopes.length === 0) {
    throw new APIError("BAD_REQUEST", {
      message: "At least one Bot scope must be granted for MCP connection.",
    });
  }

  const trimmedName = input.displayName.trim().slice(0, 100) || input.clientId.slice(0, 100);
  const scopesJson = JSON.stringify(input.scopes);

  const existing = await db.orm
    .select({
      id: schema.botConnections.id,
      status: schema.botConnections.status,
      version: schema.botConnections.version,
    })
    .from(schema.botConnections)
    .where(
      and(
        eq(schema.botConnections.workspaceId, input.workspaceId),
        eq(schema.botConnections.channelType, "mcp_oauth"),
        eq(schema.botConnections.oauthClientId, input.clientId),
      ),
    )
    .get();

  if (existing !== undefined) {
    if (existing.status === "revoked") {
      throw new APIError("FORBIDDEN", {
        message: "NOT_AUTHORIZED: OAuth client has been revoked and cannot be re-authorized.",
      });
    }

    const eventId = generatePrefixedId("evt");
    const outcome = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: `UPDATE bot_connections
              SET display_name = ?, scopes = ?, status = 'active', version = version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND status != 'revoked' AND version = ?`,
        params: [
          trimmedName,
          scopesJson,
          input.nowMs,
          existing.id,
          input.workspaceId,
          existing.version,
        ],
      },
      followUps: [
        {
          sql: `INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at)
                VALUES (?, ?, 'human', 'oauth_consent', 'bot_connection', ?, 'bot.oauth_consent_updated', ?, NULL, ?)`,
          params: [
            eventId,
            input.workspaceId,
            existing.id,
            JSON.stringify({
              oauth_client_id: input.clientId,
              scopes: input.scopes,
            }),
            input.nowMs,
          ],
        },
      ],
    });

    if (!outcome.applied) {
      throw new APIError("FORBIDDEN", {
        message: "NOT_AUTHORIZED: OAuth bot connection state changed concurrently.",
      });
    }
    return { botId: existing.id, created: false };
  }

  const botId = generatePrefixedId("bot");
  const eventId = generatePrefixedId("evt");
  await db.executor.batch([
    {
      sql: `INSERT INTO bot_connections (id, workspace_id, display_name, channel_type, oauth_client_id, token_hash, scopes, status, version, created_at, updated_at)
            VALUES (?, ?, ?, 'mcp_oauth', ?, NULL, ?, 'active', 1, ?, ?)`,
      params: [
        botId,
        input.workspaceId,
        trimmedName,
        input.clientId,
        scopesJson,
        input.nowMs,
        input.nowMs,
      ],
    },
    {
      sql: `INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at)
            VALUES (?, ?, 'human', 'oauth_consent', 'bot_connection', ?, 'bot.oauth_connected', ?, NULL, ?)`,
      params: [
        eventId,
        input.workspaceId,
        botId,
        JSON.stringify({
          oauth_client_id: input.clientId,
          scopes: input.scopes,
        }),
        input.nowMs,
      ],
    },
  ]);

  return { botId, created: true };
}

const PASSKEY_AUTHENTICATED_PATHS = new Set<string>([
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);

function createOwnerAuthBoundaryPlugin(
  db: AppDatabase,
  configuredOwnerEmail: string,
): BetterAuthPlugin {
  return {
    id: "bot-board-owner-auth-boundary",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            if (!isValidOwnerEmail(configuredOwnerEmail)) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: OWNER_EMAIL is not configured.",
              });
            }
            // Check single-owner lock BEFORE comparing email to prevent post-bootstrap OWNER_EMAIL enumeration (M1)
            const existingUser = await db.orm
              .select({ id: schema.user.id })
              .from(schema.user)
              .limit(1)
              .get();
            if (existingUser !== undefined) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: Single-owner workspace forbids additional signups.",
              });
            }
            const candidateEmail = readStringField(ctx.body, "email") ?? "";
            assertAllowedOwnerEmail({
              configuredOwnerEmail,
              candidateEmail,
            });
          }),
        },
        {
          matcher: (context) =>
            context.path !== undefined && PASSKEY_AUTHENTICATED_PATHS.has(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session === null) {
              throw new APIError("UNAUTHORIZED", {
                message: "NOT_AUTHORIZED: Owner sign-in required for passkey management.",
              });
            }
            if (!isValidOwnerEmail(configuredOwnerEmail)) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: OWNER_EMAIL must be configured.",
              });
            }
            const userRow = await db.orm
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, session.user.id))
              .get();
            if (
              userRow === undefined ||
              normalizeOwnerEmail(userRow.email) !== configuredOwnerEmail ||
              normalizeOwnerEmail(session.user.email) !== configuredOwnerEmail
            ) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: Only the configured single owner may manage passkeys.",
              });
            }
          }),
        },
      ],
    },
  };
}

function createBotConnectionConsentPlugin(
  db: AppDatabase,
  configuredOwnerEmail: string,
  nowFn: () => number,
): BetterAuthPlugin {
  return {
    id: "bot-board-oauth-consent",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/oauth2/consent",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (session === null) {
              throw new APIError("UNAUTHORIZED", {
                message: "NOT_AUTHORIZED: Owner sign-in required for OAuth consent.",
              });
            }
            if (!isValidOwnerEmail(configuredOwnerEmail)) {
              throw new APIError("FORBIDDEN", {
                message: "NOT_AUTHORIZED: OWNER_EMAIL must be configured.",
              });
            }
            const ownerUser = await db.orm
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, session.user.id))
              .get();
            if (
              ownerUser === undefined ||
              normalizeOwnerEmail(ownerUser.email) !== configuredOwnerEmail ||
              normalizeOwnerEmail(session.user.email) !== configuredOwnerEmail
            ) {
              throw new APIError("FORBIDDEN", {
                message:
                  "NOT_AUTHORIZED: Only the configured single owner may approve OAuth consent.",
              });
            }

            const accept = readBooleanField(ctx.body, "accept");
            if (accept === true) {
              const oauthState = await getOAuthProviderState();
              const oauthQuery = oauthState?.query ?? readStringField(ctx.body, "oauth_query");
              const scopeField = readStringField(ctx.body, "scope");
              const queryScope =
                oauthQuery !== null
                  ? new URLSearchParams(
                      oauthQuery.startsWith("?") ? oauthQuery.slice(1) : oauthQuery,
                    ).get("scope")
                  : null;
              const effectiveScope = scopeField ?? queryScope ?? "";
              if (parseBotScopes(effectiveScope).length === 0) {
                throw new APIError("BAD_REQUEST", {
                  message: "At least one Bot scope must be selected.",
                });
              }

              const clientId = extractClientIdFromQueryString(oauthQuery);
              if (clientId !== null) {
                const workspaceId = await ensureOwnerWorkspace(db, session.user.id, nowFn());
                const existing = await db.orm
                  .select({ status: schema.botConnections.status })
                  .from(schema.botConnections)
                  .where(
                    and(
                      eq(schema.botConnections.workspaceId, workspaceId),
                      eq(schema.botConnections.channelType, "mcp_oauth"),
                      eq(schema.botConnections.oauthClientId, clientId),
                    ),
                  )
                  .get();
                if (existing?.status === "revoked") {
                  throw new APIError("FORBIDDEN", {
                    message:
                      "NOT_AUTHORIZED: This OAuth client has been revoked and cannot be re-authorized.",
                  });
                }
              }
            }
          }),
        },
        {
          matcher: (context) => context.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            let clientId = readStringField(ctx.body, "client_id");
            if (clientId === null) {
              const authHeader = ctx.headers?.get("authorization") ?? "";
              const basicMatch = /^Basic\s+(\S+)$/i.exec(authHeader.trim());
              if (basicMatch?.[1] !== undefined) {
                try {
                  const decoded = atob(basicMatch[1]);
                  const colonIdx = decoded.indexOf(":");
                  const rawId = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
                  if (rawId.trim() !== "") {
                    clientId = decodeURIComponent(rawId.trim());
                  }
                } catch {
                  // Malformed Basic auth will be rejected downstream by Better Auth
                }
              }
            }
            // M2: Support private_key_jwt (RFC 7523 client_assertion) when client_id & Basic auth are omitted
            if (clientId === null) {
              const assertion = readStringField(ctx.body, "client_assertion");
              if (assertion !== null) {
                const parts = assertion.split(".");
                const payloadPart = parts[1];
                if (parts.length === 3 && payloadPart !== undefined) {
                  try {
                    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
                    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
                    const decodedPayload: unknown = JSON.parse(atob(padded));
                    clientId =
                      readStringField(decodedPayload, "iss") ??
                      readStringField(decodedPayload, "sub");
                  } catch {
                    // Malformed JWT assertion will be rejected downstream by Better Auth
                  }
                }
              }
            }
            if (clientId === null) {
              return;
            }
            const revoked = await db.orm
              .select({ id: schema.botConnections.id })
              .from(schema.botConnections)
              .where(
                and(
                  eq(schema.botConnections.channelType, "mcp_oauth"),
                  eq(schema.botConnections.oauthClientId, clientId),
                  eq(schema.botConnections.status, "revoked"),
                ),
              )
              .get();
            if (revoked !== undefined) {
              throw new APIError("FORBIDDEN", {
                error: "access_denied",
                error_description: "OAuth client has been revoked.",
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === "/oauth2/consent",
          handler: createAuthMiddleware(async (ctx) => {
            if (readBooleanField(ctx.body, "accept") !== true) {
              return;
            }
            const returned: unknown = ctx.context.returned;
            if (returned instanceof APIError || returned instanceof Error) {
              return;
            }
            const redirectOk = readBooleanField(returned, "redirect") === true;
            const redirectUrl = readStringField(returned, "url");
            if (!redirectOk || redirectUrl === null) {
              return;
            }
            // M2: Only upsert bot_connections when authorization actually succeeded with an authorization code
            // (prevents false-positive upsert on prompt=login redirects to /sign-in or error redirects)
            const hasAuthCode = ((): boolean => {
              try {
                const parsedRedirect = new URL(redirectUrl, "https://bot-board.local");
                return (
                  parsedRedirect.searchParams.has("code") &&
                  !parsedRedirect.searchParams.has("error")
                );
              } catch {
                return false;
              }
            })();
            if (!hasAuthCode) {
              return;
            }

            const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
            if (session === null) {
              return;
            }

            const oauthState = await getOAuthProviderState();
            const oauthQuery = oauthState?.query ?? readStringField(ctx.body, "oauth_query");
            const clientId = extractClientIdFromQueryString(oauthQuery);
            if (clientId === null) {
              return;
            }

            const consentRow = await db.orm
              .select({ scopes: schema.oauthConsent.scopes })
              .from(schema.oauthConsent)
              .where(
                and(
                  eq(schema.oauthConsent.clientId, clientId),
                  eq(schema.oauthConsent.userId, session.user.id),
                ),
              )
              .get();
            if (consentRow === undefined) {
              return;
            }

            const grantedScopes = parseBotScopes(consentRow.scopes);
            if (grantedScopes.length === 0) {
              await db.executor.batch([
                {
                  sql: "DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
                  params: [clientId, session.user.id],
                },
              ]);
              throw new APIError("BAD_REQUEST", {
                message: "At least one Bot scope must be granted for MCP connection.",
              });
            }

            const clientRow = await db.orm
              .select({ name: schema.oauthClient.name })
              .from(schema.oauthClient)
              .where(eq(schema.oauthClient.clientId, clientId))
              .get();
            const workspaceId = await ensureOwnerWorkspace(db, session.user.id, nowFn());

            try {
              await upsertOAuthBotConnection(db, {
                workspaceId,
                clientId,
                displayName: clientRow?.name ?? clientId,
                scopes: grantedScopes,
                nowMs: nowFn(),
              });
            } catch (err) {
              // M2: Clean up newly persisted oauthConsent row if concurrent revocation blocked bot_connections upsert
              await db.executor.batch([
                {
                  sql: "DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
                  params: [clientId, session.user.id],
                },
              ]);
              throw err;
            }
          }),
        },
      ],
    },
  };
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
  const configuredOwnerEmail = normalizeOwnerEmail(config.ownerEmail);
  const mcpResourceUrl = `${baseOrigin}/api/mcp`;
  const rpID = new URL(baseOrigin).hostname;

  const ownerBoundaryPlugin = createOwnerAuthBoundaryPlugin(db, configuredOwnerEmail);
  const mcpOAuthEnabled = config.enableMcpOAuth !== false;
  const plugins = mcpOAuthEnabled
    ? [
        jwt(),
        passkey({
          rpID,
          rpName: "bot-board",
          origin: trustedOrigins,
          authenticatorSelection: {
            residentKey: "required",
            userVerification: "preferred",
          },
        }),
        mcp({
          loginPage: "/sign-in",
          consentPage: "/consent",
          resource: mcpResourceUrl,
          grantTypes: ["authorization_code", "refresh_token"],
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          scopes: ["openid", "profile", "email", "offline_access", ...BOT_SCOPES],
        }),
        ownerBoundaryPlugin,
        createBotConnectionConsentPlugin(db, configuredOwnerEmail, nowFn),
      ]
    : [jwt(), ownerBoundaryPlugin];

  const auth = betterAuth({
    baseURL: normalizedBaseUrl,
    secret: config.secret,
    trustedOrigins,
    telemetry: {
      enabled: false,
    },
    onAPIError: {
      errorURL: "/sign-in",
    },
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
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    databaseHooks: {
      user: {
        create: {
          async before(newUser) {
            if (!isValidOwnerEmail(configuredOwnerEmail)) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: OWNER_EMAIL is not configured.",
              });
            }
            // Check single-owner lock BEFORE comparing email (uniform 403 post-bootstrap; M1)
            const existingUser = await db.orm
              .select({ id: schema.user.id })
              .from(schema.user)
              .limit(1)
              .get();
            if (existingUser !== undefined) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: Single-owner workspace forbids additional signups.",
              });
            }
            assertAllowedOwnerEmail({
              configuredOwnerEmail,
              candidateEmail: newUser.email,
            });
            return {
              data: {
                ...newUser,
                email: configuredOwnerEmail,
              },
            };
          },
          async after(createdUser) {
            await ensureOwnerWorkspace(db, createdUser.id, nowFn());
          },
        },
      },
      account: {
        create: {
          async before(newAccount) {
            if (newAccount.providerId !== "credential") {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: Only credential accounts are permitted.",
              });
            }
            if (!isValidOwnerEmail(configuredOwnerEmail)) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: OWNER_EMAIL must be configured.",
              });
            }
            const userRow = await db.orm
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, newAccount.userId))
              .get();
            if (
              userRow === undefined ||
              normalizeOwnerEmail(userRow.email) !== configuredOwnerEmail
            ) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: Account creation denied for non-owner user.",
              });
            }
            return { data: newAccount };
          },
        },
      },
      session: {
        create: {
          async before(newSession) {
            if (!isValidOwnerEmail(configuredOwnerEmail)) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
                message: "NOT_AUTHORIZED: OWNER_EMAIL must be configured.",
              });
            }
            const ownerUser = await db.orm
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, newSession.userId))
              .get();
            if (
              ownerUser === undefined ||
              normalizeOwnerEmail(ownerUser.email) !== configuredOwnerEmail
            ) {
              throw new APIError("FORBIDDEN", {
                code: "NOT_AUTHORIZED",
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

  const verifyOAuthJwt: OAuthJwtVerifier = async (
    rawToken: string,
  ): Promise<VerifiedOAuthTokenClaims | null> => {
    // Fast skip for non-JWT opaque tokens (3 base64url dot-separated segments required for JWS)
    if (rawToken.split(".").length !== 3) {
      return null;
    }
    try {
      const authContext = await auth.$context;
      const payload = await verifyBearerToken(rawToken, {
        jwksFetch: async () => await auth.api.getJwks(),
        verifyOptions: {
          issuer: authContext.baseURL,
          audience: mcpResourceUrl,
          typ: "at+jwt",
          requiredClaims: ["azp", "sub", "exp"],
        },
      });
      const sub = typeof payload.sub === "string" && payload.sub.trim() !== "" ? payload.sub : null;
      const azpRaw: unknown = Reflect.get(payload, "azp");
      const azp = typeof azpRaw === "string" && azpRaw.trim() !== "" ? azpRaw : null;
      if (sub === null || azp === null) {
        return null;
      }
      const scopes = parseBotScopes(Reflect.get(payload, "scope"));
      return {
        sub,
        clientId: azp,
        scopes,
      };
    } catch {
      return null;
    }
  };

  return {
    async handler(request: Request): Promise<Response> {
      const reqUrl = new URL(request.url);
      if (
        reqUrl.pathname === "/api/auth/owner-status" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const existingUser = await db.orm
          .select({ id: schema.user.id })
          .from(schema.user)
          .limit(1)
          .get();
        const body =
          request.method === "HEAD"
            ? null
            : JSON.stringify({ initialized: existingUser !== undefined });
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }

      const response = await auth.handler(request);
      if (
        response.status === 404 &&
        mcpOAuthEnabled &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        // Support root-level & path-aware RFC 8414 / OIDC discovery alongside /api/auth-suffixed paths
        if (reqUrl.pathname === "/.well-known/oauth-authorization-server") {
          const rewritten = new Request(
            `${baseOrigin}/.well-known/oauth-authorization-server/api/auth`,
            { method: request.method, headers: request.headers },
          );
          return await auth.handler(rewritten);
        }
        if (
          reqUrl.pathname === "/.well-known/openid-configuration" ||
          reqUrl.pathname === "/.well-known/openid-configuration/api/auth"
        ) {
          const rewritten = new Request(`${baseOrigin}/api/auth/.well-known/openid-configuration`, {
            method: request.method,
            headers: request.headers,
          });
          return await auth.handler(rewritten);
        }
      }
      return response;
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
    verifyOAuthJwt,
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

/**
 * Request-scoped lazy OAuth 2.1 JWT verifier for `/api/mcp`.
 * Avoids initializing Better Auth on Worker Bearer or opaque token requests.
 */
export function createLazyOAuthJwtVerifierFromD1(
  db: AppDatabase,
  config: BetterAuthConfig,
): OAuthJwtVerifier {
  let cachedVerifier: OAuthJwtVerifier | null = null;
  return async (rawToken: string): Promise<VerifiedOAuthTokenClaims | null> => {
    if (rawToken.split(".").length !== 3) {
      return null;
    }
    if (cachedVerifier === null) {
      cachedVerifier = createBetterAuth(db, config).verifyOAuthJwt;
    }
    return await cachedVerifier(rawToken);
  };
}
