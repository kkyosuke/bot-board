import { and, eq } from "drizzle-orm";

import {
  type BotChannelType,
  type StoredBotConnectionStatus,
  type VerifiedBotContext,
} from "@/auth/context";
import { type D1BotVerificationInput, mintVerifiedBotContext } from "@/auth/internal/mint-context";
import { hashBearerToken, hashOAuthOpaqueToken } from "@/auth/token-hash";
import { type AppDatabase, schema } from "@/db";
import { BOT_SCOPES, type BotScope, DomainError } from "@/domain";

export type { D1BotVerificationInput, VerifiedBotContext };

export interface VerifiedOAuthTokenClaims {
  readonly sub: string;
  readonly clientId: string;
  readonly scopes: readonly BotScope[];
}

export type OAuthJwtVerifier = (token: string) => Promise<VerifiedOAuthTokenClaims | null>;

export interface AuthenticateBotRequestInput {
  readonly db: AppDatabase;
  readonly authorizationHeader: string | null;
  readonly verifyOAuthJwt?: OAuthJwtVerifier;
  readonly nowMs?: number;
}

export function verifyBotConnectionContext(record: D1BotVerificationInput): VerifiedBotContext {
  return mintVerifiedBotContext(record);
}

export function parseBotScopes(raw: unknown): readonly BotScope[] {
  const candidates: string[] = [];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === "string") {
              candidates.push(item);
            }
          }
        }
      } catch {
        return [];
      }
    } else if (trimmed !== "") {
      for (const part of trimmed.split(/\s+/)) {
        if (part !== "") {
          candidates.push(part);
        }
      }
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        candidates.push(item);
      }
    }
  }

  const valid: BotScope[] = [];
  for (const item of candidates) {
    const matched = BOT_SCOPES.find((scope) => scope === item);
    if (matched !== undefined && !valid.includes(matched)) {
      valid.push(matched);
    }
  }
  return valid;
}

function parseChannelType(raw: string): BotChannelType {
  if (raw === "mcp_oauth" || raw === "worker_bearer") {
    return raw;
  }
  throw new DomainError("NOT_AUTHORIZED", "Unsupported bot connection channel.", false);
}

function parseConnectionStatus(raw: string): StoredBotConnectionStatus {
  if (raw === "active" || raw === "paused" || raw === "revoked") {
    return raw;
  }
  throw new DomainError("NOT_AUTHORIZED", "Invalid bot connection status.", false);
}

function extractBearerToken(authorizationHeader: string | null): string {
  if (authorizationHeader === null) {
    throw new DomainError("NOT_AUTHORIZED", "Missing Authorization Bearer token.", false);
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1];
  if (token === undefined || token.trim() === "") {
    throw new DomainError("NOT_AUTHORIZED", "Malformed Authorization Bearer token.", false);
  }
  return token;
}

/**
 * Authenticates an incoming Bot request (Worker Bearer or OAuth 2.1 access token)
 * and ALWAYS performs a live per-request D1 lookup against `bot_connections` and `workspaces`
 * to enforce instant revocation, pausing, workspace ownership, and scope narrowing (BOT-02).
 */
export async function authenticateBotRequest(
  input: AuthenticateBotRequestInput,
): Promise<VerifiedBotContext> {
  const rawToken = extractBearerToken(input.authorizationHeader);
  const nowMs = input.nowMs ?? Date.now();

  // Path A: Worker Bearer Token (SHA-256 hex lookup against bot_connections.token_hash)
  const tokenHash = await hashBearerToken(rawToken);
  const workerMatch = await input.db.orm
    .select({
      botId: schema.botConnections.id,
      workspaceId: schema.botConnections.workspaceId,
      channelType: schema.botConnections.channelType,
      status: schema.botConnections.status,
      scopes: schema.botConnections.scopes,
      ownerUserId: schema.workspaces.ownerUserId,
      isWorkspacePaused: schema.workspaces.isPaused,
    })
    .from(schema.botConnections)
    .innerJoin(schema.workspaces, eq(schema.botConnections.workspaceId, schema.workspaces.id))
    .where(
      and(
        eq(schema.botConnections.tokenHash, tokenHash),
        eq(schema.botConnections.channelType, "worker_bearer"),
      ),
    )
    .get();

  if (workerMatch !== undefined) {
    return verifyBotConnectionContext({
      botConnectionId: workerMatch.botId,
      workspaceId: workerMatch.workspaceId,
      workspaceOwnerUserId: workerMatch.ownerUserId,
      isWorkspacePaused: workerMatch.isWorkspacePaused,
      channelType: parseChannelType(workerMatch.channelType),
      status: parseConnectionStatus(workerMatch.status),
      connectionScopes: parseBotScopes(workerMatch.scopes),
    });
  }

  // Path B: OAuth 2.1 access token (JWT verifier or hashed D1 oauthAccessToken) + mandatory D1 bot_connections lookup
  let oauthClaims: VerifiedOAuthTokenClaims | null = null;

  if (input.verifyOAuthJwt !== undefined) {
    try {
      oauthClaims = await input.verifyOAuthJwt(rawToken);
    } catch {
      // Fail closed on invalid/expired/malformed JWT so callers receive 401 WWW-Authenticate, never 500
      oauthClaims = null;
    }
  }

  if (oauthClaims === null) {
    // Hash with unpadded base64url(SHA-256) matching @better-auth/oauth-provider storeToken("hashed")
    const hashedOpaqueToken = await hashOAuthOpaqueToken(rawToken);
    const tokenRecord = await input.db.orm
      .select({
        clientId: schema.oauthAccessToken.clientId,
        userId: schema.oauthAccessToken.userId,
        scopes: schema.oauthAccessToken.scopes,
        expiresAt: schema.oauthAccessToken.expiresAt,
        revoked: schema.oauthAccessToken.revoked,
        clientDisabled: schema.oauthClient.disabled,
      })
      .from(schema.oauthAccessToken)
      .innerJoin(
        schema.oauthClient,
        eq(schema.oauthAccessToken.clientId, schema.oauthClient.clientId),
      )
      .where(eq(schema.oauthAccessToken.token, hashedOpaqueToken))
      .get();

    if (
      tokenRecord !== undefined &&
      tokenRecord.userId !== null &&
      tokenRecord.clientDisabled !== true &&
      tokenRecord.revoked === null &&
      tokenRecord.expiresAt !== null &&
      tokenRecord.expiresAt.getTime() > nowMs
    ) {
      oauthClaims = {
        sub: tokenRecord.userId,
        clientId: tokenRecord.clientId,
        scopes: parseBotScopes(tokenRecord.scopes),
      };
    }
  }

  if (oauthClaims === null) {
    throw new DomainError("NOT_AUTHORIZED", "Invalid, expired, or revoked Bot credentials.", false);
  }

  const oauthConnection = await input.db.orm
    .select({
      botId: schema.botConnections.id,
      workspaceId: schema.botConnections.workspaceId,
      channelType: schema.botConnections.channelType,
      oauthClientId: schema.botConnections.oauthClientId,
      status: schema.botConnections.status,
      scopes: schema.botConnections.scopes,
      ownerUserId: schema.workspaces.ownerUserId,
      isWorkspacePaused: schema.workspaces.isPaused,
    })
    .from(schema.botConnections)
    .innerJoin(schema.workspaces, eq(schema.botConnections.workspaceId, schema.workspaces.id))
    .where(
      and(
        eq(schema.botConnections.channelType, "mcp_oauth"),
        eq(schema.botConnections.oauthClientId, oauthClaims.clientId),
        eq(schema.workspaces.ownerUserId, oauthClaims.sub),
      ),
    )
    .get();

  if (oauthConnection === undefined) {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "No authorized bot_connections record found for this OAuth client.",
      false,
    );
  }

  return verifyBotConnectionContext({
    botConnectionId: oauthConnection.botId,
    workspaceId: oauthConnection.workspaceId,
    workspaceOwnerUserId: oauthConnection.ownerUserId,
    isWorkspacePaused: oauthConnection.isWorkspacePaused,
    channelType: parseChannelType(oauthConnection.channelType),
    status: parseConnectionStatus(oauthConnection.status),
    connectionScopes: parseBotScopes(oauthConnection.scopes),
    ...(oauthConnection.oauthClientId !== null
      ? { connectionOAuthClientId: oauthConnection.oauthClientId }
      : {}),
    tokenClientId: oauthClaims.clientId,
    tokenScopes: oauthClaims.scopes,
    tokenSubjectUserId: oauthClaims.sub,
  });
}
