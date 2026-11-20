export const SPA_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains";

function isPublicCacheableDiscoveryPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/api/auth/.well-known/") ||
    pathname === "/api/auth/jwks"
  );
}

function isSensitiveNoStoreApiPath(pathname: string, method: string): boolean {
  if (method.toUpperCase() === "OPTIONS") {
    return false;
  }
  if (pathname.startsWith("/api/human/")) {
    return true;
  }
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    return true;
  }
  if (pathname.startsWith("/api/auth/") && !isPublicCacheableDiscoveryPath(pathname)) {
    return true;
  }
  return false;
}

function isSensitiveNoStoreSpaPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized === "/consent" || normalized === "/sign-in";
}

function isHttpsRequest(request: Request): boolean {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

function cloneResponseWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Applies baseline HTTP security headers across all API, Auth, Well-Known, and MCP responses
 * without mutating potentially immutable Response headers.
 */
export function applyApiSecurityHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const pathname = new URL(request.url).pathname;

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");

  if (isHttpsRequest(request)) {
    headers.set("Strict-Transport-Security", HSTS_HEADER_VALUE);
  }

  if (isSensitiveNoStoreApiPath(pathname, request.method)) {
    headers.set("Cache-Control", "no-store");
  }

  return cloneResponseWithHeaders(response, headers);
}

/**
 * Applies matching SPA / Static Asset security headers when requests are served through
 * Worker `env.ASSETS.fetch` (e.g. local fullstack dev/E2E or Worker-proxied asset tests),
 * mirroring `public/_headers` and `infra/index.ts` `STATIC_ASSETS_HEADERS`.
 */
export function applySpaAssetSecurityHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const pathname = new URL(request.url).pathname;

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", SPA_CONTENT_SECURITY_POLICY);

  if (isSensitiveNoStoreSpaPath(pathname)) {
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cache-Control", "no-store");
  } else if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "same-origin");
  }

  if (isHttpsRequest(request)) {
    headers.set("Strict-Transport-Security", HSTS_HEADER_VALUE);
  }

  return cloneResponseWithHeaders(response, headers);
}
