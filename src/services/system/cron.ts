import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { type AppDatabase, guardedBatch, type RawSqlStatement, schema, type SqlParam } from "@/db";
import { finalizeExpiredProvisionalCards } from "@/services/system/finalize";
import { generateEntityId } from "@/services/system/idempotency";
import { type BotWorkQueueProducer } from "@/services/system/queues";
import { createLogger } from "@/shared/logger";

const cronLogger = createLogger("system-cron");

export interface CronMaintenanceOptions {
  readonly nowMs?: number;
  readonly botWorkQueue?: BotWorkQueueProducer;
  readonly limit?: number;
}

export interface CronMaintenanceReport {
  readonly finalizedCount: number;
  readonly releasedLeasesCount: number;
  readonly expiredCardsCount: number;
  readonly redispatchedDecisionsCount: number;
}

/**
 * Cron Duty #2: Release expired work_leases and return orphaned running tasks to ready.
 * B2: Pins exact task status/version inside parentUpdate so a concurrent task version bump
 * rolls back the lease deletion rather than leaving a running task permanently without a lease.
 */
export async function releaseExpiredWorkLeases(
  db: AppDatabase,
  options: { readonly nowMs?: number; readonly limit?: number } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const expiredLeases = await db.orm
    .select({
      taskId: schema.workLeases.taskId,
      botId: schema.workLeases.botId,
      leaseToken: schema.workLeases.leaseToken,
      expiresAt: schema.workLeases.expiresAt,
    })
    .from(schema.workLeases)
    .where(lte(schema.workLeases.expiresAt, nowMs))
    .orderBy(asc(schema.workLeases.expiresAt), asc(schema.workLeases.taskId))
    .limit(limit)
    .all();

  let releasedCount = 0;

  for (const lease of expiredLeases) {
    const task = await db.orm
      .select({
        id: schema.tasks.id,
        workspaceId: schema.tasks.workspaceId,
        status: schema.tasks.status,
        version: schema.tasks.version,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, lease.taskId))
      .get();

    let parentGuardSql: string;
    const parentParams: SqlParam[] = [lease.taskId, lease.leaseToken, nowMs];
    const followUps: RawSqlStatement[] = [];

    if (task === undefined) {
      parentGuardSql = " AND NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)";
      parentParams.push(lease.taskId);
    } else if (task.status === "running") {
      parentGuardSql =
        " AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status = 'running' AND version = ?)";
      parentParams.push(task.id, task.workspaceId, task.version);

      const nextTaskVersion = task.version + 1;
      const preClaimTaskVersion = task.version - 1;
      const eventId = generateEntityId("evt");
      followUps.push(
        {
          sql: `UPDATE tasks
                SET status = 'ready', status_reason = 'WorkLease expired; returned to ready', version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status = 'running' AND version = ?`,
          params: [nowMs, task.id, task.workspaceId, task.version],
        },
        {
          sql: `UPDATE decisions
                SET finalized_task_version = ?
                WHERE status = 'finalized'
                  AND consumed_at IS NULL
                  AND finalized_task_version = ?
                  AND card_id IN (
                    SELECT dc.id FROM decision_cards dc
                    INNER JOIN proposals p ON p.id = dc.proposal_id
                    WHERE p.task_id = ? AND dc.workspace_id = ?
                  )`,
          params: [nextTaskVersion, preClaimTaskVersion, task.id, task.workspaceId],
        },
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', 'cron', 'task', ?, 'lease.expired', ?, NULL, ?)",
          params: [
            eventId,
            task.workspaceId,
            task.id,
            JSON.stringify({
              task_id: task.id,
              bot_id: lease.botId,
              expired_at: lease.expiresAt,
              recovered_version: nextTaskVersion,
            }),
            nowMs,
          ],
        },
      );
    } else {
      parentGuardSql =
        " AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status != 'running')";
      parentParams.push(task.id, task.workspaceId);
    }

    const outcome = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: `DELETE FROM work_leases WHERE task_id = ? AND lease_token = ? AND expires_at <= ?${parentGuardSql}`,
        params: parentParams,
      },
      followUps,
    });

    if (outcome.applied) {
      releasedCount += 1;
    }
  }

  return releasedCount;
}

/**
 * Cron Duty #3: Expire overdue pending/deferred decision_cards and return waiting_human tasks
 * to ready when no active cards remain.
 */
export async function expireOverdueDecisionCards(
  db: AppDatabase,
  options: { readonly nowMs?: number; readonly limit?: number } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const overdueCards = await db.orm
    .select({
      id: schema.decisionCards.id,
      workspaceId: schema.decisionCards.workspaceId,
      version: schema.decisionCards.version,
      taskId: schema.proposals.taskId,
    })
    .from(schema.decisionCards)
    .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
    .where(
      and(
        inArray(schema.decisionCards.status, ["pending", "deferred"]),
        isNotNull(schema.decisionCards.expiresAt),
        lte(schema.decisionCards.expiresAt, nowMs),
      ),
    )
    .orderBy(asc(schema.decisionCards.expiresAt), asc(schema.decisionCards.id))
    .limit(limit)
    .all();

  let expiredCount = 0;

  for (const card of overdueCards) {
    const eventId = generateEntityId("evt");
    const outcome = await guardedBatch(db.executor, {
      parentUpdate: {
        sql: `UPDATE decision_cards
              SET status = 'expired', version = version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'deferred')
                AND expires_at IS NOT NULL AND expires_at <= ? AND version = ?`,
        params: [nowMs, card.id, card.workspaceId, nowMs, card.version],
      },
      followUps: [
        {
          sql: `UPDATE tasks
                SET status = 'ready', status_reason = 'Decision card expired', version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status = 'waiting_human'
                  AND NOT EXISTS (
                    SELECT 1 FROM decision_cards dc
                    INNER JOIN proposals p ON p.id = dc.proposal_id
                    WHERE p.task_id = ? AND dc.workspace_id = ? AND dc.status IN ('pending', 'deferred', 'provisional')
                  )`,
          params: [nowMs, card.taskId, card.workspaceId, card.taskId, card.workspaceId],
        },
        {
          sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', 'cron', 'decision_card', ?, 'card.expired', ?, NULL, ?)",
          params: [
            eventId,
            card.workspaceId,
            card.id,
            JSON.stringify({
              card_id: card.id,
              task_id: card.taskId,
              source: "cron",
            }),
            nowMs,
          ],
        },
      ],
    });

    if (outcome.applied) {
      expiredCount += 1;
    }
  }

  return expiredCount;
}

/**
 * Cron Duty #4: Re-dispatch the latest finalized unconsumed decision (consumed_at IS NULL) per ready task
 * in unpaused workspaces that have at least one active worker_bearer bot and no active WorkLease.
 * (M2: orders DESC so the latest resolved decision wins; Minor 5: skips MCP-only workspaces.)
 */
export async function redispatchUnconsumedDecisions(
  db: AppDatabase,
  options: CronMaintenanceOptions = {},
): Promise<number> {
  if (options.botWorkQueue === undefined) {
    return 0;
  }
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  const activeWorkerWorkspaces = await db.orm
    .select({ workspaceId: schema.botConnections.workspaceId })
    .from(schema.botConnections)
    .where(
      and(
        eq(schema.botConnections.channelType, "worker_bearer"),
        eq(schema.botConnections.status, "active"),
      ),
    )
    .all();

  const eligibleWorkspaceIds = new Set(activeWorkerWorkspaces.map((w) => w.workspaceId));
  if (eligibleWorkspaceIds.size === 0) {
    return 0;
  }

  const candidates = await db.orm
    .select({
      decisionId: schema.decisions.id,
      taskId: schema.tasks.id,
      workspaceId: schema.tasks.workspaceId,
      finalizedAt: schema.decisions.finalizedAt,
    })
    .from(schema.decisions)
    .innerJoin(schema.decisionCards, eq(schema.decisions.cardId, schema.decisionCards.id))
    .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
    .innerJoin(schema.tasks, eq(schema.proposals.taskId, schema.tasks.id))
    .innerJoin(schema.workspaces, eq(schema.tasks.workspaceId, schema.workspaces.id))
    .where(
      and(
        eq(schema.decisions.status, "finalized"),
        isNull(schema.decisions.consumedAt),
        eq(schema.tasks.status, "ready"),
        eq(schema.workspaces.isPaused, false),
      ),
    )
    .orderBy(desc(schema.decisions.finalizedAt), desc(schema.decisions.id))
    .limit(limit * 4)
    .all();

  const seenTaskIds = new Set<string>();
  let dispatchedCount = 0;

  for (const row of candidates) {
    if (dispatchedCount >= limit) {
      break;
    }
    if (!eligibleWorkspaceIds.has(row.workspaceId)) {
      continue;
    }
    if (seenTaskIds.has(row.taskId)) {
      continue;
    }
    seenTaskIds.add(row.taskId);

    const activeLease = await db.orm
      .select({ expiresAt: schema.workLeases.expiresAt })
      .from(schema.workLeases)
      .where(eq(schema.workLeases.taskId, row.taskId))
      .get();

    if (activeLease !== undefined && activeLease.expiresAt > nowMs) {
      continue;
    }

    try {
      await options.botWorkQueue.send({
        decision_id: row.decisionId,
        task_id: row.taskId,
        workspace_id: row.workspaceId,
      });
      dispatchedCount += 1;
    } catch (error) {
      cronLogger.warn("Failed to re-dispatch unconsumed finalized decision to bot-work queue", {
        error,
        decisionId: row.decisionId,
        taskId: row.taskId,
      });
    }
  }

  return dispatchedCount;
}

/**
 * Executes all 4 Cron Trigger duties in causal order without duplicate queueing (M1):
 * 1) Finalize expired provisional cards (DB finalization only; Duty #4 handles unified dispatch)
 * 2) Release expired WorkLeases -> ready (atomic task-version pinning)
 * 3) Expire overdue decision_cards -> expired / ready
 * 4) Dispatch finalized unconsumed decisions -> bot-work Queue (single pause/worker/lease-aware pass)
 */
export async function runScheduledMaintenance(
  db: AppDatabase,
  options: CronMaintenanceOptions = {},
): Promise<CronMaintenanceReport> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 50;

  // M1: Omit botWorkQueue here so Duty #4 is the single deduplicated dispatch pass for this Cron tick
  const finalizedResults = await finalizeExpiredProvisionalCards(db, {
    source: "cron",
    nowMs,
    limit,
  });
  const finalizedCount = finalizedResults.filter((r) => r.outcome.applied).length;

  const releasedLeasesCount = await releaseExpiredWorkLeases(db, { nowMs, limit });
  const expiredCardsCount = await expireOverdueDecisionCards(db, { nowMs, limit });
  const redispatchedDecisionsCount = await redispatchUnconsumedDecisions(db, {
    nowMs,
    limit,
    ...(options.botWorkQueue !== undefined ? { botWorkQueue: options.botWorkQueue } : {}),
  });

  cronLogger.info("Completed scheduled maintenance pass", {
    finalizedCount,
    releasedLeasesCount,
    expiredCardsCount,
    redispatchedDecisionsCount,
  });

  return {
    finalizedCount,
    releasedLeasesCount,
    expiredCardsCount,
    redispatchedDecisionsCount,
  };
}
