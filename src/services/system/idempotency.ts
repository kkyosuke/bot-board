import { and, eq } from "drizzle-orm";

import { type AppDatabase, collectErrorMessages, type RawSqlStatement, schema } from "@/db";
import { DomainError, type ErrorCode } from "@/domain";

export type ActorType = "human" | "bot" | "system";

export interface IdempotencyKey {
  readonly workspaceId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly operation: string;
  readonly requestId: string;
}

const RACE_REPLAY_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "VERSION_CONFLICT",
  "LEASE_CONFLICT",
  "INVALID_TRANSITION",
  "STALE_PROPOSAL",
  "GROUP_LOCKED",
]);

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  const sortedEntries = Object.entries(value)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([k, val]) => [k, canonicalizeValue(val)] as const);
  return Object.fromEntries(sortedEntries);
}

export async function canonicalJsonHash(payload: unknown): Promise<string> {
  return await sha256Hex(JSON.stringify(canonicalizeValue(payload)));
}

export function generateEntityId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

export function generateLeaseToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function assertNonEmptyRequestId(requestId: string): void {
  if (requestId.trim() === "" || requestId.length > 128) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "request_id must be a non-empty string up to 128 characters.",
      false,
    );
  }
}

export async function lookupIdempotentResponse<T>(
  db: AppDatabase,
  key: IdempotencyKey,
  inputHash: string,
  parseStored: (raw: unknown) => T,
): Promise<{ readonly hit: true; readonly response: T } | { readonly hit: false }> {
  assertNonEmptyRequestId(key.requestId);

  const existing = await db.orm
    .select()
    .from(schema.idempotencyKeys)
    .where(
      and(
        eq(schema.idempotencyKeys.workspaceId, key.workspaceId),
        eq(schema.idempotencyKeys.actorType, key.actorType),
        eq(schema.idempotencyKeys.actorId, key.actorId),
        eq(schema.idempotencyKeys.operation, key.operation),
        eq(schema.idempotencyKeys.requestId, key.requestId),
      ),
    )
    .get();

  if (existing === undefined) {
    return { hit: false };
  }

  if (existing.inputHash !== inputHash) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      `request_id "${key.requestId}" was already used with a different payload for "${key.operation}".`,
      false,
    );
  }

  const parsedJson: unknown = JSON.parse(existing.responseJson);
  return {
    hit: true,
    response: parseStored(parsedJson),
  };
}

export function buildInsertIdempotencyKeySql(
  key: IdempotencyKey,
  inputHash: string,
  response: unknown,
  createdAt: number,
): RawSqlStatement {
  return {
    sql: "INSERT INTO idempotency_keys (workspace_id, actor_type, actor_id, operation, request_id, input_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    params: [
      key.workspaceId,
      key.actorType,
      key.actorId,
      key.operation,
      key.requestId,
      inputHash,
      JSON.stringify(response),
      createdAt,
    ],
  };
}

export function isIdempotencyUniqueViolation(error: unknown): boolean {
  return collectErrorMessages(error).some(
    (msg) =>
      msg.includes("UNIQUE constraint failed") &&
      (msg.includes("idempotency_keys") || msg.includes("request_id")),
  );
}

function shouldReplayIdempotencyOnError(error: unknown): boolean {
  if (isIdempotencyUniqueViolation(error)) {
    return true;
  }
  if (error instanceof DomainError && RACE_REPLAY_ERROR_CODES.has(error.code)) {
    return true;
  }
  return false;
}

export async function runWithIdempotencyRaceGuard<T>(
  db: AppDatabase,
  key: IdempotencyKey,
  inputHash: string,
  parseStored: (raw: unknown) => T,
  executeMutation: () => Promise<T>,
): Promise<T> {
  const precheck = await lookupIdempotentResponse(db, key, inputHash, parseStored);
  if (precheck.hit) {
    return precheck.response;
  }

  try {
    return await executeMutation();
  } catch (error) {
    if (shouldReplayIdempotencyOnError(error)) {
      const replay = await lookupIdempotentResponse(db, key, inputHash, parseStored);
      if (replay.hit) {
        return replay.response;
      }
    }
    throw error;
  }
}
