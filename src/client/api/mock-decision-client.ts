import {
  type DecisionCardItem,
  type DecisionPayload,
  DomainError,
  PROVISIONAL_UNDO_WINDOW_MS,
  validateDecisionPayload,
} from "@/domain";

import {
  ClientTransportError,
  type DecideCardInput,
  type DecisionCardClient,
  type DecisionQueueSnapshot,
  type DeferCardInput,
  type DeferCardReceipt,
  type ProvisionalDecisionReceipt,
  type UndoCardInput,
  type UndoCardReceipt,
} from "./decision-client";
import { createInitialDecisionCards } from "./fixtures";

interface StoredProvisionalEntry {
  readonly decisionId: string;
  readonly card: DecisionCardItem;
  readonly version: number;
  readonly provisionalUntil: number;
  readonly payload: DecisionPayload;
  readonly lockedPendingSiblings: readonly DecisionCardItem[];
  readonly lockedDeferredSiblings: readonly DecisionCardItem[];
}

interface IdempotencyRecord<T> {
  readonly inputFingerprint: string;
  readonly response: T;
}

export interface MockDecisionClientOptions {
  readonly initialCards?: readonly DecisionCardItem[];
  readonly now?: () => number;
  readonly initialOffline?: boolean;
}

function cloneCard(card: DecisionCardItem): DecisionCardItem {
  return {
    ...card,
    factors: card.factors.map((factor) => ({ ...factor })),
    ...(card.options !== undefined
      ? { options: card.options.map((option) => ({ ...option })) }
      : {}),
    artifact: {
      ...card.artifact,
      excerpt: [...card.artifact.excerpt],
    },
  };
}

function createOfflineError(): ClientTransportError {
  return new ClientTransportError(
    "オフラインのため操作を送信できません。復帰後に最新版を確認して再操作してください。",
  );
}

export function createMockDecisionClient(
  options: MockDecisionClientOptions = {},
): DecisionCardClient {
  const nowFn = options.now ?? (() => Date.now());
  let offline = options.initialOffline ?? false;
  let seq = 1;

  const initialSource = (): DecisionCardItem[] =>
    (options.initialCards ?? createInitialDecisionCards()).map(cloneCard);

  let pendingCards: DecisionCardItem[] = initialSource();
  let deferredCards: DecisionCardItem[] = [];
  const cardGroupById = new Map<string, string>();
  const provisionalByCardId = new Map<string, StoredProvisionalEntry>();
  const lockedGroupAcceptedCardId = new Map<string, string>();
  const closedGroupIds = new Set<string>();
  const decideIdempotency = new Map<string, IdempotencyRecord<ProvisionalDecisionReceipt>>();
  const undoIdempotency = new Map<string, IdempotencyRecord<UndoCardReceipt>>();
  const deferIdempotency = new Map<string, IdempotencyRecord<DeferCardReceipt>>();

  const indexCardGroups = (cards: readonly DecisionCardItem[]): void => {
    cardGroupById.clear();
    for (const card of cards) {
      if (card.selectionGroupId !== undefined) {
        cardGroupById.set(card.id, card.selectionGroupId);
      }
    }
  };
  indexCardGroups(pendingCards);

  const finalizeExpired = (): void => {
    const now = nowFn();
    for (const [cardId, entry] of provisionalByCardId.entries()) {
      if (entry.provisionalUntil <= now) {
        provisionalByCardId.delete(cardId);
        if (entry.payload.decision === "accepted" && entry.card.selectionGroupId !== undefined) {
          lockedGroupAcceptedCardId.delete(entry.card.selectionGroupId);
          closedGroupIds.add(entry.card.selectionGroupId);
        }
      }
    }
  };

  const isSiblingLockedOrClosed = (cardId: string): boolean => {
    const groupId = cardGroupById.get(cardId);
    if (groupId === undefined) {
      return false;
    }
    if (closedGroupIds.has(groupId)) {
      return true;
    }
    const acceptedCardId = lockedGroupAcceptedCardId.get(groupId);
    return acceptedCardId !== undefined && acceptedCardId !== cardId;
  };

  const buildSnapshot = (): DecisionQueueSnapshot => {
    finalizeExpired();
    return {
      pendingCards: pendingCards.map(cloneCard),
      deferredCards: deferredCards.map(cloneCard),
    };
  };

  return {
    setOfflineMode(nextOffline: boolean): void {
      offline = nextOffline;
    },

    resetDemoQueue(): Promise<DecisionQueueSnapshot> {
      offline = false;
      pendingCards = initialSource();
      deferredCards = [];
      indexCardGroups(pendingCards);
      provisionalByCardId.clear();
      lockedGroupAcceptedCardId.clear();
      closedGroupIds.clear();
      decideIdempotency.clear();
      undoIdempotency.clear();
      deferIdempotency.clear();
      return Promise.resolve(buildSnapshot());
    },

    listCards(): Promise<DecisionQueueSnapshot> {
      return Promise.resolve(buildSnapshot());
    },

    decideCard(input: DecideCardInput): Promise<ProvisionalDecisionReceipt> {
      finalizeExpired();

      if (offline) {
        return Promise.reject(createOfflineError());
      }

      const fingerprint = JSON.stringify({
        cardId: input.cardId,
        expectedVersion: input.expectedVersion,
        payload: input.payload,
      });
      const existing = decideIdempotency.get(input.requestId);
      if (existing !== undefined) {
        if (existing.inputFingerprint !== fingerprint) {
          return Promise.reject(
            new DomainError("IDEMPOTENCY_CONFLICT", "request_id reused with different input."),
          );
        }
        return Promise.resolve(existing.response);
      }

      if (isSiblingLockedOrClosed(input.cardId)) {
        return Promise.reject(
          new DomainError(
            "GROUP_LOCKED",
            "Selection group is locked or closed because another candidate was accepted.",
          ),
        );
      }

      const cardIndex = pendingCards.findIndex((card) => card.id === input.cardId);
      if (cardIndex === -1) {
        return Promise.reject(new DomainError("INVALID_TRANSITION", "Card is no longer pending."));
      }

      const card = pendingCards[cardIndex];
      if (card === undefined) {
        return Promise.reject(new DomainError("NOT_FOUND", "Card not found."));
      }

      if (card.version !== input.expectedVersion) {
        return Promise.reject(
          new DomainError("VERSION_CONFLICT", "Card version has changed; reload required.", true),
        );
      }

      try {
        validateDecisionPayload(card, input.payload);
      } catch (err) {
        return Promise.reject(
          err instanceof Error
            ? err
            : new DomainError("VALIDATION_ERROR", "Invalid decision payload."),
        );
      }

      const now = nowFn();
      const newVersion = card.version + 1;
      const updatedCard: DecisionCardItem = { ...card, version: newVersion };

      pendingCards.splice(cardIndex, 1);

      let lockedPendingSiblings: DecisionCardItem[] = [];
      let lockedDeferredSiblings: DecisionCardItem[] = [];
      if (input.payload.decision === "accepted" && card.selectionGroupId !== undefined) {
        const groupId = card.selectionGroupId;
        lockedGroupAcceptedCardId.set(groupId, card.id);
        lockedPendingSiblings = pendingCards.filter((item) => item.selectionGroupId === groupId);
        pendingCards = pendingCards.filter((item) => item.selectionGroupId !== groupId);
        lockedDeferredSiblings = deferredCards.filter((item) => item.selectionGroupId === groupId);
        deferredCards = deferredCards.filter((item) => item.selectionGroupId !== groupId);
      }

      const decisionId = `dec-${seq}`;
      seq += 1;
      const provisionalUntil = now + PROVISIONAL_UNDO_WINDOW_MS;

      provisionalByCardId.set(card.id, {
        decisionId,
        card: cloneCard(updatedCard),
        version: newVersion,
        provisionalUntil,
        payload: input.payload,
        lockedPendingSiblings: lockedPendingSiblings.map(cloneCard),
        lockedDeferredSiblings: lockedDeferredSiblings.map(cloneCard),
      });

      const closedSiblingCardIds = [
        ...lockedPendingSiblings.map((sibling) => sibling.id),
        ...lockedDeferredSiblings.map((sibling) => sibling.id),
      ];

      const receipt: ProvisionalDecisionReceipt = {
        decisionId,
        cardId: card.id,
        newVersion,
        status: "provisional",
        provisionalUntil,
        payload: input.payload,
        closedSiblingCardIds,
      };

      decideIdempotency.set(input.requestId, {
        inputFingerprint: fingerprint,
        response: receipt,
      });

      return Promise.resolve(receipt);
    },

    undoCard(input: UndoCardInput): Promise<UndoCardReceipt> {
      finalizeExpired();

      if (offline) {
        return Promise.reject(createOfflineError());
      }

      const fingerprint = JSON.stringify({
        cardId: input.cardId,
        expectedVersion: input.expectedVersion,
      });
      const existing = undoIdempotency.get(input.requestId);
      if (existing !== undefined) {
        if (existing.inputFingerprint !== fingerprint) {
          return Promise.reject(
            new DomainError("IDEMPOTENCY_CONFLICT", "request_id reused with different input."),
          );
        }
        return Promise.resolve(existing.response);
      }

      const entry = provisionalByCardId.get(input.cardId);
      if (entry === undefined) {
        return Promise.reject(
          new DomainError("INVALID_TRANSITION", "Provisional decision already finalized."),
        );
      }

      if (nowFn() >= entry.provisionalUntil) {
        finalizeExpired();
        return Promise.reject(
          new DomainError("INVALID_TRANSITION", "Undo window (5s) has already expired."),
        );
      }

      if (entry.version !== input.expectedVersion) {
        return Promise.reject(
          new DomainError("VERSION_CONFLICT", "Provisional card version mismatch.", true),
        );
      }

      provisionalByCardId.delete(input.cardId);
      if (entry.payload.decision === "accepted" && entry.card.selectionGroupId !== undefined) {
        lockedGroupAcceptedCardId.delete(entry.card.selectionGroupId);
      }

      const newVersion = entry.version + 1;
      const restoredCard: DecisionCardItem = { ...cloneCard(entry.card), version: newVersion };
      const restoredPendingSiblings = entry.lockedPendingSiblings.map(cloneCard);
      const restoredDeferredSiblings = entry.lockedDeferredSiblings.map(cloneCard);

      pendingCards = [restoredCard, ...restoredPendingSiblings, ...pendingCards];
      if (restoredDeferredSiblings.length > 0) {
        deferredCards = [...restoredDeferredSiblings, ...deferredCards];
      }

      const allRestoredSiblings = [...restoredPendingSiblings, ...restoredDeferredSiblings];
      const receipt: UndoCardReceipt = {
        cardId: restoredCard.id,
        newVersion,
        status: "pending",
        restoredCard: cloneCard(restoredCard),
        restoredSiblingCards: allRestoredSiblings.map(cloneCard),
      };

      undoIdempotency.set(input.requestId, {
        inputFingerprint: fingerprint,
        response: receipt,
      });

      return Promise.resolve(receipt);
    },

    deferCard(input: DeferCardInput): Promise<DeferCardReceipt> {
      finalizeExpired();

      if (offline) {
        return Promise.reject(createOfflineError());
      }

      const fingerprint = JSON.stringify({
        cardId: input.cardId,
        expectedVersion: input.expectedVersion,
        action: input.action,
      });
      const existing = deferIdempotency.get(input.requestId);
      if (existing !== undefined) {
        if (existing.inputFingerprint !== fingerprint) {
          return Promise.reject(
            new DomainError("IDEMPOTENCY_CONFLICT", "request_id reused with different input."),
          );
        }
        return Promise.resolve(existing.response);
      }

      if (isSiblingLockedOrClosed(input.cardId)) {
        return Promise.reject(
          new DomainError(
            "GROUP_LOCKED",
            "Selection group is locked or closed because another candidate was accepted.",
          ),
        );
      }

      if (input.action === "defer") {
        const idx = pendingCards.findIndex((c) => c.id === input.cardId);
        if (idx === -1) {
          return Promise.reject(new DomainError("INVALID_TRANSITION", "Card is not pending."));
        }
        const target = pendingCards[idx];
        if (target === undefined) {
          return Promise.reject(new DomainError("NOT_FOUND", "Card not found."));
        }
        if (target.version !== input.expectedVersion) {
          return Promise.reject(
            new DomainError("VERSION_CONFLICT", "Card version mismatch.", true),
          );
        }
        pendingCards.splice(idx, 1);
        const updated: DecisionCardItem = { ...target, version: target.version + 1 };
        deferredCards.push(updated);

        const receipt: DeferCardReceipt = {
          cardId: updated.id,
          newVersion: updated.version,
          status: "deferred",
          card: cloneCard(updated),
        };
        deferIdempotency.set(input.requestId, { inputFingerprint: fingerprint, response: receipt });
        return Promise.resolve(receipt);
      }

      const idx = deferredCards.findIndex((c) => c.id === input.cardId);
      if (idx === -1) {
        return Promise.reject(new DomainError("INVALID_TRANSITION", "Card is not deferred."));
      }
      const target = deferredCards[idx];
      if (target === undefined) {
        return Promise.reject(new DomainError("NOT_FOUND", "Card not found."));
      }
      if (target.version !== input.expectedVersion) {
        return Promise.reject(new DomainError("VERSION_CONFLICT", "Card version mismatch.", true));
      }
      deferredCards.splice(idx, 1);
      const updated: DecisionCardItem = { ...target, version: target.version + 1 };
      pendingCards = [updated, ...pendingCards];

      const receipt: DeferCardReceipt = {
        cardId: updated.id,
        newVersion: updated.version,
        status: "pending",
        card: cloneCard(updated),
      };
      deferIdempotency.set(input.requestId, { inputFingerprint: fingerprint, response: receipt });
      return Promise.resolve(receipt);
    },
  };
}
