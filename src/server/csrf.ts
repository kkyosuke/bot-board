import { DomainError } from "@/domain";

function extractNormalizedOrigin(rawHeader: string | null): string | null {
  if (rawHeader === null) {
    return null;
  }
  const trimmed = rawHeader.trim();
  if (trimmed === "" || trimmed === "null") {
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

export function normalizeTrustedOriginSet(trustedOrigins: readonly string[]): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const entry of trustedOrigins) {
    const origin = extractNormalizedOrigin(entry);
    if (origin !== null) {
      allowed.add(origin);
    }
  }
  return allowed;
}

/**
 * Enforces trustedOrigins-based CSRF protection for all mutating /api/human/* endpoints.
 * Fails closed whenever Sec-Fetch-Site is cross-site or neither Origin nor Referer matches trustedOrigins.
 */
export function assertTrustedCsrfOrigin(
  request: Request,
  trustedOrigins: ReadonlySet<string>,
): void {
  const secFetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "CSRF protection blocked cross-site mutation request.",
      false,
    );
  }

  const originHeader = request.headers.get("origin");
  if (originHeader !== null) {
    const normalizedOrigin = extractNormalizedOrigin(originHeader);
    if (normalizedOrigin === null || !trustedOrigins.has(normalizedOrigin)) {
      throw new DomainError(
        "NOT_AUTHORIZED",
        "CSRF protection rejected untrusted Origin header.",
        false,
      );
    }
    return;
  }

  const refererHeader = request.headers.get("referer");
  const normalizedReferer = extractNormalizedOrigin(refererHeader);
  if (normalizedReferer !== null && trustedOrigins.has(normalizedReferer)) {
    return;
  }

  throw new DomainError(
    "NOT_AUTHORIZED",
    "CSRF protection requires a trusted Origin or Referer header on mutating requests.",
    false,
  );
}
