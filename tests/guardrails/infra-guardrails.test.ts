import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("Pulumi Cloudflare infrastructure guardrails (S1)", () => {
  test("infra/ defines Pulumi Bun runtime and all required Cloudflare resources & ASSETS binding (M6)", () => {
    const pulumiYamlPath = join(REPO_ROOT, "infra", "Pulumi.yaml");
    const infraIndexPath = join(REPO_ROOT, "infra", "index.ts");

    expect(existsSync(pulumiYamlPath)).toBe(true);
    expect(existsSync(infraIndexPath)).toBe(true);

    const pulumiYaml = readFileSync(pulumiYamlPath, "utf8");
    expect(pulumiYaml).toContain("runtime: bun");

    const infraIndex = readFileSync(infraIndexPath, "utf8");
    expect(infraIndex).toContain("cloudflare.D1Database");
    expect(infraIndex).toContain("cloudflare.WorkersScript");
    expect(infraIndex).toContain("cloudflare.Queue(");
    expect(infraIndex).toContain("cloudflare.QueueConsumer");
    expect(infraIndex).toContain("cloudflare.WorkersCronTrigger");
    expect(infraIndex).toContain("cloudflare.WorkersCustomDomain");
    expect(infraIndex).toContain("cloudflare.WorkersRoute");
    expect(infraIndex).toContain('type: "assets"');
    expect(infraIndex).toContain('name: "ASSETS"');
    expect(infraIndex).toContain("assertClientAssetsExist");
    expect(infraIndex).toContain('notFoundHandling: "single-page-application"');
    expect(infraIndex).toContain('runWorkerFirst: ["/api/*", "/.well-known/*"]');
    expect(infraIndex).toContain('type: "ratelimit"');
    expect(infraIndex).toContain("rateLimitNamespaceId");
    expect(infraIndex).toContain("deliveryDelay: 5");
    expect(infraIndex).toContain("deadLetterQueue:");
  });

  test("Pulumi stack configs isolate rateLimitNamespaceId per environment and contain zero inline plaintext secrets (M6, Minor 5)", () => {
    const namespaceIds = new Set<string>();
    const secretKeys = [
      "betterAuthSecret",
      "githubClientId",
      "githubClientSecret",
      "xaiApiKey",
      "apiToken",
    ];
    const secretInlineValuePattern = new RegExp(
      `(?:^|:)(?:${secretKeys.join("|")})\\s*:\\s*\\S+`,
      "i",
    );

    for (const fileName of ["Pulumi.staging.yaml", "Pulumi.prod.yaml"]) {
      const fullPath = join(REPO_ROOT, "infra", fileName);
      expect(existsSync(fullPath)).toBe(true);
      const content = readFileSync(fullPath, "utf8");
      const activeLines = content.split(/\r?\n/).filter((line) => !line.trim().startsWith("#"));

      const nsLine = activeLines.find((line) => line.includes("rateLimitNamespaceId:"));
      expect(nsLine).toBeDefined();
      if (nsLine !== undefined) {
        const nsVal = nsLine
          .split("rateLimitNamespaceId:")[1]
          ?.trim()
          .replace(/^["']|["']$/g, "");
        expect(nsVal).toBeTruthy();
        if (nsVal !== undefined) {
          namespaceIds.add(nsVal);
        }
      }

      for (const line of activeLines) {
        expect(line).not.toMatch(secretInlineValuePattern);
      }
    }

    expect(namespaceIds.size).toBe(2);
  });
});
