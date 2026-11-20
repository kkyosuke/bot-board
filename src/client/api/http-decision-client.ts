import { z } from "zod";

import {
  CARD_TYPES,
  type DecisionCardItem,
  DomainError,
  ERROR_CODES,
  type ErrorCode,
  SELECTION_MODES,
} from "@/domain";

import {
  type CardDetailSnapshot,
  ClientAuthError,
  ClientTransportError,
  type DecideCardInput,
  type DecisionCardClient,
  type DecisionQueueSnapshot,
  type DeferCardInput,
  type DeferCardReceipt,
  type ProvisionalCardSnapshot,
  type ProvisionalDecisionReceipt,
  type UndoCardInput,
  type UndoCardReceipt,
} from "./decision-client";

const decisionFactorSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const decisionOptionSchema = z.object({
  id: z.string(),
  title: z.string(),
  badge: z.string().optional(),
  summary: z.string(),
  meta: z.string(),
  recommended: z.boolean().optional(),
});

const artifactPreviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  version: z.number(),
  summary: z.string(),
  excerpt: z.array(z.string()),
});

const decisionCardItemSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  selectionGroupId: z.string().optional(),
  cardType: z.enum(CARD_TYPES),
  selectionMode: z.enum(SELECTION_MODES),
  typeLabel: z.string(),
  shortChip: z.string(),
  botName: z.string(),
  submittedAtLabel: z.string(),
  version: z.number().int(),
  headline: z.string(),
  summary: z.string(),
  acceptEffect: z.string(),
  declineEffect: z.string(),
  factors: z.array(decisionFactorSchema),
  options: z.array(decisionOptionSchema).optional(),
  artifact: artifactPreviewSchema,
});

const provisionalCardSnapshotSchema = z.object({
  card: decisionCardItemSchema,
  decisionId: z.string(),
  decision: z.enum(["accepted", "declined"]),
  selectedOptionIds: z.array(z.string()),
  provisionalUntil: z.number(),
});

const listCardsResponseSchema = z.object({
  pendingCards: z.array(decisionCardItemSchema),
  deferredCards: z.array(decisionCardItemSchema),
  provisionalCards: z.array(provisionalCardSnapshotSchema),
  workspacePaused: z.boolean(),
  hasActiveBots: z.boolean(),
  runningTaskCount: z.number().int(),
});

const cardDetailResponseSchema = z.object({
  card: decisionCardItemSchema,
  status: z.string(),
  provisionalResult: z.enum(["accepted", "declined"]).nullable(),
  provisionalUntil: z.number().nullable(),
  expiresAt: z.number().nullable(),
  targetTaskVersion: z.number().int(),
  currentTaskVersion: z.number().int(),
  artifactFull: z
    .object({
      id: z.string(),
      title: z.string(),
      kind: z.string(),
      summary: z.string(),
      contentOrUrl: z.string(),
      version: z.number().int(),
    })
    .nullable(),
  siblings: z.array(
    z.object({
      cardId: z.string(),
      proposalId: z.string(),
      title: z.string(),
      status: z.string(),
      version: z.number().int(),
    }),
  ),
  replacementCardId: z.string().nullable(),
});

const decideResponseSchema = z.object({
  decision_id: z.string(),
  card_id: z.string(),
  version: z.number().int(),
  status: z.literal("provisional"),
  result: z.enum(["accepted", "declined"]),
  selected_option_ids: z.array(z.string()),
  provisional_until: z.number(),
  locked_sibling_card_ids: z.array(z.string()),
  trace_id: z.string(),
});

const undoResponseSchema = z.object({
  card_id: z.string(),
  version: z.number().int(),
  status: z.literal("pending"),
  restored_sibling_card_ids: z.array(z.string()),
  trace_id: z.string(),
});

const deferResponseSchema = z.object({
  card_id: z.string(),
  version: z.number().int(),
  status: z.enum(["deferred", "pending"]),
  trace_id: z.string(),
});

function toDomainCard(parsed: z.infer<typeof decisionCardItemSchema>): DecisionCardItem {
  return {
    id: parsed.id,
    proposalId: parsed.proposalId,
    taskId: parsed.taskId,
    taskTitle: parsed.taskTitle,
    ...(parsed.selectionGroupId !== undefined ? { selectionGroupId: parsed.selectionGroupId } : {}),
    cardType: parsed.cardType,
    selectionMode: parsed.selectionMode,
    typeLabel: parsed.typeLabel,
    shortChip: parsed.shortChip,
    botName: parsed.botName,
    submittedAtLabel: parsed.submittedAtLabel,
    version: parsed.version,
    headline: parsed.headline,
    summary: parsed.summary,
    acceptEffect: parsed.acceptEffect,
    declineEffect: parsed.declineEffect,
    factors: parsed.factors.map((f) => ({
      label: f.label,
      value: f.value,
    })),
    ...(parsed.options !== undefined
      ? {
          options: parsed.options.map((o) => ({
            id: o.id,
            title: o.title,
            ...(o.badge !== undefined ? { badge: o.badge } : {}),
            summary: o.summary,
            meta: o.meta,
            ...(o.recommended !== undefined ? { recommended: o.recommended } : {}),
          })),
        }
      : {}),
    artifact: {
      id: parsed.artifact.id,
      title: parsed.artifact.title,
      kind: parsed.artifact.kind,
      version: parsed.artifact.version,
      summary: parsed.artifact.summary,
      excerpt: parsed.artifact.excerpt,
    },
  };
}

function isErrorCode(raw: string): raw is ErrorCode {
  return ERROR_CODES.some((code) => code === raw);
}

const domainErrorDetailsSchema = z.object({
  replacementCardId: z.string().optional(),
  currentVersion: z.number().optional(),
  retryAfterSeconds: z.number().optional(),
  reason: z.string().optional(),
});

const apiErrorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  details: domainErrorDetailsSchema.optional(),
});

export async function parseHumanApiError(res: Response): Promise<Error> {
  const rawJson: unknown = await res.json().catch(() => null);
  const parsedBody = apiErrorBodySchema.safeParse(rawJson);
  const body = parsedBody.success ? parsedBody.data : {};

  const message =
    body.message !== undefined && body.message.trim() !== ""
      ? body.message
      : `サーバーエラーが発生しました (HTTP ${res.status})。`;

  if (res.status === 401) {
    return new ClientAuthError(401, message);
  }
  if (res.status === 403) {
    return new ClientAuthError(403, message);
  }

  if (body.code !== undefined && isErrorCode(body.code)) {
    const retryable = body.retryable ?? res.status >= 500;
    const rawDetails = body.details;
    const details =
      rawDetails !== undefined
        ? {
            ...(rawDetails.replacementCardId !== undefined
              ? { replacementCardId: rawDetails.replacementCardId }
              : {}),
            ...(rawDetails.currentVersion !== undefined
              ? { currentVersion: rawDetails.currentVersion }
              : {}),
            ...(rawDetails.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: rawDetails.retryAfterSeconds }
              : {}),
            ...(rawDetails.reason !== undefined ? { reason: rawDetails.reason } : {}),
          }
        : undefined;
    return new DomainError(body.code, message, retryable, details);
  }

  if (res.status >= 500 || res.status === 429) {
    return new ClientTransportError(message);
  }
  return new DomainError("VALIDATION_ERROR", message, false);
}

export interface HttpDecisionClientOptions {
  readonly baseUrl?: string;
}

export function createHttpDecisionClient(
  options: HttpDecisionClientOptions = {},
): DecisionCardClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const cardCache = new Map<string, DecisionCardItem>();
  let simulatedOffline = false;

  const rememberCards = (cards: readonly DecisionCardItem[]): void => {
    for (const card of cards) {
      cardCache.set(card.id, card);
    }
  };

  const requestJson = async (path: string, init: RequestInit): Promise<unknown> => {
    if (simulatedOffline) {
      throw new ClientTransportError(
        "通信に失敗したため未反映です。接続回復後に再試行してください。",
      );
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new ClientTransportError(
        "通信に失敗したため未反映です。接続回復後に再試行してください。",
      );
    }

    if (!res.ok) {
      throw await parseHumanApiError(res);
    }
    try {
      return await res.json();
    } catch {
      throw new ClientTransportError(
        "サーバーから不正な応答を受信しました。しばらくして再試行してください。",
      );
    }
  };

  const listCards = async (): Promise<DecisionQueueSnapshot> => {
    const raw = await requestJson("/api/human/cards", { method: "GET" });
    const parsed = listCardsResponseSchema.parse(raw);
    const pendingCards = parsed.pendingCards.map(toDomainCard);
    const deferredCards = parsed.deferredCards.map(toDomainCard);
    const provisionalCards: ProvisionalCardSnapshot[] = parsed.provisionalCards.map((entry) => ({
      card: toDomainCard(entry.card),
      decisionId: entry.decisionId,
      decision: entry.decision,
      selectedOptionIds: entry.selectedOptionIds,
      provisionalUntil: entry.provisionalUntil,
    }));
    rememberCards(pendingCards);
    rememberCards(deferredCards);
    rememberCards(provisionalCards.map((p) => p.card));
    return {
      pendingCards,
      deferredCards,
      provisionalCards,
      workspacePaused: parsed.workspacePaused,
      hasActiveBots: parsed.hasActiveBots,
      runningTaskCount: parsed.runningTaskCount,
    };
  };

  const getCardDetail = async (cardId: string): Promise<CardDetailSnapshot> => {
    const raw = await requestJson(`/api/human/cards/${encodeURIComponent(cardId)}`, {
      method: "GET",
    });
    const parsed = cardDetailResponseSchema.parse(raw);
    const card = toDomainCard(parsed.card);
    cardCache.set(card.id, card);
    return {
      card,
      status: parsed.status,
      provisionalResult: parsed.provisionalResult,
      provisionalUntil: parsed.provisionalUntil,
      expiresAt: parsed.expiresAt,
      targetTaskVersion: parsed.targetTaskVersion,
      currentTaskVersion: parsed.currentTaskVersion,
      artifactFull: parsed.artifactFull,
      siblings: parsed.siblings,
      replacementCardId: parsed.replacementCardId,
    };
  };

  return {
    listCards,
    getCardDetail,

    async decideCard(input: DecideCardInput): Promise<ProvisionalDecisionReceipt> {
      const raw = await requestJson(`/api/human/cards/${encodeURIComponent(input.cardId)}/decide`, {
        method: "POST",
        body: JSON.stringify({
          request_id: input.requestId,
          expected_version: input.expectedVersion,
          payload: input.payload,
        }),
      });
      const parsed = decideResponseSchema.parse(raw);
      const existing = cardCache.get(parsed.card_id);
      if (existing !== undefined) {
        cardCache.set(parsed.card_id, { ...existing, version: parsed.version });
      }
      return {
        decisionId: parsed.decision_id,
        cardId: parsed.card_id,
        newVersion: parsed.version,
        status: "provisional",
        provisionalUntil: parsed.provisional_until,
        payload: input.payload,
        closedSiblingCardIds: parsed.locked_sibling_card_ids,
      };
    },

    async undoCard(input: UndoCardInput): Promise<UndoCardReceipt> {
      const raw = await requestJson(`/api/human/cards/${encodeURIComponent(input.cardId)}/undo`, {
        method: "POST",
        body: JSON.stringify({
          request_id: input.requestId,
          expected_version: input.expectedVersion,
        }),
      });
      const parsed = undoResponseSchema.parse(raw);
      const refreshed = await listCards();
      const restoredCard =
        refreshed.pendingCards.find((c) => c.id === parsed.card_id) ??
        cardCache.get(parsed.card_id);
      if (restoredCard === undefined) {
        throw new DomainError(
          "NOT_FOUND",
          `Card "${parsed.card_id}" was not found after undo.`,
          false,
        );
      }
      const siblingSet = new Set(parsed.restored_sibling_card_ids);
      const restoredSiblingCards = [...refreshed.pendingCards, ...refreshed.deferredCards].filter(
        (c) => siblingSet.has(c.id),
      );
      return {
        cardId: parsed.card_id,
        newVersion: parsed.version,
        status: "pending",
        restoredCard: { ...restoredCard, version: parsed.version },
        restoredSiblingCards,
        refreshedSnapshot: refreshed,
      };
    },

    async deferCard(input: DeferCardInput): Promise<DeferCardReceipt> {
      const raw = await requestJson(`/api/human/cards/${encodeURIComponent(input.cardId)}/defer`, {
        method: "POST",
        body: JSON.stringify({
          request_id: input.requestId,
          expected_version: input.expectedVersion,
          action: input.action,
        }),
      });
      const parsed = deferResponseSchema.parse(raw);
      const cached = cardCache.get(parsed.card_id);
      if (cached !== undefined) {
        const updatedCard: DecisionCardItem = { ...cached, version: parsed.version };
        cardCache.set(parsed.card_id, updatedCard);
        return {
          cardId: parsed.card_id,
          newVersion: parsed.version,
          status: parsed.status,
          card: updatedCard,
        };
      }
      const detail = await getCardDetail(parsed.card_id);
      return {
        cardId: parsed.card_id,
        newVersion: parsed.version,
        status: parsed.status,
        card: detail.card,
      };
    },

    setOfflineMode(offline: boolean): void {
      simulatedOffline = offline;
    },
  };
}
