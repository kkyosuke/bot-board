import { type BetterAuthConfig, parseTrustedOrigins } from "@/auth/better-auth";
import { createLazyAuthAndOwnerFromD1 } from "@/auth/owner";
import { createApp } from "@/server/app";
import { type RequestRateLimiter } from "@/server/rate-limit";
import { mountAuthRoutes } from "@/server/routes/auth";
import { mountHumanRoutes } from "@/server/routes/human";
import { type McpBotServicePort, mountMcpRoutes } from "@/server/routes/mcp";
import { createHumanServicePortFromD1 } from "@/services/human";
import {
  type BotWorkQueueProducer,
  type DecisionFinalizeQueueProducer,
} from "@/services/system/queues";

export type RuntimeD1Binding = Parameters<typeof createLazyAuthAndOwnerFromD1>[0];

export interface HttpRuntimeConfig {
  readonly db: RuntimeD1Binding;
  readonly getMcpPort: () => McpBotServicePort;
  readonly finalizeQueue: DecisionFinalizeQueueProducer;
  readonly botWorkQueue: BotWorkQueueProducer;
  readonly rateLimiter?: RequestRateLimiter;
  readonly betterAuthSecret?: string;
  readonly betterAuthUrl?: string;
  readonly trustedOrigins?: string;
  readonly ownerEmail?: string;
  readonly enableMcpOAuth?: boolean;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly now?: () => number;
}

export async function handleWorkerHttpRequest(
  request: Request,
  config: HttpRuntimeConfig,
): Promise<Response> {
  // M1: Fail closed when BETTER_AUTH_URL is missing/invalid; NEVER trust attacker-controlled request.url origin
  const explicitBaseUrl = config.betterAuthUrl?.trim() ?? "";
  const trustedOrigins =
    explicitBaseUrl !== "" ? parseTrustedOrigins(explicitBaseUrl, config.trustedOrigins) : [];

  const authConfigured =
    explicitBaseUrl !== "" &&
    trustedOrigins.length > 0 &&
    config.betterAuthSecret !== undefined &&
    config.betterAuthSecret.trim().length >= 16;

  const authConfig: BetterAuthConfig | null = authConfigured
    ? {
        baseUrl: explicitBaseUrl,
        secret: config.betterAuthSecret,
        trustedOrigins,
        enableMcpOAuth: config.enableMcpOAuth ?? true,
        ...(config.ownerEmail !== undefined ? { ownerEmail: config.ownerEmail } : {}),
        ...(config.waitUntil !== undefined ? { waitUntil: config.waitUntil } : {}),
        ...(config.now !== undefined ? { now: config.now } : {}),
      }
    : null;

  // M4: Share a single request-scoped lazy BetterAuth+D1 pair across Auth and Human routes (zero overhead on /api/health or /api/mcp)
  const lazyAuthAndOwner =
    authConfig !== null ? createLazyAuthAndOwnerFromD1(config.db, authConfig) : null;

  const pathname = new URL(request.url).pathname;
  const isMcpPath = pathname === "/api/mcp" || pathname.startsWith("/api/mcp/");

  const app = createApp({
    ...(lazyAuthAndOwner !== null
      ? {
          mountAuthRoutes(honoApp) {
            mountAuthRoutes(honoApp, {
              auth: lazyAuthAndOwner.auth,
              ...(config.rateLimiter !== undefined ? { rateLimiter: config.rateLimiter } : {}),
            });
          },
          mountHumanRoutes(honoApp) {
            const humanPort = createHumanServicePortFromD1(config.db, {
              finalizeQueue: config.finalizeQueue,
              botWorkQueue: config.botWorkQueue,
              ...(config.now !== undefined ? { now: config.now } : {}),
            });
            mountHumanRoutes(honoApp, {
              port: humanPort,
              authenticateOwner: lazyAuthAndOwner.authenticateOwner,
              trustedOrigins,
              ...(config.rateLimiter !== undefined ? { rateLimiter: config.rateLimiter } : {}),
            });
          },
        }
      : {}),
    ...(isMcpPath
      ? {
          mountMcpRoutes(honoApp) {
            mountMcpRoutes(honoApp, {
              port: config.getMcpPort(),
              ...(config.rateLimiter !== undefined ? { rateLimiter: config.rateLimiter } : {}),
              ...(explicitBaseUrl !== "" ? { publicBaseUrl: explicitBaseUrl } : {}),
            });
          },
        }
      : {}),
  });

  return await app.fetch(request);
}
