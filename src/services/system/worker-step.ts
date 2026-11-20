import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  assertModelTimeoutWithinLease,
  type ModelAdapter,
  ModelAdapterError,
  type ModelStepContext,
  type ModelStepOutput,
  type ModelStepTriggerDecision,
} from "@/adapters";
import { type VerifiedBotContext } from "@/auth/context";
import { type AppDatabase, guardedBatch, type RawSqlStatement, schema, type SqlParam } from "@/db";
import {
  CARD_TYPES,
  DomainError,
  hasVersionMismatch,
  SELECTION_MODES,
  TASK_STATUSES,
  type TaskStatus,
} from "@/domain";
import { claimTask, createTask, recordResult, submitProposal, updateTask } from "@/services/bot";
import { checkWorkspaceBudget, recordWorkerStepExecutedEvent } from "@/services/system/budget";
import { canonicalJsonHash, generateEntityId } from "@/services/system/idempotency";
import { createLogger } from "@/shared/logger";

export const DEFAULT_WORKER_LEASE_SECONDS = 120;
export const DEFAULT_WORKER_STEP_TIMEOUT_MS = 25_000;

const workerStepLogger = createLogger("system-worker-step");

const selectedOptionIdsSchema = z.array(z.string());

function parseTaskStatusStrict(raw: string): TaskStatus {
  const found = TASK_STATUSES.find((s) => s === raw);
  return found ?? "ready";
}

function parseCardTypeStrict(raw: string): (typeof CARD_TYPES)[number] {
  const found = CARD_TYPES.find((c) => c === raw);
  return found ?? "policy";
}

function parseSelectionModeStrict(raw: string): (typeof SELECTION_MODES)[number] {
  const found = SELECTION_MODES.find((m) => m === raw);
  return found ?? "binary";
}

function parseSelectedOptionIds(raw: string | null): readonly string[] {
  if (raw === null || raw.trim() === "") {
    return [];
  }
  try {
    const parsedJson: unknown = JSON.parse(raw);
    const parsed = selectedOptionIdsSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export interface HandleBotWorkTaskInput {
  readonly taskId: string;
  readonly decisionId?: string;
  readonly adapter: ModelAdapter;
  readonly leaseDurationSeconds?: number;
  readonly stepTimeoutMs?: number;
  readonly nowMs?: number;
}

export type BotWorkStepOutcome =
  | { readonly outcome: "completed"; readonly action: ModelStepOutput["action"] }
  | { readonly outcome: "reconfirmation_created"; readonly replacementCardId: string }
  | { readonly outcome: "budget_blocked"; readonly reason: string }
  | { readonly outcome: "failed_permanent"; readonly reason: string }
  | { readonly outcome: "retry"; readonly delaySeconds: number; readonly reason: string }
  | { readonly outcome: "skipped_paused"; readonly reason: string }
  | { readonly outcome: "noop"; readonly reason: string };

/**
 * M2/M4: Scoped strictly to (workspaceId, taskId). Marks the specific finalized decision
 * AND any older unconsumed finalized decisions on the same task as consumed.
 */
function buildScopedConsumeDecisionSql(params: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly decisionId: string;
  readonly nowMs: number;
}): RawSqlStatement {
  return {
    sql: `UPDATE decisions
          SET consumed_at = COALESCE(consumed_at, ?)
          WHERE status = 'finalized'
            AND consumed_at IS NULL
            AND card_id IN (
              SELECT dc.id FROM decision_cards dc
              INNER JOIN proposals p ON p.id = dc.proposal_id
              WHERE dc.workspace_id = ? AND p.task_id = ?
            )
            AND (
              id = ?
              OR finalized_at <= COALESCE((SELECT finalized_at FROM decisions WHERE id = ?), ?)
            )`,
    params: [
      params.nowMs,
      params.workspaceId,
      params.taskId,
      params.decisionId,
      params.decisionId,
      params.nowMs,
    ],
  };
}

async function markDecisionConsumedScoped(
  db: AppDatabase,
  workspaceId: string,
  taskId: string,
  decisionId: string | undefined,
  nowMs: number,
): Promise<void> {
  if (decisionId === undefined) {
    return;
  }
  await db.executor.batch([
    buildScopedConsumeDecisionSql({ workspaceId, taskId, decisionId, nowMs }),
  ]);
}

async function releaseWorkerLeaseOnRetry(params: {
  readonly db: AppDatabase;
  readonly workspaceId: string;
  readonly botConnectionId: string;
  readonly taskId: string;
  readonly claimedVersion: number;
  readonly leaseToken: string;
  readonly preClaimVersion: number;
  readonly decisionId?: string;
  readonly reason: string;
  readonly nowMs: number;
}): Promise<void> {
  const nextReadyVersion = params.claimedVersion + 1;
  const followUps: RawSqlStatement[] = [
    {
      sql: "DELETE FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ?",
      params: [params.taskId, params.botConnectionId, params.leaseToken],
    },
  ];
  if (params.decisionId !== undefined) {
    followUps.push({
      sql: `UPDATE decisions
            SET finalized_task_version = ?
            WHERE id = ?
              AND status = 'finalized'
              AND consumed_at IS NULL
              AND finalized_task_version = ?
              AND card_id IN (
                SELECT dc.id FROM decision_cards dc
                INNER JOIN proposals p ON p.id = dc.proposal_id
                WHERE dc.workspace_id = ? AND p.task_id = ?
              )`,
      params: [
        nextReadyVersion,
        params.decisionId,
        params.preClaimVersion,
        params.workspaceId,
        params.taskId,
      ],
    });
  }
  await guardedBatch(params.db.executor, {
    parentUpdate: {
      sql: `UPDATE tasks
            SET status = 'ready', status_reason = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'running' AND version = ?
              AND EXISTS (SELECT 1 FROM work_leases WHERE task_id = ? AND bot_id = ? AND lease_token = ?)`,
      params: [
        params.reason.slice(0, 500),
        params.nowMs,
        params.taskId,
        params.workspaceId,
        params.claimedVersion,
        params.taskId,
        params.botConnectionId,
        params.leaseToken,
      ],
    },
    followUps,
  });
}

async function recordPermanentFailureOrReleaseLease(params: {
  readonly db: AppDatabase;
  readonly ctx: VerifiedBotContext;
  readonly taskId: string;
  readonly claimedVersion: number;
  readonly leaseToken: string;
  readonly preClaimVersion: number;
  readonly decisionId?: string;
  readonly adapterName: string;
  readonly estimatedCostCents: number;
  readonly reason: string;
  readonly nowMs: number;
}): Promise<BotWorkStepOutcome> {
  const safeReason = params.reason.slice(0, 500);
  try {
    await recordResult(
      params.db,
      params.ctx,
      {
        request_id: `worker-fail-${params.taskId}-v${params.claimedVersion}-${generateEntityId("req")}`,
        task_id: params.taskId,
        expected_version: params.claimedVersion,
        lease_token: params.leaseToken,
        outcome: "failed",
        status_reason: safeReason,
        ...(params.decisionId !== undefined ? { decision_id: params.decisionId } : {}),
      },
      params.nowMs,
    );
    await markDecisionConsumedScoped(
      params.db,
      params.ctx.workspaceId,
      params.taskId,
      params.decisionId,
      params.nowMs,
    );
  } catch (fallbackErr) {
    workerStepLogger.warn(
      "recordResult(failed) could not be applied (e.g. bot revoked/paused); releasing WorkLease cleanly",
      { error: fallbackErr, taskId: params.taskId },
    );
    await releaseWorkerLeaseOnRetry({
      db: params.db,
      workspaceId: params.ctx.workspaceId,
      botConnectionId: params.ctx.botConnectionId,
      taskId: params.taskId,
      claimedVersion: params.claimedVersion,
      leaseToken: params.leaseToken,
      preClaimVersion: params.preClaimVersion,
      ...(params.decisionId !== undefined ? { decisionId: params.decisionId } : {}),
      reason: safeReason,
      nowMs: params.nowMs,
    });
  }

  await recordWorkerStepExecutedEvent(params.db, {
    workspaceId: params.ctx.workspaceId,
    botConnectionId: params.ctx.botConnectionId,
    taskId: params.taskId,
    ...(params.decisionId !== undefined ? { decisionId: params.decisionId } : {}),
    actionKind: "failed_permanent",
    adapterName: params.adapterName,
    estimatedCostCents: params.estimatedCostCents,
    nowMs: params.nowMs,
  });

  return {
    outcome: "failed_permanent",
    reason: safeReason,
  };
}

async function createNonLoopingStaleReconfirmation(params: {
  readonly db: AppDatabase;
  readonly ctx: VerifiedBotContext;
  readonly task: typeof schema.tasks.$inferSelect;
  readonly decisionId: string;
  readonly proposal: typeof schema.proposals.$inferSelect;
  readonly currentArtifactVersion: number | null;
  readonly nowMs: number;
}): Promise<BotWorkStepOutcome> {
  // DEC-03 anti-loop guard: if an active non-terminal card already exists on this task, consume & ack cleanly
  const existingActive = await params.db.orm
    .select({ id: schema.decisionCards.id })
    .from(schema.decisionCards)
    .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
    .where(
      and(
        eq(schema.decisionCards.workspaceId, params.ctx.workspaceId),
        eq(schema.proposals.taskId, params.task.id),
        inArray(schema.decisionCards.status, ["pending", "deferred", "provisional"]),
      ),
    )
    .get();

  if (existingActive !== undefined) {
    await markDecisionConsumedScoped(
      params.db,
      params.ctx.workspaceId,
      params.task.id,
      params.decisionId,
      params.nowMs,
    );
    return {
      outcome: "noop",
      reason: `Active reconfirmation card "${existingActive.id}" already exists; preventing loop.`,
    };
  }

  const nextTaskVersion = params.task.version + 1;
  const replacementProposalId = generateEntityId("prop");
  const replacementCardId = generateEntityId("card");
  const eventId = generateEntityId("evt");

  // M3: Use current artifact version (or detach target_artifact_id if deleted) so reconfirmation card is never born stale
  const replacementArtifactId =
    params.proposal.targetArtifactId !== null && params.currentArtifactVersion !== null
      ? params.proposal.targetArtifactId
      : null;
  const replacementArtifactVersion =
    replacementArtifactId !== null ? params.currentArtifactVersion : null;

  const reconfirmTitle = params.proposal.title.startsWith("[再確認]")
    ? params.proposal.title.slice(0, 160)
    : `[再確認] ${params.proposal.title}`.slice(0, 160);
  const reconfirmSuffix =
    "\n（判断確定後にタスクまたは成果の版が更新されたため、実行前の再確認が必要です：DEC-03）";
  const reconfirmSummary = params.proposal.summary.includes("再確認が必要です")
    ? params.proposal.summary.slice(0, 1000)
    : `${params.proposal.summary.slice(0, 1000 - reconfirmSuffix.length)}${reconfirmSuffix}`;

  const payloadHash = await canonicalJsonHash({
    reconfirm_for_decision_id: params.decisionId,
    reconfirm_for_proposal_id: params.proposal.id,
    target_task_version: nextTaskVersion,
    target_artifact_id: replacementArtifactId,
    target_artifact_version: replacementArtifactVersion,
    title: reconfirmTitle,
  });

  const outcome = await guardedBatch(params.db.executor, {
    parentUpdate: {
      sql: `UPDATE tasks
            SET status = 'waiting_human',
                status_reason = 'Task or artifact version changed after decision finalization; reconfirmation required (DEC-03)',
                version = version + 1,
                updated_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'ready' AND version = ?`,
      params: [params.nowMs, params.task.id, params.ctx.workspaceId, params.task.version],
    },
    followUps: [
      {
        sql: `INSERT INTO proposals (
          id, workspace_id, task_id, proposer_bot_id, card_type, selection_mode, options_json,
          title, summary, on_accept_effect, on_decline_effect, on_decline_policy, factors_json,
          target_task_version, target_artifact_id, target_artifact_version, payload_hash, superseded_by_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        params: [
          replacementProposalId,
          params.ctx.workspaceId,
          params.task.id,
          params.ctx.botConnectionId,
          params.proposal.cardType,
          params.proposal.selectionMode,
          params.proposal.optionsJson,
          reconfirmTitle,
          reconfirmSummary,
          params.proposal.onAcceptEffect,
          params.proposal.onDeclineEffect,
          params.proposal.onDeclinePolicy,
          params.proposal.factorsJson,
          nextTaskVersion,
          replacementArtifactId,
          replacementArtifactVersion,
          payloadHash,
          params.nowMs,
        ],
      },
      {
        sql: `INSERT INTO decision_cards (
          id, workspace_id, proposal_id, selection_group_id, status,
          provisional_result, provisional_until, expires_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'pending', NULL, NULL, NULL, 1, ?, ?)`,
        params: [
          replacementCardId,
          params.ctx.workspaceId,
          replacementProposalId,
          params.nowMs,
          params.nowMs,
        ],
      },
      buildScopedConsumeDecisionSql({
        workspaceId: params.ctx.workspaceId,
        taskId: params.task.id,
        decisionId: params.decisionId,
        nowMs: params.nowMs,
      }),
      {
        sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'task', ?, 'worker.stale_decision_reconfirmation', ?, NULL, ?)",
        params: [
          eventId,
          params.ctx.workspaceId,
          params.ctx.botConnectionId,
          params.task.id,
          JSON.stringify({
            decision_id: params.decisionId,
            replacement_card_id: replacementCardId,
            observed_task_version: params.task.version,
            observed_artifact_version: replacementArtifactVersion,
          }),
          params.nowMs,
        ],
      },
    ],
  });

  if (!outcome.applied) {
    return {
      outcome: "noop",
      reason: "Concurrent update already handled stale decision reconfirmation.",
    };
  }

  return {
    outcome: "reconfirmation_created",
    replacementCardId,
  };
}

/**
 * Executes 1 bounded autonomous worker step for a task triggered by `bot-work` Queue.
 */
export async function handleBotWorkTask(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  input: HandleBotWorkTaskInput,
): Promise<BotWorkStepOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const leaseDurationSeconds = input.leaseDurationSeconds ?? DEFAULT_WORKER_LEASE_SECONDS;
  const stepTimeoutMs = input.stepTimeoutMs ?? DEFAULT_WORKER_STEP_TIMEOUT_MS;

  assertModelTimeoutWithinLease({
    timeoutMs: stepTimeoutMs,
    leaseRemainingMs: leaseDurationSeconds * 1000,
  });

  if (ctx.isWorkspacePaused || ctx.status !== "active") {
    return {
      outcome: "skipped_paused",
      reason: "Workspace or worker bot connection is paused/inactive.",
    };
  }

  const [workspace, task] = await Promise.all([
    db.orm
      .select({
        id: schema.workspaces.id,
        goal: schema.workspaces.goal,
        allowedScope: schema.workspaces.allowedScope,
        isPaused: schema.workspaces.isPaused,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .get(),
    db.orm
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, input.taskId), eq(schema.tasks.workspaceId, ctx.workspaceId)))
      .get(),
  ]);

  if (workspace === undefined || workspace.isPaused) {
    return {
      outcome: "skipped_paused",
      reason: "Workspace is paused or unavailable.",
    };
  }

  if (task === undefined) {
    return {
      outcome: "noop",
      reason: `Task "${input.taskId}" not found in workspace.`,
    };
  }

  if (task.status !== "ready") {
    return {
      outcome: "noop",
      reason: `Task "${task.id}" is "${task.status}" (expected "ready").`,
    };
  }

  let triggerDecision: ModelStepTriggerDecision | undefined;
  if (input.decisionId !== undefined) {
    const decisionRow = await db.orm
      .select({
        decision: schema.decisions,
        card: schema.decisionCards,
        proposal: schema.proposals,
      })
      .from(schema.decisions)
      .innerJoin(schema.decisionCards, eq(schema.decisions.cardId, schema.decisionCards.id))
      .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
      .where(eq(schema.decisions.id, input.decisionId))
      .get();

    if (
      decisionRow === undefined ||
      decisionRow.card.workspaceId !== ctx.workspaceId ||
      decisionRow.proposal.taskId !== task.id
    ) {
      return {
        outcome: "noop",
        reason: `Decision "${input.decisionId}" not found for task "${task.id}".`,
      };
    }

    // DEC-01: NEVER execute on provisional or canceled decisions
    if (
      decisionRow.decision.status !== "finalized" ||
      (decisionRow.card.status !== "accepted" && decisionRow.card.status !== "declined")
    ) {
      return {
        outcome: "noop",
        reason: `Decision "${input.decisionId}" is not finalized (status: ${decisionRow.decision.status}).`,
      };
    }

    if (decisionRow.decision.consumedAt !== null) {
      return {
        outcome: "noop",
        reason: `Decision "${input.decisionId}" was already consumed.`,
      };
    }

    // M3: Check BOTH finalized_task_version AND target_artifact_version for DEC-03 staleness
    let currentArtifactVersion: number | null = null;
    if (decisionRow.proposal.targetArtifactId !== null) {
      const artifact = await db.orm
        .select({ version: schema.artifacts.version })
        .from(schema.artifacts)
        .where(
          and(
            eq(schema.artifacts.id, decisionRow.proposal.targetArtifactId),
            eq(schema.artifacts.workspaceId, ctx.workspaceId),
          ),
        )
        .get();
      currentArtifactVersion = artifact?.version ?? null;
    }

    const expectedTaskVersion = decisionRow.decision.finalizedTaskVersion ?? task.version;
    const isStale = hasVersionMismatch({
      targetTaskVersion: expectedTaskVersion,
      currentTaskVersion: task.version,
      targetArtifactVersion: decisionRow.proposal.targetArtifactVersion,
      currentArtifactVersion,
    });

    if (isStale) {
      return await createNonLoopingStaleReconfirmation({
        db,
        ctx,
        task,
        decisionId: input.decisionId,
        proposal: decisionRow.proposal,
        currentArtifactVersion,
        nowMs,
      });
    }

    const decisionResult: "accepted" | "declined" =
      decisionRow.decision.result === "declined" ? "declined" : "accepted";
    triggerDecision = {
      id: decisionRow.decision.id,
      result: decisionResult,
      proposalTitle: decisionRow.proposal.title,
      cardType: parseCardTypeStrict(decisionRow.proposal.cardType),
      selectionMode: parseSelectionModeStrict(decisionRow.proposal.selectionMode),
      selectedOptionIds: parseSelectedOptionIds(decisionRow.decision.selectedOptionIdsJson),
    };
  }

  // Enforce structured budget_limit BEFORE claiming / calling external model API
  const budgetEval = await checkWorkspaceBudget(db, ctx.workspaceId, task.id, nowMs);
  if (budgetEval === null) {
    return { outcome: "skipped_paused", reason: "Workspace disappeared before budget check." };
  }
  if (!budgetEval.check.allowed) {
    const eventId = generateEntityId("evt");
    const budgetFollowUps: RawSqlStatement[] = [
      {
        sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'task', ?, 'worker.budget_exceeded', ?, NULL, ?)",
        params: [
          eventId,
          ctx.workspaceId,
          ctx.botConnectionId,
          task.id,
          JSON.stringify({
            breached_limit: budgetEval.check.breachedLimit,
            message: budgetEval.check.message,
            usage: budgetEval.usage,
            limit: budgetEval.limit,
          }),
          nowMs,
        ],
      },
    ];
    // M5-2: Mark triggering decision consumed so owner Retry resumes cleanly without spurious DEC-03 reconfirmation
    if (input.decisionId !== undefined) {
      budgetFollowUps.push(
        buildScopedConsumeDecisionSql({
          workspaceId: ctx.workspaceId,
          taskId: task.id,
          decisionId: input.decisionId,
          nowMs,
        }),
      );
    }

    await guardedBatch(db.executor, {
      parentUpdate: {
        sql: `UPDATE tasks
              SET status = 'blocked', status_reason = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND status = 'ready' AND version = ?`,
        params: [budgetEval.check.message, nowMs, task.id, ctx.workspaceId, task.version],
      },
      followUps: budgetFollowUps,
    });
    return {
      outcome: "budget_blocked",
      reason: budgetEval.check.message,
    };
  }

  // Claim task with WorkLease via real Bot service
  const preClaimVersion = task.version;
  let claimed: Awaited<ReturnType<typeof claimTask>>;
  try {
    claimed = await claimTask(
      db,
      ctx,
      {
        request_id: `worker-claim-${task.id}-v${preClaimVersion}-${generateEntityId("req")}`,
        task_id: task.id,
        expected_version: preClaimVersion,
        lease_duration_seconds: leaseDurationSeconds,
      },
      nowMs,
    );
  } catch (err) {
    if (err instanceof DomainError) {
      if (err.code === "WORKSPACE_PAUSED" || err.code === "NOT_AUTHORIZED") {
        return { outcome: "skipped_paused", reason: err.message };
      }
      if (err.code === "LEASE_CONFLICT") {
        return { outcome: "retry", delaySeconds: 15, reason: err.message };
      }
      return { outcome: "noop", reason: err.message };
    }
    throw err;
  }

  // Minor 4: Compute live remaining lease duration and release lease cleanly if timeout guard fails
  const liveNowMs = input.nowMs ?? Date.now();
  const leaseRemainingMs = claimed.lease_expires_at - liveNowMs;
  try {
    assertModelTimeoutWithinLease({
      timeoutMs: stepTimeoutMs,
      leaseRemainingMs,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "WorkLease remaining TTL too short";
    await releaseWorkerLeaseOnRetry({
      db,
      workspaceId: ctx.workspaceId,
      botConnectionId: ctx.botConnectionId,
      taskId: task.id,
      claimedVersion: claimed.version,
      leaseToken: claimed.lease_token,
      preClaimVersion,
      ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
      reason,
      nowMs: liveNowMs,
    });
    return { outcome: "retry", delaySeconds: 5, reason };
  }

  const latestArtifacts = await db.orm
    .select({
      id: schema.artifacts.id,
      title: schema.artifacts.title,
      kind: schema.artifacts.kind,
      summary: schema.artifacts.summary,
      version: schema.artifacts.version,
    })
    .from(schema.artifacts)
    .where(
      and(eq(schema.artifacts.workspaceId, ctx.workspaceId), eq(schema.artifacts.taskId, task.id)),
    )
    .orderBy(desc(schema.artifacts.updatedAt), desc(schema.artifacts.version))
    .limit(5)
    .all();

  const stepContext: ModelStepContext = {
    workspaceGoal: workspace.goal,
    allowedScope: workspace.allowedScope,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: parseTaskStatusStrict(claimed.status),
      requiresApproval: task.requiresApproval,
      version: claimed.version,
      retryCount: task.retryCount,
    },
    latestArtifacts,
    ...(triggerDecision !== undefined ? { triggerDecision } : {}),
  };

  let stepOutput: ModelStepOutput;
  try {
    stepOutput = await input.adapter.executeStep(stepContext, {
      timeoutMs: stepTimeoutMs,
      leaseRemainingMs,
    });
  } catch (error) {
    if (error instanceof ModelAdapterError) {
      if (error.kind === "retryable") {
        await releaseWorkerLeaseOnRetry({
          db,
          workspaceId: ctx.workspaceId,
          botConnectionId: ctx.botConnectionId,
          taskId: task.id,
          claimedVersion: claimed.version,
          leaseToken: claimed.lease_token,
          preClaimVersion,
          ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
          reason: `Transient model failure (${error.reasonCode}): ${error.message}`,
          nowMs,
        });
        return {
          outcome: "retry",
          delaySeconds: error.retryAfterSeconds ?? 15,
          reason: error.message,
        };
      }

      return await recordPermanentFailureOrReleaseLease({
        db,
        ctx,
        taskId: task.id,
        claimedVersion: claimed.version,
        leaseToken: claimed.lease_token,
        preClaimVersion,
        ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
        adapterName: input.adapter.name,
        estimatedCostCents: 0,
        reason: `${error.reasonCode}: ${error.message}`,
        nowMs,
      });
    }

    workerStepLogger.error("Unexpected transient failure executing model adapter step", {
      error,
      taskId: task.id,
    });
    await releaseWorkerLeaseOnRetry({
      db,
      workspaceId: ctx.workspaceId,
      botConnectionId: ctx.botConnectionId,
      taskId: task.id,
      claimedVersion: claimed.version,
      leaseToken: claimed.lease_token,
      preClaimVersion,
      ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
      reason: "Unexpected transient worker failure; scheduled retry",
      nowMs,
    });
    return {
      outcome: "retry",
      delaySeconds: 15,
      reason: "Unexpected transient worker failure.",
    };
  }

  // B1: Unified post-claim mutation guard so ZERO Bot service errors can ever leak a WorkLease
  const runPostClaimMutation = async (
    actionKind: string,
    mutate: () => Promise<BotWorkStepOutcome>,
  ): Promise<BotWorkStepOutcome> => {
    try {
      const outcome = await mutate();
      await recordWorkerStepExecutedEvent(db, {
        workspaceId: ctx.workspaceId,
        botConnectionId: ctx.botConnectionId,
        taskId: task.id,
        ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
        actionKind,
        adapterName: input.adapter.name,
        estimatedCostCents: stepOutput.estimated_cost_cents,
        nowMs,
      });
      return outcome;
    } catch (err) {
      if (err instanceof DomainError && !err.retryable) {
        return await recordPermanentFailureOrReleaseLease({
          db,
          ctx,
          taskId: task.id,
          claimedVersion: claimed.version,
          leaseToken: claimed.lease_token,
          preClaimVersion,
          ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
          adapterName: input.adapter.name,
          estimatedCostCents: stepOutput.estimated_cost_cents,
          reason: `${err.code}: ${err.message}`,
          nowMs,
        });
      }

      const retryReason =
        err instanceof Error ? err.message : `Transient failure during ${actionKind}`;
      await releaseWorkerLeaseOnRetry({
        db,
        workspaceId: ctx.workspaceId,
        botConnectionId: ctx.botConnectionId,
        taskId: task.id,
        claimedVersion: claimed.version,
        leaseToken: claimed.lease_token,
        preClaimVersion,
        ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
        reason: retryReason,
        nowMs,
      });
      await recordWorkerStepExecutedEvent(db, {
        workspaceId: ctx.workspaceId,
        botConnectionId: ctx.botConnectionId,
        taskId: task.id,
        ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
        actionKind: `${actionKind}:retry`,
        adapterName: input.adapter.name,
        estimatedCostCents: stepOutput.estimated_cost_cents,
        nowMs,
      });
      return {
        outcome: "retry",
        delaySeconds: 10,
        reason: retryReason,
      };
    }
  };

  if (stepOutput.action === "submit_proposal") {
    if (
      budgetEval.usage.cardsCreatedToday + stepOutput.proposals.length >
      budgetEval.limit.max_cards_per_day
    ) {
      const capMessage = `Daily card limit would be exceeded (${budgetEval.usage.cardsCreatedToday + stepOutput.proposals.length}/${budgetEval.limit.max_cards_per_day}).`;
      return await runPostClaimMutation("budget_blocked", async () => {
        await updateTask(
          db,
          ctx,
          {
            request_id: `worker-cap-${task.id}-v${claimed.version}-${generateEntityId("req")}`,
            task_id: task.id,
            expected_version: claimed.version,
            lease_token: claimed.lease_token,
            status: "blocked",
            status_reason: capMessage,
          },
          nowMs,
        );
        await markDecisionConsumedScoped(db, ctx.workspaceId, task.id, input.decisionId, nowMs);
        await db.orm.insert(schema.events).values({
          id: generateEntityId("evt"),
          workspaceId: ctx.workspaceId,
          actorType: "system",
          actorId: ctx.botConnectionId,
          entityType: "task",
          entityId: task.id,
          action: "worker.budget_exceeded",
          payloadJson: JSON.stringify({
            breached_limit: "max_cards_per_day",
            message: capMessage,
            usage: budgetEval.usage,
            limit: budgetEval.limit,
          }),
          requestId: null,
          createdAt: nowMs,
        });
        return { outcome: "budget_blocked", reason: capMessage };
      });
    }

    return await runPostClaimMutation("submit_proposal", async () => {
      await submitProposal(
        db,
        ctx,
        {
          request_id: `worker-prop-${task.id}-v${claimed.version}-${generateEntityId("req")}`,
          task_id: task.id,
          expected_version: claimed.version,
          lease_token: claimed.lease_token,
          ...(stepOutput.selection_group_id !== undefined
            ? { selection_group_id: stepOutput.selection_group_id }
            : {}),
          ...(stepOutput.artifact !== undefined ? { artifact: stepOutput.artifact } : {}),
          proposals: stepOutput.proposals,
        },
        nowMs,
      );
      await markDecisionConsumedScoped(db, ctx.workspaceId, task.id, input.decisionId, nowMs);
      return { outcome: "completed", action: "submit_proposal" };
    });
  }

  if (stepOutput.action === "record_result") {
    if (stepOutput.outcome === "success" && task.requiresApproval) {
      return await recordPermanentFailureOrReleaseLease({
        db,
        ctx,
        taskId: task.id,
        claimedVersion: claimed.version,
        leaseToken: claimed.lease_token,
        preClaimVersion,
        ...(input.decisionId !== undefined ? { decisionId: input.decisionId } : {}),
        adapterName: input.adapter.name,
        estimatedCostCents: stepOutput.estimated_cost_cents,
        reason:
          "APPROVAL_REQUIRED: Model attempted direct record_result(success) on requires_approval=true task.",
        nowMs,
      });
    }

    return await runPostClaimMutation(`record_result:${stepOutput.outcome}`, async () => {
      await recordResult(
        db,
        ctx,
        {
          request_id: `worker-res-${task.id}-v${claimed.version}-${generateEntityId("req")}`,
          task_id: task.id,
          expected_version: claimed.version,
          lease_token: claimed.lease_token,
          outcome: stepOutput.outcome,
          ...(stepOutput.summary !== undefined ? { summary: stepOutput.summary } : {}),
          ...(stepOutput.status_reason !== undefined
            ? { status_reason: stepOutput.status_reason }
            : {}),
          ...(input.decisionId !== undefined ? { decision_id: input.decisionId } : {}),
          ...(stepOutput.artifact !== undefined ? { artifact: stepOutput.artifact } : {}),
        },
        nowMs,
      );
      await markDecisionConsumedScoped(db, ctx.workspaceId, task.id, input.decisionId, nowMs);
      return { outcome: "completed", action: "record_result" };
    });
  }

  // stepOutput.action === "update_task"
  return await runPostClaimMutation(`update_task:${stepOutput.status}`, async () => {
    if (stepOutput.subtasks !== undefined) {
      for (let idx = 0; idx < stepOutput.subtasks.length; idx += 1) {
        const sub = stepOutput.subtasks[idx];
        if (sub === undefined) {
          continue;
        }
        await createTask(
          db,
          ctx,
          {
            request_id: `worker-sub-${task.id}-v${claimed.version}-${idx}-${generateEntityId("req")}`,
            title: sub.title,
            description: sub.description,
            parent_task_id: task.id,
            requires_approval: sub.requires_approval,
          },
          nowMs,
        );
      }
    }

    await updateTask(
      db,
      ctx,
      {
        request_id: `worker-upd-${task.id}-v${claimed.version}-${generateEntityId("req")}`,
        task_id: task.id,
        expected_version: claimed.version,
        lease_token: claimed.lease_token,
        status: stepOutput.status,
        ...(stepOutput.description !== undefined ? { description: stepOutput.description } : {}),
        ...(stepOutput.status_reason !== undefined
          ? { status_reason: stepOutput.status_reason }
          : {}),
        ...(stepOutput.artifact !== undefined ? { artifact: stepOutput.artifact } : {}),
      },
      nowMs,
    );
    await markDecisionConsumedScoped(db, ctx.workspaceId, task.id, input.decisionId, nowMs);
    return { outcome: "completed", action: "update_task" };
  });
}

export interface HandleBotWorkDlqInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly decisionId?: string;
  readonly reason?: string;
  readonly nowMs?: number;
}

/**
 * BOT-03 & M4: Records DLQ arrival as Task status = 'failed' with explicit reason and retry_count increment.
 * Strictly restricted to status IN ('ready', 'running'), scoped to (workspace_id, task_id),
 * and when decisionId is present requires that decision to be finalized & unconsumed so duplicate DLQ
 * messages NEVER clobber waiting_human, done, or already-processed tasks.
 */
export async function handleBotWorkDlqMessage(
  db: AppDatabase,
  input: HandleBotWorkDlqInput,
): Promise<{ readonly applied: boolean }> {
  const nowMs = input.nowMs ?? Date.now();
  const reason = (
    input.reason !== undefined && input.reason.trim() !== ""
      ? input.reason.trim()
      : "Queue retries exhausted (moved to bot-work-dlq)"
  ).slice(0, 500);
  const eventId = generateEntityId("evt");

  const parentParams: SqlParam[] = [reason, nowMs, input.taskId, input.workspaceId];
  let decisionGuardSql = "";
  const followUps: RawSqlStatement[] = [
    {
      sql: "DELETE FROM work_leases WHERE task_id = ?",
      params: [input.taskId],
    },
  ];

  if (input.decisionId !== undefined) {
    decisionGuardSql =
      " AND EXISTS (SELECT 1 FROM decisions d INNER JOIN decision_cards dc ON d.card_id = dc.id INNER JOIN proposals p ON dc.proposal_id = p.id WHERE d.id = ? AND dc.workspace_id = ? AND p.task_id = ? AND d.status = 'finalized' AND d.consumed_at IS NULL)";
    parentParams.push(input.decisionId, input.workspaceId, input.taskId);
    followUps.push(
      buildScopedConsumeDecisionSql({
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        decisionId: input.decisionId,
        nowMs,
      }),
    );
  }

  followUps.push({
    sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', 'bot-work-dlq', 'task', ?, 'worker.dlq_failed', ?, NULL, ?)",
    params: [
      eventId,
      input.workspaceId,
      input.taskId,
      JSON.stringify({
        task_id: input.taskId,
        decision_id: input.decisionId ?? null,
        status_reason: reason,
      }),
      nowMs,
    ],
  });

  const outcome = await guardedBatch(db.executor, {
    parentUpdate: {
      sql: `UPDATE tasks
            SET status = 'failed', status_reason = ?, retry_count = retry_count + 1, version = version + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND status IN ('ready', 'running')${decisionGuardSql}`,
      params: parentParams,
    },
    followUps,
  });

  return { applied: outcome.applied };
}
