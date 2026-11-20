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

export type DomainErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 423 | 429;

export interface DomainErrorDetails {
  readonly replacementCardId?: string;
  readonly currentVersion?: number;
  readonly retryAfterSeconds?: number;
  readonly reason?: string;
}

export function errorCodeToHttpStatus(code: ErrorCode): DomainErrorHttpStatus {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "NOT_AUTHORIZED":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "VERSION_CONFLICT":
    case "LEASE_CONFLICT":
    case "GROUP_LOCKED":
    case "INVALID_TRANSITION":
    case "STALE_PROPOSAL":
      return 409;
    case "WORKSPACE_PAUSED":
      return 423;
    case "RATE_LIMITED":
      return 429;
  }
}

export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly details?: DomainErrorDetails;

  public constructor(
    code: ErrorCode,
    message: string,
    retryable = false,
    details?: DomainErrorDetails,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
