const SENSITIVE_KEY_PATTERN =
  /(secret|token|password|authorization|cookie|api[-_]?key|private[-_]?key|credential|code[-_]?verifier)/i;
const BEARER_VALUE_PATTERN = /\bBearer\s+[^\s"',;]+/gi;
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

export type LogLevel = "info" | "warn" | "error";

function redactString(input: string): string {
  return input
    .replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(BEARER_VALUE_PATTERN, "Bearer [REDACTED]");
}

function redactInternal(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (ancestors.has(value)) {
    return "[Circular]";
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }

  ancestors.add(value);
  try {
    if (value instanceof Error) {
      const serializedError: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message),
      };
      if (value.stack !== undefined) {
        serializedError["stack"] = redactString(value.stack);
      }
      if (value.cause !== undefined) {
        serializedError["cause"] = redactInternal(value.cause, ancestors);
      }
      for (const [key, entry] of Object.entries(value)) {
        serializedError[key] = SENSITIVE_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : redactInternal(entry, ancestors);
      }
      return serializedError;
    }

    if (value instanceof Headers) {
      const headersOutput: Record<string, unknown> = {};
      value.forEach((headerValue, headerKey) => {
        headersOutput[headerKey] = SENSITIVE_KEY_PATTERN.test(headerKey)
          ? "[REDACTED]"
          : redactString(headerValue);
      });
      return headersOutput;
    }

    if (value instanceof Map) {
      const mapOutput: Record<string, unknown> = {};
      for (const [mapKey, mapValue] of value.entries()) {
        const normalizedKey = String(mapKey);
        mapOutput[normalizedKey] = SENSITIVE_KEY_PATTERN.test(normalizedKey)
          ? "[REDACTED]"
          : redactInternal(mapValue, ancestors);
      }
      return mapOutput;
    }

    if (value instanceof Set) {
      return Array.from(value, (item) => redactInternal(item, ancestors));
    }

    if (Array.isArray(value)) {
      return value.map((item) => redactInternal(item, ancestors));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : redactInternal(entry, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

export function redactSensitiveData(value: unknown): unknown {
  return redactInternal(value, new WeakSet<object>());
}

export interface Logger {
  info(event: string, metadata?: Record<string, unknown>): void;
  warn(event: string, metadata?: Record<string, unknown>): void;
  error(event: string, metadata?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  const safeComponent = redactString(component);

  const emit = (level: LogLevel, event: string, metadata?: Record<string, unknown>): void => {
    let safeMetadata: unknown;
    if (metadata !== undefined) {
      try {
        safeMetadata = redactSensitiveData(metadata);
      } catch {
        safeMetadata = { redactionError: "Failed to serialize metadata." };
      }
    }

    const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: safeComponent,
      event: redactString(event),
      ...(safeMetadata !== undefined ? { metadata: safeMetadata } : {}),
    });

    if (level === "error") {
      console.error(payload);
      return;
    }
    if (level === "warn") {
      console.warn(payload);
      return;
    }
    console.info(payload);
  };

  return {
    info: (event, metadata) => emit("info", event, metadata),
    warn: (event, metadata) => emit("warn", event, metadata),
    error: (event, metadata) => emit("error", event, metadata),
  };
}
