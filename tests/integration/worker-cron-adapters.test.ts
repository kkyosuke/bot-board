import { afterEach, describe, expect, test } from "bun:test";

import { type Message, type MessageBatch } from "@cloudflare/workers-types";
import { and, eq } from "drizzle-orm";

import {
  createGrokModelAdapter,
  createLocalScenarioModelAdapter,
  createScriptedModelAdapter,
  ModelAdapterError,
} from "@/adapters";
import { ensureOwnerWorkspace } from "@/auth/better-auth";
import { verifyBotConnectionContext } from "@/auth/bot";
import { hashOAuthOpaqueToken } from "@/auth/token-hash";
import { createD1Database, type D1LikeDatabase, schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import { serializeBudgetLimit } from "@/domain";
import { claimTask, createTask, submitProposal } from "@/services/bot";
import {
  type BotWorkQueuePayload,
  type DecisionFinalizeQueuePayload,
  finalizeDecisionCard,
  getWorkspaceBudgetUsage,
  type QueueSendOptions,
  releaseExpiredWorkLeases,
} from "@/services/system";
import workerHandler, {
  handleBotWorkBatch,
  handleBotWorkDlqBatch,
  handleScheduledTrigger,
} from "@/worker";

const openDbs: SqliteAppDatabase[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function normalizeParam(v: unknown): string | number | null | Uint8Array {
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "string" || typeof v === "number" || v instanceof Uint8Array) {
    return v;
  }
  if (v instanceof Date) {
    return v.getTime();
  }
  return JSON.stringify(v);
}

interface AtomicD1PreparedStatement {
  readonly __sql: string;
  readonly __params: readonly (string | number | null | Uint8Array)[];
  bind(...values: unknown[]): AtomicD1PreparedStatement;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
  raw(): Promise<unknown[][]>;
}

function createSqliteBackedD1(db: SqliteAppDatabase): D1LikeDatabase {
  const buildStmt = (
    sqlText: string,
    params: readonly (string | number | null | Uint8Array)[] = [],
  ): AtomicD1PreparedStatement => ({
    __sql: sqlText,
    __params: params,
    bind(...values: unknown[]) {
      return buildStmt(sqlText, values.map(normalizeParam));
    },
    async run() {
      const res = await db.executor.batch([{ sql: sqlText, params }]);
      return { meta: { changes: res[0]?.changes ?? 0 } };
    },
    async raw(): Promise<unknown[][]> {
      const res = await db.executor.query(sqlText, params, "all");
      return res.rows.map((row): unknown[] => {
        if (Array.isArray(row)) {
          const typed: readonly unknown[] = row;
          return [...typed];
        }
        return [row];
      });
    },
  });

  return {
    prepare(sqlText: string) {
      return buildStmt(sqlText);
    },
    async batch(statements) {
      const rawStmts: {
        readonly sql: string;
        readonly params: readonly (string | number | null | Uint8Array)[];
      }[] = [];
      for (const s of statements) {
        const sqlVal: unknown = Reflect.get(s, "__sql");
        const paramsVal: unknown = Reflect.get(s, "__params");
        if (typeof sqlVal === "string" && Array.isArray(paramsVal)) {
          const typedParams: readonly unknown[] = paramsVal;
          rawStmts.push({ sql: sqlVal, params: typedParams.map(normalizeParam) });
        }
      }
      const results = await db.executor.batch(rawStmts);
      return results.map((r) => ({ meta: { changes: r.changes } }));
    },
    async exec(sqlText: string) {
      await db.executor.batch([{ sql: sqlText, params: [] }]);
      return { count: 1, duration: 0 };
    },
  };
}

interface RecordedMessageActions {
  acked: number;
  retried: number[];
}

function createQueueBatch(
  queue: string,
  bodies: readonly unknown[],
  nowMs: number,
): { readonly batch: MessageBatch; readonly actions: RecordedMessageActions[] } {
  const actions: RecordedMessageActions[] = [];
  const messages: Message[] = bodies.map((body, idx) => {
    const tracker: RecordedMessageActions = { acked: 0, retried: [] };
    actions.push(tracker);
    return {
      id: `msg-${queue}-${idx}`,
      timestamp: new Date(nowMs),
      body,
      attempts: 1,
      ack() {
        tracker.acked += 1;
      },
      retry(opts?: { readonly delaySeconds?: number }) {
        tracker.retried.push(opts?.delaySeconds ?? 0);
      },
    };
  });

  const batch: MessageBatch = {
    queue,
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: messages.length * 64,
        oldestMessageTimestamp: new Date(nowMs),
      },
    },
    ackAll() {},
    retryAll() {},
  };

  return { batch, actions };
}

function createStubFetch(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

async function setupWorkerFixture() {
  const sqliteDb = createSqliteDatabase(":memory:");
  openDbs.push(sqliteDb);
  await sqliteDb.applyMigrations();

  const d1 = createSqliteBackedD1(sqliteDb);
  const db = createD1Database(d1);
  let nowMs = 1_760_300_000_000;
  let seq = 1;

  const ownerUserId = "user-s7-owner";
  await sqliteDb.orm.insert(schema.user).values({
    id: ownerUserId,
    name: "S7 Owner",
    email: "s7@example.test",
    emailVerified: true,
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  const workspaceId = await ensureOwnerWorkspace(db, ownerUserId, nowMs);

  const workerBotId = "bot-s7-worker-1";
  await sqliteDb.orm.insert(schema.botConnections).values({
    id: workerBotId,
    workspaceId,
    displayName: "Grok Autonomous Worker",
    channelType: "worker_bearer",
    oauthClientId: null,
    tokenHash: await hashOAuthOpaqueToken("bbw_s7_worker_secret"),
    scopes: JSON.stringify(["tasks:read", "tasks:write", "proposals:write", "decisions:read"]),
    status: "active",
    version: 1,
    createdAt: nowMs,
    updatedAt: nowMs,
  });

  const botCtx = verifyBotConnectionContext({
    botConnectionId: workerBotId,
    workspaceId,
    workspaceOwnerUserId: ownerUserId,
    isWorkspacePaused: false,
    channelType: "worker_bearer",
    status: "active",
    connectionScopes: ["tasks:read", "tasks:write", "proposals:write", "decisions:read"],
  });

  const botWorkQueueSent: BotWorkQueuePayload[] = [];
  const botWorkQueue = {
    send(message: BotWorkQueuePayload, _opts?: QueueSendOptions) {
      botWorkQueueSent.push(message);
      return Promise.resolve();
    },
  };
  const finalizeQueueSent: DecisionFinalizeQueuePayload[] = [];
  const finalizeQueue = {
    send(message: DecisionFinalizeQueuePayload, _opts?: QueueSendOptions) {
      finalizeQueueSent.push(message);
      return Promise.resolve();
    },
  };

  async function seedFinalizedPolicyDecision(options?: {
    readonly result?: "accepted" | "declined";
    readonly requiresApproval?: boolean;
    readonly title?: string;
    readonly withArtifact?: boolean;
  }) {
    const tag = `seed-${seq}`;
    seq += 1;
    const created = await createTask(
      db,
      botCtx,
      {
        request_id: `create-${tag}`,
        title: options?.title ?? "アプリ企画・競合調査",
        description: "モバイル片手スワイプ比較",
        requires_approval: options?.requiresApproval ?? true,
      },
      nowMs,
    );
    const claimed = await claimTask(
      db,
      botCtx,
      {
        request_id: `claim-${tag}`,
        task_id: created.task_id,
        expected_version: created.version,
        lease_duration_seconds: 120,
      },
      nowMs,
    );
    const submitted = await submitProposal(
      db,
      botCtx,
      {
        request_id: `prop-${tag}`,
        task_id: created.task_id,
        expected_version: claimed.version,
        lease_token: claimed.lease_token,
        ...(options?.withArtifact === true
          ? {
              artifact: {
                title: "初期ドラフト",
                kind: "markdown",
                summary: "v1 ドラフト",
                content_or_url: "# v1",
              },
            }
          : {}),
        proposals: [
          {
            card_type: "policy",
            selection_mode: "binary",
            title: "スマホ優先MVP方針で進める？",
            summary: "最小機能で検証",
            on_accept_effect: "成果ドラフト作成へ進む",
            on_decline_effect: "代替方針を再提案",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      nowMs,
    );
    const card = submitted.cards[0];
    if (card === undefined) {
      throw new Error("Expected card to be created");
    }

    const decisionResult = options?.result ?? "accepted";
    const decisionId = `dec-${tag}`;
    const provisionalUntil = nowMs + 5_000;
    await sqliteDb.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: decisionResult,
        provisionalUntil,
        version: card.version + 1,
        updatedAt: nowMs,
      })
      .where(eq(schema.decisionCards.id, card.card_id));

    await sqliteDb.orm.insert(schema.decisions).values({
      id: decisionId,
      cardId: card.card_id,
      actorUserId: ownerUserId,
      result: decisionResult,
      selectedOptionIdsJson: "[]",
      status: "provisional",
      cardVersion: card.version + 1,
      finalizedTaskVersion: null,
      provisionalAt: nowMs,
      finalizedAt: null,
      canceledAt: null,
      consumedAt: null,
    });

    nowMs += 6_000;
    const finalized = await finalizeDecisionCard(db, card.card_id, {
      source: "queue",
      nowMs,
      botWorkQueue,
    });
    expect(finalized.outcome.applied).toBe(true);

    return {
      taskId: created.task_id,
      cardId: card.card_id,
      decisionId,
      artifactId: submitted.artifact_id,
    };
  }

  return {
    sqliteDb,
    d1,
    db,
    ownerUserId,
    workspaceId,
    workerBotId,
    botCtx,
    botWorkQueue,
    botWorkQueueSent,
    finalizeQueue,
    finalizeQueueSent,
    getNow: () => nowMs,
    advanceNow: (deltaMs: number) => {
      nowMs += deltaMs;
    },
    seedFinalizedPolicyDecision,
  };
}

describe("S7 Autonomous Worker (bot-work / bot-work-dlq), 4-Duty Cron & Budget Enforcement (BOT-01, BOT-03, DEC-01, DEC-03)", () => {
  test("BOT-01: accepted & declined finalized decisions auto-resume via bot-work Queue, produce deliverable/revision cards, and mark consumed_at", async () => {
    const f = await setupWorkerFixture();

    const seededAccept = await f.seedFinalizedPolicyDecision({ result: "accepted" });
    const msg = f.botWorkQueueSent.find((m) => m.decision_id === seededAccept.decisionId);
    expect(msg).toBeDefined();

    const { batch, actions } = createQueueBatch("bot-work", [msg], f.getNow());
    await handleBotWorkBatch(
      batch,
      { DB: f.d1, MODEL_ADAPTER: createLocalScenarioModelAdapter() },
      { nowMs: f.getNow() },
    );
    expect(actions[0]?.acked).toBe(1);
    expect(actions[0]?.retried).toHaveLength(0);

    const taskAfter = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seededAccept.taskId))
      .get();
    expect(taskAfter?.status).toBe("waiting_human");

    const decisionAfter = await f.sqliteDb.orm
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, seededAccept.decisionId))
      .get();
    expect(decisionAfter?.consumedAt).not.toBeNull();

    const deliverableProps = await f.sqliteDb.orm
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.taskId, seededAccept.taskId))
      .all();
    expect(deliverableProps.some((p) => p.cardType === "deliverable")).toBe(true);

    // Declined policy decision (revise) auto-generates revision card without decline-reason input
    const seededDecline = await f.seedFinalizedPolicyDecision({
      result: "declined",
      title: "見送り後改訂タスク",
    });
    const declineMsg = f.botWorkQueueSent.find((m) => m.decision_id === seededDecline.decisionId);
    expect(declineMsg).toBeDefined();
    const { batch: decBatch, actions: decActions } = createQueueBatch(
      "bot-work",
      [declineMsg],
      f.getNow(),
    );
    await handleBotWorkBatch(
      decBatch,
      { DB: f.d1, MODEL_ADAPTER: createLocalScenarioModelAdapter() },
      { nowMs: f.getNow() },
    );
    expect(decActions[0]?.acked).toBe(1);

    const revisedProps = await f.sqliteDb.orm
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.taskId, seededDecline.taskId))
      .all();
    expect(revisedProps.some((p) => p.title.includes("代替案"))).toBe(true);
  });

  test("DEC-01: bot-work ignores provisional and canceled decisions without invoking ModelAdapter", async () => {
    const f = await setupWorkerFixture();

    const created = await createTask(
      f.db,
      f.botCtx,
      {
        request_id: "dec01-t",
        title: "DEC-01 猶予保護タスク",
        description: "",
        requires_approval: true,
      },
      f.getNow(),
    );
    const claimed = await claimTask(
      f.db,
      f.botCtx,
      {
        request_id: "dec01-c",
        task_id: created.task_id,
        expected_version: created.version,
        lease_duration_seconds: 120,
      },
      f.getNow(),
    );
    const submitted = await submitProposal(
      f.db,
      f.botCtx,
      {
        request_id: "dec01-p",
        task_id: created.task_id,
        expected_version: claimed.version,
        lease_token: claimed.lease_token,
        proposals: [
          {
            card_type: "policy",
            selection_mode: "binary",
            title: "仮確定カード",
            summary: "5秒猶予中",
            on_accept_effect: "次へ",
            on_decline_effect: "見送り",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      f.getNow(),
    );
    const cardId = submitted.cards[0]?.card_id ?? "";

    // Force task to ready to verify worker STILL checks decision.status === 'finalized' even if task is ready!
    await f.sqliteDb.orm
      .update(schema.tasks)
      .set({ status: "ready", version: submitted.task_version + 1 })
      .where(eq(schema.tasks.id, created.task_id));

    await f.sqliteDb.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: f.getNow() + 5_000,
      })
      .where(eq(schema.decisionCards.id, cardId));
    await f.sqliteDb.orm.insert(schema.decisions).values({
      id: "dec-provisional-only",
      cardId,
      actorUserId: f.ownerUserId,
      result: "accepted",
      selectedOptionIdsJson: "[]",
      status: "provisional",
      cardVersion: 2,
      finalizedTaskVersion: null,
      provisionalAt: f.getNow(),
      finalizedAt: null,
      canceledAt: null,
      consumedAt: null,
    });

    let invocations = 0;
    const spyAdapter = createScriptedModelAdapter("dec01-spy", () => {
      invocations += 1;
      return { action: "update_task", status: "ready", estimated_cost_cents: 0 };
    });

    const provBatch = createQueueBatch(
      "bot-work",
      [
        {
          decision_id: "dec-provisional-only",
          task_id: created.task_id,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow(),
    );
    await handleBotWorkBatch(
      provBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: spyAdapter },
      { nowMs: f.getNow() },
    );
    expect(provBatch.actions[0]?.acked).toBe(1);
    expect(invocations).toBe(0);

    // Cancel the decision (undo within 5s) -> still ignored with zero adapter invocations
    await f.sqliteDb.orm
      .update(schema.decisions)
      .set({ status: "canceled", canceledAt: f.getNow() + 1_000 })
      .where(eq(schema.decisions.id, "dec-provisional-only"));
    const cancelBatch = createQueueBatch(
      "bot-work",
      [
        {
          decision_id: "dec-provisional-only",
          task_id: created.task_id,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow() + 1_000,
    );
    await handleBotWorkBatch(
      cancelBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: spyAdapter },
      { nowMs: f.getNow() + 1_000 },
    );
    expect(cancelBatch.actions[0]?.acked).toBe(1);
    expect(invocations).toBe(0);
  });

  test("DEC-03: creates ONE non-looping [再確認] card on task version OR target_artifact_version mismatch with updated artifact version and zero Cron re-dispatch", async () => {
    const f = await setupWorkerFixture();

    // Case A: task.version mismatch
    const seededTaskStale = await f.seedFinalizedPolicyDecision({ result: "accepted" });
    const beforeTask = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seededTaskStale.taskId))
      .get();
    if (beforeTask === undefined) {
      throw new Error("Expected task");
    }
    await f.sqliteDb.orm
      .update(schema.tasks)
      .set({ version: beforeTask.version + 1, updatedAt: f.getNow() + 10 })
      .where(eq(schema.tasks.id, seededTaskStale.taskId));

    let adapterInvocations = 0;
    const spyAdapter = createScriptedModelAdapter("dec03-spy", () => {
      adapterInvocations += 1;
      return { action: "update_task", status: "ready", estimated_cost_cents: 0 };
    });

    const staleMsg: BotWorkQueuePayload = {
      decision_id: seededTaskStale.decisionId,
      task_id: seededTaskStale.taskId,
      workspace_id: f.workspaceId,
    };

    const run1 = createQueueBatch("bot-work", [staleMsg], f.getNow() + 20);
    await handleBotWorkBatch(
      run1.batch,
      { DB: f.d1, MODEL_ADAPTER: spyAdapter },
      { nowMs: f.getNow() + 20 },
    );
    expect(run1.actions[0]?.acked).toBe(1);
    expect(adapterInvocations).toBe(0);

    // Original finalized card stays immutable ('accepted')
    const originalCard = await f.sqliteDb.orm
      .select()
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, seededTaskStale.cardId))
      .get();
    expect(originalCard?.status).toBe("accepted");

    // Duplicate delivery + Cron #4 -> ZERO extra cards, ZERO Cron re-dispatch!
    const run2 = createQueueBatch("bot-work", [staleMsg], f.getNow() + 30);
    await handleBotWorkBatch(
      run2.batch,
      { DB: f.d1, MODEL_ADAPTER: spyAdapter },
      { nowMs: f.getNow() + 30 },
    );
    expect(run2.actions[0]?.acked).toBe(1);

    f.botWorkQueueSent.length = 0;
    await handleScheduledTrigger(
      { cron: "* * * * *", scheduledTime: f.getNow() + 60_000 },
      { DB: f.d1, BOT_WORK_QUEUE: f.botWorkQueue },
    );
    expect(f.botWorkQueueSent.filter((m) => m.task_id === seededTaskStale.taskId)).toHaveLength(0);

    // Case B (M3): target_artifact_version mismatch while task.version matches -> [再確認] stores currentArtifactVersion (v2)!
    const seededArtStale = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      withArtifact: true,
      title: "Artifact 版ずれテスト",
    });
    expect(seededArtStale.artifactId).not.toBeNull();
    if (seededArtStale.artifactId !== null) {
      await f.sqliteDb.orm
        .update(schema.artifacts)
        .set({ version: 2, updatedAt: f.getNow() + 10 })
        .where(eq(schema.artifacts.id, seededArtStale.artifactId));
    }

    const artRun = createQueueBatch(
      "bot-work",
      [
        {
          decision_id: seededArtStale.decisionId,
          task_id: seededArtStale.taskId,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow() + 20,
    );
    await handleBotWorkBatch(
      artRun.batch,
      { DB: f.d1, MODEL_ADAPTER: spyAdapter },
      { nowMs: f.getNow() + 20 },
    );
    expect(artRun.actions[0]?.acked).toBe(1);
    expect(adapterInvocations).toBe(0);

    const artProps = await f.sqliteDb.orm
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.taskId, seededArtStale.taskId))
      .all();
    const reconfirmArtProp = artProps.find((p) => p.title.startsWith("[再確認]"));
    expect(reconfirmArtProp).toBeDefined();
    expect(reconfirmArtProp?.targetArtifactVersion).toBe(2);
  });

  test("BOT-03 & B1 & M4: retries 429 cleanly, records permanent/invalid-mutation errors without leaking WorkLease, and protects done/waiting_human/foreign decisions in DLQ", async () => {
    const f = await setupWorkerFixture();

    // 1. Transient 429 -> releases lease & carries finalized_task_version -> retry succeeds cleanly
    const seededRetry = await f.seedFinalizedPolicyDecision({ result: "accepted" });
    let attempt = 0;
    const flakyAdapter = createScriptedModelAdapter("flaky-429", () => {
      attempt += 1;
      if (attempt === 1) {
        throw new ModelAdapterError("retryable", "RATE_LIMITED", "Upstream 429", {
          retryAfterSeconds: 12,
        });
      }
      return {
        action: "submit_proposal",
        proposals: [
          {
            card_type: "deliverable",
            selection_mode: "binary",
            title: "リトライ後に生成された成果を受け入れる？",
            summary: "429からの回復成功",
            on_accept_effect: "完了",
            on_decline_effect: "やり直し",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
        estimated_cost_cents: 1,
      };
    });

    const msg1: BotWorkQueuePayload = {
      decision_id: seededRetry.decisionId,
      task_id: seededRetry.taskId,
      workspace_id: f.workspaceId,
    };
    const batch1 = createQueueBatch("bot-work", [msg1], f.getNow());
    await handleBotWorkBatch(
      batch1.batch,
      { DB: f.d1, MODEL_ADAPTER: flakyAdapter },
      { nowMs: f.getNow() },
    );
    expect(batch1.actions[0]?.retried).toEqual([12]);
    expect(
      await f.sqliteDb.orm
        .select()
        .from(schema.workLeases)
        .where(eq(schema.workLeases.taskId, seededRetry.taskId))
        .get(),
    ).toBeUndefined();

    const batch2 = createQueueBatch("bot-work", [msg1], f.getNow() + 12_000);
    await handleBotWorkBatch(
      batch2.batch,
      { DB: f.d1, MODEL_ADAPTER: flakyAdapter },
      { nowMs: f.getNow() + 12_000 },
    );
    expect(batch2.actions[0]?.acked).toBe(1);
    const waitingTask = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seededRetry.taskId))
      .get();
    expect(waitingTask?.status).toBe("waiting_human");

    // 2. B1: Model returns update_task referencing a non-existent artifact.id -> records failed, releases WorkLease, acks!
    const seededBadArt = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "存在しないArtifact参照テスト",
    });
    const hallucinatedArtifactAdapter = createScriptedModelAdapter("bad-art", () => ({
      action: "update_task",
      status: "ready",
      artifact: {
        id: "art-does-not-exist",
        expected_version: 1,
        title: "Ghost",
        kind: "markdown",
        summary: "S",
        content_or_url: "Body",
      },
      estimated_cost_cents: 3,
    }));
    const badArtBatch = createQueueBatch(
      "bot-work",
      [
        {
          decision_id: seededBadArt.decisionId,
          task_id: seededBadArt.taskId,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow(),
    );
    await handleBotWorkBatch(
      badArtBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: hallucinatedArtifactAdapter },
      { nowMs: f.getNow() },
    );
    expect(badArtBatch.actions[0]?.acked).toBe(1);
    const badArtTask = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seededBadArt.taskId))
      .get();
    expect(badArtTask?.status).toBe("failed");
    expect(badArtTask?.statusReason).toContain("NOT_FOUND");
    expect(
      await f.sqliteDb.orm
        .select()
        .from(schema.workLeases)
        .where(eq(schema.workLeases.taskId, seededBadArt.taskId))
        .get(),
    ).toBeUndefined();

    // 3. Direct record_result(success) on requires_approval=true -> permanent failed (BOT-03)
    const seededApprovalGuard = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      requiresApproval: true,
      title: "承認必須バイパス防止テスト",
    });
    const illegalDoneAdapter = createScriptedModelAdapter("illegal-done", () => ({
      action: "record_result",
      outcome: "success",
      summary: "Trying to skip human approval",
      estimated_cost_cents: 1,
    }));
    const guardBatch = createQueueBatch(
      "bot-work",
      [
        {
          decision_id: seededApprovalGuard.decisionId,
          task_id: seededApprovalGuard.taskId,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow(),
    );
    await handleBotWorkBatch(
      guardBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: illegalDoneAdapter },
      { nowMs: f.getNow() },
    );
    expect(guardBatch.actions[0]?.acked).toBe(1);
    const guardTask = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seededApprovalGuard.taskId))
      .get();
    expect(guardTask?.status).toBe("failed");
    expect(guardTask?.statusReason).toContain("APPROVAL_REQUIRED");

    // 4. DLQ records failed on ready/running, NEVER overwrites waiting_human / done / already-consumed / foreign decision!
    const dlqSeeded = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "DLQ 退避タスク",
    });
    const dlqBatch = createQueueBatch(
      "bot-work-dlq",
      [
        // Valid ready task -> fails cleanly
        {
          decision_id: dlqSeeded.decisionId,
          task_id: dlqSeeded.taskId,
          workspace_id: f.workspaceId,
        },
        // Duplicate DLQ for already-waiting_human + consumed task (seededRetry) -> MUST NOT clobber waiting_human!
        {
          decision_id: seededRetry.decisionId,
          task_id: seededRetry.taskId,
          workspace_id: f.workspaceId,
        },
        // Duplicate DLQ for same dlqSeeded (now failed & consumed) -> MUST NOT double-increment retry_count!
        {
          decision_id: dlqSeeded.decisionId,
          task_id: dlqSeeded.taskId,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow(),
    );
    await handleBotWorkDlqBatch(dlqBatch.batch, { DB: f.d1 }, f.getNow());
    expect(dlqBatch.actions.every((a) => a.acked === 1)).toBe(true);

    const dlqTask = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, dlqSeeded.taskId))
      .get();
    expect(dlqTask?.status).toBe("failed");
    expect(dlqTask?.retryCount).toBe(1);

    const protectedWaiting = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, seededRetry.taskId))
      .get();
    expect(protectedWaiting?.status).toBe("waiting_human");

    // Done task protected from DLQ without decisionId too
    const doneTask = await createTask(
      f.db,
      f.botCtx,
      {
        request_id: "dlq-done-t",
        title: "Already Done",
        description: "",
        requires_approval: false,
      },
      f.getNow(),
    );
    await f.sqliteDb.orm
      .update(schema.tasks)
      .set({ status: "done" })
      .where(eq(schema.tasks.id, doneTask.task_id));
    const dlqDoneBatch = createQueueBatch(
      "bot-work-dlq",
      [{ task_id: doneTask.task_id, workspace_id: f.workspaceId }],
      f.getNow(),
    );
    await handleBotWorkDlqBatch(dlqDoneBatch.batch, { DB: f.d1 }, f.getNow());
    const doneAfter = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, doneTask.task_id))
      .get();
    expect(doneAfter?.status).toBe("done");
  });

  test("enforces is_paused and ALL 3 budget_limit dimensions (max_cards_per_day pre+post, max_steps_per_task, daily_cost_limit_cents accumulation)", async () => {
    const f = await setupWorkerFixture();

    // 1. is_paused halts bot-work cleanly
    const tPaused = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "Pause Test",
    });
    await f.sqliteDb.orm
      .update(schema.workspaces)
      .set({ isPaused: true })
      .where(eq(schema.workspaces.id, f.workspaceId));

    let calls = 0;
    const stepAdapter = createScriptedModelAdapter("budget-step", () => {
      calls += 1;
      return { action: "update_task", status: "ready", estimated_cost_cents: 6 };
    });

    const pBatch = createQueueBatch(
      "bot-work",
      [{ decision_id: tPaused.decisionId, task_id: tPaused.taskId, workspace_id: f.workspaceId }],
      f.getNow(),
    );
    await handleBotWorkBatch(
      pBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: stepAdapter },
      { nowMs: f.getNow() },
    );
    expect(pBatch.actions[0]?.acked).toBe(1);
    expect(calls).toBe(0);

    // 2. Unpause + set max_steps_per_task = 2, daily_cost_limit_cents = 100 -> 2 steps succeed (12 cents), 3rd step blocks on max_steps_per_task!
    await f.sqliteDb.orm
      .update(schema.workspaces)
      .set({
        isPaused: false,
        budgetLimit: serializeBudgetLimit({
          max_cards_per_day: 100,
          max_steps_per_task: 2,
          daily_cost_limit_cents: 100,
        }),
      })
      .where(eq(schema.workspaces.id, f.workspaceId));

    for (let i = 0; i < 3; i += 1) {
      const b = createQueueBatch(
        "bot-work",
        [{ task_id: tPaused.taskId, workspace_id: f.workspaceId }],
        f.getNow() + i * 1000,
      );
      await handleBotWorkBatch(
        b.batch,
        { DB: f.d1, MODEL_ADAPTER: stepAdapter },
        { nowMs: f.getNow() + i * 1000 },
      );
      expect(b.actions[0]?.acked).toBe(1);
    }
    expect(calls).toBe(2);
    const stepBlocked = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, tPaused.taskId))
      .get();
    expect(stepBlocked?.status).toBe("blocked");
    expect(stepBlocked?.statusReason).toContain("Per-task step limit reached");

    // 3. Accumulated positive daily cost (12 cents >= 10 cents) blocks a fresh task on daily_cost_limit_cents!
    await f.sqliteDb.orm
      .update(schema.workspaces)
      .set({
        budgetLimit: serializeBudgetLimit({
          max_cards_per_day: 100,
          max_steps_per_task: 10,
          daily_cost_limit_cents: 10,
        }),
      })
      .where(eq(schema.workspaces.id, f.workspaceId));

    const tCost = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "Cost Cap Test",
    });
    const cBatch = createQueueBatch(
      "bot-work",
      [{ decision_id: tCost.decisionId, task_id: tCost.taskId, workspace_id: f.workspaceId }],
      f.getNow(),
    );
    await handleBotWorkBatch(
      cBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: stepAdapter },
      { nowMs: f.getNow() },
    );
    const costBlocked = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, tCost.taskId))
      .get();
    expect(costBlocked?.status).toBe("blocked");
    expect(costBlocked?.statusReason).toContain("Daily cost limit reached");
    // Decision consumed on budget_blocked so owner retry resumes cleanly without spurious DEC-03
    const costDec = await f.sqliteDb.orm
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, tCost.decisionId))
      .get();
    expect(costDec?.consumedAt).not.toBeNull();

    // 4. max_cards_per_day post-model batch cap blocks & STILL records spent model cost cents + worker.budget_exceeded!
    const currentUsage = await getWorkspaceBudgetUsage(
      f.db,
      f.workspaceId,
      tCost.taskId,
      f.getNow(),
    );
    await f.sqliteDb.orm
      .update(schema.workspaces)
      .set({
        budgetLimit: serializeBudgetLimit({
          max_cards_per_day: currentUsage.cardsCreatedToday + 2, // allows 1 pre-card (from seed) + 1 remaining, so 2-card batch exceeds!
          max_steps_per_task: 10,
          daily_cost_limit_cents: 500,
        }),
      })
      .where(eq(schema.workspaces.id, f.workspaceId));

    const tCardCap = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "Card Cap Test",
    });
    const twoCardAdapter = createScriptedModelAdapter("two-cards", () => ({
      action: "submit_proposal",
      proposals: [
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "案A",
          summary: "S",
          on_accept_effect: "A",
          on_decline_effect: "D",
          on_decline_policy: "revise",
          factors: [],
        },
        {
          card_type: "choice",
          selection_mode: "binary",
          title: "案B",
          summary: "S",
          on_accept_effect: "A",
          on_decline_effect: "D",
          on_decline_policy: "revise",
          factors: [],
        },
      ],
      estimated_cost_cents: 7,
    }));

    const capBatch = createQueueBatch(
      "bot-work",
      [{ decision_id: tCardCap.decisionId, task_id: tCardCap.taskId, workspace_id: f.workspaceId }],
      f.getNow(),
    );
    await handleBotWorkBatch(
      capBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: twoCardAdapter },
      { nowMs: f.getNow() },
    );
    const capTask = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, tCardCap.taskId))
      .get();
    expect(capTask?.status).toBe("blocked");
    expect(capTask?.statusReason).toContain("Daily card limit would be exceeded");

    // Verify spent 7 cents WAS recorded in budget usage!
    const usageAfterCap = await getWorkspaceBudgetUsage(
      f.db,
      f.workspaceId,
      tCardCap.taskId,
      f.getNow(),
    );
    expect(usageAfterCap.costCentsToday).toBe(currentUsage.costCentsToday + 7);
    expect(usageAfterCap.stepsExecutedForTask).toBe(1);
  });

  test("Grok adapter -> handleBotWorkBatch E2E: enforces zero XAI_API_KEY leakage in D1, records usage cost floor, and classifies 401 as permanent failed", async () => {
    const f = await setupWorkerFixture();
    const secretKey = "xai-e2e-secret-never-persist-8888";

    const seededOk = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "Grok 実配線E2Eタスク",
    });
    const okGrokAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      action: "submit_proposal",
                      artifact: {
                        title: "Grok生成成果",
                        kind: "markdown",
                        summary: "Grok経由生成",
                        content_or_url: "# Generated by Grok adapter",
                      },
                      proposals: [
                        {
                          card_type: "deliverable",
                          selection_mode: "binary",
                          title: "Grok成果を受け入れる？",
                          summary: "最終ドラフト",
                          on_accept_effect: "完了",
                          on_decline_effect: "改訂",
                          on_decline_policy: "revise",
                          factors: [],
                        },
                      ],
                      estimated_cost_cents: 0,
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 18_000, completion_tokens: 4_000 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    });

    const okBatch = createQueueBatch(
      "bot-work",
      [{ decision_id: seededOk.decisionId, task_id: seededOk.taskId, workspace_id: f.workspaceId }],
      f.getNow(),
    );
    await handleBotWorkBatch(
      okBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: okGrokAdapter },
      { nowMs: f.getNow() },
    );
    expect(okBatch.actions[0]?.acked).toBe(1);

    // 22,000 tokens -> ceil(22000/10000) = 3 cents recorded in budget usage
    const usage = await getWorkspaceBudgetUsage(f.db, f.workspaceId, seededOk.taskId, f.getNow());
    expect(usage.costCentsToday).toBe(3);

    // 401 Auth failure via Grok adapter marks task permanently failed with ZERO secret leakage in D1
    const seeded401 = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "Grok 401 秘密非漏洩テスト",
    });
    const badKeyGrokAdapter = createGrokModelAdapter({
      apiKey: secretKey,
      fetchImpl: createStubFetch(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: `Unauthorized token ${secretKey}` }), {
            status: 401,
          }),
        ),
      ),
    });
    const errBatch = createQueueBatch(
      "bot-work",
      [
        {
          decision_id: seeded401.decisionId,
          task_id: seeded401.taskId,
          workspace_id: f.workspaceId,
        },
      ],
      f.getNow(),
    );
    await handleBotWorkBatch(
      errBatch.batch,
      { DB: f.d1, MODEL_ADAPTER: badKeyGrokAdapter },
      { nowMs: f.getNow() },
    );
    expect(errBatch.actions[0]?.acked).toBe(1);

    const allTasks = await f.sqliteDb.orm.select().from(schema.tasks).all();
    const allEvents = await f.sqliteDb.orm.select().from(schema.events).all();
    const failed401 = allTasks.find((t) => t.id === seeded401.taskId);
    expect(failed401?.status).toBe("failed");
    expect(failed401?.statusReason).toContain("AUTH_ERROR");
    expect(JSON.stringify({ allTasks, allEvents })).not.toContain(secretKey);
  });

  test("Cron 4 duties + B2 + M1 + M2 + Minor 5 + BOT-02: single-dispatch per tick, atomic lease release, group latest-decision ordering, and active worker_bearer filtering", async () => {
    const f = await setupWorkerFixture();

    // Duty 1 setup: provisional card past provisional_until
    const t1 = await createTask(
      f.db,
      f.botCtx,
      {
        request_id: "cron-t1",
        title: "Duty 1 Provisional",
        description: "",
        requires_approval: true,
      },
      f.getNow(),
    );
    const c1 = await claimTask(
      f.db,
      f.botCtx,
      {
        request_id: "cron-c1",
        task_id: t1.task_id,
        expected_version: t1.version,
        lease_duration_seconds: 120,
      },
      f.getNow(),
    );
    const p1 = await submitProposal(
      f.db,
      f.botCtx,
      {
        request_id: "cron-p1",
        task_id: t1.task_id,
        expected_version: c1.version,
        lease_token: c1.lease_token,
        proposals: [
          {
            card_type: "policy",
            selection_mode: "binary",
            title: "Cron 確定テスト",
            summary: "確定待ち",
            on_accept_effect: "次へ",
            on_decline_effect: "改訂",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      f.getNow(),
    );
    const card1Id = p1.cards[0]?.card_id ?? "";
    await f.sqliteDb.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: f.getNow() + 5_000,
        version: 2,
      })
      .where(eq(schema.decisionCards.id, card1Id));
    await f.sqliteDb.orm.insert(schema.decisions).values({
      id: "dec-cron-duty1",
      cardId: card1Id,
      actorUserId: f.ownerUserId,
      result: "accepted",
      selectedOptionIdsJson: "[]",
      status: "provisional",
      cardVersion: 2,
      finalizedTaskVersion: null,
      provisionalAt: f.getNow(),
      finalizedAt: null,
      canceledAt: null,
      consumedAt: null,
    });

    // Duty 2 setup: crashed worker holding expired WorkLease on a task with an unconsumed finalized decision
    const crashedSeed = await f.seedFinalizedPolicyDecision({
      result: "accepted",
      title: "Duty 2 Crashed Worker",
    });
    const crashedTaskBefore = await f.sqliteDb.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, crashedSeed.taskId))
      .get();
    await claimTask(
      f.db,
      f.botCtx,
      {
        request_id: "cron-crash-claim",
        task_id: crashedSeed.taskId,
        expected_version: crashedTaskBefore?.version ?? 1,
        lease_duration_seconds: 15,
      },
      f.getNow(),
    );

    // Duty 3 setup: overdue pending card
    const t3 = await createTask(
      f.db,
      f.botCtx,
      {
        request_id: "cron-t3",
        title: "Duty 3 Overdue Card",
        description: "",
        requires_approval: true,
      },
      f.getNow(),
    );
    const c3 = await claimTask(
      f.db,
      f.botCtx,
      {
        request_id: "cron-c3",
        task_id: t3.task_id,
        expected_version: t3.version,
        lease_duration_seconds: 120,
      },
      f.getNow(),
    );
    const p3 = await submitProposal(
      f.db,
      f.botCtx,
      {
        request_id: "cron-p3",
        task_id: t3.task_id,
        expected_version: c3.version,
        lease_token: c3.lease_token,
        proposals: [
          {
            card_type: "policy",
            selection_mode: "binary",
            title: "期限切れカード",
            summary: "60秒で期限切れ",
            on_accept_effect: "次へ",
            on_decline_effect: "改訂",
            on_decline_policy: "revise",
            factors: [],
            expires_in_seconds: 60,
          },
        ],
      },
      f.getNow(),
    );
    const card3Id = p3.cards[0]?.card_id ?? "";

    // M2 setup: candidate group where Card A is finalized declined first, then Card B is finalized accepted!
    const tGrp = await createTask(
      f.db,
      f.botCtx,
      {
        request_id: "grp-t",
        title: "M2 グループ順序テスト",
        description: "",
        requires_approval: true,
      },
      f.getNow(),
    );
    const cGrp = await claimTask(
      f.db,
      f.botCtx,
      {
        request_id: "grp-c",
        task_id: tGrp.task_id,
        expected_version: tGrp.version,
        lease_duration_seconds: 120,
      },
      f.getNow(),
    );
    const pGrp = await submitProposal(
      f.db,
      f.botCtx,
      {
        request_id: "grp-p",
        task_id: tGrp.task_id,
        expected_version: cGrp.version,
        lease_token: cGrp.lease_token,
        selection_group_id: "grp-m2-order",
        proposals: [
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "案A（先に却下）",
            summary: "S",
            on_accept_effect: "A",
            on_decline_effect: "D",
            on_decline_policy: "revise",
            factors: [],
          },
          {
            card_type: "choice",
            selection_mode: "binary",
            title: "案B（後で採用）",
            summary: "S",
            on_accept_effect: "A",
            on_decline_effect: "D",
            on_decline_policy: "revise",
            factors: [],
          },
        ],
      },
      f.getNow(),
    );
    const cardAId = pGrp.cards[0]?.card_id ?? "";
    const cardBId = pGrp.cards[1]?.card_id ?? "";

    // Finalize Card A as declined first
    await f.sqliteDb.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: "declined",
        provisionalUntil: f.getNow() + 5_000,
        version: 2,
      })
      .where(eq(schema.decisionCards.id, cardAId));
    await f.sqliteDb.orm.insert(schema.decisions).values({
      id: "dec-grp-a-declined",
      cardId: cardAId,
      actorUserId: f.ownerUserId,
      result: "declined",
      selectedOptionIdsJson: "[]",
      status: "provisional",
      cardVersion: 2,
      finalizedTaskVersion: null,
      provisionalAt: f.getNow(),
      finalizedAt: null,
      canceledAt: null,
      consumedAt: null,
    });
    f.advanceNow(6_000);
    await finalizeDecisionCard(f.db, cardAId, { source: "queue", nowMs: f.getNow() });

    // Then finalize Card B as accepted
    await f.sqliteDb.orm
      .update(schema.decisionCards)
      .set({
        status: "provisional",
        provisionalResult: "accepted",
        provisionalUntil: f.getNow() + 5_000,
        version: 2,
      })
      .where(eq(schema.decisionCards.id, cardBId));
    await f.sqliteDb.orm.insert(schema.decisions).values({
      id: "dec-grp-b-accepted",
      cardId: cardBId,
      actorUserId: f.ownerUserId,
      result: "accepted",
      selectedOptionIdsJson: "[]",
      status: "provisional",
      cardVersion: 2,
      finalizedTaskVersion: null,
      provisionalAt: f.getNow(),
      finalizedAt: null,
      canceledAt: null,
      consumedAt: null,
    });
    f.advanceNow(6_000);
    await finalizeDecisionCard(f.db, cardBId, { source: "queue", nowMs: f.getNow() });

    // Verify M2: dec-grp-a-declined was atomically marked consumed when Card B resolved the group!
    const decA = await f.sqliteDb.orm
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.id, "dec-grp-a-declined"))
      .get();
    expect(decA?.consumedAt).not.toBeNull();

    // Clear queue log, advance 90s, and run single Cron tick!
    f.botWorkQueueSent.length = 0;
    f.advanceNow(90_000);
    const report = await handleScheduledTrigger(
      { cron: "* * * * *", scheduledTime: f.getNow() },
      { DB: f.d1, BOT_WORK_QUEUE: f.botWorkQueue },
    );

    expect(report.finalizedCount).toBe(1);
    expect(report.releasedLeasesCount).toBe(1);
    expect(report.expiredCardsCount).toBe(1);

    // M1: dec-cron-duty1 MUST be dispatched EXACTLY ONCE (not twice!) in this Cron tick!
    expect(f.botWorkQueueSent.filter((m) => m.decision_id === "dec-cron-duty1")).toHaveLength(1);
    // M2: For tGrp, ONLY dec-grp-b-accepted is dispatched (NEVER dec-grp-a-declined)!
    expect(f.botWorkQueueSent.filter((m) => m.task_id === tGrp.task_id)).toHaveLength(1);
    expect(f.botWorkQueueSent.find((m) => m.task_id === tGrp.task_id)?.decision_id).toBe(
      "dec-grp-b-accepted",
    );
    // Duty 2 recovered crashedSeed -> now executes cleanly with NO false DEC-03 reconfirmation!
    const crashedMsg = f.botWorkQueueSent.find((m) => m.decision_id === crashedSeed.decisionId);
    expect(crashedMsg).toBeDefined();
    const recoverRun = createQueueBatch("bot-work", [crashedMsg], f.getNow());
    await handleBotWorkBatch(
      recoverRun.batch,
      { DB: f.d1, MODEL_ADAPTER: createLocalScenarioModelAdapter() },
      { nowMs: f.getNow() },
    );
    expect(recoverRun.actions[0]?.acked).toBe(1);
    const crashedProps = await f.sqliteDb.orm
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.taskId, crashedSeed.taskId))
      .all();
    expect(crashedProps.some((p) => p.title.startsWith("[再確認]"))).toBe(false);
    expect(crashedProps.some((p) => p.cardType === "deliverable")).toBe(true);

    // Duty 3 verified
    const c3After = await f.sqliteDb.orm
      .select()
      .from(schema.decisionCards)
      .where(eq(schema.decisionCards.id, card3Id))
      .get();
    expect(c3After?.status).toBe("expired");

    // B2: releaseExpiredWorkLeases atomically guards task status & version (clean no-op when lease expired & task already moved)
    expect(await releaseExpiredWorkLeases(f.db, { nowMs: f.getNow() })).toBe(0);

    // Minor 5 + BOT-02: Revoking the sole worker_bearer stops BOTH Cron Duty #4 dispatches AND bot-work execution!
    await f.sqliteDb.orm
      .update(schema.botConnections)
      .set({ status: "revoked" })
      .where(eq(schema.botConnections.id, f.workerBotId));

    f.botWorkQueueSent.length = 0;
    const revokedReport = await handleScheduledTrigger(
      { cron: "* * * * *", scheduledTime: f.getNow() + 60_000 },
      { DB: f.d1, BOT_WORK_QUEUE: f.botWorkQueue },
    );
    expect(revokedReport.redispatchedDecisionsCount).toBe(0);

    let revokedAdapterCalls = 0;
    const revokedBatch = createQueueBatch(
      "bot-work",
      [{ decision_id: "dec-grp-b-accepted", task_id: tGrp.task_id, workspace_id: f.workspaceId }],
      f.getNow() + 60_000,
    );
    await handleBotWorkBatch(
      revokedBatch.batch,
      {
        DB: f.d1,
        MODEL_ADAPTER: createScriptedModelAdapter("revoked-spy", () => {
          revokedAdapterCalls += 1;
          return { action: "update_task", status: "ready", estimated_cost_cents: 0 };
        }),
      },
      { nowMs: f.getNow() + 60_000 },
    );
    expect(revokedBatch.actions[0]?.acked).toBe(1);
    expect(revokedAdapterCalls).toBe(0);

    // Minor 1: An active worker_bearer WITHOUT tasks:write scope is skipped by Cron Duty #4 (prevents infinite re-dispatch)
    await f.sqliteDb.orm
      .update(schema.botConnections)
      .set({ status: "active", scopes: JSON.stringify(["tasks:read", "decisions:read"]) })
      .where(eq(schema.botConnections.id, f.workerBotId));

    f.botWorkQueueSent.length = 0;
    const readOnlyWorkerReport = await handleScheduledTrigger(
      { cron: "* * * * *", scheduledTime: f.getNow() + 61_000 },
      { DB: f.d1, BOT_WORK_QUEUE: f.botWorkQueue },
    );
    expect(readOnlyWorkerReport.redispatchedDecisionsCount).toBe(0);

    // Prefixed queue dispatch smoke check
    const prefixedDlq = createQueueBatch("bot-board-staging-bot-work-dlq", [], f.getNow());
    await workerHandler.queue(
      prefixedDlq.batch,
      {
        DB: f.d1,
        DECISION_FINALIZE_QUEUE: f.finalizeQueue,
        BOT_WORK_QUEUE: f.botWorkQueue,
        BOT_WORK_DLQ: f.botWorkQueue,
      },
      { waitUntil() {} },
    );
  });

  test("refreshes post-LLM wall-clock timestamps and uses deterministic subtask request_ids (M4, Minor 2)", async () => {
    const f = await setupWorkerFixture();

    const created = await createTask(
      f.db,
      f.botCtx,
      {
        request_id: "m4-create-1",
        title: "Slow Model Step Task",
        description: "Verify post-LLM timestamp refresh and idempotent subtask creation",
        requires_approval: true,
      },
      Date.now(),
    );

    const startWallMs = Date.now();
    const slowAdapter = createScriptedModelAdapter("slow-subtask-adapter", async () => {
      await Bun.sleep(25);
      return {
        action: "update_task",
        status: "ready",
        description: "Decomposed into 1 subtask",
        subtasks: [
          {
            title: "Deterministic Subtask",
            description: "Should not duplicate on retry",
            requires_approval: true,
          },
        ],
        estimated_cost_cents: 1,
      };
    });

    const batch = createQueueBatch(
      "bot-work",
      [{ task_id: created.task_id, workspace_id: f.workspaceId }],
      startWallMs,
    );
    // Omit nowMs so worker-step computes real wall-clock before and after executeStep()
    await handleBotWorkBatch(batch.batch, { DB: f.d1, MODEL_ADAPTER: slowAdapter });
    expect(batch.actions[0]?.acked).toBe(1);

    const stepEvent = await f.sqliteDb.orm
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityId, created.task_id),
          eq(schema.events.action, "worker.step_executed"),
        ),
      )
      .get();
    expect(stepEvent).toBeDefined();
    expect(stepEvent?.createdAt ?? 0).toBeGreaterThanOrEqual(startWallMs + 20);

    // Verify subtask idempotency key uses deterministic request_id (no random suffix)
    const subKey = await f.sqliteDb.orm
      .select()
      .from(schema.idempotencyKeys)
      .where(
        and(
          eq(schema.idempotencyKeys.workspaceId, f.workspaceId),
          eq(schema.idempotencyKeys.operation, "create_task"),
          eq(schema.idempotencyKeys.requestId, `worker-sub-${created.task_id}-v2-0`),
        ),
      )
      .get();
    expect(subKey).toBeDefined();
  });
});
