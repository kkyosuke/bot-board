import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { DomainError, type ErrorCode } from "@/domain";
import { createApp } from "@/server/app";

describe("Hono root app skeleton & DomainError HTTP mapping (S1)", () => {
  test("serves GET /api/health and returns structured 404 JSON for unknown routes", async () => {
    const app = createApp();

    const healthRes = await app.request("/api/health");
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true, service: "bot-board" });

    const missingRes = await app.request("/api/does-not-exist");
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toEqual({
      code: "NOT_FOUND",
      message: "Route not found: GET /api/does-not-exist",
      retryable: false,
    });
  });

  test("maps all DomainError codes, ZodError, Retry-After header, and HTTP 500 INTERNAL_ERROR without secret leakage (M4, M7)", async () => {
    const conflictCodes: readonly ErrorCode[] = [
      "IDEMPOTENCY_CONFLICT",
      "VERSION_CONFLICT",
      "LEASE_CONFLICT",
      "GROUP_LOCKED",
      "INVALID_TRANSITION",
      "STALE_PROPOSAL",
    ];

    const app = createApp({
      mountHumanRoutes(router) {
        router.get("/api/test/not-auth", () => {
          throw new DomainError("NOT_AUTHORIZED", "Forbidden", false);
        });
        for (const code of conflictCodes) {
          router.get(`/api/test/conflict/${code}`, () => {
            throw new DomainError(
              code,
              `Conflict ${code}`,
              code === "GROUP_LOCKED",
              code === "STALE_PROPOSAL" ? { replacementCardId: "card-new-1" } : undefined,
            );
          });
        }
        router.get("/api/test/rate-limit", () => {
          throw new DomainError("RATE_LIMITED", "Too many requests", true, {
            retryAfterSeconds: 30,
          });
        });
        router.get("/api/test/paused", () => {
          throw new DomainError("WORKSPACE_PAUSED", "Workspace paused", true);
        });
        router.get("/api/test/zod", () => {
          z.object({ count: z.number().int().positive() }).parse({ count: -1 });
          return new Response("ok");
        });
        router.get("/api/test/crash", () => {
          throw new Error("Unexpected secret Bearer top_secret_123");
        });
      },
    });

    const authRes = await app.request("/api/test/not-auth");
    expect(authRes.status).toBe(403);
    expect(await authRes.json()).toEqual({
      code: "NOT_AUTHORIZED",
      message: "Forbidden",
      retryable: false,
    });

    for (const code of conflictCodes) {
      const res = await app.request(`/api/test/conflict/${code}`);
      expect(res.status).toBe(409);
      const body: unknown = await res.json();
      expect(body).toMatchObject({
        code,
        retryable: code === "GROUP_LOCKED",
      });
      if (code === "STALE_PROPOSAL") {
        expect(body).toMatchObject({ details: { replacementCardId: "card-new-1" } });
      }
    }

    const rateRes = await app.request("/api/test/rate-limit");
    expect(rateRes.status).toBe(429);
    expect(rateRes.headers.get("Retry-After")).toBe("30");
    expect(await rateRes.json()).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });

    const pausedRes = await app.request("/api/test/paused");
    expect(pausedRes.status).toBe(423);

    const zodRes = await app.request("/api/test/zod");
    expect(zodRes.status).toBe(400);
    expect(await zodRes.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      retryable: false,
    });

    const crashRes = await app.request("/api/test/crash");
    expect(crashRes.status).toBe(500);
    const crashBody: unknown = await crashRes.json();
    expect(crashBody).toEqual({
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
      retryable: true,
    });
    expect(JSON.stringify(crashBody)).not.toContain("top_secret_123");
  });
});
