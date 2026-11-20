import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { type VerifiedBotContext } from "@/auth/context";
import { type AppDatabase, guardedBatch, type RawSqlStatement, schema, type SqlParam } from "@/db";
import {
  assertCanClaimTask,
  assertCanSubmitProposal,
  assertCanSupersedeProposal,
  assertCardIsFinalizedForBot,
  assertExpectedVersion,
  assertGroupDeclinePolicyConsistency,
  DECISION_CARD_STATUSES,
  DECISION_RECORD_STATUSES,
  type DecisionCardStatus,
  type DecisionRecordStatus,
  DomainError,
  ON_DECLINE_POLICIES,
  type OnDeclinePolicy,
  resolveTaskStatusOnRecordResult,
  TASK_STATUSES,
  type TaskStatus,
} from "@/domain";
import { assertBotWriteAccess } from "@/services/bot/guards";
import {
  type ArtifactUpsertInput,
  type ClaimTaskInput,
  claimTaskInputSchema,
  type CreateTaskInput,
  createTaskInputSchema,
  type ProposalItemInput,
  type RecordResultInput,
  recordResultInputSchema,
  type RenewLeaseInput,
  renewLeaseInputSchema,
  type SubmitProposalInput,
  submitProposalInputSchema,
  type SupersedeProposalInput,
  supersedeProposalInputSchema,
  type UpdateTaskInput,
  updateTaskInputSchema,
} from "@/services/bot/schemas";
import {
  buildInsertIdempotencyKeySql,
  canonicalJsonHash,
  generateEntityId,
  generateLeaseToken,
  runWithIdempotencyRaceGuard,
} from "@/services/system/idempotency";

const createTaskResultSchema = z.object({
  task_id: z.string(),
  version: z.number().int(),
  status: z.enum(TASK_STATUSES),
  trace_id: z.string(),
});
export type CreateTaskResult = z.infer<typeof createTaskResultSchema>;

const claimTaskResultSchema = z.object({
  task_id: z.string(),
  version: z.number().int(),
  status: z.enum(TASK_STATUSES),
  lease_token: z.string(),
  lease_expires_at: z.number().int(),
  trace_id: z.string(),
});
export type ClaimTaskResult = z.infer<typeof claimTaskResultSchema>;

const renewLeaseResultSchema = z.object({
  task_id: z.string(),
  lease_expires_at: z.number().int(),
  trace_id: z.string(),
});
export type RenewLeaseResult = z.infer<typeof renewLeaseResultSchema>;

const updateTaskResultSchema = z.object({
  task_id: z.string(),
  version: z.number().int(),
  status: z.enum(TASK_STATUSES),
  artifact_id: z.string().nullable(),
  artifact_version: z.number().int().nullable(),
  trace_id: z.string(),
});
export type UpdateTaskResult = z.infer<typeof updateTaskResultSchema>;

const submitProposalResultSchema = z.object({
  task_id: z.string(),
  task_version: z.number().int(),
  task_status: z.enum(TASK_STATUSES),
  selection_group_id: z.string().nullable(),
  cards: z.array(
    z.object({
      card_id: z.string(),
      proposal_id: z.string(),
      version: z.number().int(),
      status: z.enum(DECISION_CARD_STATUSES),
    }),
  ),
  artifact_id: z.string().nullable(),
  artifact_version: z.number().int().nullable(),
  trace_id: z.string(),
});
export type SubmitProposalResult = z.infer<typeof submitProposalResultSchema>;

const supersedeProposalResultSchema = z.object({
  task_id: z.string(),
  task_version: z.number().int(),
  superseded_card_id: z.string(),
  replacement_card_id: z.string(),
  replacement_proposal_id: z.string(),
  artifact_id: z.string().nullable(),
  artifact_version: z.number().int().nullable(),
  trace_id: z.string(),
});
export type SupersedeProposalResult = z.infer<typeof supersedeProposalResultSchema>;

const recordResultOutputSchema = z.object({
  task_id: z.string(),
  version: z.number().int(),
  status: z.enum(TASK_STATUSES),
  retry_count: z.number().int(),
  consumed_decision_id: z.string().nullable(),
  artifact_id: z.string().nullable(),
  artifact_version: z.number().int().nullable(),
  trace_id: z.string(),
});
export type RecordResultOutput = z.infer<typeof recordResultOutputSchema>;

const ACTIVE_BOT_AND_UNPAUSED_WS_SQL =
  " AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ? AND w.is_paused = 0) AND EXISTS (SELECT 1 FROM bot_connections bc WHERE bc.id = ? AND bc.workspace_id = ? AND bc.status = 'active')";

function activeBotAndWorkspaceParams(ctx: VerifiedBotContext): readonly SqlParam[] {
  return [ctx.workspaceId, ctx.botConnectionId, ctx.workspaceId];
}

function parseTaskStatusStrict(raw: string): TaskStatus {
  const matched = TASK_STATUSES.find((status) => status === raw);
  if (matched === undefined) {
    throw new DomainError("INVALID_TRANSITION", `Invalid stored task status "${raw}".`, false);
  }
  return matched;
}

function parseCardStatusStrict(raw: string): DecisionCardStatus {
  const matched = DECISION_CARD_STATUSES.find((status) => status === raw);
  if (matched === undefined) {
    throw new DomainError("INVALID_TRANSITION", `Invalid stored card status "${raw}".`, false);
  }
  return matched;
}

function parseDecisionStatusStrict(raw: string): DecisionRecordStatus {
  const matched = DECISION_RECORD_STATUSES.find((status) => status === raw);
  if (matched === undefined) {
    throw new DomainError("INVALID_TRANSITION", `Invalid stored decision status "${raw}".`, false);
  }
  return matched;
}

function parseOnDeclinePolicyStrict(raw: string): OnDeclinePolicy {
  const matched = ON_DECLINE_POLICIES.find((policy) => policy === raw);
  if (matched === undefined) {
    throw new DomainError("VALIDATION_ERROR", `Invalid stored on_decline_policy "${raw}".`, false);
  }
  return matched;
}

function validateProposalItemOptions(item: ProposalItemInput): void {
  const options = item.options ?? [];
  if (item.selection_mode === "binary") {
    if (options.length > 0) {
      throw new DomainError(
        "VALIDATION_ERROR",
        'Binary proposals must not include "options".',
        false,
      );
    }
    return;
  }

  if (options.length < 2) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Selection mode "${item.selection_mode}" requires at least 2 options.`,
      false,
    );
  }

  const seenIds = new Set<string>();
  for (const opt of options) {
    if (seenIds.has(opt.id)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Duplicate option id "${opt.id}" in proposal "${item.title}".`,
        false,
      );
    }
    seenIds.add(opt.id);
  }
}

function serializeProposalOptionsJson(item: ProposalItemInput): string | null {
  if (item.selection_mode === "binary") {
    return null;
  }
  return item.options !== undefined ? JSON.stringify(item.options) : null;
}

async function throwClassifiedMutationFailure(params: {
  readonly db: AppDatabase;
  readonly ctx: VerifiedBotContext;
  readonly taskId?: string;
  readonly expectedVersion?: number;
  readonly leaseToken?: string;
  readonly nowMs: number;
  readonly fallbackCode: "VERSION_CONFLICT" | "LEASE_CONFLICT" | "INVALID_TRANSITION";
  readonly fallbackMessage: string;
  readonly fallbackRetryable: boolean;
}): Promise<never> {
  const [ws, bot] = await Promise.all([
    params.db.orm
      .select({ isPaused: schema.workspaces.isPaused })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, params.ctx.workspaceId))
      .get(),
    params.db.orm
      .select({ status: schema.botConnections.status })
      .from(schema.botConnections)
      .where(
        and(
          eq(schema.botConnections.id, params.ctx.botConnectionId),
          eq(schema.botConnections.workspaceId, params.ctx.workspaceId),
        ),
      )
      .get(),
  ]);

  if (ws === undefined || bot === undefined || bot.status !== "active") {
    throw new DomainError(
      "NOT_AUTHORIZED",
      "Bot connection is paused, revoked, or unavailable.",
      false,
    );
  }
  if (ws.isPaused) {
    throw new DomainError("WORKSPACE_PAUSED", "Workspace is currently paused.", true);
  }

  if (params.taskId !== undefined) {
    const task = await params.db.orm
      .select({ status: schema.tasks.status, version: schema.tasks.version })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, params.taskId),
          eq(schema.tasks.workspaceId, params.ctx.workspaceId),
        ),
      )
      .get();

    if (task === undefined) {
      throw new DomainError("NOT_FOUND", `Task "${params.taskId}" not found.`, false);
    }

    if (params.expectedVersion !== undefined && task.version !== params.expectedVersion) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `Task version conflict (expected ${params.expectedVersion}, actual ${task.version}).`,
        false,
        { currentVersion: task.version },
      );
    }

    if (params.leaseToken !== undefined) {
      const lease = await params.db.orm
        .select()
        .from(schema.workLeases)
        .where(eq(schema.workLeases.taskId, params.taskId))
        .get();
      if (
        lease === undefined ||
        lease.botId !== params.ctx.botConnectionId ||
        lease.leaseToken !== params.leaseToken ||
        lease.expiresAt <= params.nowMs
      ) {
        throw new DomainError(
          "LEASE_CONFLICT",
          `Active lease for task "${params.taskId}" expired or was revoked.`,
          true,
        );
      }
    }
  }

  throw new DomainError(params.fallbackCode, params.fallbackMessage, params.fallbackRetryable);
}

interface PreparedArtifactUpsert {
  readonly artifactId: string;
  readonly artifactVersion: number;
  readonly parentConditionSql: string;
  readonly parentConditionParams: readonly SqlParam[];
  readonly statement: RawSqlStatement;
}

async function prepareArtifactUpsert(params: {
  readonly db: AppDatabase;
  readonly ctx: VerifiedBotContext;
  readonly taskId: string;
  readonly artifact: ArtifactUpsertInput;
  readonly nowMs: number;
}): Promise<PreparedArtifactUpsert> {
  if (params.artifact.id !== undefined) {
    const existing = await params.db.orm
      .select()
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.id, params.artifact.id),
          eq(schema.artifacts.workspaceId, params.ctx.workspaceId),
          eq(schema.artifacts.taskId, params.taskId),
        ),
      )
      .get();

    if (existing === undefined) {
      throw new DomainError("NOT_FOUND", `Artifact "${params.artifact.id}" not found.`, false);
    }

    const expectedArtVersion = params.artifact.expected_version;
    if (expectedArtVersion === undefined) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Updating an existing artifact requires artifact.expected_version.",
        false,
      );
    }

    assertExpectedVersion(expectedArtVersion, existing.version, "Artifact");
    const nextVersion = existing.version + 1;

    return {
      artifactId: existing.id,
      artifactVersion: nextVersion,
      parentConditionSql:
        " AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND workspace_id = ? AND task_id = ? AND version = ?)",
      parentConditionParams: [existing.id, params.ctx.workspaceId, params.taskId, existing.version],
      statement: {
        sql: "UPDATE artifacts SET title = ?, kind = ?, summary = ?, content_or_url = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND task_id = ? AND version = ?",
        params: [
          params.artifact.title,
          params.artifact.kind,
          params.artifact.summary,
          params.artifact.content_or_url,
          params.nowMs,
          existing.id,
          params.ctx.workspaceId,
          params.taskId,
          existing.version,
        ],
      },
    };
  }

  const newArtifactId = generateEntityId("art");
  return {
    artifactId: newArtifactId,
    artifactVersion: 1,
    parentConditionSql: "",
    parentConditionParams: [],
    statement: {
      sql: "INSERT INTO artifacts (id, workspace_id, task_id, created_by_bot_id, title, kind, summary, content_or_url, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      params: [
        newArtifactId,
        params.ctx.workspaceId,
        params.taskId,
        params.ctx.botConnectionId,
        params.artifact.title,
        params.artifact.kind,
        params.artifact.summary,
        params.artifact.content_or_url,
        params.nowMs,
        params.nowMs,
      ],
    },
  };
}

async function assertCallerHoldsActiveLease(params: {
  readonly db: AppDatabase;
  readonly ctx: VerifiedBotContext;
  readonly taskId: string;
  readonly leaseToken: string;
  readonly nowMs: number;
}): Promise<void> {
  const lease = await params.db.orm
    .select()
    .from(schema.workLeases)
    .where(eq(schema.workLeases.taskId, params.taskId))
    .get();

  if (
    lease === undefined ||
    lease.botId !== params.ctx.botConnectionId ||
    lease.leaseToken !== params.leaseToken ||
    lease.expiresAt <= params.nowMs
  ) {
    throw new DomainError(
      "LEASE_CONFLICT",
      `Valid active lease required for task "${params.taskId}".`,
      true,
    );
  }
}

export async function createTask(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: CreateTaskInput,
  nowMs = Date.now(),
): Promise<CreateTaskResult> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "tasks:write");
  const input = createTaskInputSchema.parse(rawInput);

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "create_task",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    title: input.title,
    description: input.description,
    parent_task_id: input.parent_task_id ?? null,
    requires_approval: input.requires_approval,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => createTaskResultSchema.parse(raw),
    async () => {
      if (input.parent_task_id !== undefined) {
        const parentTask = await db.orm
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.id, input.parent_task_id),
              eq(schema.tasks.workspaceId, ctx.workspaceId),
            ),
          )
          .get();
        if (parentTask === undefined) {
          throw new DomainError(
            "NOT_FOUND",
            `Parent task "${input.parent_task_id}" not found.`,
            false,
          );
        }
      }

      const taskId = generateEntityId("task");
      const traceId = generateEntityId("evt");
      const result: CreateTaskResult = {
        task_id: taskId,
        version: 1,
        status: "ready",
        trace_id: traceId,
      };

      const parentTaskCheckSql =
        input.parent_task_id !== undefined
          ? " AND EXISTS (SELECT 1 FROM tasks pt WHERE pt.id = ? AND pt.workspace_id = ?)"
          : "";
      const parentTaskCheckParams: SqlParam[] =
        input.parent_task_id !== undefined ? [input.parent_task_id, ctx.workspaceId] : [];

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `INSERT INTO tasks (id, workspace_id, parent_task_id, title, description, status, requires_approval, retry_count, version, created_at, updated_at) SELECT ?, ?, ?, ?, ?, 'ready', ?, 0, 1, ?, ? WHERE 1 = 1${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}${parentTaskCheckSql}`,
          params: [
            taskId,
            ctx.workspaceId,
            input.parent_task_id ?? null,
            input.title,
            input.description,
            input.requires_approval,
            nowMs,
            nowMs,
            ...activeBotAndWorkspaceParams(ctx),
            ...parentTaskCheckParams,
          ],
        },
        followUps: [
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'task', ?, 'task_created', ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.botConnectionId,
              taskId,
              JSON.stringify({ title: input.title, requires_approval: input.requires_approval }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
        ],
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          nowMs,
          fallbackCode: "INVALID_TRANSITION",
          fallbackMessage: "Failed to create task.",
          fallbackRetryable: true,
        });
      }

      return result;
    },
  );
}

export async function claimTask(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: ClaimTaskInput,
  nowMs = Date.now(),
): Promise<ClaimTaskResult> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "tasks:write");
  const input = claimTaskInputSchema.parse(rawInput);

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "claim_task",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: input.task_id,
    expected_version: input.expected_version,
    lease_duration_seconds: input.lease_duration_seconds,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => claimTaskResultSchema.parse(raw),
    async () => {
      const task = await db.orm
        .select()
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.id, input.task_id), eq(schema.tasks.workspaceId, ctx.workspaceId)),
        )
        .get();

      if (task === undefined) {
        throw new DomainError("NOT_FOUND", `Task "${input.task_id}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, task.version, "Task");
      assertCanClaimTask(parseTaskStatusStrict(task.status), ctx.isWorkspacePaused);

      const existingLease = await db.orm
        .select()
        .from(schema.workLeases)
        .where(eq(schema.workLeases.taskId, task.id))
        .get();

      if (existingLease !== undefined && existingLease.expiresAt > nowMs) {
        throw new DomainError(
          "LEASE_CONFLICT",
          `Task "${task.id}" is already leased until ${existingLease.expiresAt}.`,
          true,
        );
      }

      const leaseToken = generateLeaseToken();
      const leaseExpiresAt = nowMs + input.lease_duration_seconds * 1000;
      const nextVersion = task.version + 1;
      const traceId = generateEntityId("evt");

      const result: ClaimTaskResult = {
        task_id: task.id,
        version: nextVersion,
        status: "running",
        lease_token: leaseToken,
        lease_expires_at: leaseExpiresAt,
        trace_id: traceId,
      };

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE tasks SET status = 'running', assigned_bot_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'ready' AND version = ? AND NOT EXISTS (SELECT 1 FROM work_leases WHERE task_id = ? AND expires_at > ?)${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}`,
          params: [
            ctx.botConnectionId,
            nowMs,
            task.id,
            ctx.workspaceId,
            input.expected_version,
            task.id,
            nowMs,
            ...activeBotAndWorkspaceParams(ctx),
          ],
        },
        followUps: [
          {
            sql: "DELETE FROM work_leases WHERE task_id = ?",
            params: [task.id],
          },
          {
            sql: "INSERT INTO work_leases (task_id, bot_id, lease_token, expires_at) VALUES (?, ?, ?, ?)",
            params: [task.id, ctx.botConnectionId, leaseToken, leaseExpiresAt],
          },
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'task', ?, 'task_claimed', ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.botConnectionId,
              task.id,
              JSON.stringify({ lease_expires_at: leaseExpiresAt }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
        ],
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          taskId: task.id,
          expectedVersion: input.expected_version,
          nowMs,
          fallbackCode: "LEASE_CONFLICT",
          fallbackMessage: `Failed to acquire lease for "${task.id}".`,
          fallbackRetryable: true,
        });
      }

      return result;
    },
  );
}

export async function renewLease(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: RenewLeaseInput,
  nowMs = Date.now(),
): Promise<RenewLeaseResult> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "tasks:write");
  const input = renewLeaseInputSchema.parse(rawInput);

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "renew_lease",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: input.task_id,
    lease_token: input.lease_token,
    lease_duration_seconds: input.lease_duration_seconds,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => renewLeaseResultSchema.parse(raw),
    async () => {
      const nextExpiresAt = nowMs + input.lease_duration_seconds * 1000;
      const traceId = generateEntityId("evt");
      const result: RenewLeaseResult = {
        task_id: input.task_id,
        lease_expires_at: nextExpiresAt,
        trace_id: traceId,
      };

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE work_leases SET expires_at = ? WHERE task_id = ? AND bot_id = ? AND lease_token = ? AND expires_at > ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status = 'running')${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}`,
          params: [
            nextExpiresAt,
            input.task_id,
            ctx.botConnectionId,
            input.lease_token,
            nowMs,
            input.task_id,
            ctx.workspaceId,
            ...activeBotAndWorkspaceParams(ctx),
          ],
        },
        followUps: [
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'work_lease', ?, 'lease_renewed', ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.botConnectionId,
              input.task_id,
              JSON.stringify({ lease_expires_at: nextExpiresAt }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
        ],
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          taskId: input.task_id,
          leaseToken: input.lease_token,
          nowMs,
          fallbackCode: "LEASE_CONFLICT",
          fallbackMessage: `Cannot renew lease for task "${input.task_id}": lease expired, invalid token, or task not running.`,
          fallbackRetryable: true,
        });
      }

      return result;
    },
  );
}

export async function updateTask(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: UpdateTaskInput,
  nowMs = Date.now(),
): Promise<UpdateTaskResult> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "tasks:write");
  const input = updateTaskInputSchema.parse(rawInput);

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "update_task",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: input.task_id,
    expected_version: input.expected_version,
    lease_token: input.lease_token,
    description: input.description ?? null,
    status: input.status ?? null,
    status_reason: input.status_reason ?? null,
    artifact: input.artifact ?? null,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => updateTaskResultSchema.parse(raw),
    async () => {
      const task = await db.orm
        .select()
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.id, input.task_id), eq(schema.tasks.workspaceId, ctx.workspaceId)),
        )
        .get();

      if (task === undefined) {
        throw new DomainError("NOT_FOUND", `Task "${input.task_id}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, task.version, "Task");
      if (task.status !== "running") {
        throw new DomainError(
          "INVALID_TRANSITION",
          `Only "running" tasks can be updated via update_task (current: "${task.status}").`,
          false,
        );
      }

      await assertCallerHoldsActiveLease({
        db,
        ctx,
        taskId: task.id,
        leaseToken: input.lease_token,
        nowMs,
      });

      const preparedArtifact =
        input.artifact !== undefined
          ? await prepareArtifactUpsert({
              db,
              ctx,
              taskId: task.id,
              artifact: input.artifact,
              nowMs,
            })
          : null;

      const nextStatus: TaskStatus = input.status ?? "running";
      const nextDescription = input.description ?? task.description;
      const nextStatusReason =
        input.status_reason !== undefined ? input.status_reason : task.statusReason;
      const nextVersion = task.version + 1;
      const traceId = generateEntityId("evt");

      const result: UpdateTaskResult = {
        task_id: task.id,
        version: nextVersion,
        status: nextStatus,
        artifact_id: preparedArtifact?.artifactId ?? null,
        artifact_version: preparedArtifact?.artifactVersion ?? null,
        trace_id: traceId,
      };

      const followUps: RawSqlStatement[] = [];
      if (preparedArtifact !== null) {
        followUps.push(preparedArtifact.statement);
      }
      if (nextStatus === "blocked" || nextStatus === "ready") {
        followUps.push({
          sql: "DELETE FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ?",
          params: [task.id, ctx.botConnectionId, input.lease_token],
        });
      }
      followUps.push(
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'task', ?, 'task_updated', ?, ?, ?)",
          params: [
            traceId,
            ctx.workspaceId,
            ctx.botConnectionId,
            task.id,
            JSON.stringify({
              status: nextStatus,
              status_reason: nextStatusReason,
              artifact_id: preparedArtifact?.artifactId ?? null,
            }),
            input.request_id,
            nowMs,
          ],
        },
        buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
      );

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE tasks SET description = ?, status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'running' AND version = ? AND EXISTS (SELECT 1 FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ? AND expires_at > ?)${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}${preparedArtifact?.parentConditionSql ?? ""}`,
          params: [
            nextDescription,
            nextStatus,
            nextStatusReason,
            nowMs,
            task.id,
            ctx.workspaceId,
            input.expected_version,
            task.id,
            ctx.botConnectionId,
            input.lease_token,
            nowMs,
            ...activeBotAndWorkspaceParams(ctx),
            ...(preparedArtifact?.parentConditionParams ?? []),
          ],
        },
        followUps,
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          taskId: task.id,
          expectedVersion: input.expected_version,
          leaseToken: input.lease_token,
          nowMs,
          fallbackCode: "VERSION_CONFLICT",
          fallbackMessage: `Concurrent task, lease, or artifact conflict while updating "${task.id}".`,
          fallbackRetryable: false,
        });
      }

      return result;
    },
  );
}

export async function submitProposal(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: SubmitProposalInput,
  nowMs = Date.now(),
): Promise<SubmitProposalResult> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "proposals:write");
  const input = submitProposalInputSchema.parse(rawInput);

  for (const item of input.proposals) {
    validateProposalItemOptions(item);
  }
  assertGroupDeclinePolicyConsistency(input.proposals.map((item) => item.on_decline_policy));

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "submit_proposal",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: input.task_id,
    expected_version: input.expected_version,
    lease_token: input.lease_token,
    selection_group_id: input.selection_group_id ?? null,
    proposals: input.proposals,
    artifact: input.artifact ?? null,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => submitProposalResultSchema.parse(raw),
    async () => {
      const task = await db.orm
        .select()
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.id, input.task_id), eq(schema.tasks.workspaceId, ctx.workspaceId)),
        )
        .get();

      if (task === undefined) {
        throw new DomainError("NOT_FOUND", `Task "${input.task_id}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, task.version, "Task");
      assertCanSubmitProposal(parseTaskStatusStrict(task.status));

      await assertCallerHoldsActiveLease({
        db,
        ctx,
        taskId: task.id,
        leaseToken: input.lease_token,
        nowMs,
      });

      // B3: Reject reuse of any existing selection_group_id globally (generic error avoids cross-workspace leakage)
      if (input.selection_group_id !== undefined) {
        const collidingGroup = await db.orm
          .select({ id: schema.decisionCards.id })
          .from(schema.decisionCards)
          .where(eq(schema.decisionCards.selectionGroupId, input.selection_group_id))
          .get();
        if (collidingGroup !== undefined) {
          throw new DomainError(
            "VALIDATION_ERROR",
            "selection_group_id must be a fresh unused identifier.",
            false,
          );
        }
      }

      const preparedArtifact =
        input.artifact !== undefined
          ? await prepareArtifactUpsert({
              db,
              ctx,
              taskId: task.id,
              artifact: input.artifact,
              nowMs,
            })
          : null;

      // M4: Resolve and atomically guard any referenced non-upserted existing artifacts
      const referencedArtifactVersions = new Map<string, number>();
      const nonUpsertedArtifactGuards: { readonly id: string; readonly version: number }[] = [];

      if (preparedArtifact !== null) {
        referencedArtifactVersions.set(
          preparedArtifact.artifactId,
          preparedArtifact.artifactVersion,
        );
      }

      for (const item of input.proposals) {
        if (
          item.target_artifact_id !== undefined &&
          !referencedArtifactVersions.has(item.target_artifact_id)
        ) {
          const existingArt = await db.orm
            .select({ id: schema.artifacts.id, version: schema.artifacts.version })
            .from(schema.artifacts)
            .where(
              and(
                eq(schema.artifacts.id, item.target_artifact_id),
                eq(schema.artifacts.workspaceId, ctx.workspaceId),
                eq(schema.artifacts.taskId, task.id),
              ),
            )
            .get();
          if (existingArt === undefined) {
            throw new DomainError(
              "NOT_FOUND",
              `Referenced target_artifact_id "${item.target_artifact_id}" not found on task "${task.id}".`,
              false,
            );
          }
          referencedArtifactVersions.set(existingArt.id, existingArt.version);
          nonUpsertedArtifactGuards.push({ id: existingArt.id, version: existingArt.version });
        }
      }

      const nextTaskVersion = task.version + 1;
      const selectionGroupId =
        input.selection_group_id ?? (input.proposals.length > 1 ? generateEntityId("grp") : null);
      const traceId = generateEntityId("evt");

      const followUps: RawSqlStatement[] = [
        {
          sql: "DELETE FROM work_leases WHERE task_id = ?",
          params: [task.id],
        },
      ];

      if (preparedArtifact !== null) {
        followUps.push(preparedArtifact.statement);
      }

      const createdCards: {
        readonly card_id: string;
        readonly proposal_id: string;
        readonly version: number;
        readonly status: DecisionCardStatus;
      }[] = [];

      for (const item of input.proposals) {
        const proposalId = generateEntityId("prop");
        const cardId = generateEntityId("card");
        const targetArtifactId = item.target_artifact_id ?? preparedArtifact?.artifactId ?? null;
        const targetArtifactVersion =
          targetArtifactId !== null
            ? (referencedArtifactVersions.get(targetArtifactId) ?? null)
            : null;
        const payloadHash = await canonicalJsonHash(item);
        const expiresAt =
          item.expires_in_seconds !== undefined ? nowMs + item.expires_in_seconds * 1000 : null;

        followUps.push(
          {
            sql: "INSERT INTO proposals (id, workspace_id, task_id, proposer_bot_id, card_type, selection_mode, options_json, title, summary, on_accept_effect, on_decline_effect, on_decline_policy, factors_json, target_task_version, target_artifact_id, target_artifact_version, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: [
              proposalId,
              ctx.workspaceId,
              task.id,
              ctx.botConnectionId,
              item.card_type,
              item.selection_mode,
              serializeProposalOptionsJson(item),
              item.title,
              item.summary,
              item.on_accept_effect,
              item.on_decline_effect,
              item.on_decline_policy,
              JSON.stringify(item.factors),
              nextTaskVersion,
              targetArtifactId,
              targetArtifactVersion,
              payloadHash,
              nowMs,
            ],
          },
          {
            sql: "INSERT INTO decision_cards (id, workspace_id, proposal_id, selection_group_id, status, expires_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?)",
            params: [
              cardId,
              ctx.workspaceId,
              proposalId,
              selectionGroupId,
              expiresAt,
              nowMs,
              nowMs,
            ],
          },
        );

        createdCards.push({
          card_id: cardId,
          proposal_id: proposalId,
          version: 1,
          status: "pending",
        });
      }

      const result: SubmitProposalResult = {
        task_id: task.id,
        task_version: nextTaskVersion,
        task_status: "waiting_human",
        selection_group_id: selectionGroupId,
        cards: createdCards,
        artifact_id: preparedArtifact?.artifactId ?? null,
        artifact_version: preparedArtifact?.artifactVersion ?? null,
        trace_id: traceId,
      };

      followUps.push(
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'task', ?, 'proposal_submitted', ?, ?, ?)",
          params: [
            traceId,
            ctx.workspaceId,
            ctx.botConnectionId,
            task.id,
            JSON.stringify({
              selection_group_id: selectionGroupId,
              card_count: createdCards.length,
              card_ids: createdCards.map((c) => c.card_id),
            }),
            input.request_id,
            nowMs,
          ],
        },
        buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
      );

      let extraGuardSql = "";
      const extraGuardParams: SqlParam[] = [];
      if (selectionGroupId !== null) {
        extraGuardSql +=
          " AND NOT EXISTS (SELECT 1 FROM decision_cards WHERE selection_group_id = ?)";
        extraGuardParams.push(selectionGroupId);
      }
      for (const artGuard of nonUpsertedArtifactGuards) {
        extraGuardSql +=
          " AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND workspace_id = ? AND task_id = ? AND version = ?)";
        extraGuardParams.push(artGuard.id, ctx.workspaceId, task.id, artGuard.version);
      }

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE tasks SET status = 'waiting_human', version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'running' AND version = ? AND EXISTS (SELECT 1 FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ? AND expires_at > ?)${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}${preparedArtifact?.parentConditionSql ?? ""}${extraGuardSql}`,
          params: [
            nowMs,
            task.id,
            ctx.workspaceId,
            input.expected_version,
            task.id,
            ctx.botConnectionId,
            input.lease_token,
            nowMs,
            ...activeBotAndWorkspaceParams(ctx),
            ...(preparedArtifact?.parentConditionParams ?? []),
            ...extraGuardParams,
          ],
        },
        followUps,
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          taskId: task.id,
          expectedVersion: input.expected_version,
          leaseToken: input.lease_token,
          nowMs,
          fallbackCode: "VERSION_CONFLICT",
          fallbackMessage: `Concurrent conflict submitting proposal for task "${task.id}".`,
          fallbackRetryable: false,
        });
      }

      return result;
    },
  );
}

export async function supersedeProposal(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: SupersedeProposalInput,
  nowMs = Date.now(),
): Promise<SupersedeProposalResult> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "proposals:write");
  const input = supersedeProposalInputSchema.parse(rawInput);
  validateProposalItemOptions(input.replacement);

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "supersede_proposal",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: input.task_id,
    expected_version: input.expected_version,
    target_card_id: input.target_card_id,
    lease_token: input.lease_token ?? null,
    replacement: input.replacement,
    artifact: input.artifact ?? null,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => supersedeProposalResultSchema.parse(raw),
    async () => {
      const task = await db.orm
        .select()
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.id, input.task_id), eq(schema.tasks.workspaceId, ctx.workspaceId)),
        )
        .get();

      if (task === undefined) {
        throw new DomainError("NOT_FOUND", `Task "${input.task_id}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, task.version, "Task");

      const taskStatus = parseTaskStatusStrict(task.status);
      const isFromRunning = taskStatus === "running";

      if (isFromRunning) {
        if (input.lease_token === undefined) {
          throw new DomainError(
            "LEASE_CONFLICT",
            "Superseding a proposal while task is running requires lease_token.",
            true,
          );
        }
        await assertCallerHoldsActiveLease({
          db,
          ctx,
          taskId: task.id,
          leaseToken: input.lease_token,
          nowMs,
        });
      }

      const targetRow = await db.orm
        .select({
          cardId: schema.decisionCards.id,
          cardStatus: schema.decisionCards.status,
          selectionGroupId: schema.decisionCards.selectionGroupId,
          proposalId: schema.decisionCards.proposalId,
          taskId: schema.proposals.taskId,
          onDeclinePolicy: schema.proposals.onDeclinePolicy,
        })
        .from(schema.decisionCards)
        .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
        .where(
          and(
            eq(schema.decisionCards.id, input.target_card_id),
            eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          ),
        )
        .get();

      if (targetRow === undefined || targetRow.taskId !== task.id) {
        throw new DomainError(
          "NOT_FOUND",
          `Target decision card "${input.target_card_id}" not found on task "${task.id}".`,
          false,
        );
      }

      const targetCardStatus = parseCardStatusStrict(targetRow.cardStatus);
      let groupCardStatuses: DecisionCardStatus[] = [targetCardStatus];

      if (targetRow.selectionGroupId !== null) {
        const siblings = await db.orm
          .select({
            status: schema.decisionCards.status,
            onDeclinePolicy: schema.proposals.onDeclinePolicy,
          })
          .from(schema.decisionCards)
          .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
          .where(
            and(
              eq(schema.decisionCards.workspaceId, ctx.workspaceId),
              eq(schema.decisionCards.selectionGroupId, targetRow.selectionGroupId),
            ),
          )
          .all();

        groupCardStatuses = siblings.map((s) => parseCardStatusStrict(s.status));
        assertGroupDeclinePolicyConsistency([
          ...siblings.map((s) => parseOnDeclinePolicyStrict(s.onDeclinePolicy)),
          input.replacement.on_decline_policy,
        ]);
      }

      assertCanSupersedeProposal({
        taskStatus,
        targetCardStatus,
        groupCardStatuses,
      });

      const preparedArtifact =
        input.artifact !== undefined
          ? await prepareArtifactUpsert({
              db,
              ctx,
              taskId: task.id,
              artifact: input.artifact,
              nowMs,
            })
          : null;

      let targetArtifactId =
        input.replacement.target_artifact_id ?? preparedArtifact?.artifactId ?? null;
      let targetArtifactVersion: number | null = preparedArtifact?.artifactVersion ?? null;
      let referencedArtGuardSql = "";
      const referencedArtGuardParams: SqlParam[] = [];

      if (
        input.replacement.target_artifact_id !== undefined &&
        input.replacement.target_artifact_id !== preparedArtifact?.artifactId
      ) {
        const existingArt = await db.orm
          .select({ id: schema.artifacts.id, version: schema.artifacts.version })
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.id, input.replacement.target_artifact_id),
              eq(schema.artifacts.workspaceId, ctx.workspaceId),
              eq(schema.artifacts.taskId, task.id),
            ),
          )
          .get();
        if (existingArt === undefined) {
          throw new DomainError(
            "NOT_FOUND",
            `Referenced target_artifact_id "${input.replacement.target_artifact_id}" not found on task "${task.id}".`,
            false,
          );
        }
        targetArtifactId = existingArt.id;
        targetArtifactVersion = existingArt.version;
        referencedArtGuardSql =
          " AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND workspace_id = ? AND task_id = ? AND version = ?)";
        referencedArtGuardParams.push(
          existingArt.id,
          ctx.workspaceId,
          task.id,
          existingArt.version,
        );
      }

      const nextTaskVersion = task.version + 1;
      const replacementProposalId = generateEntityId("prop");
      const replacementCardId = generateEntityId("card");
      const payloadHash = await canonicalJsonHash(input.replacement);
      const expiresAt =
        input.replacement.expires_in_seconds !== undefined
          ? nowMs + input.replacement.expires_in_seconds * 1000
          : null;
      const traceId = generateEntityId("evt");

      const result: SupersedeProposalResult = {
        task_id: task.id,
        task_version: nextTaskVersion,
        superseded_card_id: targetRow.cardId,
        replacement_card_id: replacementCardId,
        replacement_proposal_id: replacementProposalId,
        artifact_id: preparedArtifact?.artifactId ?? null,
        artifact_version: preparedArtifact?.artifactVersion ?? null,
        trace_id: traceId,
      };

      const followUps: RawSqlStatement[] = [];
      // B2: Always release work_leases when transitioning running -> waiting_human
      if (isFromRunning && input.lease_token !== undefined) {
        followUps.push({
          sql: "DELETE FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ?",
          params: [task.id, ctx.botConnectionId, input.lease_token],
        });
      }
      if (preparedArtifact !== null) {
        followUps.push(preparedArtifact.statement);
      }

      followUps.push(
        {
          sql: "INSERT INTO proposals (id, workspace_id, task_id, proposer_bot_id, card_type, selection_mode, options_json, title, summary, on_accept_effect, on_decline_effect, on_decline_policy, factors_json, target_task_version, target_artifact_id, target_artifact_version, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          params: [
            replacementProposalId,
            ctx.workspaceId,
            task.id,
            ctx.botConnectionId,
            input.replacement.card_type,
            input.replacement.selection_mode,
            serializeProposalOptionsJson(input.replacement),
            input.replacement.title,
            input.replacement.summary,
            input.replacement.on_accept_effect,
            input.replacement.on_decline_effect,
            input.replacement.on_decline_policy,
            JSON.stringify(input.replacement.factors),
            nextTaskVersion,
            targetArtifactId,
            targetArtifactVersion,
            payloadHash,
            nowMs,
          ],
        },
        {
          sql: "INSERT INTO decision_cards (id, workspace_id, proposal_id, selection_group_id, status, expires_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?)",
          params: [
            replacementCardId,
            ctx.workspaceId,
            replacementProposalId,
            targetRow.selectionGroupId,
            expiresAt,
            nowMs,
            nowMs,
          ],
        },
        {
          sql: "UPDATE proposals SET superseded_by_id = ? WHERE id = ?",
          params: [replacementProposalId, targetRow.proposalId],
        },
        {
          sql: "UPDATE decision_cards SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'deferred')",
          params: [nowMs, targetRow.cardId],
        },
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'decision_card', ?, 'proposal_superseded', ?, ?, ?)",
          params: [
            traceId,
            ctx.workspaceId,
            ctx.botConnectionId,
            targetRow.cardId,
            JSON.stringify({
              replacement_card_id: replacementCardId,
              replacement_proposal_id: replacementProposalId,
            }),
            input.request_id,
            nowMs,
          ],
        },
        buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
      );

      // B2: Pin exact source status + atomic lease verification when running
      const statusAndLeaseSql =
        isFromRunning && input.lease_token !== undefined
          ? "status = 'running' AND EXISTS (SELECT 1 FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ? AND expires_at > ?)"
          : "status = 'waiting_human'";
      const statusAndLeaseParams: SqlParam[] =
        isFromRunning && input.lease_token !== undefined
          ? [task.id, ctx.botConnectionId, input.lease_token, nowMs]
          : [];

      const groupGuardSql =
        targetRow.selectionGroupId !== null
          ? " AND NOT EXISTS (SELECT 1 FROM decision_cards sib WHERE sib.workspace_id = ? AND sib.selection_group_id = ? AND sib.status IN ('provisional', 'accepted'))"
          : "";
      const groupGuardParams: SqlParam[] =
        targetRow.selectionGroupId !== null ? [ctx.workspaceId, targetRow.selectionGroupId] : [];

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE tasks SET status = 'waiting_human', version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND ${statusAndLeaseSql} AND version = ? AND EXISTS (SELECT 1 FROM decision_cards dc WHERE dc.id = ? AND dc.workspace_id = ? AND dc.status IN ('pending', 'deferred'))${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}${groupGuardSql}${preparedArtifact?.parentConditionSql ?? ""}${referencedArtGuardSql}`,
          params: [
            nowMs,
            task.id,
            ctx.workspaceId,
            ...statusAndLeaseParams,
            input.expected_version,
            targetRow.cardId,
            ctx.workspaceId,
            ...activeBotAndWorkspaceParams(ctx),
            ...groupGuardParams,
            ...(preparedArtifact?.parentConditionParams ?? []),
            ...referencedArtGuardParams,
          ],
        },
        followUps,
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          taskId: task.id,
          expectedVersion: input.expected_version,
          ...(isFromRunning && input.lease_token !== undefined
            ? { leaseToken: input.lease_token }
            : {}),
          nowMs,
          fallbackCode: "INVALID_TRANSITION",
          fallbackMessage: `Concurrent transition blocked superseding card "${targetRow.cardId}".`,
          fallbackRetryable: true,
        });
      }

      return result;
    },
  );
}

export async function recordResult(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: RecordResultInput,
  nowMs = Date.now(),
): Promise<RecordResultOutput> {
  assertBotWriteAccess(ctx, ctx.workspaceId, "tasks:write");
  const input = recordResultInputSchema.parse(rawInput);

  const key = {
    workspaceId: ctx.workspaceId,
    actorType: "bot" as const,
    actorId: ctx.botConnectionId,
    operation: "record_result",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    task_id: input.task_id,
    expected_version: input.expected_version,
    lease_token: input.lease_token,
    outcome: input.outcome,
    summary: input.summary ?? null,
    status_reason: input.status_reason ?? null,
    decision_id: input.decision_id ?? null,
    artifact: input.artifact ?? null,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    key,
    inputHash,
    (raw) => recordResultOutputSchema.parse(raw),
    async () => {
      const task = await db.orm
        .select()
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.id, input.task_id), eq(schema.tasks.workspaceId, ctx.workspaceId)),
        )
        .get();

      if (task === undefined) {
        throw new DomainError("NOT_FOUND", `Task "${input.task_id}" not found.`, false);
      }

      assertExpectedVersion(input.expected_version, task.version, "Task");

      const nextStatus = resolveTaskStatusOnRecordResult({
        taskStatus: parseTaskStatusStrict(task.status),
        outcome: input.outcome,
        requiresApproval: task.requiresApproval,
      });

      await assertCallerHoldsActiveLease({
        db,
        ctx,
        taskId: task.id,
        leaseToken: input.lease_token,
        nowMs,
      });

      // M3: Pre-check AND atomic SQL guard for finalized decision_id
      let decisionGuardSql = "";
      const decisionGuardParams: SqlParam[] = [];
      if (input.decision_id !== undefined) {
        const decisionRow = await db.orm
          .select({
            id: schema.decisions.id,
            decisionStatus: schema.decisions.status,
            cardStatus: schema.decisionCards.status,
            taskId: schema.proposals.taskId,
            workspaceId: schema.decisionCards.workspaceId,
          })
          .from(schema.decisions)
          .innerJoin(schema.decisionCards, eq(schema.decisions.cardId, schema.decisionCards.id))
          .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
          .where(eq(schema.decisions.id, input.decision_id))
          .get();

        if (
          decisionRow === undefined ||
          decisionRow.workspaceId !== ctx.workspaceId ||
          decisionRow.taskId !== task.id
        ) {
          throw new DomainError(
            "NOT_FOUND",
            `Decision "${input.decision_id}" not found for task "${task.id}".`,
            false,
          );
        }

        assertCardIsFinalizedForBot(
          parseCardStatusStrict(decisionRow.cardStatus),
          parseDecisionStatusStrict(decisionRow.decisionStatus),
        );

        decisionGuardSql =
          " AND EXISTS (SELECT 1 FROM decisions d INNER JOIN decision_cards dc ON d.card_id = dc.id INNER JOIN proposals p ON dc.proposal_id = p.id WHERE d.id = ? AND d.status = 'finalized' AND dc.status IN ('accepted', 'declined') AND dc.workspace_id = ? AND p.task_id = ?)";
        decisionGuardParams.push(input.decision_id, ctx.workspaceId, task.id);
      }

      const preparedArtifact =
        input.artifact !== undefined
          ? await prepareArtifactUpsert({
              db,
              ctx,
              taskId: task.id,
              artifact: input.artifact,
              nowMs,
            })
          : null;

      const nextVersion = task.version + 1;
      const nextRetryCount = nextStatus === "failed" ? task.retryCount + 1 : task.retryCount;
      const normalizedStatusReason =
        input.status_reason !== undefined && input.status_reason.trim() !== ""
          ? input.status_reason.trim()
          : undefined;
      const normalizedSummary =
        input.summary !== undefined && input.summary.trim() !== ""
          ? input.summary.trim()
          : undefined;
      const nextStatusReason =
        normalizedStatusReason ??
        (nextStatus === "failed" ? (normalizedSummary ?? "Execution failed") : null);
      const traceId = generateEntityId("evt");

      const result: RecordResultOutput = {
        task_id: task.id,
        version: nextVersion,
        status: nextStatus,
        retry_count: nextRetryCount,
        consumed_decision_id: input.decision_id ?? null,
        artifact_id: preparedArtifact?.artifactId ?? null,
        artifact_version: preparedArtifact?.artifactVersion ?? null,
        trace_id: traceId,
      };

      const followUps: RawSqlStatement[] = [
        {
          sql: "DELETE FROM work_leases WHERE task_id = ?",
          params: [task.id],
        },
      ];

      if (preparedArtifact !== null) {
        followUps.push(preparedArtifact.statement);
      }
      if (input.decision_id !== undefined) {
        followUps.push({
          sql: "UPDATE decisions SET consumed_at = COALESCE(consumed_at, ?) WHERE id = ? AND status = 'finalized'",
          params: [nowMs, input.decision_id],
        });
      }

      followUps.push(
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'bot', ?, 'task', ?, 'result_recorded', ?, ?, ?)",
          params: [
            traceId,
            ctx.workspaceId,
            ctx.botConnectionId,
            task.id,
            JSON.stringify({
              outcome: input.outcome,
              status: nextStatus,
              status_reason: nextStatusReason,
              summary: normalizedSummary ?? null,
              decision_id: input.decision_id ?? null,
              artifact_id: preparedArtifact?.artifactId ?? null,
            }),
            input.request_id,
            nowMs,
          ],
        },
        buildInsertIdempotencyKeySql(key, inputHash, result, nowMs),
      );

      const outcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE tasks SET status = ?, status_reason = ?, retry_count = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'running' AND version = ? AND EXISTS (SELECT 1 FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ? AND expires_at > ?)${ACTIVE_BOT_AND_UNPAUSED_WS_SQL}${decisionGuardSql}${preparedArtifact?.parentConditionSql ?? ""}`,
          params: [
            nextStatus,
            nextStatusReason,
            nextRetryCount,
            nowMs,
            task.id,
            ctx.workspaceId,
            input.expected_version,
            task.id,
            ctx.botConnectionId,
            input.lease_token,
            nowMs,
            ...activeBotAndWorkspaceParams(ctx),
            ...decisionGuardParams,
            ...(preparedArtifact?.parentConditionParams ?? []),
          ],
        },
        followUps,
      });

      if (!outcome.applied) {
        await throwClassifiedMutationFailure({
          db,
          ctx,
          taskId: task.id,
          expectedVersion: input.expected_version,
          leaseToken: input.lease_token,
          nowMs,
          fallbackCode: "VERSION_CONFLICT",
          fallbackMessage: `Concurrent conflict recording result for task "${task.id}".`,
          fallbackRetryable: false,
        });
      }

      return result;
    },
  );
}
