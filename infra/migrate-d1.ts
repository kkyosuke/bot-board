import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

export interface DiskMigration {
  readonly id: string;
  readonly filePath: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface D1MigrationSqlRunner {
  query(
    sql: string,
    params?: readonly (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
}

export interface ApplyMigrationsOptions {
  readonly dryRun?: boolean;
  readonly nowMs?: number;
}

export interface ApplyMigrationsReport {
  readonly alreadyApplied: readonly string[];
  readonly applied: readonly string[];
  readonly pendingDryRun: readonly string[];
}

const CREATE_TRACKING_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS _schema_migrations (id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)";

const cloudflareD1QueryResponseSchema = z.object({
  success: z.boolean(),
  errors: z
    .array(
      z.object({
        code: z.number().optional(),
        message: z.string(),
      }),
    )
    .optional(),
  result: z
    .array(
      z.object({
        success: z.boolean().optional(),
        results: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
});

export function computeMigrationChecksum(sqlText: string): string {
  return createHash("sha256").update(sqlText, "utf8").digest("hex");
}

/**
 * Splits a SQL migration file into individual executable statements while preserving
 * single-quoted, double-quoted, and backtick literals and stripping SQL comments.
 */
export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = "";
  let idx = 0;

  while (idx < sqlText.length) {
    const ch = sqlText[idx];
    const next = sqlText[idx + 1];

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      idx += 1;
      while (idx < sqlText.length) {
        const inner = sqlText[idx];
        current += inner ?? "";
        idx += 1;
        if (inner === quote) {
          if (sqlText[idx] === quote) {
            current += quote;
            idx += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      const nl = sqlText.indexOf("\n", idx + 2);
      idx = nl === -1 ? sqlText.length : nl + 1;
      current += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = sqlText.indexOf("*/", idx + 2);
      idx = end === -1 ? sqlText.length : end + 2;
      current += " ";
      continue;
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed !== "") {
        statements.push(trimmed);
      }
      current = "";
      idx += 1;
      continue;
    }

    current += ch ?? "";
    idx += 1;
  }

  const tail = current.trim();
  if (tail !== "") {
    statements.push(tail);
  }
  return statements;
}

export function loadDiskMigrations(migrationsDir: string): readonly DiskMigration[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  return files.map((fileName) => {
    const filePath = resolve(migrationsDir, fileName);
    const sql = readFileSync(filePath, "utf8");
    const id = fileName.replace(/\.sql$/i, "");
    return {
      id,
      filePath,
      sql,
      checksum: computeMigrationChecksum(sql),
    };
  });
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createCloudflareD1RestRunner(config: {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: FetchLike;
}): D1MigrationSqlRunner {
  const accountId = config.accountId.trim();
  const databaseId = config.databaseId.trim();
  const apiToken = config.apiToken.trim();
  const apiBase = (config.apiBaseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
  const fetchFn = config.fetchImpl ?? fetch;

  if (accountId === "" || databaseId === "" || apiToken === "") {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN are required for remote D1 migration.",
    );
  }

  const endpoint = `${apiBase}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  return {
    async query(sql, params = []) {
      const res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          sql,
          params,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const rawText = await res.text();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        throw new Error(`Cloudflare D1 API returned non-JSON response (HTTP ${res.status}).`);
      }

      const parsed = cloudflareD1QueryResponseSchema.safeParse(parsedJson);
      if (!res.ok || !parsed.success || !parsed.data.success) {
        const errorDetails = parsed.success
          ? (parsed.data.errors ?? []).map((e) => e.message).join("; ")
          : "unexpected response envelope";
        throw new Error(
          `Cloudflare D1 API query failed (HTTP ${res.status}): ${errorDetails || "unknown error"}`,
        );
      }

      const firstResult = parsed.data.result?.[0];
      if (firstResult?.success === false) {
        throw new Error("Cloudflare D1 statement execution reported success=false.");
      }
      return firstResult?.results ?? [];
    },
  };
}

export async function applyMigrationsWithRunner(
  migrations: readonly DiskMigration[],
  runner: D1MigrationSqlRunner,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsReport> {
  const dryRun = options.dryRun === true;
  const nowMs = options.nowMs ?? Date.now();

  await runner.query(CREATE_TRACKING_TABLE_SQL);
  const existingRows = await runner.query(
    "SELECT id, checksum FROM _schema_migrations ORDER BY id ASC",
  );

  const appliedMap = new Map<string, string>();
  for (const row of existingRows) {
    const idVal = row["id"];
    const checksumVal = row["checksum"];
    if (typeof idVal === "string" && typeof checksumVal === "string") {
      appliedMap.set(idVal, checksumVal);
    }
  }

  const alreadyApplied: string[] = [];
  const applied: string[] = [];
  const pendingDryRun: string[] = [];

  for (const migration of migrations) {
    const existingChecksum = appliedMap.get(migration.id);
    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `Migration checksum drift detected for "${migration.id}" (remote=${existingChecksum}, local=${migration.checksum}). Never edit an already-applied migration.`,
        );
      }
      alreadyApplied.push(migration.id);
      continue;
    }

    const statements = splitSqlStatements(migration.sql);
    if (statements.length === 0) {
      throw new Error(`Migration "${migration.id}" contains zero executable SQL statements.`);
    }

    if (dryRun) {
      pendingDryRun.push(migration.id);
      continue;
    }

    for (const stmt of statements) {
      await runner.query(stmt);
    }
    await runner.query(
      "INSERT INTO _schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
      [migration.id, migration.checksum, nowMs],
    );
    applied.push(migration.id);
  }

  return {
    alreadyApplied,
    applied,
    pendingDryRun,
  };
}

function readCliFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

function resolveDatabaseIdFromPulumiStack(repoRoot: string, stack: string): string {
  const pulumiBin = Bun.which("pulumi");
  if (pulumiBin === null) {
    throw new Error("pulumi CLI not found; set CLOUDFLARE_D1_DATABASE_ID explicitly.");
  }
  const proc = Bun.spawnSync(
    [
      pulumiBin,
      "stack",
      "output",
      "d1DatabaseUuid",
      "--cwd",
      resolve(repoRoot, "infra"),
      "--stack",
      stack,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to read d1DatabaseUuid from Pulumi stack "${stack}": ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim();
}

function resolveAccountIdFromPulumiStack(repoRoot: string, stack: string): string {
  const pulumiBin = Bun.which("pulumi");
  if (pulumiBin === null) {
    throw new Error("pulumi CLI not found; set CLOUDFLARE_ACCOUNT_ID explicitly.");
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
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `Failed to read bot-board:accountId from Pulumi stack "${stack}": ${proc.stderr.toString().trim()}`,
    );
  }
  return proc.stdout.toString().trim();
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const stackArg = readCliFlag(args, "--stack");
  const repoRoot = resolve(import.meta.dirname, "..");
  const migrationsDir = resolve(repoRoot, "src", "db", "migrations");
  const migrations = loadDiskMigrations(migrationsDir);

  const explicitAccountId = process.env["CLOUDFLARE_ACCOUNT_ID"]?.trim() ?? "";
  const accountId =
    explicitAccountId !== ""
      ? explicitAccountId
      : stackArg !== undefined
        ? resolveAccountIdFromPulumiStack(repoRoot, stackArg)
        : "";
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"]?.trim() ?? "";
  const explicitDbId = process.env["CLOUDFLARE_D1_DATABASE_ID"]?.trim() ?? "";
  const databaseId =
    explicitDbId !== ""
      ? explicitDbId
      : stackArg !== undefined
        ? resolveDatabaseIdFromPulumiStack(repoRoot, stackArg)
        : "";

  const runner = createCloudflareD1RestRunner({
    accountId,
    databaseId,
    apiToken,
  });

  const report = await applyMigrationsWithRunner(migrations, runner, { dryRun });
  process.stdout.write(
    `✓ D1 migration check complete (alreadyApplied=${report.alreadyApplied.length}, applied=${report.applied.length}, pendingDryRun=${report.pendingDryRun.length})\n`,
  );
}

if (import.meta.main) {
  await runCli();
}
