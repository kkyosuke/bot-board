import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("Pulumi Cloudflare infrastructure & Worker bundle guardrails (S1, Deploy Readiness)", () => {
  test("infra/ defines valid Pulumi Node.js + Bun package manager runtime, hardened Cloudflare resources, and zero Bun-only import.meta.dir (B1, B2, M2)", () => {
    const pulumiYamlPath = join(REPO_ROOT, "infra", "Pulumi.yaml");
    const infraIndexPath = join(REPO_ROOT, "infra", "index.ts");

    expect(existsSync(pulumiYamlPath)).toBe(true);
    expect(existsSync(infraIndexPath)).toBe(true);

    const pulumiYaml = readFileSync(pulumiYamlPath, "utf8");
    expect(pulumiYaml).toContain("name: nodejs");
    expect(pulumiYaml).toContain("packagemanager: bun");
    expect(pulumiYaml).toContain("typescript: false");
    expect(pulumiYaml).toContain("main: ../dist/infra/index.mjs");
    expect(pulumiYaml).not.toMatch(/^\s*runtime:\s*bun\s*$/m);

    const infraIndex = readFileSync(infraIndexPath, "utf8");
    expect(infraIndex).not.toContain("import.meta.dir.");
    expect(infraIndex).not.toMatch(/import\.meta\.dir\b/);
    expect(infraIndex).toContain("import.meta.dirname");

    expect(infraIndex).toContain("cloudflare.D1Database");
    expect(infraIndex).toContain("protect: isProd");
    expect(infraIndex).toContain("cloudflare.WorkersScript");
    expect(infraIndex).toContain("observability:");
    expect(infraIndex).toContain("cloudflare.Queue(");
    expect(infraIndex).toContain("cloudflare.QueueConsumer");
    expect(infraIndex).toContain("maxConcurrency:");
    expect(infraIndex).toContain("cloudflare.WorkersCronTrigger");
    expect(infraIndex).toContain("cloudflare.WorkersScriptSubdomain");
    expect(infraIndex).toContain("cloudflare.WorkersCustomDomain");
    expect(infraIndex).toContain("cloudflare.WorkersRoute");
    expect(infraIndex).toContain('type: "assets"');
    expect(infraIndex).toContain('name: "ASSETS"');
    expect(infraIndex).toContain("assertClientAssetsExist");
    expect(infraIndex).toContain('notFoundHandling: "single-page-application"');
    expect(infraIndex).toContain('runWorkerFirst: ["/api/*", "/.well-known/*"]');
    expect(infraIndex).toContain("headers: STATIC_ASSETS_HEADERS");
    expect(infraIndex).toContain("X-Frame-Options: DENY");
    expect(infraIndex).toContain("frame-ancestors 'none'");
    expect(infraIndex).toContain("X-Content-Type-Options: nosniff");
    expect(infraIndex).toContain('type: "ratelimit"');
    expect(infraIndex).toContain("rateLimitNamespaceId");
    expect(infraIndex).toContain("RATE_LIMIT_PERIOD_SECONDS");
    expect(infraIndex).toContain("WORKER_LLM_PROVIDER");
    expect(infraIndex).toContain("XAI_MODEL");
    expect(infraIndex).toContain("XAI_API_URL");
    expect(infraIndex).toContain("GEMINI_API_KEY");
    expect(infraIndex).toContain("GEMINI_MODEL");
    expect(infraIndex).toContain("GEMINI_API_URL");
    expect(infraIndex).toContain("META_MODEL_API_KEY");
    expect(infraIndex).toContain("META_MODEL");
    expect(infraIndex).toContain("META_API_URL");
    expect(infraIndex).toContain("deliveryDelay: 5");
    expect(infraIndex).toContain("deadLetterQueue:");
    expect(infraIndex).toContain("export const d1DatabaseUuid");
    expect(infraIndex).toContain("export const publicUrl");

    // Verify public/_headers exists and stays in exact line-by-line parity with STATIC_ASSETS_HEADERS
    const publicHeadersPath = join(REPO_ROOT, "public", "_headers");
    expect(existsSync(publicHeadersPath)).toBe(true);
    const publicHeadersLines = readFileSync(publicHeadersPath, "utf8").trim().split(/\r?\n/);
    expect(publicHeadersLines.length).toBeGreaterThanOrEqual(10);
    for (const line of publicHeadersLines) {
      expect(infraIndex).toContain(JSON.stringify(line));
    }

    // Verify deploy env vars & secrets stay in 1:1 parity across infra/deploy.ts, deploy.yml, and docs/deploy-and-plugins.md
    const deployTs = readFileSync(join(REPO_ROOT, "infra", "deploy.ts"), "utf8");
    const deployYml = readFileSync(join(REPO_ROOT, ".github", "workflows", "deploy.yml"), "utf8");
    const runbookMd = readFileSync(join(REPO_ROOT, "docs", "deploy-and-plugins.md"), "utf8");

    for (const envVar of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "SMOKE_BOT_TOKEN"]) {
      expect(deployTs).toContain(envVar);
      expect(deployYml).toContain(`${envVar}:`);
      expect(runbookMd).toContain(envVar);
    }
    for (const pulumiSecret of [
      "PULUMI_ACCESS_TOKEN",
      "PULUMI_BACKEND_URL",
      "PULUMI_CONFIG_PASSPHRASE",
    ]) {
      expect(deployYml).toContain(`${pulumiSecret}:`);
      expect(runbookMd).toContain(pulumiSecret);
    }

    // Verify GitHub Secrets -> GitHub Actions -> Pulumi secret -> Cloudflare Worker secret_text parity
    expect(infraIndex).toContain("pulumi.secret(");
    const syncedWorkerSecrets = [
      "BETTER_AUTH_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "GEMINI_API_KEY",
      "XAI_API_KEY",
      "META_MODEL_API_KEY",
    ];
    const expectedSecretExpressions: Readonly<Record<string, string>> = {
      BETTER_AUTH_SECRET: "BETTER_AUTH_SECRET: ${{ secrets.BETTER_AUTH_SECRET }}",
      GITHUB_CLIENT_ID: "GITHUB_CLIENT_ID: ${{ secrets.GITHUB_CLIENT_ID }}",
      GITHUB_CLIENT_SECRET: "GITHUB_CLIENT_SECRET: ${{ secrets.GITHUB_CLIENT_SECRET }}",
      GEMINI_API_KEY:
        "GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY || secrets.GOOGLE_GEMINI_API_KEY }}",
      XAI_API_KEY: "XAI_API_KEY: ${{ secrets.XAI_API_KEY }}",
      META_MODEL_API_KEY: "META_MODEL_API_KEY: ${{ secrets.META_MODEL_API_KEY }}",
    };
    for (const secretName of syncedWorkerSecrets) {
      const expectedExpr = expectedSecretExpressions[secretName];
      expect(expectedExpr).toBeDefined();
      expect(infraIndex).toContain(`"${secretName}"`);
      if (expectedExpr !== undefined) {
        expect(deployYml).toContain(expectedExpr);
      }
      expect(deployYml).not.toContain(`vars.${secretName}`);
      expect(runbookMd).toContain(secretName);
    }
    expect(deployYml).toContain(
      "environment: ${{ inputs.stack == 'prod' && 'prd-deploy' || inputs.stack }}",
    );
    expect(runbookMd).toContain("prd-deploy");
    expect(runbookMd).toContain("GOOGLE_GEMINI_API_KEY");
    expect(deployYml).not.toContain("vars.GOOGLE_GEMINI_API_KEY");
    expect(deployYml).not.toContain("vars.CLOUDFLARE_API_TOKEN");
    expect(deployYml).not.toContain("vars.PULUMI_ACCESS_TOKEN");
    expect(deployYml).not.toContain("vars.PULUMI_BACKEND_URL");
    expect(deployYml).not.toContain("vars.PULUMI_CONFIG_PASSPHRASE");
    expect(deployYml).not.toContain("vars.AWS_ACCESS_KEY_ID");
    expect(deployYml).not.toContain("vars.AWS_SECRET_ACCESS_KEY");
    expect(deployYml).not.toContain("vars.SMOKE_BOT_TOKEN");
    expect(deployYml).toContain("AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}");
    expect(deployYml).toContain("AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}");
    expect(deployTs).toContain("buildPulumiCommandEnv");
    expect(deployTs).toContain("runPulumiLogin");
    expect(deployTs).not.toContain('["login", pulumiBackendUrl');
    expect(deployTs).not.toContain('"login", pulumiBackendUrl');
  });

  test("Pulumi stack configs isolate rateLimitNamespaceId, enforce safe workerCpuMsLimit (5000..300000ms), and contain zero inline plaintext secrets (B2, M2)", () => {
    const namespaceIds = new Set<string>();
    const secretKeys = [
      "betterAuthSecret",
      "githubClientId",
      "githubClientSecret",
      "xaiApiKey",
      "geminiApiKey",
      "metaModelApiKey",
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

      const cpuLine = activeLines.find((line) => line.includes("workerCpuMsLimit:"));
      expect(cpuLine).toBeDefined();
      if (cpuLine !== undefined) {
        const cpuMs = Number(
          cpuLine
            .split("workerCpuMsLimit:")[1]
            ?.trim()
            .replace(/^["']|["']$/g, ""),
        );
        expect(Number.isInteger(cpuMs)).toBe(true);
        expect(cpuMs).toBeGreaterThanOrEqual(5000);
        expect(cpuMs).toBeLessThanOrEqual(300_000);
      }

      for (const line of activeLines) {
        expect(line).not.toMatch(secretInlineValuePattern);
      }
    }

    expect(namespaceIds.size).toBe(2);
  });

  test("Cloudflare Worker bundle builds cleanly with workerd conditions, zero bun:/require()/AsyncLocalStoragePolyfill, and stays within size budget (M1)", async () => {
    const buildResult = await Bun.build({
      entrypoints: [join(REPO_ROOT, "src", "worker", "index.ts")],
      target: "node",
      conditions: ["workerd", "worker", "module", "browser"],
      format: "esm",
      minify: true,
    });
    expect(buildResult.success).toBe(true);
    const artifact = buildResult.outputs[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) {
      return;
    }

    const code = await artifact.text();
    const rawBytes = new TextEncoder().encode(code);
    const gzipBytes = Bun.gzipSync(rawBytes);

    expect(code).not.toContain("bun:");
    expect(code).not.toContain("AsyncLocalStoragePolyfill");
    expect(code).not.toMatch(/\brequire\s*\(\s*["']/);
    expect(code).toMatch(/export\s*\{[^}]*\bas\s+default\b|export\s+default\b/);
    expect(rawBytes.byteLength).toBeLessThan(2_000_000);
    expect(gzipBytes.byteLength).toBeLessThan(500_000);
  });
});
