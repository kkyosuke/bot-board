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

const STRIP_WHEN_EMPTY_ENV_KEYS = [
  "PULUMI_CONFIG_PASSPHRASE",
  "PULUMI_CONFIG_PASSPHRASE_FILE",
  "PULUMI_ACCESS_TOKEN",
  "PULUMI_BACKEND_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

export function isSelfHostedPulumiBackend(rawUrl: string): boolean {
  const trimmed = rawUrl.trim().toLowerCase();
  if (trimmed === "") {
    return false;
  }
  return !trimmed.startsWith("https://") && !trimmed.startsWith("http://");
}

export function buildPulumiCommandEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const stripSet = new Set<string>(STRIP_WHEN_EMPTY_ENV_KEYS);

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) {
      continue;
    }
    if (stripSet.has(key) && value.trim() === "") {
      continue;
    }
    sanitized[key] = value;
  }

  // Mirror deploy.yml R2_* -> AWS_* fallback so local `bun run deploy` works identically with Cloudflare R2 credentials
  if (sanitized["AWS_ACCESS_KEY_ID"] === undefined && sanitized["R2_ACCESS_KEY_ID"] !== undefined) {
    sanitized["AWS_ACCESS_KEY_ID"] = sanitized["R2_ACCESS_KEY_ID"];
  }
  if (
    sanitized["AWS_SECRET_ACCESS_KEY"] === undefined &&
    sanitized["R2_SECRET_ACCESS_KEY"] !== undefined
  ) {
    sanitized["AWS_SECRET_ACCESS_KEY"] = sanitized["R2_SECRET_ACCESS_KEY"];
  }

  const backendUrl = sanitized["PULUMI_BACKEND_URL"]?.trim() ?? "";
  if (backendUrl !== "" && isSelfHostedPulumiBackend(backendUrl)) {
    const passphrase = sanitized["PULUMI_CONFIG_PASSPHRASE"]?.trim() ?? "";
    const passphraseFile = sanitized["PULUMI_CONFIG_PASSPHRASE_FILE"]?.trim() ?? "";
    if (passphrase === "" && passphraseFile === "") {
      throw new Error(
        "Refusing to deploy with a self-hosted PULUMI_BACKEND_URL without a non-empty PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE (prevents silent empty-passphrase secret encryption).",
      );
    }
  }

  return sanitized;
}

export function redactSecretFromText(rawText: string, secretValue: string): string {
  const trimmedSecret = secretValue.trim();
  let output = rawText;
  if (trimmedSecret !== "") {
    output = output.split(trimmedSecret).join("<REDACTED>");
  }
  return output.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, "<REDACTED_URL>");
}

export interface PulumiLoginSpawnResult {
  readonly exitCode: number;
  readonly stderrText: string;
}

export type PulumiLoginSpawner = (
  cmd: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
  },
) => PulumiLoginSpawnResult;

function defaultPulumiLoginSpawner(
  cmd: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
  },
): PulumiLoginSpawnResult {
  const proc = Bun.spawnSync([...cmd], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stderrText: proc.stderr.toString(),
  };
}

export function runPulumiLogin(
  pulumiBin: string,
  infraDir: string,
  pulumiEnv: Record<string, string>,
  spawner: PulumiLoginSpawner = defaultPulumiLoginSpawner,
): void {
  const backendUrl = pulumiEnv["PULUMI_BACKEND_URL"]?.trim() ?? "";
  if (backendUrl === "") {
    return;
  }
  // Never pass PULUMI_BACKEND_URL via argv or inherited stdio; Pulumi reads it from child env safely.
  const result = spawner([pulumiBin, "login", "--non-interactive"], {
    cwd: infraDir,
    env: pulumiEnv,
  });
  if (result.exitCode !== 0) {
    const safeDetail = redactSecretFromText(result.stderrText.trim(), backendUrl);
    throw new Error(
      `Command failed (exit ${result.exitCode}): pulumi login --non-interactive${safeDetail !== "" ? ` (${safeDetail})` : ""}`,
    );
  }
}

function readCliFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

function runCommandOrThrow(
  cmd: readonly string[],
  cwd: string,
  env?: Record<string, string>,
  safeLabel?: string,
): void {
  const result = Bun.spawnSync([...cmd], {
    cwd,
    ...(env !== undefined ? { env } : {}),
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (exit ${result.exitCode}): ${safeLabel ?? cmd.join(" ")}`);
  }
}

function readPulumiOutputs(
  repoRoot: string,
  pulumiBin: string,
  stack: string,
  pulumiEnv: Record<string, string>,
) {
  const proc = Bun.spawnSync(
    [
      pulumiBin,
      "stack",
      "output",
      "--cwd",
      resolve(repoRoot, "infra"),
      "--stack",
      stack,
      "--json",
      "--non-interactive",
    ],
    {
      cwd: repoRoot,
      env: pulumiEnv,
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

function resolveCloudflareAccountId(
  repoRoot: string,
  pulumiBin: string,
  stack: string,
  pulumiEnv: Record<string, string>,
): string {
  const fromEnv = pulumiEnv["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "";
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
      "--non-interactive",
    ],
    {
      cwd: repoRoot,
      env: pulumiEnv,
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

  const pulumiEnv = buildPulumiCommandEnv(process.env);
  const repoRoot = resolve(import.meta.dirname, "..");

  process.stdout.write(`==> [1/4] Building client, worker, and Pulumi entrypoint (${stack})...\n`);
  runCommandOrThrow([process.execPath, "run", "build"], repoRoot);
  runCommandOrThrow([process.execPath, "run", "build:worker"], repoRoot);
  runCommandOrThrow([process.execPath, "run", "build:infra"], repoRoot);

  const infraDir = resolve(repoRoot, "infra");
  if ((pulumiEnv["PULUMI_BACKEND_URL"]?.trim() ?? "") !== "") {
    process.stdout.write("==> [2/4] Logging into configured Pulumi backend...\n");
    runPulumiLogin(pulumiBin, infraDir, pulumiEnv);
  }

  process.stdout.write(`==> [2/4] Selecting/creating Pulumi stack (${stack}) and deploying...\n`);
  runCommandOrThrow(
    [pulumiBin, "stack", "select", "--create", stack, "--cwd", infraDir, "--non-interactive"],
    repoRoot,
    pulumiEnv,
  );
  runCommandOrThrow(
    [pulumiBin, "up", "--cwd", infraDir, "--stack", stack, "--yes", "--non-interactive"],
    repoRoot,
    pulumiEnv,
  );

  const outputs = readPulumiOutputs(repoRoot, pulumiBin, stack, pulumiEnv);
  const accountId = resolveCloudflareAccountId(repoRoot, pulumiBin, stack, pulumiEnv);

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
