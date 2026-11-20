import { DomainError } from "@/domain";

export type SqlParam = string | number | boolean | null | Uint8Array;

export interface RawSqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
}

export interface SqlQueryResult {
  readonly rows: readonly (readonly unknown[])[];
  readonly changes: number;
}

export interface SqlQueryMethodResult {
  readonly rows: unknown[];
  readonly changes: number;
  readonly meta: { readonly changes: number };
}

export interface SqlExecutor {
  query(
    sql: string,
    params: readonly SqlParam[],
    method: "run" | "all" | "values" | "get",
  ): Promise<SqlQueryMethodResult>;
  batch(statements: readonly RawSqlStatement[]): Promise<readonly SqlQueryResult[]>;
  exec(sql: string): Promise<void>;
}

/**
 * Drizzle sqlite-proxy checks `if (!clientResult.rows) return undefined` for `method === "get"`,
 * even though its `.d.ts` declares `{ rows: any[] }`. Removing `rows` produces `undefined`
 * at runtime without type assertions or `any`.
 */
export function createEmptyGetQueryResult(): SqlQueryMethodResult {
  const result: SqlQueryMethodResult = {
    rows: [],
    changes: 0,
    meta: { changes: 0 },
  };
  Reflect.deleteProperty(result, "rows");
  return result;
}

export interface GuardedMutationOutcome {
  readonly applied: boolean;
  readonly parentChanges: number;
}

export interface GuardedBatchSpec {
  readonly parentUpdate: RawSqlStatement;
  readonly followUps: readonly RawSqlStatement[];
  readonly expectedParentChanges?: number;
}

export function didParentMutationApply(parentChanges: number): GuardedMutationOutcome {
  return {
    applied: parentChanges === 1,
    parentChanges,
  };
}

export const BATCH_GUARD_SQL = "INSERT INTO _batch_guard (ok) SELECT 0 WHERE changes() != ?";

export function isBatchGuardAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return msg.includes("CHECK constraint failed") && msg.includes("chk_batch_guard_ok");
}

function stripLeadingSqlComments(rawSql: string): string {
  let cursor = rawSql.trimStart();
  while (cursor.length > 0) {
    if (cursor.startsWith("--")) {
      const nl = cursor.indexOf("\n");
      if (nl === -1) {
        return "";
      }
      cursor = cursor.slice(nl + 1).trimStart();
      continue;
    }
    if (cursor.startsWith("/*")) {
      const end = cursor.indexOf("*/");
      if (end === -1) {
        return "";
      }
      cursor = cursor.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return cursor;
}

function stripQuotedLiteralsAndComments(rawSql: string): string {
  let out = "";
  let idx = 0;
  while (idx < rawSql.length) {
    const ch = rawSql[idx];
    const next = rawSql[idx + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      idx += 1;
      while (idx < rawSql.length) {
        if (rawSql[idx] === quote) {
          if (rawSql[idx + 1] === quote) {
            idx += 2;
            continue;
          }
          idx += 1;
          break;
        }
        idx += 1;
      }
      out += " ";
      continue;
    }
    if (ch === "-" && next === "-") {
      const nl = rawSql.indexOf("\n", idx + 2);
      idx = nl === -1 ? rawSql.length : nl + 1;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = rawSql.indexOf("*/", idx + 2);
      idx = end === -1 ? rawSql.length : end + 2;
      out += " ";
      continue;
    }
    out += ch ?? "";
    idx += 1;
  }
  return out;
}

function assertSingleDmlParentStatement(rawSql: string): void {
  const withoutLeading = stripLeadingSqlComments(rawSql);
  if (withoutLeading === "") {
    throw new DomainError(
      "VALIDATION_ERROR",
      "guardedBatch parentUpdate SQL must not be empty.",
      false,
    );
  }

  const scrubbed = stripQuotedLiteralsAndComments(withoutLeading).trim();
  const withoutTrailingSemicolon = scrubbed.endsWith(";")
    ? scrubbed.slice(0, -1).trimEnd()
    : scrubbed;
  if (withoutTrailingSemicolon.includes(";")) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "guardedBatch parentUpdate must be a single DML statement.",
      false,
    );
  }

  if (!/^(?:UPDATE|INSERT|DELETE|REPLACE)\b/i.test(withoutTrailingSemicolon)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "guardedBatch parentUpdate must be a direct DML statement (UPDATE, INSERT, DELETE, or REPLACE).",
      false,
    );
  }
}

/**
 * Executes a conditional parent DML statement followed by dependent follow-up SQL statements
 * inside a single atomic D1 / SQLite batch transaction.
 *
 * Right after `parentUpdate`, `_batch_guard` checks `changes() != expectedParentChanges`.
 * If the parent DML did not match the expected row count (e.g. 0 rows or >1 rows), SQLite raises
 * `chk_batch_guard_ok` BEFORE any follow-up SQL executes, rolling back the entire batch
 * and returning `{ applied: false, parentChanges: 0 }`.
 */
export async function guardedBatch(
  executor: SqlExecutor,
  spec: GuardedBatchSpec,
): Promise<GuardedMutationOutcome> {
  const expectedChanges = spec.expectedParentChanges ?? 1;
  if (!Number.isInteger(expectedChanges) || expectedChanges < 1) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "expectedParentChanges must be a positive integer.",
      false,
    );
  }

  assertSingleDmlParentStatement(spec.parentUpdate.sql);

  const statements: RawSqlStatement[] = [
    spec.parentUpdate,
    {
      sql: BATCH_GUARD_SQL,
      params: [expectedChanges],
    },
    ...spec.followUps,
  ];

  try {
    const results = await executor.batch(statements);
    const parentChanges = results[0]?.changes ?? 0;
    if (parentChanges !== expectedChanges) {
      throw new DomainError(
        "INVALID_TRANSITION",
        `guardedBatch committed unexpectedly with parentChanges=${parentChanges} (expected ${expectedChanges}).`,
        false,
      );
    }
    return {
      applied: true,
      parentChanges,
    };
  } catch (error) {
    if (isBatchGuardAbortError(error)) {
      return {
        applied: false,
        parentChanges: 0,
      };
    }
    throw error;
  }
}
