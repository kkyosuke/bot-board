import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  applyMigrationsWithRunner,
  computeMigrationChecksum,
  createCloudflareD1RestRunner,
  type D1MigrationSqlRunner,
  type DiskMigration,
  loadDiskMigrations,
  splitSqlStatements,
} from "../../../infra/migrate-d1";

function createSqliteRunner(sqlite: Database): D1MigrationSqlRunner {
  return {
    query(sql, params = []) {
      const stmt = sqlite.query(sql);
      if (stmt.columnNames.length === 0) {
        stmt.run(...params);
        return Promise.resolve([]);
      }
      const rows: unknown[] = stmt.all(...params);
      const records: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (row !== null && typeof row === "object" && !Array.isArray(row)) {
          records.push(Object.fromEntries(Object.entries(row)));
        }
      }
      return Promise.resolve(records);
    },
  };
}

describe("Cloudflare D1 remote migration runner (infra/migrate-d1.ts, B3)", () => {
  test("splitSqlStatements preserves quoted semicolons and strips line & block comments", () => {
    const sql = [
      "-- leading comment; ignore",
      "CREATE TABLE t1 (id TEXT PRIMARY KEY, note TEXT DEFAULT 'a;b''c');",
      "/* block comment ; still ignored */",
      'CREATE INDEX "idx;1" ON t1 (id);',
      "   -- trailing comment only",
    ].join("\n");

    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("DEFAULT 'a;b''c'");
    expect(statements[1]).toContain('CREATE INDEX "idx;1"');
  });

  test("applies real disk migrations idempotently, supports dry-run, and rejects checksum drift", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const runner = createSqliteRunner(sqlite);
    const migrations = loadDiskMigrations(
      resolve(import.meta.dirname, "..", "..", "..", "src", "db", "migrations"),
    );
    expect(migrations.length).toBeGreaterThanOrEqual(1);

    // 1) Dry-run reports pending without creating domain tables
    const dryReport = await applyMigrationsWithRunner(migrations, runner, {
      dryRun: true,
      nowMs: 1_700_000_000_000,
    });
    expect(dryReport.pendingDryRun).toEqual(migrations.map((m) => m.id));
    expect(dryReport.applied).toEqual([]);

    // 2) First apply creates all tables and records _schema_migrations
    const firstReport = await applyMigrationsWithRunner(migrations, runner, {
      nowMs: 1_700_000_000_100,
    });
    expect(firstReport.applied).toEqual(migrations.map((m) => m.id));
    expect(firstReport.alreadyApplied).toEqual([]);

    // Verify core tables exist (workspaces, tasks, decision_cards, user, jwks)
    const tableRows = await runner.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
    );
    const tableNames = tableRows.map((r) => String(r["name"]));
    expect(tableNames).toContain("workspaces");
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("decision_cards");
    expect(tableNames).toContain("user");
    expect(tableNames).toContain("jwks");
    expect(tableNames).toContain("_schema_migrations");

    // 3) Re-run is a 100% idempotent no-op
    const secondReport = await applyMigrationsWithRunner(migrations, runner, {
      nowMs: 1_700_000_000_200,
    });
    expect(secondReport.applied).toEqual([]);
    expect(secondReport.alreadyApplied).toEqual(migrations.map((m) => m.id));

    // 4) Checksum drift on an already-applied migration fails fast
    const tampered: DiskMigration[] = migrations.map((m, idx) =>
      idx === 0
        ? { ...m, sql: `${m.sql}\n-- modified`, checksum: computeMigrationChecksum(`${m.sql}x`) }
        : m,
    );
    let driftError: unknown = null;
    try {
      await applyMigrationsWithRunner(tampered, runner);
    } catch (err) {
      driftError = err;
    }
    expect(driftError).toBeInstanceOf(Error);
    expect(driftError instanceof Error ? driftError.message : "").toContain(
      "Migration checksum drift",
    );
    sqlite.close();
  });

  test("createCloudflareD1RestRunner sends Bearer auth to D1 REST API and never leaks apiToken on error", async () => {
    const secretToken = "cf_secret_token_never_leak_999";
    const calls: { readonly url: string; readonly auth: string | null; readonly body: string }[] =
      [];

    const runner = createCloudflareD1RestRunner({
      accountId: "acc-123",
      databaseId: "db-456",
      apiToken: secretToken,
      fetchImpl: (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          auth: headers.get("Authorization"),
          body: typeof init?.body === "string" ? init.body : "",
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: [{ success: true, results: [{ id: "0001_initial", checksum: "abc" }] }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
    });

    const rows = await runner.query("SELECT id, checksum FROM _schema_migrations");
    expect(rows).toEqual([{ id: "0001_initial", checksum: "abc" }]);
    expect(calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-123/d1/database/db-456/query",
    );
    expect(calls[0]?.auth).toBe(`Bearer ${secretToken}`);

    const failingRunner = createCloudflareD1RestRunner({
      accountId: "acc-123",
      databaseId: "db-456",
      apiToken: secretToken,
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: false, errors: [{ code: 7403, message: "Forbidden" }] }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          ),
        ),
    });

    let errMsg = "";
    try {
      await failingRunner.query("SELECT 1");
    } catch (err) {
      errMsg = err instanceof Error ? err.message : String(err);
    }
    expect(errMsg).toContain("HTTP 403");
    expect(errMsg).not.toContain(secretToken);
  });
});
