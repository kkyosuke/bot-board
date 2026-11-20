import { Database, type SQLQueryBindings } from "bun:sqlite";

import { type AppDatabase, createDrizzleFromExecutor } from "./d1";
import {
  createEmptyGetQueryResult,
  type RawSqlStatement,
  type SqlExecutor,
  type SqlParam,
  type SqlQueryResult,
} from "./guarded-batch";
import { MIGRATIONS } from "./migrations";

export interface SqliteAppDatabase extends AppDatabase {
  readonly sqlite: Database;
  applyMigrations(): Promise<void>;
  close(): void;
}

function toSqliteBindings(params: readonly SqlParam[]): SQLQueryBindings[] {
  const bindings: SQLQueryBindings[] = [];
  for (const param of params) {
    if (typeof param === "boolean") {
      bindings.push(param ? 1 : 0);
    } else {
      bindings.push(param);
    }
  }
  return bindings;
}

function readSingleInteger(sqlite: Database, sql: string): number {
  const rows = sqlite.query(sql).values();
  const value = rows[0]?.[0];
  return typeof value === "number" ? value : 0;
}

export function createSqliteSqlExecutor(sqlite: Database): SqlExecutor {
  return {
    query(sql, params, method) {
      const bindings = toSqliteBindings(params);
      const stmt = sqlite.query(sql);

      if (method === "run") {
        const result = stmt.run(...bindings);
        const changes = result.changes;
        return Promise.resolve({
          rows: [],
          changes,
          meta: { changes },
        });
      }

      const rawRows = stmt.values(...bindings);
      if (method === "get") {
        const firstRow = rawRows[0];
        if (firstRow === undefined) {
          return Promise.resolve(createEmptyGetQueryResult());
        }
        return Promise.resolve({
          rows: firstRow,
          changes: 0,
          meta: { changes: 0 },
        });
      }

      return Promise.resolve({
        rows: rawRows,
        changes: 0,
        meta: { changes: 0 },
      });
    },

    batch(statements: readonly RawSqlStatement[]) {
      const executeBatch = sqlite.transaction((items: readonly RawSqlStatement[]) => {
        const results: SqlQueryResult[] = [];
        for (const item of items) {
          const bindings = toSqliteBindings(item.params ?? []);
          const stmt = sqlite.query(item.sql);
          if (stmt.columnNames.length === 0) {
            const runResult = stmt.run(...bindings);
            results.push({ rows: [], changes: runResult.changes });
          } else {
            const beforeTotal = readSingleInteger(sqlite, "SELECT total_changes()");
            const rows = stmt.values(...bindings);
            const afterTotal = readSingleInteger(sqlite, "SELECT total_changes()");
            const changes =
              afterTotal > beforeTotal ? readSingleInteger(sqlite, "SELECT changes()") : 0;
            results.push({ rows, changes });
          }
        }
        return results;
      });

      return Promise.resolve(executeBatch(statements));
    },

    exec(sql) {
      sqlite.exec(sql);
      return Promise.resolve();
    },
  };
}

export function createSqliteDatabase(filename = ":memory:"): SqliteAppDatabase {
  const sqlite = new Database(filename, { create: true, strict: false });
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  const executor = createSqliteSqlExecutor(sqlite);
  const orm = createDrizzleFromExecutor(executor);

  return {
    sqlite,
    orm,
    executor,
    async applyMigrations() {
      for (const migration of MIGRATIONS) {
        await executor.exec(migration.sql);
      }
    },
    close() {
      sqlite.close();
    },
  };
}
