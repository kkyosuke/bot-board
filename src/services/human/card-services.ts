import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";

import { type OwnerContext } from "@/auth/context";
import { type AppDatabase, guardedBatch, type RawSqlStatement, schema, type SqlParam } from "@/db";
import {
  type ArtifactPreview,
  assertCanDeferCard,
  assertCanUndoCard,
  CARD_TYPES,
  type CardType,
  DECISION_CARD_STATUSES,
  type DecisionCardItem,
  type DecisionCardStatus,
  type DecisionFactor,
  type DecisionOption,
  type DecisionPayload,
  DomainError,
  evaluateCardDecidePreconditions,
  SELECTION_MODES,
  type SelectionMode,
  validateDecisionPayload,
} from "@/domain";
import {
  type DecideHumanCardInput,
  decideHumanCardInputSchema,
  type DeferHumanCardInput,
  deferHumanCardInputSchema,
  type ListHumanCardsQuery,
  listHumanCardsQuerySchema,
  type UndoHumanCardInput,
  undoHumanCardInputSchema,
} from "@/services/human/schemas";
import {
  buildInsertIdempotencyKeySql,
  buildStaleReconfirmationFollowUps,
  canonicalJsonHash,
  type DecisionFinalizeQueueProducer,
  finalizeExpiredProvisionalCards,
  findReplacementCardIdForProposal,
  generateEntityId,
  runWithIdempotencyRaceGuard,
} from "@/services/system";
import { type BotWorkQueueProducer } from "@/services/system/queues";
import { createLogger } from "@/shared/logger";

const humanCardLogger = createLogger("human-cards");

export const PROVISIONAL_WINDOW_MS = 5_000;

export interface HumanCardServiceDeps {
  readonly finalizeQueue?: DecisionFinalizeQueueProducer;
  readonly botWorkQueue?: BotWorkQueueProducer;
  readonly now?: () => number;
}

export interface ProvisionalCardView {
  readonly card: DecisionCardItem;
  readonly decisionId: string;
  readonly decision: "accepted" | "declined";
  readonly selectedOptionIds: readonly string[];
  readonly provisionalUntil: number;
}

export interface HumanCardsListResult {
  readonly pendingCards: readonly DecisionCardItem[];
  readonly deferredCards: readonly DecisionCardItem[];
  readonly provisionalCards: readonly ProvisionalCardView[];
  readonly workspacePaused: boolean;
  readonly hasActiveBots: boolean;
  readonly runningTaskCount: number;
}

export interface HumanCardSiblingSummary {
  readonly cardId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly status: DecisionCardStatus;
  readonly version: number;
}

export interface HumanCardDetailResult {
  readonly card: DecisionCardItem;
  readonly status: DecisionCardStatus;
  readonly provisionalResult: "accepted" | "declined" | null;
  readonly provisionalUntil: number | null;
  readonly expiresAt: number | null;
  readonly targetTaskVersion: number;
  readonly currentTaskVersion: number;
  readonly artifactFull: {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly summary: string;
    readonly contentOrUrl: string;
    readonly version: number;
  } | null;
  readonly siblings: readonly HumanCardSiblingSummary[];
  readonly replacementCardId: string | null;
}

const decideReceiptSchema = z.object({
  decision_id: z.string(),
  card_id: z.string(),
  version: z.number().int(),
  status: z.literal("provisional"),
  result: z.enum(["accepted", "declined"]),
  selected_option_ids: z.array(z.string()),
  provisional_until: z.number().int(),
  locked_sibling_card_ids: z.array(z.string()),
  trace_id: z.string(),
});
export type HumanDecideCardResult = z.infer<typeof decideReceiptSchema>;

const undoReceiptSchema = z.object({
  card_id: z.string(),
  version: z.number().int(),
  status: z.literal("pending"),
  restored_sibling_card_ids: z.array(z.string()),
  trace_id: z.string(),
});
export type HumanUndoCardResult = z.infer<typeof undoReceiptSchema>;

const deferReceiptSchema = z.object({
  card_id: z.string(),
  version: z.number().int(),
  status: z.enum(["deferred", "pending"]),
  trace_id: z.string(),
});
export type HumanDeferCardResult = z.infer<typeof deferReceiptSchema>;

const storedFactorSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const storedOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  badge: z.string().optional(),
  summary: z.string(),
  meta: z.string(),
  recommended: z.boolean().optional(),
});

function parseCardType(raw: string): CardType {
  for (const item of CARD_TYPES) {
    if (item === raw) {
      return item;
    }
  }
  return "policy";
}

function parseSelectionMode(raw: string): SelectionMode {
  for (const item of SELECTION_MODES) {
    if (item === raw) {
      return item;
    }
  }
  return "binary";
}

function parseCardStatus(raw: string): DecisionCardStatus {
  for (const item of DECISION_CARD_STATUSES) {
    if (item === raw) {
      return item;
    }
  }
  return "pending";
}

function parseFactors(raw: string): readonly DecisionFactor[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const checked = z.array(storedFactorSchema).safeParse(parsed);
    return checked.success ? checked.data : [];
  } catch {
    return [];
  }
}

function parseOptions(raw: string | null): readonly DecisionOption[] | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const checked = z.array(storedOptionSchema).safeParse(parsed);
    if (!checked.success) {
      return undefined;
    }
    return checked.data.map((opt) => ({
      id: opt.id,
      title: opt.title,
      summary: opt.summary,
      meta: opt.meta,
      ...(opt.badge !== undefined ? { badge: opt.badge } : {}),
      ...(opt.recommended !== undefined ? { recommended: opt.recommended } : {}),
    }));
  } catch {
    return undefined;
  }
}

function parseSelectedOptionIds(raw: string | null): readonly string[] {
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

function cardTypeLabels(
  cardType: CardType,
  selectionMode: SelectionMode,
): { readonly typeLabel: string; readonly shortChip: string } {
  if (selectionMode === "single") {
    return { typeLabel: "候補選択（単一）", shortChip: "候補" };
  }
  if (selectionMode === "multi") {
    return { typeLabel: "複数選択", shortChip: "複数" };
  }
  if (cardType === "deliverable") {
    return { typeLabel: "成果確認", shortChip: "成果" };
  }
  if (cardType === "choice") {
    return { typeLabel: "選択確認", shortChip: "選択" };
  }
  return { typeLabel: "方針確認", shortChip: "方針" };
}

function buildExcerptLines(contentOrUrl: string): readonly string[] {
  const lines = contentOrUrl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return ["プレビュー本文なし"];
  }
  return lines.slice(0, 6).map((line) => line.slice(0, 180));
}

function formatSubmittedAtLabel(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 16).replace("T", " ");
}

function buildDecisionCardItem(params: {
  readonly card: typeof schema.decisionCards.$inferSelect;
  readonly proposal: typeof schema.proposals.$inferSelect;
  readonly task: typeof schema.tasks.$inferSelect;
  readonly botName: string;
  readonly artifact: typeof schema.artifacts.$inferSelect | null | undefined;
}): DecisionCardItem {
  const cardType = parseCardType(params.proposal.cardType);
  const selectionMode = parseSelectionMode(params.proposal.selectionMode);
  const labels = cardTypeLabels(cardType, selectionMode);
  const options = parseOptions(params.proposal.optionsJson);
  const art = params.artifact ?? undefined;
  const artifactPreview: ArtifactPreview =
    art !== undefined
      ? {
          id: art.id,
          title: art.title,
          kind: art.kind,
          version: art.version,
          summary: art.summary,
          excerpt: buildExcerptLines(art.contentOrUrl),
        }
      : {
          id: `task-ref-${params.task.id}`,
          title: params.task.title,
          kind: "task",
          version: params.task.version,
          summary: params.task.description || params.proposal.summary,
          excerpt: buildExcerptLines(params.task.description || params.proposal.summary),
        };

  return {
    id: params.card.id,
    proposalId: params.proposal.id,
    taskId: params.task.id,
    taskTitle: params.task.title,
    ...(params.card.selectionGroupId !== null
      ? { selectionGroupId: params.card.selectionGroupId }
      : {}),
    cardType,
    selectionMode,
    typeLabel: labels.typeLabel,
    shortChip: labels.shortChip,
    botName: params.botName,
    submittedAtLabel: formatSubmittedAtLabel(params.card.createdAt),
    version: params.card.version,
    headline: params.proposal.title,
    summary: params.proposal.summary,
    acceptEffect: params.proposal.onAcceptEffect,
    declineEffect: params.proposal.onDeclineEffect,
    factors: parseFactors(params.proposal.factorsJson),
    ...(options !== undefined ? { options } : {}),
    artifact: artifactPreview,
  };
}

function extractSelectedOptionIdsFromPayload(payload: DecisionPayload): readonly string[] {
  if (payload.mode === "binary") {
    return [];
  }
  if (payload.mode === "single") {
    return payload.decision === "accepted" ? [payload.selectedOptionId] : [];
  }
  return payload.decision === "accepted" ? [...payload.acceptedOptionIds] : [];
}

function isGroupAcceptUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return (
    msg.includes("UNIQUE constraint failed") &&
    (msg.includes("decision_cards.selection_group_id") ||
      msg.includes("idx_decision_cards_single_group_accept"))
  );
}

async function hasLockedSiblingInGroup(
  db: AppDatabase,
  workspaceId: string,
  selectionGroupId: string | null,
  excludeCardId: string,
): Promise<boolean> {
  if (selectionGroupId === null) {
    return false;
  }
  const groupCards = await db.orm
    .select({
      id: schema.decisionCards.id,
      status: schema.decisionCards.status,
      provisionalResult: schema.decisionCards.provisionalResult,
    })
    .from(schema.decisionCards)
    .where(
      and(
        eq(schema.decisionCards.workspaceId, workspaceId),
        eq(schema.decisionCards.selectionGroupId, selectionGroupId),
        ne(schema.decisionCards.id, excludeCardId),
      ),
    )
    .all();

  return groupCards.some(
    (row) =>
      row.status === "accepted" ||
      (row.status === "provisional" && row.provisionalResult === "accepted"),
  );
}

async function expireCardAtomically(params: {
  readonly db: AppDatabase;
  readonly workspaceId: string;
  readonly cardId: string;
  readonly cardStatus: "pending" | "deferred";
  readonly cardVersion: number;
  readonly taskId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly nowMs: number;
}): Promise<void> {
  const expEvtId = generateEntityId("evt");
  await guardedBatch(params.db.executor, {
    parentUpdate: {
      sql: "UPDATE decision_cards SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ? AND version = ? AND expires_at IS NOT NULL AND expires_at <= ?",
      params: [
        params.nowMs,
        params.cardId,
        params.workspaceId,
        params.cardStatus,
        params.cardVersion,
        params.nowMs,
      ],
    },
    followUps: [
      {
        sql: `UPDATE tasks
              SET status = 'ready', status_reason = 'Decision card expired', version = version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ? AND status = 'waiting_human'
                AND NOT EXISTS (
                  SELECT 1 FROM decision_cards dc
                  JOIN proposals p ON p.id = dc.proposal_id
                  WHERE p.task_id = ? AND dc.workspace_id = ? AND dc.status IN ('pending', 'deferred', 'provisional')
                )`,
        params: [
          params.nowMs,
          params.taskId,
          params.workspaceId,
          params.taskId,
          params.workspaceId,
        ],
      },
      {
        sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', ?, 'decision_card', ?, 'card.expired', ?, ?, ?)",
        params: [
          expEvtId,
          params.workspaceId,
          params.actorId,
          params.cardId,
          JSON.stringify({ card_id: params.cardId }),
          params.requestId,
          params.nowMs,
        ],
      },
    ],
  });
}

export async function listHumanCards(
  db: AppDatabase,
  ctx: OwnerContext,
  rawQuery: Partial<ListHumanCardsQuery> = {},
  deps: HumanCardServiceDeps = {},
): Promise<HumanCardsListResult> {
  const query = listHumanCardsQuerySchema.parse(rawQuery);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();

  // On-demand finalization scoped strictly to ctx.workspaceId
  await finalizeExpiredProvisionalCards(db, {
    workspaceId: ctx.workspaceId,
    source: "on_demand",
    nowMs,
    ...(deps.botWorkQueue !== undefined ? { botWorkQueue: deps.botWorkQueue } : {}),
  });

  // M2: Use fixed-parameter JOIN queries instead of unbounded inArray(...) (Cloudflare D1 100-param limit)
  const [
    workspace,
    activeBots,
    runningTasks,
    visibleCardRows,
    acceptedGroupRows,
    provisionalDecRows,
  ] = await Promise.all([
    db.orm
      .select({ isPaused: schema.workspaces.isPaused })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .get(),
    db.orm
      .select({ id: schema.botConnections.id, status: schema.botConnections.status })
      .from(schema.botConnections)
      .where(eq(schema.botConnections.workspaceId, ctx.workspaceId))
      .all(),
    db.orm
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.workspaceId, ctx.workspaceId), eq(schema.tasks.status, "running")))
      .all(),
    db.orm
      .select({
        card: schema.decisionCards,
        proposal: schema.proposals,
        task: schema.tasks,
        botName: schema.botConnections.displayName,
        artifact: schema.artifacts,
      })
      .from(schema.decisionCards)
      .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
      .innerJoin(schema.tasks, eq(schema.proposals.taskId, schema.tasks.id))
      .innerJoin(
        schema.botConnections,
        eq(schema.proposals.proposerBotId, schema.botConnections.id),
      )
      .leftJoin(
        schema.artifacts,
        and(
          eq(schema.proposals.targetArtifactId, schema.artifacts.id),
          eq(schema.artifacts.workspaceId, ctx.workspaceId),
        ),
      )
      .where(
        and(
          eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          inArray(schema.decisionCards.status, ["pending", "deferred", "provisional"]),
        ),
      )
      .orderBy(asc(schema.decisionCards.createdAt), asc(schema.decisionCards.id))
      .all(),
    db.orm
      .select({ selectionGroupId: schema.decisionCards.selectionGroupId })
      .from(schema.decisionCards)
      .where(
        and(
          eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          eq(schema.decisionCards.status, "accepted"),
          isNotNull(schema.decisionCards.selectionGroupId),
        ),
      )
      .all(),
    db.orm
      .select({ decision: schema.decisions })
      .from(schema.decisions)
      .innerJoin(schema.decisionCards, eq(schema.decisions.cardId, schema.decisionCards.id))
      .where(
        and(
          eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          eq(schema.decisions.status, "provisional"),
        ),
      )
      .all(),
  ]);

  const lockedGroups = new Set<string>();
  for (const row of visibleCardRows) {
    if (
      row.card.selectionGroupId !== null &&
      row.card.status === "provisional" &&
      row.card.provisionalResult === "accepted"
    ) {
      lockedGroups.add(row.card.selectionGroupId);
    }
  }
  for (const row of acceptedGroupRows) {
    if (row.selectionGroupId !== null) {
      lockedGroups.add(row.selectionGroupId);
    }
  }

  const provisionalDecisionMap = new Map<string, typeof schema.decisions.$inferSelect>();
  for (const row of provisionalDecRows) {
    provisionalDecisionMap.set(row.decision.cardId, row.decision);
  }

  const pendingCards: DecisionCardItem[] = [];
  const deferredCards: DecisionCardItem[] = [];
  const provisionalCards: ProvisionalCardView[] = [];

  for (const row of visibleCardRows) {
    const item = buildDecisionCardItem({
      card: row.card,
      proposal: row.proposal,
      task: row.task,
      botName: row.botName,
      artifact: row.artifact,
    });

    if (row.card.status === "provisional") {
      const dec = provisionalDecisionMap.get(row.card.id);
      if (
        dec !== undefined &&
        (dec.result === "accepted" || dec.result === "declined") &&
        row.card.provisionalUntil !== null
      ) {
        provisionalCards.push({
          card: item,
          decisionId: dec.id,
          decision: dec.result,
          selectedOptionIds: parseSelectedOptionIds(dec.selectedOptionIdsJson),
          provisionalUntil: row.card.provisionalUntil,
        });
      }
      continue;
    }

    // DEC-04: temporarily exclude pending/deferred siblings while another candidate is accepted/provisional(accepted)
    if (row.card.selectionGroupId !== null && lockedGroups.has(row.card.selectionGroupId)) {
      continue;
    }

    if (row.card.status === "pending" && (query.status === "all" || query.status === "pending")) {
      pendingCards.push(item);
    } else if (
      row.card.status === "deferred" &&
      (query.status === "all" || query.status === "deferred")
    ) {
      deferredCards.push(item);
    }
  }

  return {
    pendingCards,
    deferredCards,
    provisionalCards,
    workspacePaused: workspace?.isPaused === true,
    hasActiveBots: activeBots.some((b) => b.status === "active"),
    runningTaskCount: runningTasks.length,
  };
}

export async function getHumanCardDetail(
  db: AppDatabase,
  ctx: OwnerContext,
  cardId: string,
  deps: HumanCardServiceDeps = {},
): Promise<HumanCardDetailResult> {
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  // B2 & M3: Finalize due provisional cards strictly within ctx.workspaceId (including siblings)
  await finalizeExpiredProvisionalCards(db, {
    workspaceId: ctx.workspaceId,
    source: "on_demand",
    nowMs,
    ...(deps.botWorkQueue !== undefined ? { botWorkQueue: deps.botWorkQueue } : {}),
  });

  const row = await db.orm
    .select({
      card: schema.decisionCards,
      proposal: schema.proposals,
      task: schema.tasks,
      botName: schema.botConnections.displayName,
      artifact: schema.artifacts,
    })
    .from(schema.decisionCards)
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
    .where(
      and(
        eq(schema.decisionCards.id, cardId),
        eq(schema.decisionCards.workspaceId, ctx.workspaceId),
      ),
    )
    .get();

  if (row === undefined) {
    throw new DomainError("NOT_FOUND", `Decision card "${cardId}" not found.`, false);
  }

  const siblings: HumanCardSiblingSummary[] = [];
  if (row.card.selectionGroupId !== null) {
    const siblingRows = await db.orm
      .select({
        cardId: schema.decisionCards.id,
        proposalId: schema.decisionCards.proposalId,
        title: schema.proposals.title,
        status: schema.decisionCards.status,
        version: schema.decisionCards.version,
      })
      .from(schema.decisionCards)
      .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
      .where(
        and(
          eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          eq(schema.decisionCards.selectionGroupId, row.card.selectionGroupId),
          ne(schema.decisionCards.id, row.card.id),
        ),
      )
      .orderBy(asc(schema.decisionCards.createdAt), asc(schema.decisionCards.id))
      .all();

    for (const sib of siblingRows) {
      siblings.push({
        cardId: sib.cardId,
        proposalId: sib.proposalId,
        title: sib.title,
        status: parseCardStatus(sib.status),
        version: sib.version,
      });
    }
  }

  const replacementCardId = await findReplacementCardIdForProposal(
    db,
    ctx.workspaceId,
    row.proposal.supersededById,
  );

  const cardItem = buildDecisionCardItem({
    card: row.card,
    proposal: row.proposal,
    task: row.task,
    botName: row.botName,
    artifact: row.artifact,
  });

  return {
    card: cardItem,
    status: parseCardStatus(row.card.status),
    provisionalResult:
      row.card.provisionalResult === "accepted" || row.card.provisionalResult === "declined"
        ? row.card.provisionalResult
        : null,
    provisionalUntil: row.card.provisionalUntil,
    expiresAt: row.card.expiresAt,
    targetTaskVersion: row.proposal.targetTaskVersion,
    currentTaskVersion: row.task.version,
    artifactFull:
      row.artifact !== null
        ? {
            id: row.artifact.id,
            title: row.artifact.title,
            kind: row.artifact.kind,
            summary: row.artifact.summary,
            contentOrUrl: row.artifact.contentOrUrl,
            version: row.artifact.version,
          }
        : null,
    siblings,
    replacementCardId,
  };
}

export async function decideHumanCard(
  db: AppDatabase,
  ctx: OwnerContext,
  cardId: string,
  rawInput: DecideHumanCardInput,
  deps: HumanCardServiceDeps = {},
): Promise<HumanDecideCardResult> {
  const input = decideHumanCardInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "decide_card",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    card_id: cardId,
    expected_version: input.expected_version,
    payload: input.payload,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    idempKey,
    inputHash,
    (raw) => decideReceiptSchema.parse(raw),
    async () => {
      // B2 & M3: Finalize due provisional cards strictly within ctx.workspaceId (unblocks expired/stale sibling locks)
      await finalizeExpiredProvisionalCards(db, {
        workspaceId: ctx.workspaceId,
        source: "on_demand",
        nowMs,
        ...(deps.botWorkQueue !== undefined ? { botWorkQueue: deps.botWorkQueue } : {}),
      });

      // M3: Bounded retry loop handles concurrent Task/Artifact version updates cleanly into stale reconfirmation
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const row = await db.orm
          .select({
            card: schema.decisionCards,
            proposal: schema.proposals,
            task: schema.tasks,
            botName: schema.botConnections.displayName,
            artifact: schema.artifacts,
          })
          .from(schema.decisionCards)
          .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
          .innerJoin(schema.tasks, eq(schema.proposals.taskId, schema.tasks.id))
          .innerJoin(
            schema.botConnections,
            eq(schema.proposals.proposerBotId, schema.botConnections.id),
          )
          .leftJoin(
            schema.artifacts,
            and(
              eq(schema.proposals.targetArtifactId, schema.artifacts.id),
              eq(schema.artifacts.workspaceId, ctx.workspaceId),
            ),
          )
          .where(
            and(
              eq(schema.decisionCards.id, cardId),
              eq(schema.decisionCards.workspaceId, ctx.workspaceId),
            ),
          )
          .get();

        if (row === undefined) {
          throw new DomainError("NOT_FOUND", `Decision card "${cardId}" not found.`, false);
        }

        const cardItem = buildDecisionCardItem({
          card: row.card,
          proposal: row.proposal,
          task: row.task,
          botName: row.botName,
          artifact: row.artifact,
        });

        validateDecisionPayload(cardItem, input.payload);

        const groupLocked = await hasLockedSiblingInGroup(
          db,
          ctx.workspaceId,
          row.card.selectionGroupId,
          row.card.id,
        );
        const existingReplacementCardId = await findReplacementCardIdForProposal(
          db,
          ctx.workspaceId,
          row.proposal.supersededById,
        );

        const evaluation = evaluateCardDecidePreconditions({
          cardStatus: parseCardStatus(row.card.status),
          expectedVersion: input.expected_version,
          currentVersion: row.card.version,
          nowMs,
          expiresAtMs: row.card.expiresAt,
          targetTaskVersion: row.proposal.targetTaskVersion,
          currentTaskVersion: row.task.version,
          targetArtifactVersion: row.proposal.targetArtifactVersion,
          currentArtifactVersion: row.artifact?.version ?? null,
          hasGroupLock: groupLocked,
          replacementCardId: existingReplacementCardId,
        });

        if (evaluation.outcome === "expired") {
          await expireCardAtomically({
            db,
            workspaceId: ctx.workspaceId,
            cardId: row.card.id,
            cardStatus: "pending",
            cardVersion: row.card.version,
            taskId: row.task.id,
            requestId: input.request_id,
            actorId: "human-decide",
            nowMs,
          });
          throw new DomainError("INVALID_TRANSITION", "Decision card has expired.", false);
        }

        // B1: If task is no longer waiting_human (e.g. done/running), close stale card WITHOUT creating reconfirmation card
        const isTaskWaitingHuman = row.task.status === "waiting_human";
        if (evaluation.outcome === "stale" || !isTaskWaitingHuman) {
          const reconfirm = isTaskWaitingHuman
            ? await buildStaleReconfirmationFollowUps({
                db,
                workspaceId: ctx.workspaceId,
                proposal: row.proposal,
                selectionGroupId: row.card.selectionGroupId,
                currentTaskVersion: row.task.version,
                currentArtifactVersion: row.artifact?.version ?? null,
                nowMs,
              })
            : null;
          const staleEvtId = generateEntityId("evt");
          const staleBatch = await guardedBatch(db.executor, {
            parentUpdate: {
              sql: `UPDATE decision_cards
                    SET status = 'superseded', version = version + 1, updated_at = ?
                    WHERE id = ? AND workspace_id = ? AND status = 'pending' AND version = ?
                      AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status = ?)`,
              params: [
                nowMs,
                row.card.id,
                ctx.workspaceId,
                row.card.version,
                row.task.id,
                ctx.workspaceId,
                row.task.status,
              ],
            },
            followUps: [
              ...(reconfirm !== null ? reconfirm.followUps : []),
              {
                sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'system', 'human-decide', 'decision_card', ?, ?, ?, ?, ?)",
                params: [
                  staleEvtId,
                  ctx.workspaceId,
                  row.card.id,
                  reconfirm !== null
                    ? "card.stale_reconfirmation"
                    : "card.stale_closed_inactive_task",
                  JSON.stringify({
                    card_id: row.card.id,
                    task_status: row.task.status,
                    replacement_card_id: reconfirm?.replacementCardId ?? null,
                  }),
                  input.request_id,
                  nowMs,
                ],
              },
            ],
          });

          if (reconfirm === null) {
            throw new DomainError(
              "STALE_PROPOSAL",
              `Target task is no longer waiting for human decision (status: "${row.task.status}").`,
              false,
            );
          }

          let finalReplacementCardId: string | null = staleBatch.applied
            ? reconfirm.replacementCardId
            : null;
          if (!staleBatch.applied) {
            const refreshedProp = await db.orm
              .select({ supersededById: schema.proposals.supersededById })
              .from(schema.proposals)
              .where(eq(schema.proposals.id, row.proposal.id))
              .get();
            finalReplacementCardId = await findReplacementCardIdForProposal(
              db,
              ctx.workspaceId,
              refreshedProp?.supersededById ?? null,
            );
            if (finalReplacementCardId === null) {
              if (attempt === 0) {
                continue;
              }
              throw new DomainError(
                "STALE_PROPOSAL",
                "Target task or proposal changed concurrently; please refresh cards.",
                false,
              );
            }
          }

          throw new DomainError(
            "STALE_PROPOSAL",
            "Target task or artifact changed; a new reconfirmation card has been created.",
            false,
            finalReplacementCardId !== null
              ? { replacementCardId: finalReplacementCardId }
              : undefined,
          );
        }

        const decisionId = generateEntityId("dec");
        const traceId = generateEntityId("evt");
        const provisionalUntil = nowMs + PROVISIONAL_WINDOW_MS;
        const nextCardVersion = row.card.version + 1;
        const selectedOptionIds = extractSelectedOptionIdsFromPayload(input.payload);

        let lockedSiblingIds: string[] = [];
        if (row.card.selectionGroupId !== null && input.payload.decision === "accepted") {
          const siblings = await db.orm
            .select({ id: schema.decisionCards.id })
            .from(schema.decisionCards)
            .where(
              and(
                eq(schema.decisionCards.workspaceId, ctx.workspaceId),
                eq(schema.decisionCards.selectionGroupId, row.card.selectionGroupId),
                ne(schema.decisionCards.id, row.card.id),
                inArray(schema.decisionCards.status, ["pending", "deferred"]),
              ),
            )
            .all();
          lockedSiblingIds = siblings.map((s) => s.id);
        }

        const receipt: HumanDecideCardResult = {
          decision_id: decisionId,
          card_id: row.card.id,
          version: nextCardVersion,
          status: "provisional",
          result: input.payload.decision,
          selected_option_ids: [...selectedOptionIds],
          provisional_until: provisionalUntil,
          locked_sibling_card_ids: lockedSiblingIds,
          trace_id: traceId,
        };

        const parentParams: SqlParam[] = [
          input.payload.decision,
          provisionalUntil,
          nowMs,
          row.card.id,
          ctx.workspaceId,
          row.card.version,
          nowMs,
          row.task.id,
          ctx.workspaceId,
          row.proposal.targetTaskVersion,
        ];
        let extraGuardsSql = "";
        if (row.proposal.targetArtifactId !== null && row.proposal.targetArtifactVersion !== null) {
          extraGuardsSql +=
            " AND EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND workspace_id = ? AND version = ?)";
          parentParams.push(
            row.proposal.targetArtifactId,
            ctx.workspaceId,
            row.proposal.targetArtifactVersion,
          );
        }
        if (row.card.selectionGroupId !== null) {
          extraGuardsSql += ` AND NOT EXISTS (
            SELECT 1 FROM decision_cards
            WHERE workspace_id = ? AND selection_group_id = ? AND id != ?
              AND (status = 'accepted' OR (status = 'provisional' AND provisional_result = 'accepted'))
          )`;
          parentParams.push(ctx.workspaceId, row.card.selectionGroupId, row.card.id);
        }

        const parentUpdate: RawSqlStatement = {
          sql: `UPDATE decision_cards
                SET status = 'provisional', provisional_result = ?, provisional_until = ?, version = version + 1, updated_at = ?
                WHERE id = ?
                  AND workspace_id = ?
                  AND status = 'pending'
                  AND version = ?
                  AND (expires_at IS NULL OR expires_at > ?)
                  AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND workspace_id = ? AND status = 'waiting_human' AND version = ?)${extraGuardsSql}`,
          params: parentParams,
        };

        const followUps: RawSqlStatement[] = [
          {
            sql: `INSERT INTO decisions (
              id, card_id, actor_user_id, result, selected_option_ids_json, status, card_version,
              finalized_task_version, provisional_at, finalized_at, canceled_at, consumed_at
            ) VALUES (?, ?, ?, ?, ?, 'provisional', ?, NULL, ?, NULL, NULL, NULL)`,
            params: [
              decisionId,
              row.card.id,
              ctx.userId,
              input.payload.decision,
              selectedOptionIds.length > 0 ? JSON.stringify(selectedOptionIds) : null,
              nextCardVersion,
              nowMs,
            ],
          },
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'decision_card', ?, 'decision.provisional', ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.userId,
              row.card.id,
              JSON.stringify({
                decision_id: decisionId,
                result: input.payload.decision,
                selected_option_ids: selectedOptionIds,
                provisional_until: provisionalUntil,
              }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(idempKey, inputHash, receipt, nowMs),
        ];

        let batchOutcome;
        try {
          batchOutcome = await guardedBatch(db.executor, { parentUpdate, followUps });
        } catch (error) {
          if (isGroupAcceptUniqueViolation(error)) {
            throw new DomainError(
              "GROUP_LOCKED",
              "Another candidate in this selection group was already accepted.",
              true,
            );
          }
          throw error;
        }

        if (batchOutcome.applied) {
          if (deps.finalizeQueue !== undefined) {
            try {
              await deps.finalizeQueue.send({ card_id: row.card.id }, { delaySeconds: 5 });
            } catch (error) {
              humanCardLogger.warn(
                "Failed to enqueue decision-finalize message (on-demand & Cron will still finalize)",
                { error, cardId: row.card.id },
              );
            }
          }
          return receipt;
        }

        const refreshed = await db.orm
          .select({ status: schema.decisionCards.status, version: schema.decisionCards.version })
          .from(schema.decisionCards)
          .where(eq(schema.decisionCards.id, row.card.id))
          .get();

        if (refreshed?.status === "superseded") {
          const refreshedProp = await db.orm
            .select({ supersededById: schema.proposals.supersededById })
            .from(schema.proposals)
            .where(eq(schema.proposals.id, row.proposal.id))
            .get();
          const repId = await findReplacementCardIdForProposal(
            db,
            ctx.workspaceId,
            refreshedProp?.supersededById ?? null,
          );
          throw new DomainError(
            "STALE_PROPOSAL",
            "Decision card was superseded concurrently.",
            false,
            repId !== null ? { replacementCardId: repId } : undefined,
          );
        }

        if (
          await hasLockedSiblingInGroup(db, ctx.workspaceId, row.card.selectionGroupId, row.card.id)
        ) {
          throw new DomainError(
            "GROUP_LOCKED",
            "Another candidate in this selection group was concurrently accepted.",
            true,
          );
        }

        if (refreshed !== undefined && refreshed.version !== input.expected_version) {
          throw new DomainError(
            "VERSION_CONFLICT",
            `Decision card version conflict (expected ${input.expected_version}, actual ${refreshed.version}).`,
            false,
            { currentVersion: refreshed.version },
          );
        }

        // M3: Card is still pending at expected_version -> Task/Artifact/expiry changed concurrently; loop to re-evaluate & create reconfirmation card
        if (attempt === 0) {
          continue;
        }
      }

      throw new DomainError(
        "STALE_PROPOSAL",
        "Target task or artifact changed concurrently; please refresh.",
        false,
      );
    },
  );
}

export async function undoHumanCard(
  db: AppDatabase,
  ctx: OwnerContext,
  cardId: string,
  rawInput: UndoHumanCardInput,
  deps: HumanCardServiceDeps = {},
): Promise<HumanUndoCardResult> {
  const input = undoHumanCardInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "undo_card",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    card_id: cardId,
    expected_version: input.expected_version,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    idempKey,
    inputHash,
    (raw) => undoReceiptSchema.parse(raw),
    async () => {
      const card = await db.orm
        .select()
        .from(schema.decisionCards)
        .where(
          and(
            eq(schema.decisionCards.id, cardId),
            eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          ),
        )
        .get();

      if (card === undefined) {
        throw new DomainError("NOT_FOUND", `Decision card "${cardId}" not found.`, false);
      }

      assertCanUndoCard({
        cardStatus: parseCardStatus(card.status),
        expectedVersion: input.expected_version,
        currentVersion: card.version,
        nowMs,
        provisionalUntilMs: card.provisionalUntil,
      });

      let restoredSiblingIds: string[] = [];
      if (card.selectionGroupId !== null && card.provisionalResult === "accepted") {
        const siblings = await db.orm
          .select({ id: schema.decisionCards.id })
          .from(schema.decisionCards)
          .where(
            and(
              eq(schema.decisionCards.workspaceId, ctx.workspaceId),
              eq(schema.decisionCards.selectionGroupId, card.selectionGroupId),
              ne(schema.decisionCards.id, card.id),
              inArray(schema.decisionCards.status, ["pending", "deferred"]),
            ),
          )
          .all();
        restoredSiblingIds = siblings.map((s) => s.id);
      }

      const traceId = generateEntityId("evt");
      const receipt: HumanUndoCardResult = {
        card_id: card.id,
        version: card.version + 1,
        status: "pending",
        restored_sibling_card_ids: restoredSiblingIds,
        trace_id: traceId,
      };

      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE decision_cards
                SET status = 'pending', provisional_result = NULL, provisional_until = NULL, version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status = 'provisional' AND provisional_until > ? AND version = ?`,
          params: [nowMs, card.id, ctx.workspaceId, nowMs, card.version],
        },
        followUps: [
          {
            sql: "UPDATE decisions SET status = 'canceled', canceled_at = ? WHERE card_id = ? AND status = 'provisional'",
            params: [nowMs, card.id],
          },
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'decision_card', ?, 'decision.undone', ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.userId,
              card.id,
              JSON.stringify({ card_id: card.id, restored_sibling_card_ids: restoredSiblingIds }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(idempKey, inputHash, receipt, nowMs),
        ],
      });

      if (!batchOutcome.applied) {
        const latest = await db.orm
          .select({ status: schema.decisionCards.status, version: schema.decisionCards.version })
          .from(schema.decisionCards)
          .where(eq(schema.decisionCards.id, card.id))
          .get();
        if (
          latest !== undefined &&
          (latest.status === "accepted" || latest.status === "declined")
        ) {
          throw new DomainError(
            "INVALID_TRANSITION",
            "Decision was already finalized and can no longer be undone.",
            false,
          );
        }
        if (latest !== undefined && latest.version !== input.expected_version) {
          throw new DomainError(
            "VERSION_CONFLICT",
            `Decision card version conflict (expected ${input.expected_version}, actual ${latest.version}).`,
            false,
            { currentVersion: latest.version },
          );
        }
        throw new DomainError("INVALID_TRANSITION", "The 5-second undo window has elapsed.", false);
      }

      return receipt;
    },
  );
}

export async function deferHumanCard(
  db: AppDatabase,
  ctx: OwnerContext,
  cardId: string,
  rawInput: DeferHumanCardInput,
  deps: HumanCardServiceDeps = {},
): Promise<HumanDeferCardResult> {
  const input = deferHumanCardInputSchema.parse(rawInput);
  const nowMs = deps.now !== undefined ? deps.now() : Date.now();
  const idempKey = {
    workspaceId: ctx.workspaceId,
    actorType: "human" as const,
    actorId: ctx.userId,
    operation: "defer_card",
    requestId: input.request_id,
  };
  const inputHash = await canonicalJsonHash({
    card_id: cardId,
    expected_version: input.expected_version,
    action: input.action,
  });

  return await runWithIdempotencyRaceGuard(
    db,
    idempKey,
    inputHash,
    (raw) => deferReceiptSchema.parse(raw),
    async () => {
      // M3: Finalize due provisional siblings in ctx.workspaceId before evaluating group lock
      await finalizeExpiredProvisionalCards(db, {
        workspaceId: ctx.workspaceId,
        source: "on_demand",
        nowMs,
        ...(deps.botWorkQueue !== undefined ? { botWorkQueue: deps.botWorkQueue } : {}),
      });

      const row = await db.orm
        .select({
          card: schema.decisionCards,
          taskId: schema.proposals.taskId,
        })
        .from(schema.decisionCards)
        .innerJoin(schema.proposals, eq(schema.decisionCards.proposalId, schema.proposals.id))
        .where(
          and(
            eq(schema.decisionCards.id, cardId),
            eq(schema.decisionCards.workspaceId, ctx.workspaceId),
          ),
        )
        .get();

      if (row === undefined) {
        throw new DomainError("NOT_FOUND", `Decision card "${cardId}" not found.`, false);
      }
      const card = row.card;

      const targetStatus: "pending" | "deferred" =
        input.action === "defer" ? "deferred" : "pending";
      const requiredCurrentStatus: "pending" | "deferred" =
        input.action === "defer" ? "pending" : "deferred";
      const groupLocked = await hasLockedSiblingInGroup(
        db,
        ctx.workspaceId,
        card.selectionGroupId,
        card.id,
      );

      assertCanDeferCard({
        cardStatus: parseCardStatus(card.status),
        targetStatus,
        expectedVersion: input.expected_version,
        currentVersion: card.version,
        hasGroupLock: groupLocked,
      });

      // Minor 3: Expire overdue cards consistently on defer/restore instead of mutating expired cards
      if (card.expiresAt !== null && card.expiresAt <= nowMs) {
        await expireCardAtomically({
          db,
          workspaceId: ctx.workspaceId,
          cardId: card.id,
          cardStatus: requiredCurrentStatus,
          cardVersion: card.version,
          taskId: row.taskId,
          requestId: input.request_id,
          actorId: "human-defer",
          nowMs,
        });
        throw new DomainError("INVALID_TRANSITION", "Decision card has expired.", false);
      }

      const traceId = generateEntityId("evt");
      const receipt: HumanDeferCardResult = {
        card_id: card.id,
        version: card.version + 1,
        status: targetStatus,
        trace_id: traceId,
      };

      const parentParams: SqlParam[] = [
        targetStatus,
        nowMs,
        card.id,
        ctx.workspaceId,
        requiredCurrentStatus,
        card.version,
        nowMs,
      ];
      let groupGuardSql = "";
      if (card.selectionGroupId !== null) {
        groupGuardSql = ` AND NOT EXISTS (
          SELECT 1 FROM decision_cards
          WHERE workspace_id = ? AND selection_group_id = ? AND id != ?
            AND (status = 'accepted' OR (status = 'provisional' AND provisional_result = 'accepted'))
        )`;
        parentParams.push(ctx.workspaceId, card.selectionGroupId, card.id);
      }

      const batchOutcome = await guardedBatch(db.executor, {
        parentUpdate: {
          sql: `UPDATE decision_cards
                SET status = ?, version = version + 1, updated_at = ?
                WHERE id = ? AND workspace_id = ? AND status = ? AND version = ? AND (expires_at IS NULL OR expires_at > ?)${groupGuardSql}`,
          params: parentParams,
        },
        followUps: [
          {
            sql: "INSERT INTO events (id, workspace_id, actor_type, actor_id, entity_type, entity_id, action, payload_json, request_id, created_at) VALUES (?, ?, 'human', ?, 'decision_card', ?, ?, ?, ?, ?)",
            params: [
              traceId,
              ctx.workspaceId,
              ctx.userId,
              card.id,
              input.action === "defer" ? "card.deferred" : "card.restored",
              JSON.stringify({ card_id: card.id, status: targetStatus }),
              input.request_id,
              nowMs,
            ],
          },
          buildInsertIdempotencyKeySql(idempKey, inputHash, receipt, nowMs),
        ],
      });

      if (!batchOutcome.applied) {
        if (await hasLockedSiblingInGroup(db, ctx.workspaceId, card.selectionGroupId, card.id)) {
          throw new DomainError(
            "GROUP_LOCKED",
            "Cannot defer or restore card while another option in its group is accepted.",
            true,
          );
        }
        const latest = await db.orm
          .select({ version: schema.decisionCards.version })
          .from(schema.decisionCards)
          .where(eq(schema.decisionCards.id, card.id))
          .get();
        if (latest !== undefined && latest.version !== input.expected_version) {
          throw new DomainError(
            "VERSION_CONFLICT",
            `Decision card version conflict (expected ${input.expected_version}, actual ${latest.version}).`,
            false,
            { currentVersion: latest.version },
          );
        }
        throw new DomainError("INVALID_TRANSITION", "Card status changed concurrently.", false);
      }

      return receipt;
    },
  );
}
