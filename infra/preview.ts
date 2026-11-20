import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const workerBundle = resolve(repoRoot, "dist", "worker", "index.js");
const clientIndex = resolve(repoRoot, "dist", "client", "index.html");

if (!existsSync(workerBundle)) {
  throw new Error(
    `Missing built worker bundle at ${workerBundle}. Run "bun run build:worker" first.`,
  );
}

if (!existsSync(clientIndex)) {
  throw new Error(`Missing built client assets at ${clientIndex}. Run "bun run build" first.`);
}

const hasCloudflareToken =
  typeof process.env["CLOUDFLARE_API_TOKEN"] === "string" &&
  process.env["CLOUDFLARE_API_TOKEN"].trim() !== "";
const hasPulumiBackend =
  (typeof process.env["PULUMI_ACCESS_TOKEN"] === "string" &&
    process.env["PULUMI_ACCESS_TOKEN"].trim() !== "") ||
  (typeof process.env["PULUMI_BACKEND_URL"] === "string" &&
    process.env["PULUMI_BACKEND_URL"].trim() !== "");

const pulumiBin = Bun.which("pulumi");

if (pulumiBin !== null && hasCloudflareToken && hasPulumiBackend) {
  const stack = process.env["PULUMI_STACK"] ?? "staging";
  const result = Bun.spawnSync(
    [
      pulumiBin,
      "preview",
      "--cwd",
      resolve(repoRoot, "infra"),
      "--stack",
      stack,
      "--non-interactive",
    ],
    {
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  process.exit(result.exitCode);
}

// Offline / unauthenticated CI fallback: verify Pulumi program bundles cleanly with Bun
const bundleCheck = await Bun.build({
  entrypoints: [resolve(repoRoot, "infra", "index.ts")],
  target: "bun",
  external: ["@pulumi/pulumi", "@pulumi/cloudflare"],
});

if (!bundleCheck.success) {
  for (const log of bundleCheck.logs) {
    process.stderr.write(`${log.message}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  "infra/index.ts verified (offline mode: set CLOUDFLARE_API_TOKEN + PULUMI_ACCESS_TOKEN + pulumi CLI for live `pulumi preview`).\n",
);
