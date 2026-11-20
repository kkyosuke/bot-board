import { and, asc, eq, lte } from "drizzle-orm";

import {
  type AppDatabase,
  didParentMutationApply,
  guardedBatch,
  type GuardedMutationOutcome,
  type RawSqlStatement,
  schema,
  type SqlParam,
} from "@/db";
import {
  CARD_TYPES,
  type CardType,
  DECISION_CARD_STATUSES,
  type DecisionCardStatus,
  evaluateCardFinalizeOutcome,
  ON_DECLINE_POLICIES,
  type OnDeclinePolicy,
  resolveTaskStatusAfterDecisionFinalized,
  type TaskStatus,
} from "@/domain";
import { canonicalJsonHash, generateEntityId } from "@/services/system/idempotency";
import { type BotWorkQueueProducer } from "@/services/system/queues";
import { createLogger } from "@/shared/logger";

export type FinalizeTriggerSource = "queue" | "cron" | "on_demand";

export type FinalizeResultKind = "noop" | "not_due" | "accepted" | "declined" | "expired" | "stale";

export interface FinalizeDecisionCardResult {
  readonly source: FinalizeTriggerSource;
  readonly outcome: GuardedMutationOutcome;
  readonly result: FinalizeResultKind;
  readonly cardId: string;
  readonly retryAfterSeconds?: number;
  readonly decisionId?: string;
  readonly replacementCardId?: string;
  readonly nextTaskStatus?: TaskStatus;
}

export interface FinalizeDecisionCardOptions {
  readonly source: FinalizeTriggerSource;
  readonly workspaceId?: string;
  readonly nowMs?: number;
  readonly botWorkQueue?: BotWorkQueueProducer;
}

export interface ReconfirmationBuildResult {
  readonly replacementCardId: string;
  readonly replacementProposalId: string | null;
  readonly followUps: readonly RawSqlStatement[];
}

const finalizeLogger = createLogger("system-finalize");

function parseCardType(raw: string): CardType {
  for (const item of CARD_TYPES) {
    if (item === raw) {
      return item;
    }
  }
  return "policy";
}

function parseCardStatus(raw: string): DecisionCardStatus {
  for (const item of DECISION_CARD_STATUSES) {
    if (item === raw) {
      return item;
    }
  }
  return "pending";
}

function parseOnDeclinePolicy(raw: string): OnDeclinePolicy {
  for (const item of ON_DECLINE_POLICIES) {
    if (item === raw) {
      return item;
    }
  }
  return "revise";
}

function parseProvisionalResult(raw: string | null): "accepted" | "declined" | null {
  if (raw === "accepted" || raw === "declined") {
    return raw;
  }
  return null;
}

function parseTaskStatus(raw: string): TaskStatus | undefined {
  if (
    raw === "ready" ||
    raw === "running" ||
    raw === "waiting_human" ||
    raw === "done" ||
    raw === "blocked" ||
    raw === "failed"
  ) {
    return raw;
  }
  return undefined;
}

export async function findReplacementCardIdForProposal(
  db: AppDatabase,
  workspaceId: string,
  supersededByProposalId: string | null,
): Promise<string | null> {
  if (supersededByProposalId === null) {
    return null;
  }
  const replacementCard = await db.orm
    .select({ id: schema.decisionCards.id })
    .from(schema.decisionCards)
    .where(
      and(
        eq(schema.decisionCards.workspaceId, workspaceId),
        eq(schema.decisionCards.proposalId, supersededByProposalId),
      ),
    )
    .get();
  return replacementCard?.id ?? null;
}

export async function buildStaleReconfirmationFollowUps(params: {
  readonly db: AppDatabase;
  readonly workspaceId: string;
  readonly proposal: typeof schema.proposals.$inferSelect;
  readonly selectionGroupId: string | null;
  readonly currentTaskVersion: number;
  readonly currentArtifactVersion: number | null;
  readonly nowMs: number;
}): Promise<ReconfirmationBuildResult> {
  const existingReplacementCardId = await findReplacementCardIdForProposal(
    params.db,
    params.workspaceId,
    params.proposal.supersededById,
  );
  if (existingReplacementCardId !== null) {
    return {
      replacementCardId: existingReplacementCardId,
      replacementProposalId: params.proposal.supersededById,
      followUps: [],
    };
  }

  const replacementProposalId = generateEntityId("prop");
  const replacementCardId = generateEntityId("card");
  const reconfirmTitle = params.proposal.title.startsWith("[再確認]")
    ? params.proposal.title.slice(0, 160)
    : `[再確認] ${params.proposal.title}`.slice(0, 160);
  const reconfirmSuffix = "\n（対象タスクまたは成果の版が更新されたため再確認が必要です）";
  const reconfirmSummary = params.proposal.summary.includes("再確認が必要です")
    ? params.proposal.summary.slice(0, 1000)
    : `${params.proposal.summary.slice(0, 1000 - reconfirmSuffix.length)}${reconfirmSuffix}`;

  const payloadHash = await canonicalJsonHash({
    reconfirm_for_proposal_id: params.proposal.id,
    selection_group_id: params.selectionGroupId,
    target_task_version: params.currentTaskVersion,
    target_artifact_id: params.proposal.targetArtifactId,
    target_artifact_version: params.currentArtifactVersion,
    title: reconfirmTitle,
  });

  const followUps: RawSqlStatement[] = [
    {
      sql: `INSERT INTO proposals (
        id, workspace_id, task_id, proposer_bot_id, card_type, selection_mode, options_json,
        title, summary, on_accept_effect, on_decline_effect, on_decline_policy, factors_json,
        target_task_version, target_artifact_id, target_artifact_version, payload_hash, superseded_by_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      params: [
        replacementProposalId,
        params.workspaceId,
        params.proposal.taskId,
        params.proposal.proposerBotId,
        params.proposal.cardType,
        params.proposal.selectionMode,
        params.proposal.optionsJson,
        reconfirmTitle,
        reconfirmSummary,
        params.proposal.onAcceptEffect,
        params.proposal.onDeclineEffect,
        params.proposal.onDeclinePolicy,
        params.proposal.factorsJson,
        params.currentTaskVersion,
        params.proposal.targetArtifactId,
        params.currentArtifactVersion,
        payloadHash,
        params.nowMs,
      ],
    },
    {
      sql: "UPDATE proposals SET superseded_by_id = ? WHERE id = ? AND workspace_id = ? AND superseded_by_id IS NULL",
      params: [replacementProposalId, params.proposal.id, params.workspaceId],
    },
    {
      // B1: Preserve selection_group_id on reconfirmation card so DEC-04 candidate exclusivity holds
      sql: `INSERT INTO decision_cards (
        id, workspace_id, proposal_id, selection_group_id, status,
        provisional_result, provisional_until, expires_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, 1, ?, ?)`,
      params: [
        replacementCardId,
        params.workspaceId,
        replacementProposalId,
        params.selectionGroupId,
        params.nowMs,
        params.nowMs,
      ],
    },
  ];

  return {
    replacementCardId,
    replacementProposalId,
    followUps,
  };
}

export async function finalizeDecisionCard(
  db: AppDatabase,
  cardId: string,
  options: FinalizeDecisionCardOptions,
): Promise<FinalizeDecisionCardResult> {
  const nowMs = options.nowMs ?? Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // B2: Enforce workspaceId boundary when invoked on behalf of an authenticated workspace caller
    const card = await db.orm
      .select()
      .from(schema.decisionCards)
      .where(
        options.workspaceId !== undefined
          ? and(
              eq(schema.decisionCards.id, cardId),
              eq(schema.decisionCards.workspaceId, options.workspaceId),
            )
          : eq(schema.decisionCards.id, cardId),
      )
      .get();

    if (card === undefined) {
      return {
        source: options.source,
        outcome: didParentMutationApply(0),
        result: "noop",
        cardId,
      };
    }

    const cardStatus = parseCardStatus(card.status);
    const provisionalResult = parseProvisionalResult(card.provisionalResult);
    if (
      cardStatus !== "provisional" ||
      provisionalResult === null ||
      card.provisionalUntil === null
    ) {
      return {
        source: options.source,
        outcome: didParentMutationApply(0),
        result: "noop",
        cardId,
      };
    }

    if (nowMs < card.provisionalUntil) {
      return {
        source: options.source,
        outcome: didParentMutationApply(0),
        result: "not_due",
        cardId,
        retryAfterSeconds: Math.max(1, Math.ceil((card.provisionalUntil - nowMs) / 1000)),
      };
    }

    const proposal = await db.orm
      .select()
      .from(schema.proposals)
      .where(
        and(
          eq(schema.proposals.id, card.proposalId),
          eq(schema.proposals.workspaceId, card.workspaceId),
        ),
      )
      .get();

    const activeDecision = await db.orm
      .select()
      .from(schema.decisions)
      .where(and(eq(schema.decisions.cardId, card.id), eq(schema.decisions.status, "provisional")))
      .get();

    if (proposal === undefined || activeDecision === undefined) {
      return {
        source: options.source,
        outcome: didParentMutationApply(0),
        result: "noop",
        cardId,
      };
    }

    const task = await db.orm
      .select()
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.id, proposal.taskId), eq(schema.tasks.workspaceId, card.workspaceId)),
      )
      .get();

    if (task === undefined) {
      return {
        source: options.source,
        outcome: didParentMutationApply(0),
        result: "noop",
        cardId,
      };
    }

    let currentArtifactVersion: number | null = null;
    if (proposal.targetArtifactId !== null) {
      const artifact = await db.orm
        .select({ version: schema.artifacts.version })
        .from(schema.artifacts)
        .where(
          and(
            eq(schema.artifacts.id, proposal.targetArtifactId),
            eq(schema.artifacts.workspaceId, card.workspaceId),
          ),
        )
        .get();
      currentArtifactVersion = artifact?.version ?? null;
    }

    const evaluation = evaluateCardFinalizeOutcome({
      cardStatus,
      provisionalResult,
      nowMs,
      provisionalUntilMs: card.provisionalUntil,
      expiresAtMs: card.expiresAt,
      targetTaskVersion: proposal.targetTaskVersion,
      currentTaskVersion: task.version,
      targetArtifactVersion: proposal.targetArtifactVersion,
      currentArtifactVersion,
    });

    if (evaluation === "noop") {
      return {
        source: options.source,
        outcome: didParentMutationApply(0),
        result: "noop",
        cardId,
      };
    }

    const eventId = generateEntityId("evt");

    if (evaluation === "expired") {
      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE decision_cards
                SET status = 'expired', provisional_result = NULL, provisional_until = NULL, version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status = 'provisional' AND provisional_until <= ? AND version = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
          params: [nowMs, card.id, card.workspaceId, nowMs, card.version, nowMs],
        },
        followUps: [
          {
            sql: "UPDATE decisions SET status = 'canceled', canceled_at = ? WHERE card_id = ? AND status = 'provisional'",
            params: [nowMs, card.id],
          },
          {
            sql: `UPDATE tasks
                  SET status = 'ready', status_reason = 'Decision card expired', version = version + 1, updated_at = ?
                  WHERE id = ? AND workspace_id = ? AND status = 'waiting_human'
                    AND NOT EXISTS (
                      SELECT 1 FROM decision_cards dc
                      JOIN proposals p ON p.id = dc.proposal_id
                      WHERE p.task_id = ? AND dc.workspace_id = ? AND dc.status IN ('pending', 'deferred', 'provisional')
                    )`,
            params: [nowMs, task.id, card.workspaceId, task.id, card.workspaceId],
          },
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'decision_card', ?, 'card.expired', ?, NULL, ?)",
            params: [
              eventId,
              card.workspaceId,
              `finalize:${options.source}`,
              card.id,
              JSON.stringify({
                card_id: card.id,
                decision_id: activeDecision.id,
                source: options.source,
              }),
              nowMs,
            ],
          },
        ],
      });

      if (batchOutcome.applied) {
        return {
          source: options.source,
          outcome: batchOutcome,
          result: "expired",
          cardId: card.id,
        };
      }
      continue;
    }

    // B1: If target task is no longer waiting_human (e.g. already done or running), NEVER reopen task or spawn reconfirmation card
    const isTaskWaitingHuman = task.status === "waiting_human";
    if (evaluation === "stale" || !isTaskWaitingHuman) {
      const reconfirm = isTaskWaitingHuman
        ? await buildStaleReconfirmationFollowUps({
            db,
            workspaceId: card.workspaceId,
            proposal,
            selectionGroupId: card.selectionGroupId,
            currentTaskVersion: task.version,
            currentArtifactVersion,
            nowMs,
          })
        : null;

      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE decision_cards
                SET status = 'superseded', provisional_result = NULL, provisional_until = NULL, version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status = 'provisional' AND provisional_until <= ? AND version = ?
                  AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status = ?)`,
          params: [
            nowMs,
            card.id,
            card.workspaceId,
            nowMs,
            card.version,
            task.id,
            card.workspaceId,
            task.status,
          ],
        },
        followUps: [
          {
            sql: "UPDATE decisions SET status = 'canceled', canceled_at = ? WHERE card_id = ? AND status = 'provisional'",
            params: [nowMs, card.id],
          },
          ...(reconfirm !== null ? reconfirm.followUps : []),
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'decision_card', ?, ?, ?, NULL, ?)",
            params: [
              eventId,
              card.workspaceId,
              `finalize:${options.source}`,
              card.id,
              reconfirm !== null ? "card.stale_reconfirmation" : "card.stale_closed_inactive_task",
              JSON.stringify({
                card_id: card.id,
                decision_id: activeDecision.id,
                task_status: task.status,
                replacement_card_id: reconfirm?.replacementCardId ?? null,
                source: options.source,
              }),
              nowMs,
            ],
          },
        ],
      });

      if (batchOutcome.applied) {
        return {
          source: options.source,
          outcome: batchOutcome,
          result: "stale",
          cardId: card.id,
          ...(reconfirm !== null ? { replacementCardId: reconfirm.replacementCardId } : {}),
        };
      }
      continue;
    }

    const cardType = parseCardType(proposal.cardType);
    const onDeclinePolicy = parseOnDeclinePolicy(proposal.onDeclinePolicy);
    const nextCardVersion = card.version + 1;

    // B1: Pin BOTH tasks.status = 'waiting_human' AND tasks.version = target_task_version atomically
    const parentParams: SqlParam[] = [
      evaluation,
      nowMs,
      card.id,
      card.workspaceId,
      evaluation,
      nowMs,
      card.version,
      nowMs,
      task.id,
      card.workspaceId,
      proposal.targetTaskVersion,
    ];
    let artifactGuardSql = "";
    if (proposal.targetArtifactId !== null && proposal.targetArtifactVersion !== null) {
      artifactGuardSql =
        " AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND workspace_id = ? AND version = ?)";
      parentParams.push(
        proposal.targetArtifactId,
        card.workspaceId,
        proposal.targetArtifactVersion,
      );
    }

    const parentUpdate: RawSqlStatement = {
      sql: `UPDATE decision_cards
            SET status = ?, provisional_result = NULL, provisional_until = NULL, version = version + 1, updated_at = ?
            WHERE id = ?
              AND workspace_id = ?
              AND status = 'provisional'
              AND provisional_result = ?
              AND provisional_until <= ?
              AND version = ?
              AND (expires_at IS NULL OR expires_at > ?)
              AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status = 'waiting_human' AND version = ?)${artifactGuardSql}`,
      params: parentParams,
    };

    const followUps: RawSqlStatement[] = [];

    if (evaluation === "accepted") {
      const nextTaskStatus = resolveTaskStatusAfterDecisionFinalized({
        cardType,
        decisionResult: "accepted",
        onDeclinePolicy,
        remainingUndecidedInGroup: 0,
      });

      if (card.selectionGroupId !== null) {
        followUps.push(
          {
            sql: `UPDATE decisions
                  SET status = 'canceled', canceled_at = ?
                  WHERE status = 'provisional'
                    AND card_id IN (
                      SELECT id FROM decision_cards
                      WHERE workspace_id = ? AND selection_group_id = ? AND id != ?
                    )`,
            params: [nowMs, card.workspaceId, card.selectionGroupId, card.id],
          },
          {
            sql: `UPDATE decision_cards
                  SET status = 'closed', provisional_result = NULL, provisional_until = NULL, version = version + 1, updated_at = ?
                  WHERE workspace_id = ? AND selection_group_id = ? AND id != ? AND status IN ('pending', 'deferred', 'provisional')`,
            params: [nowMs, card.workspaceId, card.selectionGroupId, card.id],
          },
        );
      }

      const taskReason =
        nextTaskStatus === "done"
          ? "Deliverable proposal accepted"
          : "Decision accepted; ready for next step";

      followUps.push(
        {
          sql: "UPDATE tasks SET status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'waiting_human' AND version = ?",
          params: [nextTaskStatus, taskReason, nowMs, task.id, card.workspaceId, task.version],
        },
        {
          sql: `UPDATE decisions
                SET status = 'finalized', card_version = ?, finalized_task_version = (SELECT version FROM tasks WHERE id = ?), finalized_at = ?
                WHERE id = ? AND card_id = ? AND status = 'provisional'`,
          params: [nextCardVersion, task.id, nowMs, activeDecision.id, card.id],
        },
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'decision', ?, 'decision.finalized', ?, NULL, ?)",
          params: [
            eventId,
            card.workspaceId,
            `finalize:${options.source}`,
            activeDecision.id,
            JSON.stringify({
              card_id: card.id,
              task_id: task.id,
              result: "accepted",
              next_task_status: nextTaskStatus,
              source: options.source,
            }),
            nowMs,
          ],
        },
      );

      const batchOutcome = await guardedBatch(db.executor, { parentUpdate, followUps });
      if (batchOutcome.applied) {
        if (nextTaskStatus === "ready" && options.botWorkQueue !== undefined) {
          try {
            await options.botWorkQueue.send({
              decision_id: activeDecision.id,
              task_id: task.id,
              workspace_id: card.workspaceId,
            });
          } catch (error) {
            finalizeLogger.warn(
              "Failed to enqueue bot-work after accepted finalization (Cron will recover)",
              {
                error,
                cardId: card.id,
                decisionId: activeDecision.id,
              },
            );
          }
        }
        return {
          source: options.source,
          outcome: batchOutcome,
          result: "accepted",
          cardId: card.id,
          decisionId: activeDecision.id,
          nextTaskStatus,
        };
      }
      continue;
    }

    // evaluation === "declined"
    const allDeclinedTaskStatus = resolveTaskStatusAfterDecisionFinalized({
      cardType,
      decisionResult: "declined",
      onDeclinePolicy,
      remainingUndecidedInGroup: 0,
    });
    const declineReason =
      allDeclinedTaskStatus === "blocked"
        ? "All proposals declined (policy: block)"
        : "Proposal declined; revision required";

    if (card.selectionGroupId === null) {
      followUps.push({
        sql: "UPDATE tasks SET status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'waiting_human' AND version = ?",
        params: [
          allDeclinedTaskStatus,
          declineReason,
          nowMs,
          task.id,
          card.workspaceId,
          task.version,
        ],
      });
    } else {
      followUps.push({
        sql: `UPDATE tasks
              SET status = ?, status_reason = ?, version = version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND status = 'waiting_human' AND version = ?
                AND NOT EXISTS (
                  SELECT 1 FROM decision_cards
                  WHERE workspace_id = ? AND selection_group_id = ?
                    AND status IN ('pending', 'deferred', 'provisional', 'accepted')
                )`,
        params: [
          allDeclinedTaskStatus,
          declineReason,
          nowMs,
          task.id,
          card.workspaceId,
          task.version,
          card.workspaceId,
          card.selectionGroupId,
        ],
      });
    }

    followUps.push(
      {
        sql: `UPDATE decisions
              SET status = 'finalized', card_version = ?, finalized_task_version = (SELECT version FROM tasks WHERE id = ?), finalized_at = ?
              WHERE id = ? AND card_id = ? AND status = 'provisional'`,
        params: [nextCardVersion, task.id, nowMs, activeDecision.id, card.id],
      },
      {
        sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'decision', ?, 'decision.finalized', ?, NULL, ?)",
        params: [
          eventId,
          card.workspaceId,
          `finalize:${options.source}`,
          activeDecision.id,
          JSON.stringify({
            card_id: card.id,
            task_id: task.id,
            result: "declined",
            on_decline_policy: onDeclinePolicy,
            source: options.source,
          }),
          nowMs,
        ],
      },
    );

    const batchOutcome = await guardedBatch(db.executor, { parentUpdate, followUps });
    if (batchOutcome.applied) {
      const updatedTask = await db.orm
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, task.id))
        .get();
      const nextTaskStatus =
        updatedTask !== undefined ? parseTaskStatus(updatedTask.status) : undefined;
      if (nextTaskStatus === "ready" && options.botWorkQueue !== undefined) {
        try {
          await options.botWorkQueue.send({
            decision_id: activeDecision.id,
            task_id: task.id,
            workspace_id: card.workspaceId,
          });
        } catch (error) {
          finalizeLogger.warn(
            "Failed to enqueue bot-work after declined finalization (Cron will recover)",
            {
              error,
              cardId: card.id,
              decisionId: activeDecision.id,
            },
          );
        }
      }
      return {
        source: options.source,
        outcome: batchOutcome,
        result: "declined",
        cardId: card.id,
        decisionId: activeDecision.id,
        ...(nextTaskStatus !== undefined ? { nextTaskStatus } : {}),
      };
    }
  }

  return {
    source: options.source,
    outcome: didParentMutationApply(0),
    result: "noop",
    cardId,
  };
}

export async function finalizeExpiredProvisionalCards(
  db: AppDatabase,
  options: FinalizeDecisionCardOptions & {
    readonly workspaceId?: string;
    readonly limit?: number;
  },
): Promise<readonly FinalizeDecisionCardResult[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const dueCards = await db.orm
    .select({ id: schema.decisionCards.id })
    .from(schema.decisionCards)
    .where(
      options.workspaceId !== undefined
        ? and(
            eq(schema.decisionCards.workspaceId, options.workspaceId),
            eq(schema.decisionCards.status, "provisional"),
            lte(schema.decisionCards.provisionalUntil, nowMs),
          )
        : and(
            eq(schema.decisionCards.status, "provisional"),
            lte(schema.decisionCards.provisionalUntil, nowMs),
          ),
    )
    .orderBy(asc(schema.decisionCards.provisionalUntil), asc(schema.decisionCards.id))
    .limit(limit)
    .all();

  const results: FinalizeDecisionCardResult[] = [];
  for (const row of dueCards) {
    const res = await finalizeDecisionCard(db, row.id, {
      source: options.source,
      ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
      nowMs,
      ...(options.botWorkQueue !== undefined ? { botWorkQueue: options.botWorkQueue } : {}),
    });
    results.push(res);
  }
  return results;
}
