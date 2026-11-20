import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { type AppDatabase, schema } from "@/db";
import {
  type BudgetCheckResult,
  type BudgetLimit,
  type BudgetUsageSnapshot,
  evaluateBudgetLimit,
  parseBudgetLimit,
} from "@/domain";
import { generateEntityId } from "@/services/system/idempotency";

const MS_PER_UTC_DAY = 86_400_000;

export const WORKER_STEP_EVENT_ACTION = "worker.step_executed";

const workerStepEventPayloadSchema = z.object({
  estimated_cost_cents: z.number().int().min(0).optional(),
});

export function getUtcDayStartMs(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_UTC_DAY) * MS_PER_UTC_DAY;
}

export async function getWorkspaceBudgetUsage(
  db: AppDatabase,
  workspaceId: string,
  taskId: string,
  nowMs: number,
): Promise<BudgetUsageSnapshot> {
  const dayStartMs = getUtcDayStartMs(nowMs);

  const [cardsRow, taskStepsRow, todayStepEvents] = await Promise.all([
    db.orm
      .select({ count: sql<number>`count(*)` })
      .from(schema.decisionCards)
      .where(
        and(
          eq(schema.decisionCards.workspaceId, workspaceId),
          gte(schema.decisionCards.createdAt, dayStartMs),
        ),
      )
      .get(),
    db.orm
      .select({ count: sql<number>`count(*)` })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.workspaceId, workspaceId),
          eq(schema.events.action, WORKER_STEP_EVENT_ACTION),
          eq(schema.events.entityId, taskId),
        ),
      )
      .get(),
    db.orm
      .select({ payloadJson: schema.events.payloadJson })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.workspaceId, workspaceId),
          eq(schema.events.action, WORKER_STEP_EVENT_ACTION),
          gte(schema.events.createdAt, dayStartMs),
        ),
      )
      .all(),
  ]);

  let costCentsToday = 0;
  for (const row of todayStepEvents) {
    try {
      const parsedJson: unknown = JSON.parse(row.payloadJson);
      const parsed = workerStepEventPayloadSchema.safeParse(parsedJson);
      if (parsed.success && parsed.data.estimated_cost_cents !== undefined) {
        costCentsToday += parsed.data.estimated_cost_cents;
      }
    } catch {
      // Ignore malformed historical payload
    }
  }

  return {
    cardsCreatedToday: Number(cardsRow?.count ?? 0),
    stepsExecutedForTask: Number(taskStepsRow?.count ?? 0),
    costCentsToday,
  };
}

export interface WorkspaceBudgetEvaluation {
  readonly limit: BudgetLimit;
  readonly usage: BudgetUsageSnapshot;
  readonly check: BudgetCheckResult;
}

export async function checkWorkspaceBudget(
  db: AppDatabase,
  workspaceId: string,
  taskId: string,
  nowMs: number,
): Promise<WorkspaceBudgetEvaluation | null> {
  const workspace = await db.orm
    .select({ budgetLimit: schema.workspaces.budgetLimit })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();

  if (workspace === undefined) {
    return null;
  }

  const limit = parseBudgetLimit(workspace.budgetLimit);
  const usage = await getWorkspaceBudgetUsage(db, workspaceId, taskId, nowMs);
  const check = evaluateBudgetLimit(limit, usage);
  return { limit, usage, check };
}

export async function recordWorkerStepExecutedEvent(
  db: AppDatabase,
  params: {
    readonly workspaceId: string;
    readonly botConnectionId: string;
    readonly taskId: string;
    readonly decisionId?: string;
    readonly actionKind: string;
    readonly adapterName: string;
    readonly estimatedCostCents: number;
    readonly nowMs: number;
  },
): Promise<string> {
  const eventId = generateEntityId("evt");
  await db.orm.insert(schema.events).values({
    id: eventId,
    workspaceId: params.workspaceId,
    actorType: "system",
    actorId: params.botConnectionId,
    entityType: "task",
    entityId: params.taskId,
    action: WORKER_STEP_EVENT_ACTION,
    payloadJson: JSON.stringify({
      action_kind: params.actionKind,
      adapter: params.adapterName,
      decision_id: params.decisionId ?? null,
      estimated_cost_cents: Math.max(0, Math.trunc(params.estimatedCostCents)),
    }),
    requestId: null,
    createdAt: params.nowMs,
  });
  return eventId;
}
