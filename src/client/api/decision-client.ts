import { type DecisionCardItem, type DecisionPayload } from "@/domain";

export interface DecideCardInput {
  readonly cardId: string;
  readonly expectedVersion: number;
  readonly requestId: string;
  readonly payload: DecisionPayload;
}

export interface ProvisionalDecisionReceipt {
  readonly decisionId: string;
  readonly cardId: string;
  readonly newVersion: number;
  readonly status: "provisional";
  readonly provisionalUntil: number;
  readonly payload: DecisionPayload;
  readonly closedSiblingCardIds: readonly string[];
}

export interface UndoCardInput {
  readonly cardId: string;
  readonly expectedVersion: number;
  readonly requestId: string;
}

export interface UndoCardReceipt {
  readonly cardId: string;
  readonly newVersion: number;
  readonly status: "pending";
  readonly restoredCard: DecisionCardItem;
  readonly restoredSiblingCards: readonly DecisionCardItem[];
  readonly refreshedSnapshot?: DecisionQueueSnapshot;
}

export interface DeferCardInput {
  readonly cardId: string;
  readonly expectedVersion: number;
  readonly requestId: string;
  readonly action: "defer" | "restore";
}

export interface DeferCardReceipt {
  readonly cardId: string;
  readonly newVersion: number;
  readonly status: "deferred" | "pending";
  readonly card: DecisionCardItem;
}

export interface ProvisionalCardSnapshot {
  readonly card: DecisionCardItem;
  readonly decisionId: string;
  readonly decision: "accepted" | "declined";
  readonly selectedOptionIds: readonly string[];
  readonly provisionalUntil: number;
}

export interface DecisionQueueSnapshot {
  readonly pendingCards: readonly DecisionCardItem[];
  readonly deferredCards: readonly DecisionCardItem[];
  readonly provisionalCards?: readonly ProvisionalCardSnapshot[];
  readonly workspacePaused?: boolean;
  readonly hasActiveBots?: boolean;
  readonly runningTaskCount?: number;
}

export interface CardDetailSibling {
  readonly cardId: string;
  readonly proposalId: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
}

export interface CardDetailSnapshot {
  readonly card: DecisionCardItem;
  readonly status: string;
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
  readonly siblings: readonly CardDetailSibling[];
  readonly replacementCardId: string | null;
}

export class ClientTransportError extends Error {
  public readonly code = "NETWORK_UNAVAILABLE" as const;
  public readonly retryable = true as const;

  public constructor(message: string) {
    super(message);
    this.name = "ClientTransportError";
  }
}

export class ClientAuthError extends Error {
  public readonly status: 401 | 403;

  public constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "ClientAuthError";
    this.status = status;
  }
}

export interface DecisionCardClient {
  listCards(): Promise<DecisionQueueSnapshot>;
  getCardDetail?(cardId: string): Promise<CardDetailSnapshot>;
  decideCard(input: DecideCardInput): Promise<ProvisionalDecisionReceipt>;
  undoCard(input: UndoCardInput): Promise<UndoCardReceipt>;
  deferCard(input: DeferCardInput): Promise<DeferCardReceipt>;
  setOfflineMode?(offline: boolean): void;
  resetDemoQueue?(): Promise<DecisionQueueSnapshot>;
}
