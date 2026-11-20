import { and, desc, eq, gt, inArray, isNotNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { type OwnerContext } from "@/auth/context";
import { generateWorkerBearerToken } from "@/auth/token-hash";
import { type AppDatabase, guardedBatch, type RawSqlStatement, schema } from "@/db";
import {
  assertCanRetryTask,
  assertExpectedVersion,
  BOT_SCOPES,
  type BotScope,
  type BudgetLimit,
  DEFAULT_BUDGET_LIMIT,
  DomainError,
  parseBudgetLimit,
  SELECTION_MODES,
  type SelectionMode,
  serializeBudgetLimit,
  TASK_STATUSES,
  type TaskStatus,
} from "@/domain";
import {
  type CreateWorkerBotInput,
  createWorkerBotInputSchema,
  type ListHumanHistoryQuery,
  listHumanHistoryQuerySchema,
  type RetryHumanTaskInput,
  retryHumanTaskInputSchema,
  type UpdateHumanBotInput,
  updateHumanBotInputSchema,
  type UpdateHumanWorkspaceInput,
  updateHumanWorkspaceInputSchema,
} from "@/services/human/schemas";
import {
  type BotWorkQueueProducer,
  buildInsertIdempotencyKeySql,
  canonicalJsonHash,
  finalizeExpiredProvisionalCards,
  generateEntityId,
  lookupIdempotentResponse,
  runWithIdempotencyRaceGuard,
} from "@/services/system";
import { createLogger } from "@/shared/logger";

const humanWorkspaceLogger = createLogger("human-workspace");

export interface HumanWorkspaceServiceDeps {
  readonly botWorkQueue?: BotWorkQueueProducer;
  readonly now?: () => number;
}

export interface HumanBoardBotSummary {
  readonly id: string;
  readonly display_name: string;
  readonly channel_type: "mcp_oauth" | "worker_bearer";
  readonly status: "active" | "paused" | "revoked";
  readonly counts: {
    readonly running: number;
    readonly waiting_human: number;
    readonly failed: number;
    readonly blocked: number;
    readonly ready: number;
    readonly done: number;
  };
}

export interface HumanBoardTaskItem {
  readonly id: string;
  readonly parent_task_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly status_reason: string | null;
  readonly requires_approval: boolean;
  readonly assigned_bot_id: string | null;
  readonly assigned_bot_name: string | null;
  readonly retry_count: number;
  readonly version: number;
  readonly updated_at: number;
  readonly active_lease: {
    readonly bot_id: string;
    readonly expires_at: number;
  } | null;
}

export interface HumanBoardResult {
  readonly workspace: {
    readonly id: string;
    readonly is_paused: boolean;
    readonly version: number;
  };
  readonly bots: readonly HumanBoardBotSummary[];
  readonly tasks: readonly HumanBoardTaskItem[];
  readonly columns: Record<TaskStatus, readonly HumanBoardTaskItem[]>;
}

const retryTaskResultSchema = z.object({
  task_id: z.string(),
  version: z.number().int(),
  status: z.literal("ready"),
  trace_id: z.string(),
});
export type RetryHumanTaskResult = z.infer<typeof retryTaskResultSchema>;

export interface HumanHistoryItem {
  readonly decision_id: string;
  readonly card_id: string;
  readonly task_id: string;
  readonly task_title: string;
  readonly proposal_title: string;
  readonly selection_mode: SelectionMode;
  readonly decision_result: "accepted" | "declined";
  readonly selected_option_ids: readonly string[];
  readonly execution_status: TaskStatus;
  readonly execution_reason: string | null;
  readonly bot_name: string;
  readonly artifact: {
    readonly id: string;
    readonly title: string;
    readonly version: number;
  } | null;
  readonly finalized_at: number;
}

export interface HumanHistoryResult {
  readonly items: readonly HumanHistoryItem[];
  readonly next_cursor: string | null;
}

export interface HumanWorkspaceView {
  readonly id: string;
  readonly goal: string;
  readonly allowed_scope: string;
  readonly budget_limit: BudgetLimit;
  readonly is_paused: boolean;
  readonly version: number;
  readonly updated_at: number;
}

const updateWorkspaceResultSchema = z.object({
  id: z.string(),
  goal: z.string(),
  allowed_scope: z.string(),
  budget_limit: z.object({
    max_cards_per_day: z.number().int(),
    max_steps_per_task: z.number().int(),
    daily_cost_limit_cents: z.number().int(),
  }),
  is_paused: z.boolean(),
  version: z.number().int(),
  updated_at: z.number().int(),
  trace_id: z.string(),
});
export type UpdateHumanWorkspaceResult = z.infer<typeof updateWorkspaceResultSchema>;

export interface HumanBotConnectionView {
  readonly id: string;
  readonly display_name: string;
  readonly channel_type: "mcp_oauth" | "worker_bearer";
  readonly oauth_client_id: string | null;
  readonly scopes: readonly BotScope[];
  readonly status: "active" | "paused" | "revoked";
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

const createWorkerBotStoredSchema = z.object({
  bot_id: z.string(),
  display_name: z.string(),
  channel_type: z.literal("worker_bearer"),
  scopes: z.array(z.enum(BOT_SCOPES)),
  status: z.literal("active"),
  version: z.number().int(),
  trace_id: z.string(),
});

export interface CreateWorkerBotResult {
  readonly bot_id: string;
  readonly display_name: string;
  readonly channel_type: "worker_bearer";
  readonly scopes: readonly BotScope[];
  readonly status: "active";
  readonly version: number;
  readonly bearer_token: string | null;
  readonly trace_id: string;
}

const updateBotResultSchema = z.object({
  bot_id: z.string(),
  display_name: z.string(),
  channel_type: z.enum(["mcp_oauth", "worker_bearer"]),
  scopes: z.array(z.enum(BOT_SCOPES)),
  status: z.enum(["active", "paused", "revoked"]),
  version: z.number().int(),
  trace_id: z.string(),
});
export type UpdateHumanBotResult = z.infer<typeof updateBotResultSchema>;

function parseTaskStatus(raw: string): TaskStatus {
  for (const status of TASK_STATUSES) {
    if (status === raw) {
      return status;
    }
  }
  return "ready";
}

function parseSelectionMode(raw: string): SelectionMode {
  for (const mode of SELECTION_MODES) {
    if (mode === raw) {
      return mode;
    }
  }
  return "binary";
}

function parseChannelType(raw: string): "mcp_oauth" | "worker_bearer" {
  return raw === "mcp_oauth" ? "mcp_oauth" : "worker_bearer";
}

function parseBotStatus(raw: string): "active" | "paused" | "revoked" {
  if (raw === "paused" || raw === "revoked") {
    return raw;
  }
  return "active";
}

function parseStoredScopes(raw: string): readonly BotScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const scopes: BotScope[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        for (const valid of BOT_SCOPES) {
          if (valid === item && !scopes.includes(valid)) {
            scopes.push(valid);
          }
        }
      }
    }
    return scopes;
  } catch {
    return [];
  }
}

function parseSelectedIds(raw: string | null): readonly string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const checked = z.array(z.string()).safeParse(parsed);
    return checked.success ? checked.data : [];
  } catch {
    return [];
  }
}

function parseHistoryCursor(cursor: string): { readonly timestamp: number; readonly id: string } {
  const sep = cursor.indexOf(":");
  if (sep <= 0 || sep === cursor.length - 1) {
    throw new DomainError("VALIDATION_ERROR", "Invalid cursor format.", false);
  }
  const tsPart = cursor.slice(0, sep);
  const idPart = cursor.slice(sep + 1);
  if (!/^\d+$/.test(tsPart) || idPart.trim() === "") {
    throw new DomainError("VALIDATION_ERROR", "Invalid cursor timestamp or id.", false);
  }
  const timestamp = Number(tsPart);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new DomainError("VALIDATION_ERROR", "Cursor timestamp out of safe integer range.", false);
  }
  return { timestamp, id: idPart };
}

export async function getHumanBoard(
  db: AppDatabase,
  ctx: OwnerContext,
  deps: HumanWorkspaceServiceDeps = {},
): Promise<HumanBoardResult> {
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  await finalizeExpiredProvisionalCards(db, {
    workspaceId: ctx.workspaceId,
    source: "on_demand",
    nowMs,
    ...(deps.botWorkQueue !== undefined ? { botWorkQueue: deps.botWorkQueue } : {}),
  });

  const [workspace, botRows, taskRows] = await Promise.all([
    db.orm.select().from(schema.workspaces).where(eq(schema.workspaces.id, ctx.workspaceId)).get(),
    db.orm
      .select()
      .from(schema.botConnections)
      .where(eq(schema.botConnections.workspaceId, ctx.workspaceId))
      .orderBy(desc(schema.botConnections.createdAt))
      .all(),
    db.orm
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.workspaceId, ctx.workspaceId))
      .orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.id))
      .all(),
  ]);

  if (workspace === undefined) {
    throw new DomainError("NOT_FOUND", "Workspace not found.", false);
  }

  // M2: Fixed-parameter JOIN avoids Cloudflare D1 100-variable limit even with 100+ tasks
  const leases = await db.orm
    .select({
      taskId: schema.workLeases.taskId,
      botId: schema.workLeases.botId,
      expiresAt: schema.workLeases.expiresAt,
    })
    .from(schema.workLeases)
    .innerJoin(schema.tasks, eq(schema.workLeases.taskId, schema.tasks.id))
    .where(
      and(eq(schema.tasks.workspaceId, ctx.workspaceId), gt(schema.workLeases.expiresAt, nowMs)),
    )
    .all();

  const leaseMap = new Map<string, { readonly bot_id: string; readonly expires_at: number }>();
  for (const lease of leases) {
    leaseMap.set(lease.taskId, {
      bot_id: lease.botId,
      expires_at: lease.expiresAt,
    });
  }

  const botNameById = new Map<string, string>();
  const botCountsById = new Map<
    string,
    {
      running: number;
      waiting_human: number;
      failed: number;
      blocked: number;
      ready: number;
      done: number;
    }
  >();

  for (const bot of botRows) {
    botNameById.set(bot.id, bot.displayName);
    botCountsById.set(bot.id, {
      running: 0,
      waiting_human: 0,
      failed: 0,
      blocked: 0,
      ready: 0,
      done: 0,
    });
  }

  const columns: Record<TaskStatus, HumanBoardTaskItem[]> = {
    failed: [],
    waiting_human: [],
    running: [],
    blocked: [],
    ready: [],
    done: [],
  };
  const tasks: HumanBoardTaskItem[] = [];

  for (const row of taskRows) {
    const status = parseTaskStatus(row.status);
    const activeLease = leaseMap.get(row.id) ?? null;
    const ownerBotId = activeLease?.bot_id ?? row.assignedBotId;
    if (ownerBotId !== null) {
      const counters = botCountsById.get(ownerBotId);
      if (counters !== undefined) {
        counters[status] += 1;
      }
    }
    const item: HumanBoardTaskItem = {
      id: row.id,
      parent_task_id: row.parentTaskId,
      title: row.title,
      description: row.description,
      status,
      status_reason: row.statusReason,
      requires_approval: row.requiresApproval,
      assigned_bot_id: row.assignedBotId,
      assigned_bot_name:
        row.assignedBotId !== null ? (botNameById.get(row.assignedBotId) ?? null) : null,
      retry_count: row.retryCount,
      version: row.version,
      updated_at: row.updatedAt,
      active_lease: activeLease,
    };
    tasks.push(item);
    columns[status].push(item);
  }

  const bots: HumanBoardBotSummary[] = botRows.map((bot) => ({
    id: bot.id,
    display_name: bot.displayName,
    channel_type: parseChannelType(bot.channelType),
    status: parseBotStatus(bot.status),
    counts: botCountsById.get(bot.id) ?? {
      running: 0,
      waiting_human: 0,
      failed: 0,
      blocked: 0,
      ready: 0,
      done: 0,
    },
  }));

  return {
    workspace: {
      id: workspace.id,
      is_paused: workspace.isPaused,
      version: workspace.version,
    },
    bots,
    tasks,
    columns,
  };
}

export async function retryHumanTask(
  db: AppDatabase,
  ctx: OwnerContext,
  taskId: string,
  rawInput: RetryHumanTaskInput,
  deps: HumanWorkspaceServiceDeps = {},
): Promise<RetryHumanTaskResult> {
  const input = retryHumanTaskInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "retry_task",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: taskId,
    expected_version: input.expected_version,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    idempKey,
    inputHash,
    (raw) => retryTaskResultSchema.parse(raw),
    async () => {
      const task = await db.orm
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, ctx.workspaceId)))
        .get();

      if (task === undefined) {
        throw new DomainError("NOT_FOUND", `Task "${taskId}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, task.version, "Task");
      assertCanRetryTask(parseTaskStatus(task.status));

      const traceId = generateEntityId("evt");
      const receipt: RetryHumanTaskResult = {
        task_id: task.id,
        version: task.version + 1,
        status: "ready",
        trace_id: traceId,
      };

      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE tasks
                SET status = 'ready', status_reason = 'Retried by owner', version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status IN ('failed', 'blocked') AND version = ?`,
          params: [nowMs, task.id, ctx.workspaceId, task.version],
        },
        followUps: [
          {
            sql: "DELETE FROM work_leases WHERE task_id = ?",
            params: [task.id],
          },
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'task', ?, 'task.retried', ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.userId,
              task.id,
              JSON.stringify({ previous_status: task.status, next_status: "ready" }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(idempKey, inputHash, receipt, nowMs),
        ],
      });

      if (!batchOutcome.applied) {
        const latest = await db.orm
          .select({ status: schema.tasks.status, version: schema.tasks.version })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, task.id))
          .get();
        if (latest !== undefined && latest.version !== input.expected_version) {
          throw new DomainError(
            "VERSION_CONFLICT",
            `Task version conflict (expected ${input.expected_version}, actual ${latest.version}).`,
            false,
            { currentVersion: latest.version },
          );
        }
        throw new DomainError(
          "INVALID_TRANSITION",
          "Task is no longer in failed or blocked status.",
          false,
        );
      }

      if (deps.botWorkQueue !== undefined) {
        try {
          await deps.botWorkQueue.send({
            task_id: task.id,
            workspace_id: ctx.workspaceId,
          });
        } catch (error) {
          humanWorkspaceLogger.warn("Failed to enqueue bot-work after retry (Cron will recover)", {
            error,
            taskId: task.id,
          });
        }
      }

      return receipt;
    },
  );
}

export async function listHumanHistory(
  db: AppDatabase,
  ctx: OwnerContext,
  rawQuery: Partial<ListHumanHistoryQuery> = {},
  deps: HumanWorkspaceServiceDeps = {},
): Promise<HumanHistoryResult> {
  const query = listHumanHistoryQuerySchema.parse(rawQuery);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();

  await finalizeExpiredProvisionalCards(db, {
    workspaceId: ctx.workspaceId,
    source: "on_demand",
    nowMs,
    ...(deps.botWorkQueue !== undefined ? { botWorkQueue: deps.botWorkQueue } : {}),
  });

  const conditions = [
    eq(schema.decisionCards.workspaceId, ctx.workspaceId),
    eq(schema.decisions.status, "finalized"),
    inArray(schema.decisionCards.status, ["accepted", "declined"]),
    isNotNull(schema.decisions.finalizedAt),
  ];

  if (query.filter === "accepted" || query.filter === "declined") {
    conditions.push(eq(schema.decisions.result, query.filter));
  } else if (query.filter === "failed") {
    conditions.push(eq(schema.tasks.status, "failed"));
  }

  if (query.cursor !== undefined) {
    const parsedCursor = parseHistoryCursor(query.cursor);
    const cursorCond = or(
      lt(schema.decisions.finalizedAt, parsedCursor.timestamp),
      and(
        eq(schema.decisions.finalizedAt, parsedCursor.timestamp),
        lt(schema.decisions.id, parsedCursor.id),
      ),
    );
    if (cursorCond !== undefined) {
      conditions.push(cursorCond);
    }
  }

  const rows = await db.orm
    .select({
      decision: schema.decisions,
      card: schema.decisionCards,
      proposal: schema.proposals,
      task: schema.tasks,
      botName: schema.botConnections.displayName,
      artifactId: schema.artifacts.id,
      artifactTitle: schema.artifacts.title,
      artifactVersion: schema.artifacts.version,
    })
    .from(schema.decisions)
    .innerJoin(schema.decisionCards, eq(schema.decisions.cardId, schema.decisionCards.id))
    .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
    .innerJoin(schema.tasks, eq(schema.proposals.taskId, schema.tasks.id))
    .innerJoin(schema.botConnections, eq(schema.proposals.proposerBotId, schema.botConnections.id))
    .leftJoin(
      schema.artifacts,
      and(
        eq(schema.proposals.targetArtifactId, schema.artifacts.id),
        eq(schema.artifacts.workspaceId, ctx.workspaceId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.decisions.finalizedAt), desc(schema.decisions.id))
    .limit(query.limit + 1)
    .all();

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;

  const items: HumanHistoryItem[] = pageRows.map((row) => ({
    decision_id: row.decision.id,
    card_id: row.card.id,
    task_id: row.task.id,
    task_title: row.task.title,
    proposal_title: row.proposal.title,
    selection_mode: parseSelectionMode(row.proposal.selectionMode),
    decision_result: row.decision.result === "accepted" ? "accepted" : "declined",
    selected_option_ids: parseSelectedIds(row.decision.selectedOptionIdsJson),
    execution_status: parseTaskStatus(row.task.status),
    execution_reason: row.task.statusReason,
    bot_name: row.botName,
    artifact:
      row.artifactId !== null && row.artifactTitle !== null && row.artifactVersion !== null
        ? {
            id: row.artifactId,
            title: row.artifactTitle,
            version: row.artifactVersion,
          }
        : null,
    finalized_at: row.decision.finalizedAt ?? row.decision.provisionalAt,
  }));

  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last !== undefined && last.decision.finalizedAt !== null
      ? `${last.decision.finalizedAt}:${last.decision.id}`
      : null;

  return {
    items,
    next_cursor: nextCursor,
  };
}

export async function getHumanWorkspace(
  db: AppDatabase,
  ctx: OwnerContext,
): Promise<HumanWorkspaceView> {
  const workspace = await db.orm
    .select()
    .from(schema.workspaces)
    .where(
      and(eq(schema.workspaces.id, ctx.workspaceId), eq(schema.workspaces.ownerUserId, ctx.userId)),
    )
    .get();

  if (workspace === undefined) {
    throw new DomainError("NOT_FOUND", "Workspace not found.", false);
  }

  const budget: BudgetLimit = (() => {
    try {
      return parseBudgetLimit(workspace.budgetLimit);
    } catch {
      return DEFAULT_BUDGET_LIMIT;
    }
  })();

  return {
    id: workspace.id,
    goal: workspace.goal,
    allowed_scope: workspace.allowedScope,
    budget_limit: budget,
    is_paused: workspace.isPaused,
    version: workspace.version,
    updated_at: workspace.updatedAt,
  };
}

export async function updateHumanWorkspace(
  db: AppDatabase,
  ctx: OwnerContext,
  rawInput: UpdateHumanWorkspaceInput,
  deps: HumanWorkspaceServiceDeps = {},
): Promise<UpdateHumanWorkspaceResult> {
  const input = updateHumanWorkspaceInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "update_workspace",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    expected_version: input.expected_version,
    goal: input.goal,
    allowed_scope: input.allowed_scope,
    budget_limit: input.budget_limit,
    is_paused: input.is_paused,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    idempKey,
    inputHash,
    (raw) => updateWorkspaceResultSchema.parse(raw),
    async () => {
      const workspace = await db.orm
        .select()
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, ctx.workspaceId),
            eq(schema.workspaces.ownerUserId, ctx.userId),
          ),
        )
        .get();

      if (workspace === undefined) {
        throw new DomainError("NOT_FOUND", "Workspace not found.", false);
      }

      assertExpectedVersion(input.expected_version, workspace.version, "Workspace");

      const currentBudget: BudgetLimit = (() => {
        try {
          return parseBudgetLimit(workspace.budgetLimit);
        } catch {
          return DEFAULT_BUDGET_LIMIT;
        }
      })();
      const nextGoal = input.goal ?? workspace.goal;
      const nextAllowedScope = input.allowed_scope ?? workspace.allowedScope;
      const nextBudget = input.budget_limit ?? currentBudget;
      const nextIsPaused = input.is_paused ?? workspace.isPaused;
      const nextVersion = workspace.version + 1;
      const traceId = generateEntityId("evt");

      const receipt: UpdateHumanWorkspaceResult = {
        id: workspace.id,
        goal: nextGoal,
        allowed_scope: nextAllowedScope,
        budget_limit: nextBudget,
        is_paused: nextIsPaused,
        version: nextVersion,
        updated_at: nowMs,
        trace_id: traceId,
      };

      const actionName =
        input.is_paused !== undefined && input.is_paused !== workspace.isPaused
          ? nextIsPaused
            ? "workspace.paused"
            : "workspace.resumed"
          : "workspace.updated";

      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE workspaces
                SET goal = ?, allowed_scope = ?, budget_limit = ?, is_paused = ?, version = version + 1, updated_at = ?
                WHERE id = ? AND owner_user_id = ? AND version = ?`,
          params: [
            nextGoal,
            nextAllowedScope,
            serializeBudgetLimit(nextBudget),
            nextIsPaused ? 1 : 0,
            nowMs,
            workspace.id,
            ctx.userId,
            workspace.version,
          ],
        },
        followUps: [
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'workspace', ?, ?, ?, ?, ?)",
            params: [
              traceId,
              workspace.id,
              ctx.userId,
              workspace.id,
              actionName,
              JSON.stringify({ is_paused: nextIsPaused, version: nextVersion }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(idempKey, inputHash, receipt, nowMs),
        ],
      });

      if (!batchOutcome.applied) {
        const latest = await db.orm
          .select({ version: schema.workspaces.version })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspace.id))
          .get();
        throw new DomainError(
          "VERSION_CONFLICT",
          `Workspace version conflict (expected ${input.expected_version}, actual ${latest?.version ?? -1}).`,
          false,
          latest !== undefined ? { currentVersion: latest.version } : undefined,
        );
      }

      return receipt;
    },
  );
}

export async function listHumanBots(
  db: AppDatabase,
  ctx: OwnerContext,
): Promise<readonly HumanBotConnectionView[]> {
  const rows = await db.orm
    .select()
    .from(schema.botConnections)
    .where(eq(schema.botConnections.workspaceId, ctx.workspaceId))
    .orderBy(desc(schema.botConnections.createdAt), desc(schema.botConnections.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    display_name: row.displayName,
    channel_type: parseChannelType(row.channelType),
    oauth_client_id: row.oauthClientId,
    scopes: parseStoredScopes(row.scopes),
    status: parseBotStatus(row.status),
    version: row.version,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }));
}

export async function createWorkerBot(
  db: AppDatabase,
  ctx: OwnerContext,
  rawInput: CreateWorkerBotInput,
  deps: HumanWorkspaceServiceDeps = {},
): Promise<CreateWorkerBotResult> {
  const input = createWorkerBotInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "create_worker_bot",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    display_name: input.display_name,
    scopes: input.scopes,
  });

  const existing = await lookupIdempotentResponse(db, idempKey, inputHash, (raw) =>
    createWorkerBotStoredSchema.parse(raw),
  );
  if (existing.hit) {
    // Plaintext Bearer token is NEVER persisted in idempotency_keys; replay returns null bearer_token
    return {
      ...existing.response,
      bearer_token: null,
    };
  }

  const generated = await generateWorkerBearerToken();
  const botId = generateEntityId("bot");
  const traceId = generateEntityId("evt");
  const storedReceipt = {
    bot_id: botId,
    display_name: input.display_name,
    channel_type: "worker_bearer" as const,
    scopes: [...input.scopes],
    status: "active" as const,
    version: 1,
    trace_id: traceId,
  };

  try {
    await db.executor.batch([
      {
        sql: `INSERT INTO bot_connections (
          id, workspace_id, display_name, channel_type, oauth_client_id, token_hash, scopes, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, 'worker_bearer', NULL, ?, ?, 'active', 1, ?, ?)`,
        params: [
          botId,
          ctx.workspaceId,
          input.display_name,
          generated.tokenHash,
          JSON.stringify(input.scopes),
          nowMs,
          nowMs,
        ],
      },
      {
        sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'bot_connection', ?, 'bot.created', ?, ?, ?)",
        params: [
          traceId,
          ctx.workspaceId,
          ctx.userId,
          botId,
          JSON.stringify({
            display_name: input.display_name,
            channel_type: "worker_bearer",
            scopes: input.scopes,
          }),
          input.request_id,
          nowMs,
        ],
      },
      buildInsertIdempotencyKeySql(idempKey, inputHash, storedReceipt, nowMs),
    ]);
  } catch (error) {
    const replay = await lookupIdempotentResponse(db, idempKey, inputHash, (raw) =>
      createWorkerBotStoredSchema.parse(raw),
    );
    if (replay.hit) {
      return {
        ...replay.response,
        bearer_token: null,
      };
    }
    throw error;
  }

  return {
    ...storedReceipt,
    bearer_token: generated.plaintextToken,
  };
}

export async function updateHumanBot(
  db: AppDatabase,
  ctx: OwnerContext,
  botId: string,
  rawInput: UpdateHumanBotInput,
  deps: HumanWorkspaceServiceDeps = {},
): Promise<UpdateHumanBotResult> {
  const input = updateHumanBotInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "update_bot",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    bot_id: botId,
    expected_version: input.expected_version,
    display_name: input.display_name,
    scopes: input.scopes,
    status: input.status,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    idempKey,
    inputHash,
    (raw) => updateBotResultSchema.parse(raw),
    async () => {
      const bot = await db.orm
        .select()
        .from(schema.botConnections)
        .where(
          and(
            eq(schema.botConnections.id, botId),
            eq(schema.botConnections.workspaceId, ctx.workspaceId),
          ),
        )
        .get();

      if (bot === undefined) {
        throw new DomainError("NOT_FOUND", `Bot connection "${botId}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, bot.version, "BotConnection");

      const currentStatus = parseBotStatus(bot.status);
      if (currentStatus === "revoked") {
        throw new DomainError(
          "INVALID_TRANSITION",
          "Revoked bot connections are permanently disabled and cannot be modified.",
          false,
        );
      }

      const nextDisplayName = input.display_name ?? bot.displayName;
      const nextScopes = input.scopes ?? [...parseStoredScopes(bot.scopes)];
      const nextStatus = input.status ?? currentStatus;
      const nextVersion = bot.version + 1;
      const traceId = generateEntityId("evt");

      const receipt: UpdateHumanBotResult = {
        bot_id: bot.id,
        display_name: nextDisplayName,
        channel_type: parseChannelType(bot.channelType),
        scopes: [...nextScopes],
        status: nextStatus,
        version: nextVersion,
        trace_id: traceId,
      };

      const followUps: RawSqlStatement[] = [];
      if (nextStatus === "revoked") {
        // BOT-02: Atomically clear active WorkLeases, release running tasks, and revoke OAuth tokens/consents
        followUps.push(
          {
            sql: "DELETE FROM work_leases WHERE bot_id = ?",
            params: [bot.id],
          },
          {
            sql: `UPDATE tasks
                  SET status = 'ready', assigned_bot_id = NULL, status_reason = 'Assigned bot connection revoked', version = version + 1, updated_at = ?
                  WHERE workspace_id = ? AND assigned_bot_id = ? AND status = 'running'`,
            params: [nowMs, ctx.workspaceId, bot.id],
          },
        );
        if (bot.oauthClientId !== null) {
          followUps.push(
            {
              sql: "UPDATE oauthAccessToken SET revoked = ? WHERE clientId = ? AND userId = ? AND revoked IS NULL",
              params: [nowMs, bot.oauthClientId, ctx.userId],
            },
            {
              sql: "UPDATE oauthRefreshToken SET revoked = ? WHERE clientId = ? AND userId = ? AND revoked IS NULL",
              params: [nowMs, bot.oauthClientId, ctx.userId],
            },
            {
              sql: "DELETE FROM oauthConsent WHERE clientId = ? AND userId = ?",
              params: [bot.oauthClientId, ctx.userId],
            },
          );
        }
      }

      const eventAction =
        nextStatus === "revoked"
          ? "bot.revoked"
          : nextStatus === "paused" && currentStatus !== "paused"
            ? "bot.paused"
            : nextStatus === "active" && currentStatus === "paused"
              ? "bot.resumed"
              : "bot.updated";

      followUps.push(
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'bot_connection', ?, ?, ?, ?, ?)",
          params: [
            traceId,
            ctx.workspaceId,
            ctx.userId,
            bot.id,
            eventAction,
            JSON.stringify({
              status: nextStatus,
              scopes: nextScopes,
              version: nextVersion,
            }),
            input.request_id,
            nowMs,
          ],
        },
        buildInsertIdempotencyKeySql(idempKey, inputHash, receipt, nowMs),
      );

      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE bot_connections
                SET display_name = ?, scopes = ?, status = ?, version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status != 'revoked' AND version = ?`,
          params: [
            nextDisplayName,
            JSON.stringify(nextScopes),
            nextStatus,
            nowMs,
            bot.id,
            ctx.workspaceId,
            bot.version,
          ],
        },
        followUps,
      });

      if (!batchOutcome.applied) {
        const latest = await db.orm
          .select({ status: schema.botConnections.status, version: schema.botConnections.version })
          .from(schema.botConnections)
          .where(eq(schema.botConnections.id, bot.id))
          .get();
        if (latest?.status === "revoked") {
          throw new DomainError(
            "INVALID_TRANSITION",
            "Bot connection was concurrently revoked.",
            false,
          );
        }
        throw new DomainError(
          "VERSION_CONFLICT",
          `Bot connection version conflict (expected ${input.expected_version}, actual ${latest?.version ?? -1}).`,
          false,
          latest !== undefined ? { currentVersion: latest.version } : undefined,
        );
      }

      return receipt;
    },
  );
}
