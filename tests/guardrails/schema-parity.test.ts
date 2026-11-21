import { describe, expect, test } from "bun:test";

import { getTableConfig } from "drizzle-orm/sqlite-core";

import { inspectBetterAuthSchemaContract } from "@/auth/schema-contract";
import { schema } from "@/db";
import { createSqliteDatabase } from "@/db/sqlite";

describe("Drizzle schema <-> SQL migration <-> Better Auth parity guardrails (M5, M7)", () => {
  test("every table, column, nullability, FK, named CHECK constraint, and index in src/db/schema.ts matches src/db/migrations/*.sql", async () => {
    const db = createSqliteDatabase(":memory:");
    try {
      await db.applyMigrations();

      const masterRows = db.sqlite
        .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all();

      const tableSqlByName = new Map<string, string>();
      const indexSqlByName = new Map<string, string>();

      for (const row of masterRows) {
        if (row === null || typeof row !== "object") {
          continue;
        }
        const type: unknown = Reflect.get(row, "type");
        const name: unknown = Reflect.get(row, "name");
        const ddl: unknown = Reflect.get(row, "sql");
        if (typeof type === "string" && typeof name === "string" && typeof ddl === "string") {
          if (type === "table") {
            tableSqlByName.set(name, ddl);
          } else if (type === "index") {
            indexSqlByName.set(name, ddl);
          }
        }
      }

      const schemaTables = Object.values(schema);
      expect(tableSqlByName.size).toBe(schemaTables.length);

      for (const table of schemaTables) {
        const cfg = getTableConfig(table);
        const tableDdl = tableSqlByName.get(cfg.name);
        expect(tableDdl).toBeDefined();

        // Column parity (names and NOT NULL)
        const pragmaCols = db.sqlite.query(`PRAGMA table_info("${cfg.name}")`).all();
        const sqlColNotNull = new Map<string, boolean>();
        for (const colRow of pragmaCols) {
          if (colRow !== null && typeof colRow === "object") {
            const colName: unknown = Reflect.get(colRow, "name");
            const notnull: unknown = Reflect.get(colRow, "notnull");
            if (typeof colName === "string" && typeof notnull === "number") {
              sqlColNotNull.set(colName, notnull === 1);
            }
          }
        }

        expect(sqlColNotNull.size).toBe(cfg.columns.length);
        for (const col of cfg.columns) {
          expect(sqlColNotNull.has(col.name)).toBe(true);
          expect(sqlColNotNull.get(col.name)).toBe(col.notNull);
        }

        // Named CHECK constraint parity
        for (const checkConstraint of cfg.checks) {
          expect(tableDdl).toContain(checkConstraint.name);
        }

        // Index parity
        for (const idx of cfg.indexes) {
          const idxName = idx.config.name;
          expect(indexSqlByName.has(idxName)).toBe(true);
          const idxDdl = indexSqlByName.get(idxName) ?? "";
          if (idx.config.unique) {
            expect(idxDdl.toUpperCase()).toContain("CREATE UNIQUE INDEX");
          }
          if (idx.config.where !== undefined) {
            expect(idxDdl.toUpperCase()).toContain("WHERE");
          }
        }

        // Foreign key count parity
        const fkRows = db.sqlite.query(`PRAGMA foreign_key_list("${cfg.name}")`).all();
        expect(fkRows.length).toBe(cfg.foreignKeys.length);
      }
    } finally {
      db.close();
    }
  });

  test("Better Auth + JWT + @better-auth/mcp tables and field nullability match src/db/schema.ts", () => {
    const authContract = inspectBetterAuthSchemaContract();
    const schemaByTableName = new Map(
      Object.values(schema).map((table) => {
        const cfg = getTableConfig(table);
        return [cfg.name, cfg] as const;
      }),
    );

    for (const [tableName, expectedTable] of authContract.entries()) {
      const drizzleTable = schemaByTableName.get(tableName);
      expect(drizzleTable).toBeDefined();
      if (drizzleTable === undefined) {
        continue;
      }

      const colByName = new Map(drizzleTable.columns.map((c) => [c.name, c] as const));
      expect(colByName.has("id")).toBe(true);

      for (const [colName, fieldContract] of expectedTable.fields.entries()) {
        const actualCol = colByName.get(colName);
        expect(actualCol).toBeDefined();
        if (actualCol !== undefined) {
          expect(actualCol.notNull).toBe(fieldContract.required);
          expect(actualCol.isUnique).toBe(fieldContract.unique);
        }
      }
    }
  });
});
