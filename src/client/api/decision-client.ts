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

export interface DecisionQueueSnapshot {
  readonly pendingCards: readonly DecisionCardItem[];
  readonly deferredCards: readonly DecisionCardItem[];
}

export class ClientTransportError extends Error {
  public readonly code = "NETWORK_UNAVAILABLE" as const;
  public readonly retryable = true as const;

  public constructor(message: string) {
    super(message);
    this.name = "ClientTransportError";
  }
}

export interface DecisionCardClient {
  listCards(): Promise<DecisionQueueSnapshot>;
  decideCard(input: DecideCardInput): Promise<ProvisionalDecisionReceipt>;
  undoCard(input: UndoCardInput): Promise<UndoCardReceipt>;
  deferCard(input: DeferCardInput): Promise<DeferCardReceipt>;
  setOfflineMode?(offline: boolean): void;
  resetDemoQueue?(): Promise<DecisionQueueSnapshot>;
}
