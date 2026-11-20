import { resolve } from "node:path";

import { z } from "zod";

import {
  applyMigrationsWithRunner,
  createCloudflareD1RestRunner,
  loadDiskMigrations,
} from "./migrate-d1";
import { runLiveSmokeCheck } from "./smoke";

const stackOutputsSchema = z.object({
  d1DatabaseUuid: z.string().trim().min(1),
  publicUrl: z.string().url(),
});

function readCliFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

function runCommandOrThrow(cmd: readonly string[], cwd: string): void {
  const result = Bun.spawnSync([...cmd], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (exit ${result.exitCode}): ${cmd.join(" ")}`);
  }
}

function readPulumiOutputs(repoRoot: string, pulumiBin: string, stack: string) {
  const proc = Bun.spawnSync(
    [pulumiBin, "stack", "output", "--cwd", resolve(repoRoot, "infra"), "--stack", stack, "--json"],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to read Pulumi stack outputs for "${stack}": ${proc.stderr.toString().trim()}`,
    );
  }
  const raw: unknown = JSON.parse(proc.stdout.toString());
  const parsed = stackOutputsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Pulumi stack "${stack}" outputs missing required d1DatabaseUuid or publicUrl.`,
    );
  }
  return parsed.data;
}

function resolveCloudflareAccountId(repoRoot: string, pulumiBin: string, stack: string): string {
  const fromEnv = process.env["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "";
  if (fromEnv !== "") {
    return fromEnv;
  }
  const proc = Bun.spawnSync(
    [
      pulumiBin,
      "config",
      "get",
      "bot-board:accountId",
      "--cwd",
      resolve(repoRoot, "infra"),
      "--stack",
      stack,
    ],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const fromPulumi = proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
  if (fromPulumi !== "") {
    return fromPulumi;
  }
  throw new Error(
    `Missing Cloudflare Account ID: set CLOUDFLARE_ACCOUNT_ID or configure bot-board:accountId on Pulumi stack "${stack}".`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stack = readCliFlag(args, "--stack") ?? process.env["PULUMI_STACK"] ?? "staging";
  const skipSmoke = args.includes("--skip-smoke");

  if (stack !== "staging" && stack !== "prod") {
    throw new Error(`Unsupported deploy stack "${stack}" (expected "staging" or "prod").`);
  }

  const pulumiBin = Bun.which("pulumi");
  if (pulumiBin === null) {
    throw new Error(
      "pulumi CLI is required for deployment (https://www.pulumi.com/docs/install/).",
    );
  }

  const apiToken = process.env["CLOUDFLARE_API_TOKEN"]?.trim() ?? "";
  if (apiToken === "") {
    throw new Error("CLOUDFLARE_API_TOKEN must be set before running deploy.");
  }

  const repoRoot = resolve(import.meta.dirname, "..");

  process.stdout.write(`==> [1/4] Building client, worker, and Pulumi entrypoint (${stack})...\n`);
  runCommandOrThrow([process.execPath, "run", "build"], repoRoot);
  runCommandOrThrow([process.execPath, "run", "build:worker"], repoRoot);
  runCommandOrThrow([process.execPath, "run", "build:infra"], repoRoot);

  process.stdout.write(`==> [2/4] Deploying Cloudflare resources via Pulumi (${stack})...\n`);
  runCommandOrThrow(
    [
      pulumiBin,
      "up",
      "--cwd",
      resolve(repoRoot, "infra"),
      "--stack",
      stack,
      "--yes",
      "--non-interactive",
    ],
    repoRoot,
  );

  const outputs = readPulumiOutputs(repoRoot, pulumiBin, stack);
  const accountId = resolveCloudflareAccountId(repoRoot, pulumiBin, stack);

  process.stdout.write(`==> [3/4] Applying remote D1 migrations (${outputs.d1DatabaseUuid})...\n`);
  const migrations = loadDiskMigrations(resolve(repoRoot, "src", "db", "migrations"));
  const runner = createCloudflareD1RestRunner({
    accountId,
    databaseId: outputs.d1DatabaseUuid,
    apiToken,
  });
  const migReport = await applyMigrationsWithRunner(migrations, runner);
  process.stdout.write(
    `✓ D1 migrations ready (alreadyApplied=${migReport.alreadyApplied.length}, applied=${migReport.applied.length})\n`,
  );

  if (skipSmoke) {
    process.stdout.write("==> [4/4] Live smoke check skipped (--skip-smoke).\n");
    return;
  }

  process.stdout.write(
    `==> [4/4] Running post-deploy live smoke check (${outputs.publicUrl})...\n`,
  );
  const botToken = process.env["SMOKE_BOT_TOKEN"];
  const smokeReport = await runLiveSmokeCheck({
    baseUrl: outputs.publicUrl,
    ...(botToken !== undefined && botToken.trim() !== "" ? { botToken } : {}),
  });
  for (const item of smokeReport.checks) {
    process.stdout.write(`${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}\n`);
  }
  if (!smokeReport.ok) {
    throw new Error(`Post-deploy smoke check failed for ${outputs.publicUrl}.`);
  }

  process.stdout.write(`✓ Deployment to ${stack} (${outputs.publicUrl}) completed and verified.\n`);
}

if (import.meta.main) {
  await main();
}
