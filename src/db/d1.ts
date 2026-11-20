import { type D1Database } from "@cloudflare/workers-types";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import {
  createEmptyGetQueryResult,
  type RawSqlStatement,
  type SqlExecutor,
  type SqlParam,
  type SqlQueryResult,
} from "./guarded-batch";
import { type AppSchema, schema } from "./schema";

export interface D1LikeMeta {
  readonly changes?: number;
}

export interface D1LikeRunResult {
  readonly meta?: D1LikeMeta;
}

export interface D1LikeBatchResult {
  readonly results?: readonly unknown[];
  readonly meta?: D1LikeMeta;
}

export interface D1LikePreparedStatement {
  bind(...values: unknown[]): D1LikePreparedStatement;
  run(): Promise<D1LikeRunResult>;
  raw(): Promise<unknown[][]>;
}

export interface D1LikeDatabase {
  prepare(query: string): D1LikePreparedStatement;
  batch(statements: D1LikePreparedStatement[]): Promise<readonly D1LikeBatchResult[]>;
  exec(query: string): Promise<unknown>;
}

export type AssertCloudflareD1Compatible = D1Database extends D1LikeDatabase ? true : never;

export interface AppDatabase {
  readonly orm: SqliteRemoteDatabase<AppSchema>;
  readonly executor: SqlExecutor;
}

type D1BindValue = string | number | null | Uint8Array;

function normalizeSqlParams(params: readonly unknown[]): SqlParam[] {
  const normalized: SqlParam[] = [];
  for (const param of params) {
    if (param === undefined || param === null) {
      normalized.push(null);
    } else if (typeof param === "boolean") {
      normalized.push(param ? 1 : 0);
    } else if (
      typeof param === "string" ||
      typeof param === "number" ||
      param instanceof Uint8Array
    ) {
      normalized.push(param);
    } else if (param instanceof Date) {
      normalized.push(param.getTime());
    } else if (typeof param === "bigint") {
      normalized.push(param.toString());
    } else {
      normalized.push(JSON.stringify(param));
    }
  }
  return normalized;
}

function toD1BindValues(params: readonly SqlParam[]): D1BindValue[] {
  const values: D1BindValue[] = [];
  for (const param of params) {
    if (typeof param === "boolean") {
      values.push(param ? 1 : 0);
    } else {
      values.push(param);
    }
  }
  return values;
}

export function createDrizzleFromExecutor(executor: SqlExecutor): SqliteRemoteDatabase<AppSchema> {
  return drizzle<AppSchema>(
    async (sql, params, method) => {
      return await executor.query(sql, normalizeSqlParams(params), method);
    },
    async (batchQueries) => {
      const statements: RawSqlStatement[] = batchQueries.map((item) => ({
        sql: item.sql,
        params: normalizeSqlParams(item.params),
      }));
      const batchResults = await executor.batch(statements);
      return batchResults.map((res, index) => {
        const method = batchQueries[index]?.method;
        if (method === "get") {
          const firstRow = res.rows[0];
          if (firstRow === undefined) {
            return createEmptyGetQueryResult();
          }
          return {
            rows: [...firstRow],
            changes: res.changes,
            meta: { changes: res.changes },
          };
        }
        if (method === "run") {
          return {
            rows: [],
            changes: res.changes,
            meta: { changes: res.changes },
          };
        }
        return {
          rows: res.rows.map((row) => [...row]),
          changes: res.changes,
          meta: { changes: res.changes },
        };
      });
    },
    { schema },
  );
}

/**
 * Cloudflare D1 executor.
 * Note: single queries use `bound.raw()` (positional arrays, safe for JOINs with duplicate column names).
 * D1 `batch()` returns row objects (`res.results`), so callers using `batch()` for SELECTs should avoid
 * unaliased duplicate column names across JOINs and integer-named columns.
 */
export function createD1SqlExecutor(d1: D1LikeDatabase): SqlExecutor {
  return {
    async query(sql, params, method) {
      const bound = d1.prepare(sql).bind(...toD1BindValues(params));
      if (method === "run") {
        const result = await bound.run();
        const changes = result.meta?.changes ?? 0;
        return {
          rows: [],
          changes,
          meta: { changes },
        };
      }
      const rawRows = await bound.raw();
      if (method === "get") {
        const firstRow = rawRows[0];
        if (firstRow === undefined) {
          return createEmptyGetQueryResult();
        }
        return {
          rows: firstRow,
          changes: 0,
          meta: { changes: 0 },
        };
      }
      return {
        rows: rawRows,
        changes: 0,
        meta: { changes: 0 },
      };
    },

    async batch(statements) {
      const prepared = statements.map((stmt) =>
        d1.prepare(stmt.sql).bind(...toD1BindValues(stmt.params ?? [])),
      );
      const d1Results = await d1.batch(prepared);
      const output: SqlQueryResult[] = [];
      for (const res of d1Results) {
        const rows: (readonly unknown[])[] = [];
        const rawResults: readonly unknown[] = Array.isArray(res.results) ? res.results : [];
        for (const record of rawResults) {
          if (record !== null && typeof record === "object") {
            rows.push(Object.values(record));
          }
        }
        output.push({
          rows,
          changes: res.meta?.changes ?? 0,
        });
      }
      return output;
    },

    async exec(sql) {
      await d1.exec(sql);
    },
  };
}

export function createD1Database(d1: D1LikeDatabase): AppDatabase {
  const executor = createD1SqlExecutor(d1);
  return {
    orm: createDrizzleFromExecutor(executor),
    executor,
  };
}
