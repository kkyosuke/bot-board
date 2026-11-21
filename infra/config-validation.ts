const RFC_1123_FQDN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4_LITERAL_PATTERN = /^\d+(?:\.\d+){3}$/;
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAndValidateCustomHostname(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "" ||
    normalized.length > 253 ||
    normalized.includes("://") ||
    normalized.includes("/") ||
    normalized.includes("@") ||
    normalized.includes(":") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    /\s/.test(normalized) ||
    IPV4_LITERAL_PATTERN.test(normalized) ||
    !RFC_1123_FQDN_PATTERN.test(normalized)
  ) {
    throw new Error(
      `Invalid bot-board:hostname ("${raw}"): must be a bare FQDN (e.g. "bot-board.example.com") with no scheme, path, port, userinfo, or IP literal.`,
    );
  }
  return normalized;
}

export interface AuthInfraConfigInput {
  readonly stack: string;
  readonly hostname?: string | undefined;
  readonly routePattern?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly betterAuthUrl?: string | undefined;
  readonly trustedOrigins?: string | undefined;
  readonly ownerEmail?: string | undefined;
}

export interface ValidatedAuthInfraConfig {
  readonly hostname: string | undefined;
  readonly betterAuthUrl: string;
  readonly trustedOrigins: string;
  readonly ownerEmail: string;
  readonly publicUrl: string;
}

export function resolveAndValidateAuthInfraConfig(
  input: AuthInfraConfigInput,
): ValidatedAuthInfraConfig {
  const isProd = input.stack === "prod";
  const isDeployedEnv = input.stack === "staging" || isProd;

  const normalizedHostname =
    input.hostname !== undefined ? normalizeAndValidateCustomHostname(input.hostname) : undefined;

  const rawBetterAuthUrl =
    input.betterAuthUrl?.trim() ||
    (normalizedHostname !== undefined ? `https://${normalizedHostname}` : undefined);
  if (rawBetterAuthUrl === undefined || rawBetterAuthUrl === "") {
    throw new Error(
      'Missing required configuration: set Pulumi config "bot-board:betterAuthUrl" / env "BETTER_AUTH_URL" or set "bot-board:hostname" / env "CUSTOM_HOSTNAME".',
    );
  }

  let parsedAuthUrl: URL;
  try {
    parsedAuthUrl = new URL(rawBetterAuthUrl);
  } catch {
    throw new Error(
      `Invalid bot-board:betterAuthUrl ("${rawBetterAuthUrl}"): must be a valid HTTP(S) origin URL.`,
    );
  }

  if (parsedAuthUrl.protocol !== "https:" && parsedAuthUrl.protocol !== "http:") {
    throw new Error(
      `Invalid bot-board:betterAuthUrl ("${rawBetterAuthUrl}"): protocol must be https:// or http://.`,
    );
  }
  if (isDeployedEnv && parsedAuthUrl.protocol !== "https:") {
    throw new Error(
      `Invalid bot-board:betterAuthUrl ("${rawBetterAuthUrl}"): staging and prod stacks require an https:// URL.`,
    );
  }
  if (parsedAuthUrl.username !== "" || parsedAuthUrl.password !== "") {
    throw new Error("Invalid bot-board:betterAuthUrl: userinfo credentials are not permitted.");
  }
  if (
    (parsedAuthUrl.pathname !== "/" && parsedAuthUrl.pathname !== "") ||
    parsedAuthUrl.search !== "" ||
    parsedAuthUrl.hash !== ""
  ) {
    throw new Error(
      `Invalid bot-board:betterAuthUrl ("${rawBetterAuthUrl}"): must be a bare origin with no path, query, or fragment.`,
    );
  }
  if (normalizedHostname !== undefined) {
    if (parsedAuthUrl.hostname !== normalizedHostname) {
      throw new Error(
        `bot-board:hostname ("${normalizedHostname}") must match bot-board:betterAuthUrl host ("${parsedAuthUrl.hostname}").`,
      );
    }
    if (parsedAuthUrl.port !== "") {
      throw new Error(
        `bot-board:betterAuthUrl ("${rawBetterAuthUrl}") must not specify a custom port when bot-board:hostname is set.`,
      );
    }
  }

  const normalizedOwnerEmail = input.ownerEmail?.trim().toLowerCase() ?? "";
  if (normalizedOwnerEmail === "" || !BASIC_EMAIL_PATTERN.test(normalizedOwnerEmail)) {
    // Do not echo the raw/lowercased email value in error output (may be sourced from GitHub Secrets)
    throw new Error(
      'Invalid bot-board:ownerEmail (or env "OWNER_EMAIL"): must be a valid email address.',
    );
  }

  if (
    (normalizedHostname !== undefined || input.routePattern !== undefined) &&
    input.zoneId === undefined
  ) {
    throw new Error(
      "bot-board:zoneId is required whenever bot-board:hostname or bot-board:routePattern is set.",
    );
  }
  if (
    isProd &&
    (input.zoneId === undefined ||
      (normalizedHostname === undefined && input.routePattern === undefined))
  ) {
    throw new Error(
      "Production stack requires bot-board:zoneId plus either bot-board:hostname or bot-board:routePattern.",
    );
  }

  const canonicalBetterAuthUrl = parsedAuthUrl.origin;
  const trustedOrigins = input.trustedOrigins?.trim() || canonicalBetterAuthUrl;
  const publicUrl =
    normalizedHostname !== undefined ? `https://${normalizedHostname}` : canonicalBetterAuthUrl;

  return {
    hostname: normalizedHostname,
    betterAuthUrl: canonicalBetterAuthUrl,
    trustedOrigins,
    ownerEmail: normalizedOwnerEmail,
    publicUrl,
  };
}
