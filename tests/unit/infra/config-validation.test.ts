import { describe, expect, test } from "bun:test";

import {
  normalizeAndValidateCustomHostname,
  resolveAndValidateAuthInfraConfig,
} from "../../../infra/config-validation";

describe("Pulumi auth & custom hostname validation (infra/config-validation.ts, M2, Minor 6)", () => {
  test("normalizes uppercase hostnames and rejects schemes, paths, ports, userinfo, whitespace, and IP literals", () => {
    expect(normalizeAndValidateCustomHostname("  Board.Example.COM ")).toBe("board.example.com");

    const invalidHostnames = [
      "",
      "   ",
      "localhost",
      "https://board.example.com",
      "board.example.com/path",
      "user@board.example.com",
      "board.example.com:8443",
      "board.example.com?a=1",
      "board.example.com#frag",
      "bad host.example.com",
      "127.0.0.1",
      "[::1]",
      "-bad.example.com",
      "board..example.com",
    ];
    for (const invalid of invalidHostnames) {
      expect(() => normalizeAndValidateCustomHostname(invalid)).toThrow();
    }
  });

  test("auto-derives canonical https://<hostname> BETTER_AUTH_URL and lowercases uppercase CUSTOM_HOSTNAME cleanly", () => {
    const resolved = resolveAndValidateAuthInfraConfig({
      stack: "prod",
      hostname: "Bot-Board.Example.COM",
      zoneId: "zone_123",
      ownerEmail: "  Owner@Example.COM ",
    });

    expect(resolved.hostname).toBe("bot-board.example.com");
    expect(resolved.betterAuthUrl).toBe("https://bot-board.example.com");
    expect(resolved.trustedOrigins).toBe("https://bot-board.example.com");
    expect(resolved.publicUrl).toBe("https://bot-board.example.com");
    expect(resolved.ownerEmail).toBe("owner@example.com");
  });

  test("rejects malformed BETTER_AUTH_URL, non-https on staging/prod, userinfo, subpaths, query/hash, mismatched host, and custom port with hostname", () => {
    const base = {
      stack: "staging",
      ownerEmail: "owner@example.com",
    };

    expect(() => resolveAndValidateAuthInfraConfig({ ...base })).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({ ...base, betterAuthUrl: "https://" }),
    ).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({ ...base, betterAuthUrl: "http://staging.example.com" }),
    ).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({
        ...base,
        betterAuthUrl: "https://user:pass@staging.example.com",
      }),
    ).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({
        ...base,
        betterAuthUrl: "https://staging.example.com/subpath",
      }),
    ).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({
        ...base,
        betterAuthUrl: "https://staging.example.com/?x=1",
      }),
    ).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({
        stack: "prod",
        zoneId: "z1",
        hostname: "board.example.com",
        betterAuthUrl: "https://board.example.com:8443",
        ownerEmail: "owner@example.com",
      }),
    ).toThrow();
    expect(() =>
      resolveAndValidateAuthInfraConfig({
        stack: "prod",
        zoneId: "z1",
        hostname: "board.example.com",
        betterAuthUrl: "https://other.example.com",
        ownerEmail: "owner@example.com",
      }),
    ).toThrow();
  });

  test("validates OWNER_EMAIL without echoing secret input in thrown error message (Minor 6)", () => {
    const sensitiveBadInput = "SUPER_SECRET_MALFORMED_EMAIL_TOKEN";
    let caughtMessage = "";
    try {
      resolveAndValidateAuthInfraConfig({
        stack: "staging",
        betterAuthUrl: "https://staging.example.com",
        ownerEmail: sensitiveBadInput,
      });
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }
    expect(caughtMessage).toContain("ownerEmail");
    expect(caughtMessage).not.toContain(sensitiveBadInput);
    expect(caughtMessage).not.toContain(sensitiveBadInput.toLowerCase());
  });
});
