import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";

import { type VerifiedBotContext } from "@/auth/context";
import { type AppDatabase, schema } from "@/db";
import {
  assertCardIsFinalizedForBot,
  type BudgetLimit,
  DECISION_CARD_STATUSES,
  DECISION_RECORD_STATUSES,
  type DecisionCardStatus,
  type DecisionRecordStatus,
  DomainError,
  parseBudgetLimit,
  TASK_STATUSES,
  type TaskStatus,
} from "@/domain";
import { assertBotReadScope } from "@/services/bot/guards";
import {
  type GetArtifactInput,
  getArtifactInputSchema,
  type GetTaskInput,
  getTaskInputSchema,
  type ListDecisionResultsInput,
  listDecisionResultsInputSchema,
  type ListTasksInput,
  listTasksInputSchema,
} from "@/services/bot/schemas";

export interface WorkspaceContextDto {
  readonly workspace_id: string;
  readonly goal: string;
  readonly allowed_scope: string;
  readonly budget_limit: BudgetLimit;
  readonly is_paused: boolean;
  readonly version: number;
  readonly status_meanings: Readonly<Record<TaskStatus, string>>;
}

export interface TaskSummaryDto {
  readonly id: string;
  readonly parent_task_id: string | null;
  readonly title: string;
  readonly status: TaskStatus;
  readonly status_reason: string | null;
  readonly requires_approval: boolean;
  readonly assigned_bot_id: string | null;
  readonly retry_count: number;
  readonly version: number;
  readonly updated_at: number;
}

export interface ArtifactSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly version: number;
  readonly updated_at: number;
}

export interface TaskDetailDto extends TaskSummaryDto {
  readonly description: string;
  readonly created_at: number;
  readonly active_lease: {
    readonly bot_id: string;
    readonly expires_at: number;
    readonly is_owned_by_caller: boolean;
  } | null;
  readonly artifacts: readonly ArtifactSummaryDto[];
  readonly active_cards: readonly {
    readonly card_id: string;
    readonly proposal_id: string;
    readonly selection_group_id: string | null;
    readonly status: DecisionCardStatus;
    readonly version: number;
  }[];
}

export interface ArtifactDetailDto {
  readonly id: string;
  readonly task_id: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly content_or_url: string;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface FinalizedDecisionResultDto {
  readonly decision_id: string;
  readonly card_id: string;
  readonly proposal_id: string;
  readonly task_id: string;
  readonly selection_group_id: string | null;
  readonly result: "accepted" | "declined";
  readonly selected_option_ids: readonly string[] | null;
  readonly card_version: number;
  readonly finalized_task_version: number | null;
  readonly finalized_at: number;
  readonly consumed_at: number | null;
}

const STATUS_MEANINGS: Readonly<Record<TaskStatus, string>> = Object.freeze({
  ready: "Claimable by an authorized Bot when workspace is not paused.",
  running: "Actively leased and executed by one Bot.",
  waiting_human: "Awaiting human swipe decision on one or more pending cards.",
  done: "Completed (requires accepted deliverable card when requires_approval=true).",
  blocked: "Waiting on prerequisite dependency or human retry after block.",
  failed: "Execution failed (never treated as done; requires human retry).",
});

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

function encodeCursor(timestamp: number, id: string): string {
  return `${timestamp}:${id}`;
}

function decodeCursor(cursor: string): { readonly timestamp: number; readonly id: string } {
  const colonIdx = cursor.indexOf(":");
  if (colonIdx <= 0 || colonIdx === cursor.length - 1) {
    throw new DomainError("VALIDATION_ERROR", "Malformed pagination cursor.", false);
  }
  const tsRaw = cursor.slice(0, colonIdx);
  const id = cursor.slice(colonIdx + 1);
  if (!/^\d+$/.test(tsRaw) || id.trim() === "" || id !== id.trim()) {
    throw new DomainError("VALIDATION_ERROR", "Malformed pagination cursor.", false);
  }
  const timestamp = Number(tsRaw);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new DomainError("VALIDATION_ERROR", "Malformed pagination cursor.", false);
  }
  return { timestamp, id };
}

function parseSelectedOptionIds(raw: string | null): readonly string[] | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

export async function getWorkspaceContext(
  db: AppDatabase,
  ctx: VerifiedBotContext,
): Promise<WorkspaceContextDto> {
  assertBotReadScope(ctx, ctx.workspaceId, "tasks:read");

  const workspace = await db.orm
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, ctx.workspaceId))
    .get();

  if (workspace === undefined) {
    throw new DomainError("NOT_FOUND", "Workspace not found.", false);
  }

  return {
    workspace_id: workspace.id,
    goal: workspace.goal,
    allowed_scope: workspace.allowedScope,
    budget_limit: parseBudgetLimit(workspace.budgetLimit),
    is_paused: workspace.isPaused,
    version: workspace.version,
    status_meanings: STATUS_MEANINGS,
  };
}

export async function listTasks(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: Partial<ListTasksInput> = {},
): Promise<{ readonly items: readonly TaskSummaryDto[]; readonly next_cursor: string | null }> {
  assertBotReadScope(ctx, ctx.workspaceId, "tasks:read");
  const input = listTasksInputSchema.parse(rawInput);

  const conditions = [eq(schema.tasks.workspaceId, ctx.workspaceId)];
  if (input.status !== undefined) {
    conditions.push(eq(schema.tasks.status, input.status));
  }
  if (input.assigned_bot_id !== undefined) {
    conditions.push(eq(schema.tasks.assignedBotId, input.assigned_bot_id));
  }
  if (input.parent_task_id !== undefined) {
    conditions.push(eq(schema.tasks.parentTaskId, input.parent_task_id));
  }
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    const cursorCond = or(
      lt(schema.tasks.updatedAt, decoded.timestamp),
      and(eq(schema.tasks.updatedAt, decoded.timestamp), lt(schema.tasks.id, decoded.id)),
    );
    if (cursorCond !== undefined) {
      conditions.push(cursorCond);
    }
  }

  const rows = await db.orm
    .select()
    .from(schema.tasks)
    .where(and(...conditions))
    .orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.id))
    .limit(input.limit + 1)
    .all();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const lastRow = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      parent_task_id: row.parentTaskId,
      title: row.title,
      status: parseTaskStatusStrict(row.status),
      status_reason: row.statusReason,
      requires_approval: row.requiresApproval,
      assigned_bot_id: row.assignedBotId,
      retry_count: row.retryCount,
      version: row.version,
      updated_at: row.updatedAt,
    })),
    next_cursor:
      hasMore && lastRow !== undefined ? encodeCursor(lastRow.updatedAt, lastRow.id) : null,
  };
}

export async function getTask(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: GetTaskInput,
  nowMs = Date.now(),
): Promise<TaskDetailDto> {
  assertBotReadScope(ctx, ctx.workspaceId, "tasks:read");
  const input = getTaskInputSchema.parse(rawInput);

  const task = await db.orm
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, input.task_id), eq(schema.tasks.workspaceId, ctx.workspaceId)))
    .get();

  if (task === undefined) {
    throw new DomainError("NOT_FOUND", `Task "${input.task_id}" not found.`, false);
  }

  const [lease, taskArtifacts, taskCards] = await Promise.all([
    db.orm
      .select({
        botId: schema.workLeases.botId,
        expiresAt: schema.workLeases.expiresAt,
      })
      .from(schema.workLeases)
      .where(eq(schema.workLeases.taskId, task.id))
      .get(),
    db.orm
      .select({
        id: schema.artifacts.id,
        title: schema.artifacts.title,
        kind: schema.artifacts.kind,
        summary: schema.artifacts.summary,
        version: schema.artifacts.version,
        updatedAt: schema.artifacts.updatedAt,
      })
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.workspaceId, ctx.workspaceId),
          eq(schema.artifacts.taskId, task.id),
        ),
      )
      .orderBy(desc(schema.artifacts.updatedAt))
      .limit(50)
      .all(),
    db.orm
      .select({
        cardId: schema.decisionCards.id,
        proposalId: schema.decisionCards.proposalId,
        selectionGroupId: schema.decisionCards.selectionGroupId,
        status: schema.decisionCards.status,
        version: schema.decisionCards.version,
      })
      .from(schema.decisionCards)
      .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
      .where(
        and(
          eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          eq(schema.proposals.taskId, task.id),
          inArray(schema.decisionCards.status, ["pending", "deferred", "provisional"]),
        ),
      )
      .orderBy(desc(schema.decisionCards.createdAt))
      .limit(50)
      .all(),
  ]);

  const activeLease =
    lease !== undefined && lease.expiresAt > nowMs
      ? {
          bot_id: lease.botId,
          expires_at: lease.expiresAt,
          is_owned_by_caller: lease.botId === ctx.botConnectionId,
        }
      : null;

  return {
    id: task.id,
    parent_task_id: task.parentTaskId,
    title: task.title,
    description: task.description,
    status: parseTaskStatusStrict(task.status),
    status_reason: task.statusReason,
    requires_approval: task.requiresApproval,
    assigned_bot_id: task.assignedBotId,
    retry_count: task.retryCount,
    version: task.version,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    active_lease: activeLease,
    artifacts: taskArtifacts.map((art) => ({
      id: art.id,
      title: art.title,
      kind: art.kind,
      summary: art.summary,
      version: art.version,
      updated_at: art.updatedAt,
    })),
    active_cards: taskCards.map((card) => ({
      card_id: card.cardId,
      proposal_id: card.proposalId,
      selection_group_id: card.selectionGroupId,
      status: parseCardStatusStrict(card.status),
      version: card.version,
    })),
  };
}

export async function getArtifact(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: GetArtifactInput,
): Promise<ArtifactDetailDto> {
  assertBotReadScope(ctx, ctx.workspaceId, "tasks:read");
  const input = getArtifactInputSchema.parse(rawInput);

  const artifact = await db.orm
    .select()
    .from(schema.artifacts)
    .where(
      and(
        eq(schema.artifacts.id, input.artifact_id),
        eq(schema.artifacts.workspaceId, ctx.workspaceId),
      ),
    )
    .get();

  if (artifact === undefined) {
    throw new DomainError("NOT_FOUND", `Artifact "${input.artifact_id}" not found.`, false);
  }

  if (input.expected_version !== undefined && artifact.version !== input.expected_version) {
    throw new DomainError(
      "VERSION_CONFLICT",
      `Artifact version conflict (expected ${input.expected_version}, actual ${artifact.version}).`,
      false,
      { currentVersion: artifact.version },
    );
  }

  return {
    id: artifact.id,
    task_id: artifact.taskId,
    title: artifact.title,
    kind: artifact.kind,
    summary: artifact.summary,
    content_or_url: artifact.contentOrUrl,
    version: artifact.version,
    created_at: artifact.createdAt,
    updated_at: artifact.updatedAt,
  };
}

export async function listDecisionResults(
  db: AppDatabase,
  ctx: VerifiedBotContext,
  rawInput: Partial<ListDecisionResultsInput> = {},
): Promise<{
  readonly items: readonly FinalizedDecisionResultDto[];
  readonly next_cursor: string | null;
}> {
  assertBotReadScope(ctx, ctx.workspaceId, "decisions:read");
  const input = listDecisionResultsInputSchema.parse(rawInput);

  // DEC-01: Strictly finalized decisions on finalized cards with non-null finalized_at only
  const conditions = [
    eq(schema.decisionCards.workspaceId, ctx.workspaceId),
    eq(schema.decisions.status, "finalized"),
    inArray(schema.decisionCards.status, ["accepted", "declined"]),
    isNotNull(schema.decisions.finalizedAt),
  ];

  if (input.task_id !== undefined) {
    conditions.push(eq(schema.proposals.taskId, input.task_id));
  }
  if (input.only_unconsumed) {
    conditions.push(isNull(schema.decisions.consumedAt));
  }
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    const cursorCond = or(
      gt(schema.decisions.finalizedAt, decoded.timestamp),
      and(eq(schema.decisions.finalizedAt, decoded.timestamp), gt(schema.decisions.id, decoded.id)),
    );
    if (cursorCond !== undefined) {
      conditions.push(cursorCond);
    }
  }

  const rows = await db.orm
    .select({
      decisionId: schema.decisions.id,
      cardId: schema.decisions.cardId,
      proposalId: schema.decisionCards.proposalId,
      taskId: schema.proposals.taskId,
      selectionGroupId: schema.decisionCards.selectionGroupId,
      cardStatus: schema.decisionCards.status,
      decisionStatus: schema.decisions.status,
      result: schema.decisions.result,
      selectedOptionIdsJson: schema.decisions.selectedOptionIdsJson,
      cardVersion: schema.decisions.cardVersion,
      finalizedTaskVersion: schema.decisions.finalizedTaskVersion,
      finalizedAt: schema.decisions.finalizedAt,
      consumedAt: schema.decisions.consumedAt,
    })
    .from(schema.decisions)
    .innerJoin(schema.decisionCards, eq(schema.decisions.cardId, schema.decisionCards.id))
    .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
    .where(and(...conditions))
    .orderBy(asc(schema.decisions.finalizedAt), asc(schema.decisions.id))
    .limit(input.limit + 1)
    .all();

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const items: FinalizedDecisionResultDto[] = [];

  for (const row of page) {
    const cardStatus = parseCardStatusStrict(row.cardStatus);
    const decisionStatus = parseDecisionStatusStrict(row.decisionStatus);
    assertCardIsFinalizedForBot(cardStatus, decisionStatus);

    if (row.result !== "accepted" && row.result !== "declined") {
      throw new DomainError(
        "INVALID_TRANSITION",
        `Invalid decision result "${row.result}".`,
        false,
      );
    }
    if (row.finalizedAt === null) {
      throw new DomainError(
        "INVALID_TRANSITION",
        "Finalized decision missing finalized_at.",
        false,
      );
    }

    items.push({
      decision_id: row.decisionId,
      card_id: row.cardId,
      proposal_id: row.proposalId,
      task_id: row.taskId,
      selection_group_id: row.selectionGroupId,
      result: row.result,
      selected_option_ids: parseSelectedOptionIds(row.selectedOptionIdsJson),
      card_version: row.cardVersion,
      finalized_task_version: row.finalizedTaskVersion,
      finalized_at: row.finalizedAt,
      consumed_at: row.consumedAt,
    });
  }

  const lastItem = items[items.length - 1];
  return {
    items,
    next_cursor:
      hasMore && lastItem !== undefined
        ? encodeCursor(lastItem.finalized_at, lastItem.decision_id)
        : null,
  };
}
