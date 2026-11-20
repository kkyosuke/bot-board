export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_AUTHORIZED",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "VERSION_CONFLICT",
  "LEASE_CONFLICT",
  "GROUP_LOCKED",
  "INVALID_TRANSITION",
  "STALE_PROPOSAL",
  "WORKSPACE_PAUSED",
  "RATE_LIMITED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const BOT_SCOPES = [
  "tasks:read",
  "tasks:write",
  "proposals:write",
  "decisions:read",
] as const;

export type BotScope = (typeof BOT_SCOPES)[number];

export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;

  public constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = retryable;
  }
}
