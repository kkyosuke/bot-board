import initialSql from "./0001_initial.sql" with { type: "text" };

export interface SqlMigration {
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly SqlMigration[] = [
  {
    id: "0001_initial",
    sql: initialSql,
  },
];
