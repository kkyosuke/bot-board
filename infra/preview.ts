import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const workerBundle = resolve(repoRoot, "dist", "worker", "index.js");
const clientIndex = resolve(repoRoot, "dist", "client", "index.html");
const infraOutFile = resolve(repoRoot, "dist", "infra", "index.mjs");

if (!existsSync(workerBundle)) {
  throw new Error(
    `Missing built worker bundle at ${workerBundle}. Run "bun run build:worker" first.`,
  );
}

if (!existsSync(clientIndex)) {
  throw new Error(`Missing built client assets at ${clientIndex}. Run "bun run build" first.`);
}

// Always compile the Node.js ESM Pulumi entrypoint (dist/infra/index.mjs) and verify syntax under real Node.js
const bundleCheck = await Bun.build({
  entrypoints: [resolve(repoRoot, "infra", "index.ts")],
  outdir: resolve(repoRoot, "dist", "infra"),
  naming: "index.mjs",
  target: "node",
  format: "esm",
  external: ["@pulumi/pulumi", "@pulumi/cloudflare"],
});

if (!bundleCheck.success) {
  for (const log of bundleCheck.logs) {
    process.stderr.write(`${log.message}\n`);
  }
  process.exit(1);
}

const nodeBin = Bun.which("node");
if (nodeBin !== null) {
  const syntaxCheck = Bun.spawnSync([nodeBin, "--check", infraOutFile], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (syntaxCheck.exitCode !== 0) {
    process.stderr.write(`Node.js syntax check failed for ${infraOutFile}.\n`);
    process.exit(syntaxCheck.exitCode);
  }
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

process.stdout.write(
  "✓ infra/index.ts compiled to dist/infra/index.mjs and verified under Node.js (offline mode: set CLOUDFLARE_API_TOKEN + PULUMI_ACCESS_TOKEN + pulumi CLI for live `pulumi preview`).\n",
);
