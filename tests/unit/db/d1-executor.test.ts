import { describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  type AssertCloudflareD1Compatible,
  createD1Database,
  createD1SqlExecutor,
  type D1LikeBatchResult,
  type D1LikeDatabase,
  type D1LikePreparedStatement,
  guardedBatch,
  schema,
} from "@/db";

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function createMockD1(options: {
  readonly rawRowsBySql?: ReadonlyMap<string, readonly (readonly unknown[])[]>;
  readonly batchResults?: readonly D1LikeBatchResult[];
  readonly batchError?: Error;
}): { readonly d1: D1LikeDatabase; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  function makePrepared(sql: string, boundParams: readonly unknown[]): D1LikePreparedStatement {
    return {
      bind(...values: unknown[]) {
        return makePrepared(sql, values);
      },
      run() {
        calls.push({ sql, params: boundParams });
        return Promise.resolve({ meta: { changes: 1 } });
      },
      raw() {
        calls.push({ sql, params: boundParams });
        const rows = options.rawRowsBySql?.get(sql) ?? [];
        return Promise.resolve(rows.map((r) => [...r]));
      },
    };
  }

  const d1: D1LikeDatabase = {
    prepare(query: string) {
      return makePrepared(query, []);
    },
    batch(statements) {
      if (options.batchError !== undefined) {
        return Promise.reject(options.batchError);
      }
      return Promise.resolve(
        statements.map(
          (_, idx) => options.batchResults?.[idx] ?? { results: [], meta: { changes: 0 } },
        ),
      );
    },
    exec() {
      return Promise.resolve({ count: 1, duration: 1 });
    },
  };

  return { d1, calls };
}

describe("Cloudflare D1 executor & Drizzle batch adapter (B2, B3, M7)", () => {
  test("Cloudflare D1Database is structurally assignable to D1LikeDatabase and converts JS booleans to 1/0", async () => {
    const typeProof: AssertCloudflareD1Compatible = true;
    expect(typeProof).toBe(true);

    const { d1, calls } = createMockD1({
      batchResults: [
        // Simulate undefined results array from D1 write statement safely handled without TypeError
        { meta: { changes: 1 } },
      ],
    });

    const executor = createD1SqlExecutor(d1);
    const runRes = await executor.query(
      "UPDATE workspaces SET is_paused = ? WHERE id = ?",
      [true, "ws-1"],
      "run",
    );
    expect(runRes.changes).toBe(1);
    expect(runRes.meta.changes).toBe(1);
    expect(calls[0]?.params).toEqual([1, "ws-1"]);

    const batchRes = await executor.batch([
      { sql: "UPDATE workspaces SET is_paused = ? WHERE id = ?", params: [false, "ws-1"] },
    ]);
    expect(batchRes).toEqual([{ rows: [], changes: 1 }]);
  });

  test("guardedBatch catches Cloudflare D1 CHECK constraint failed: chk_batch_guard_ok cleanly", async () => {
    const { d1 } = createMockD1({
      batchError: new Error(
        "D1_ERROR: CHECK constraint failed: chk_batch_guard_ok: SQLITE_CONSTRAINT",
      ),
    });

    const db = createD1Database(d1);
    const outcome = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'ready'",
        params: ["task-1"],
      },
      followUps: [
        {
          sql: "INSERT INTO work_leases (task_id, bot_id, lease_token, expires_at) VALUES (?, ?, ?, ?)",
          params: ["task-1", "bot-1", "tok-1", 999999],
        },
      ],
    });

    expect(outcome).toEqual({ applied: false, parentChanges: 0 });
  });

  test("createD1Database converts booleans in Drizzle queries and handles batch get/all/run cleanly", async () => {
    const now = 1_760_000_000_000;
    const { d1, calls } = createMockD1({
      batchResults: [
        {
          results: [
            {
              id: "task-1",
              workspace_id: "ws-1",
              parent_task_id: null,
              title: "First task",
              description: "Desc",
              status: "ready",
              status_reason: null,
              requires_approval: 1,
              assigned_bot_id: null,
              retry_count: 0,
              version: 1,
              created_at: now,
              updated_at: now,
            },
          ],
          meta: { changes: 0 },
        },
        {
          results: [],
          meta: { changes: 0 },
        },
        {
          results: [],
          meta: { changes: 1 },
        },
      ],
    });

    const db = createD1Database(d1);

    await db.orm
      .update(schema.workspaces)
      .set({ isPaused: true })
      .where(eq(schema.workspaces.id, "ws-1"));

    expect(calls[0]?.params).toContain(1);
    expect(calls[0]?.params).not.toContain(true);

    const [found, missing, updated] = await db.orm.batch([
      db.orm.query.tasks.findFirst({ where: eq(schema.tasks.id, "task-1") }),
      db.orm.query.tasks.findFirst({ where: eq(schema.tasks.id, "task-missing") }),
      db.orm.update(schema.tasks).set({ title: "Updated" }).where(eq(schema.tasks.id, "task-1")),
    ]);

    expect(found?.id).toBe("task-1");
    expect(found?.title).toBe("First task");
    expect(found?.requiresApproval).toBe(true);
    expect(missing).toBeUndefined();
    expect(updated).toMatchObject({ changes: 1, meta: { changes: 1 } });
  });
});
