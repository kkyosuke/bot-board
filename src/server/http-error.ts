import { ZodError } from "zod";

import {
  DomainError,
  type DomainErrorDetails,
  type DomainErrorHttpStatus,
  type ErrorCode,
  errorCodeToHttpStatus,
} from "@/domain";
import { createLogger } from "@/shared/logger";

export type HttpErrorCode = ErrorCode | "INTERNAL_ERROR";

export interface HttpErrorBody {
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: DomainErrorDetails;
}

export interface MappedHttpError {
  readonly status: DomainErrorHttpStatus | 500;
  readonly body: HttpErrorBody;
}

const httpLogger = createLogger("http-error");

export function mapErrorToHttpResponse(error: unknown): MappedHttpError {
  if (error instanceof DomainError) {
    const status = errorCodeToHttpStatus(error.code);
    const body: HttpErrorBody =
      error.details !== undefined
        ? {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: error.details,
          }
        : {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
          };
    return { status, body };
  }

  if (error instanceof ZodError) {
    const summary = error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return {
      status: 400,
      body: {
        code: "VALIDATION_ERROR",
        message: `Invalid request payload (${summary}).`,
        retryable: false,
      },
    };
  }

  httpLogger.error("Unhandled HTTP server error", { error });
  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
      retryable: true,
    },
  };
}
