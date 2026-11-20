import { afterEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { guardedBatch, schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import { DEFAULT_BUDGET_LIMIT, DomainError, serializeBudgetLimit } from "@/domain";

const openDbs: SqliteAppDatabase[] = [];

async function setupDb(): Promise<SqliteAppDatabase> {
  const db = createSqliteDatabase(":memory:");
  openDbs.push(db);
  await db.applyMigrations();
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

async function seedBaseEntities(db: SqliteAppDatabase): Promise<void> {
  const now = 1_760_000_000_000;
  await db.orm.insert(schema.user).values({
    id: "user-owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });

  await db.orm.insert(schema.workspaces).values({
    id: "ws-1",
    ownerUserId: "user-owner",
    goal: "MVP test workspace",
    allowedScope: "research, drafting",
    budgetLimit: serializeBudgetLimit(DEFAULT_BUDGET_LIMIT),
    isPaused: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  await db.orm.insert(schema.botConnections).values({
    id: "bot-1",
    workspaceId: "ws-1",
    displayName: "Worker Bot",
    channelType: "worker_bearer",
    tokenHash: "sha256-token-1",
    scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
    status: "active",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  await db.orm.insert(schema.tasks).values([
    {
      id: "task-1",
      workspaceId: "ws-1",
      title: "Competitor research",
      description: "Analyze 3 competitors",
      status: "waiting_human",
      requiresApproval: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "task-2",
      workspaceId: "ws-1",
      title: "Pricing draft",
      description: "Draft pricing options",
      status: "waiting_human",
      requiresApproval: true,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.orm.insert(schema.proposals).values([
    {
      id: "prop-1",
      workspaceId: "ws-1",
      taskId: "task-1",
      proposerBotId: "bot-1",
      cardType: "choice",
      selectionMode: "binary",
      title: "Option A",
      summary: "Summary A",
      onAcceptEffect: "Start A",
      onDeclineEffect: "Skip A",
      onDeclinePolicy: "revise",
      factorsJson: "[]",
      targetTaskVersion: 1,
      payloadHash: "hash-a",
      createdAt: now,
    },
    {
      id: "prop-2",
      workspaceId: "ws-1",
      taskId: "task-1",
      proposerBotId: "bot-1",
      cardType: "choice",
      selectionMode: "binary",
      title: "Option B",
      summary: "Summary B",
      onAcceptEffect: "Start B",
      onDeclineEffect: "Skip B",
      onDeclinePolicy: "revise",
      factorsJson: "[]",
      targetTaskVersion: 1,
      payloadHash: "hash-b",
      createdAt: now,
    },
  ]);

  await db.orm.insert(schema.decisionCards).values([
    {
      id: "card-1",
      workspaceId: "ws-1",
      proposalId: "prop-1",
      selectionGroupId: "grp-1",
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "card-2",
      workspaceId: "ws-1",
      proposalId: "prop-2",
      selectionGroupId: "grp-1",
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

describe("DB schema constraints, Drizzle ORM, and guardedBatch atomicity (S1)", () => {
  test("Drizzle select().get() and orm.batch([findFirst, all, run]) preserve exact row/undefined/changes semantics", async () => {
    const db = await setupDb();
    await seedBaseEntities(db);

    const missing = await db.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "non-existent"))
      .get();
    expect(missing).toBeUndefined();

    const found = await db.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-1"))
      .get();
    expect(found?.id).toBe("task-1");
    expect(found?.requiresApproval).toBe(true);

    const [batchFound, batchMissing, batchAll, batchRun] = await db.orm.batch([
      db.orm.query.tasks.findFirst({ where: eq(schema.tasks.id, "task-1") }),
      db.orm.query.tasks.findFirst({ where: eq(schema.tasks.id, "non-existent") }),
      db.orm.select().from(schema.tasks),
      db.orm
        .update(schema.tasks)
        .set({ title: "Updated via batch" })
        .where(eq(schema.tasks.id, "task-1")),
    ]);

    expect(batchFound?.id).toBe("task-1");
    expect(batchFound?.title).toBe("Competitor research");
    expect(batchMissing).toBeUndefined();
    expect(batchAll).toHaveLength(2);
    expect(batchRun).toMatchObject({ changes: 1, meta: { changes: 1 } });
  });

  test("guardedBatch applies follow-up inserts atomically on changes===1 and aborts all follow-ups on changes===0", async () => {
    const db = await setupDb();
    await seedBaseEntities(db);
    const now = 1_760_000_010_000;

    const failedOutcome = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE decision_cards SET status = 'provisional', provisional_result = 'accepted', provisional_until = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ?",
        params: [now + 5_000, now, "card-1", 999],
      },
      followUps: [
        {
          sql: "INSERT INTO decisions (id, card_id, actor_user_id, result, status, card_version, provisional_at) VALUES (?, ?, ?, 'accepted', 'provisional', ?, ?)",
          params: ["dec-should-not-exist", "card-1", "user-owner", 2, now],
        },
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, 'human', ?, 'decision_card', ?, 'card_provisional', '{}', ?)",
          params: ["evt-should-not-exist", "ws-1", "user-owner", "card-1", now],
        },
      ],
    });

    expect(failedOutcome).toEqual({ applied: false, parentChanges: 0 });
    expect(await db.orm.select().from(schema.decisions).all()).toHaveLength(0);
    expect(await db.orm.select().from(schema.events).all()).toHaveLength(0);

    const appliedOutcome = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE decision_cards SET status = 'provisional', provisional_result = 'accepted', provisional_until = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND version = ?",
        params: [now + 5_000, now, "card-1", 1],
      },
      followUps: [
        {
          sql: "INSERT INTO decisions (id, card_id, actor_user_id, result, status, card_version, provisional_at) VALUES (?, ?, ?, 'accepted', 'provisional', ?, ?)",
          params: ["dec-1", "card-1", "user-owner", 2, now],
        },
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, 'human', ?, 'decision_card', ?, 'card_provisional', '{}', ?)",
          params: ["evt-1", "ws-1", "user-owner", "card-1", now],
        },
      ],
    });

    expect(appliedOutcome).toEqual({ applied: true, parentChanges: 1 });
    expect(await db.orm.select().from(schema.batchGuard).all()).toHaveLength(0);
  });

  test("guardedBatch handles 'returning' string literals, RETURNING clauses, >1 row rollback, expectedParentChanges > 1, non-guard error rollback, and invalid parent SQL (B1, M1, M7)", async () => {
    const db = await setupDb();
    await seedBaseEntities(db);
    const now = 1_760_000_015_000;

    // 1. SQL text containing literal word 'returning' must NOT break change counting
    const literalRes = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE tasks SET title = 'Returning user flow', updated_at = ? WHERE id = ?",
        params: [now, "task-1"],
      },
      followUps: [
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, 'system', 'sys', 'task', ?, 'literal_test', '{}', ?)",
          params: ["evt-lit", "ws-1", "task-1", now],
        },
      ],
    });
    expect(literalRes).toEqual({ applied: true, parentChanges: 1 });

    // 2. Genuine UPDATE ... RETURNING id must still report parentChanges === 1
    const returningRes = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE tasks SET title = 'With returning clause', updated_at = ? WHERE id = ? RETURNING id",
        params: [now, "task-1"],
      },
      followUps: [
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, 'system', 'sys', 'task', ?, 'returning_test', '{}', ?)",
          params: ["evt-ret", "ws-1", "task-1", now],
        },
      ],
    });
    expect(returningRes).toEqual({ applied: true, parentChanges: 1 });

    // 3. Matching > 1 rows when expectedParentChanges = 1 must roll back ALL rows
    const overMatch = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE tasks SET status = 'blocked' WHERE workspace_id = ?",
        params: ["ws-1"],
      },
      followUps: [],
      expectedParentChanges: 1,
    });
    expect(overMatch).toEqual({ applied: false, parentChanges: 0 });
    const tasksAfterOverMatch = await db.orm.select().from(schema.tasks).all();
    expect(tasksAfterOverMatch.every((t) => t.status === "waiting_human")).toBe(true);

    // 4. expectedParentChanges = 2 succeeds when 2 rows match
    const multiMatch = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: "UPDATE tasks SET retry_count = retry_count + 1 WHERE workspace_id = ?",
        params: ["ws-1"],
      },
      followUps: [],
      expectedParentChanges: 2,
    });
    expect(multiMatch).toEqual({ applied: true, parentChanges: 2 });

    // 5. Non-guard constraint error in a follow-up MUST rethrow AND roll back parentUpdate
    await expect(
      guardedBatch(db.executor, {
        parentUpdate: {
          sql: "UPDATE tasks SET status = 'failed' WHERE id = ?",
          params: ["task-2"],
        },
        followUps: [
          {
            // Invalid foreign key workspace_id -> triggers FK constraint error (NOT chk_batch_guard_ok)
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, created_at) VALUES (?, ?, 'system', 'sys', 'task', ?, 'bad_fk', '{}', ?)",
            params: ["evt-bad-fk", "ws-does-not-exist", "task-2", now],
          },
        ],
      }),
    ).rejects.toThrow();

    const task2AfterRollback = await db.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, "task-2"))
      .get();
    expect(task2AfterRollback?.status).toBe("waiting_human");

    // 6. Reject non-DML parentUpdate (SELECT), multi-statement SQL, and invalid expectedParentChanges
    for (const invalidCount of [0, -1, 1.5, Number.NaN]) {
      await expect(
        guardedBatch(db.executor, {
          parentUpdate: {
            sql: "UPDATE tasks SET version = version + 1 WHERE id = ?",
            params: ["task-1"],
          },
          followUps: [],
          expectedParentChanges: invalidCount,
        }),
      ).rejects.toThrow(DomainError);
    }

    await expect(
      guardedBatch(db.executor, {
        parentUpdate: { sql: "SELECT 1" },
        followUps: [],
      }),
    ).rejects.toThrow(DomainError);

    await expect(
      guardedBatch(db.executor, {
        parentUpdate: { sql: "UPDATE tasks SET version = 2; DELETE FROM tasks" },
        followUps: [],
      }),
    ).rejects.toThrow(DomainError);
  });

  test("Partial Unique Index enforces single accepted/provisional(accepted) per selection_group_id (DEC-04)", async () => {
    const db = await setupDb();
    await seedBaseEntities(db);
    const now = 1_760_000_020_000;

    await db.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: now + 5_000,
        version: 2,
        updatedAt: now,
      })
      .where(eq(schema.decisionCards.id, "card-1"));

    await expect(
      db.orm
        .update(schema.decisionCards)
        .set({
          status: "provisional",
          provisionalResult: "accepted",
          provisionalUntil: now + 5_000,
          version: 2,
          updatedAt: now,
        })
        .where(eq(schema.decisionCards.id, "card-2")),
    ).rejects.toThrow();

    await expect(
      db.orm
        .update(schema.decisionCards)
        .set({
          status: "provisional",
          provisionalResult: "declined",
          provisionalUntil: now + 5_000,
          version: 2,
          updatedAt: now,
        })
        .where(eq(schema.decisionCards.id, "card-2")),
    ).resolves.toBeDefined();
  });

  test("CHECK and Partial Unique constraints enforce bot_connections credentials and active decisions per card", async () => {
    const db = await setupDb();
    await seedBaseEntities(db);
    const now = 1_760_000_030_000;

    await expect(
      db.orm.insert(schema.botConnections).values({
        id: "bot-invalid",
        workspaceId: "ws-1",
        displayName: "No Creds",
        channelType: "worker_bearer",
        scopes: "[]",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    await db.orm.insert(schema.decisions).values({
      id: "dec-canceled",
      cardId: "card-1",
      actorUserId: "user-owner",
      result: "accepted",
      status: "canceled",
      cardVersion: 2,
      provisionalAt: now,
      canceledAt: now + 1000,
    });

    await db.orm.insert(schema.decisions).values({
      id: "dec-active-1",
      cardId: "card-1",
      actorUserId: "user-owner",
      result: "accepted",
      status: "provisional",
      cardVersion: 3,
      provisionalAt: now + 2000,
    });

    await expect(
      db.orm.insert(schema.decisions).values({
        id: "dec-active-2",
        cardId: "card-1",
        actorUserId: "user-owner",
        result: "declined",
        status: "provisional",
        cardVersion: 4,
        provisionalAt: now + 3000,
      }),
    ).rejects.toThrow();
  });
});
