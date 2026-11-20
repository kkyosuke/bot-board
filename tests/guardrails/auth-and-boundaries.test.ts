import { describe, expect, test } from "bun:test";

import { assertModelTimeoutWithinLease } from "@/adapters";
import { verifyBotConnectionContext } from "@/auth/bot";
import { verifyOwnerSessionContext } from "@/auth/owner";
import { didParentMutationApply } from "@/db";
import { DomainError } from "@/domain";
import { authorizeHumanRoute } from "@/server/routes/human";
import { authorizeMcpToolCall } from "@/server/routes/mcp";
import { assertBotReadScope } from "@/services/bot";
import { assertOwnerWorkspaceAccess } from "@/services/human";
import { createLogger, redactSensitiveData } from "@/shared/logger";
import { authorizeWorkerStep, recordFinalizeQueueOutcome } from "@/worker";

describe("capability types and runtime authorization boundaries", () => {
  test("branded OwnerContext and VerifiedBotContext reject unbranded object literals at compile time", () => {
    const validOwner = verifyOwnerSessionContext({
      userId: "user-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });
    assertOwnerWorkspaceAccess(validOwner, "ws-1");

    const typeProof = (): void => {
      assertOwnerWorkspaceAccess(
        // @ts-expect-error -- plain object literal lacks OWNER_CONTEXT_BRAND
        { userId: "user-1", workspaceId: "ws-1", sessionId: "sess-1" },
        "ws-1",
      );

      assertBotReadScope(
        // @ts-expect-error -- plain object literal lacks VERIFIED_BOT_CONTEXT_BRAND
        {
          botConnectionId: "bot-1",
          workspaceId: "ws-1",
          channelType: "worker_bearer",
          status: "active",
          isWorkspacePaused: false,
          effectiveScopes: new Set(["tasks:read"]),
        },
        "ws-1",
        "tasks:read",
      );
    };

    expect(typeof typeProof).toBe("function");
    expect(validOwner.workspaceId).toBe("ws-1");
  });

  test("revoked BotConnection or empty workspaceOwnerUserId is immediately rejected (BOT-02)", () => {
    expect(() =>
      verifyBotConnectionContext({
        botConnectionId: "bot-1",
        workspaceId: "ws-1",
        workspaceOwnerUserId: "user-1",
        isWorkspacePaused: false,
        channelType: "mcp_oauth",
        status: "revoked",
        connectionOAuthClientId: "client-1",
        tokenClientId: "client-1",
        connectionScopes: ["tasks:read", "tasks:write"],
        tokenScopes: ["tasks:read", "tasks:write"],
        tokenSubjectUserId: "user-1",
      }),
    ).toThrow(DomainError);

    expect(() =>
      verifyBotConnectionContext({
        botConnectionId: "bot-1",
        workspaceId: "ws-1",
        workspaceOwnerUserId: "   ",
        isWorkspacePaused: false,
        channelType: "mcp_oauth",
        status: "active",
        connectionOAuthClientId: "client-1",
        tokenClientId: "client-1",
        connectionScopes: ["tasks:read"],
        tokenScopes: ["tasks:read"],
        tokenSubjectUserId: "   ",
      }),
    ).toThrow(DomainError);
  });

  test("OAuth BotConnection enforces oauth_client_id match, scope intersection, and immutable scope set (BOT-02)", () => {
    expect(() =>
      authorizeMcpToolCall(
        {
          botConnectionId: "bot-1",
          workspaceId: "ws-1",
          workspaceOwnerUserId: "user-1",
          isWorkspacePaused: false,
          channelType: "mcp_oauth",
          status: "active",
          connectionOAuthClientId: "client-readonly",
          tokenClientId: "client-writer",
          connectionScopes: ["tasks:read"],
          tokenScopes: ["tasks:read"],
          tokenSubjectUserId: "user-1",
        },
        "tasks:read",
        "read",
      ),
    ).toThrow("OAuth client_id mismatch.");

    const ctx = authorizeMcpToolCall(
      {
        botConnectionId: "bot-1",
        workspaceId: "ws-1",
        workspaceOwnerUserId: "user-1",
        isWorkspacePaused: false,
        channelType: "mcp_oauth",
        status: "active",
        connectionOAuthClientId: "client-1",
        tokenClientId: "client-1",
        connectionScopes: ["tasks:read"],
        tokenScopes: ["tasks:read", "tasks:write"],
        tokenSubjectUserId: "user-1",
      },
      "tasks:read",
      "read",
    );

    expect(ctx.effectiveScopes.has("tasks:read")).toBe(true);
    expect(ctx.effectiveScopes.has("tasks:write")).toBe(false);

    expect(() => {
      Set.prototype.add.call(ctx.effectiveScopes, "tasks:write");
    }).toThrow(TypeError);
    expect(ctx.effectiveScopes.has("tasks:write")).toBe(false);
  });

  test("paused BotConnection or paused Workspace blocks writes while permitting authorized reads", () => {
    const pausedBotRecord = {
      botConnectionId: "bot-2",
      workspaceId: "ws-1",
      workspaceOwnerUserId: "user-1",
      isWorkspacePaused: false,
      channelType: "worker_bearer" as const,
      status: "paused" as const,
      connectionScopes: ["tasks:read", "tasks:write"] as const,
    };

    const readCtx = authorizeMcpToolCall(pausedBotRecord, "tasks:read", "read");
    expect(readCtx.status).toBe("paused");
    expect(() => authorizeMcpToolCall(pausedBotRecord, "tasks:write", "write")).toThrow(
      DomainError,
    );

    const pausedWorkspaceRecord = {
      ...pausedBotRecord,
      status: "active" as const,
      isWorkspacePaused: true,
    };
    expect(() => authorizeMcpToolCall(pausedWorkspaceRecord, "tasks:write", "write")).toThrow(
      "Workspace is currently paused.",
    );
  });

  test("Owner route authorization rejects cross-workspace access", () => {
    expect(() =>
      authorizeHumanRoute(
        { userId: "user-1", workspaceId: "ws-1", sessionId: "sess-1" },
        "ws-other",
      ),
    ).toThrow(DomainError);
  });

  test("Worker and Adapter guards enforce timeout < WorkLease TTL and parentChanges === 1", () => {
    const workerCtx = authorizeWorkerStep(
      {
        botConnectionId: "bot-1",
        workspaceId: "ws-1",
        workspaceOwnerUserId: "user-1",
        isWorkspacePaused: false,
        channelType: "worker_bearer",
        status: "active",
        connectionScopes: ["tasks:write"],
      },
      "tasks:write",
      {
        timeoutMs: 15_000,
        leaseRemainingMs: 30_000,
      },
    );

    expect(workerCtx.botConnectionId).toBe("bot-1");
    expect(() =>
      assertModelTimeoutWithinLease({ timeoutMs: 30_000, leaseRemainingMs: 30_000 }),
    ).toThrow(DomainError);

    expect(didParentMutationApply(0).applied).toBe(false);
    expect(recordFinalizeQueueOutcome(1).outcome.applied).toBe(true);
  });

  test("logger redacts privateKey, colon Bearer tokens, event strings, Errors, Sets, Headers, BigInt, and cycles", () => {
    const cyclic: Record<string, unknown> = { label: "node" };
    cyclic["self"] = cyclic;

    const headers = new Headers({
      Authorization: "Bearer id123:super-secret-value",
      "X-Request-Id": "req-1",
    });

    const domainErr = new DomainError(
      "NOT_AUTHORIZED",
      "Failed with Bearer client_99:secret_token_xyz",
      false,
    );

    const sanitized = redactSensitiveData({
      workspaceId: "ws-1",
      leaseToken: "lease-secret-123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      rawPem: "key: -----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----",
      colonBearer: "Authorization: Bearer id123:supersecret",
      bigCounter: 42n,
      scopes: new Set(["tasks:read"]),
      timestamp: new Date("2026-11-19T00:00:00.000Z"),
      headers,
      error: domainErr,
      cyclic,
    });

    expect(sanitized).toMatchObject({
      workspaceId: "ws-1",
      leaseToken: "[REDACTED]",
      privateKey: "[REDACTED]",
      rawPem: "key: [REDACTED_PRIVATE_KEY]",
      colonBearer: "Authorization: Bearer [REDACTED]",
      bigCounter: "42",
      scopes: ["tasks:read"],
      timestamp: "2026-11-19T00:00:00.000Z",
      headers: {
        authorization: "[REDACTED]",
        "x-request-id": "req-1",
      },
      error: {
        name: "DomainError",
        code: "NOT_AUTHORIZED",
        retryable: false,
        message: "Failed with Bearer [REDACTED]",
      },
      cyclic: {
        label: "node",
        self: "[Circular]",
      },
    });

    const logger = createLogger("auth-test");
    expect(() => logger.info("Handled header Bearer tok:123", { cyclic, count: 9n })).not.toThrow();
  });
});
