import { DomainError } from "./errors";

export const CARD_TYPES = ["policy", "choice", "deliverable"] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const SELECTION_MODES = ["binary", "single", "multi"] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export const DECISION_CARD_STATUSES = [
  "pending",
  "provisional",
  "accepted",
  "declined",
  "deferred",
  "superseded",
  "closed",
  "expired",
] as const;
export type DecisionCardStatus = (typeof DECISION_CARD_STATUSES)[number];

export const BOARD_VIEW_STATES = [
  "normal",
  "loading",
  "empty",
  "bot_running",
  "bot_disconnected",
  "offline_error",
] as const;
export type BoardViewState = (typeof BOARD_VIEW_STATES)[number];

export interface DecisionFactor {
  readonly label: string;
  readonly value: string;
}

export interface DecisionOption {
  readonly id: string;
  readonly title: string;
  readonly badge?: string;
  readonly summary: string;
  readonly meta: string;
  readonly recommended?: boolean;
}

export interface ArtifactPreview {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly version: number;
  readonly summary: string;
  readonly excerpt: readonly string[];
}

export interface DecisionCardItem {
  readonly id: string;
  readonly proposalId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly selectionGroupId?: string;
  readonly cardType: CardType;
  readonly selectionMode: SelectionMode;
  readonly typeLabel: string;
  readonly shortChip: string;
  readonly botName: string;
  readonly submittedAtLabel: string;
  readonly version: number;
  readonly headline: string;
  readonly summary: string;
  readonly acceptEffect: string;
  readonly declineEffect: string;
  readonly factors: readonly DecisionFactor[];
  readonly options?: readonly DecisionOption[];
  readonly artifact: ArtifactPreview;
}

export type DecisionPayload =
  | {
      readonly mode: "binary";
      readonly decision: "accepted" | "declined";
    }
  | {
      readonly mode: "single";
      readonly decision: "accepted";
      readonly selectedOptionId: string;
    }
  | {
      readonly mode: "single";
      readonly decision: "declined";
    }
  | {
      readonly mode: "multi";
      readonly decision: "accepted";
      readonly acceptedOptionIds: readonly string[];
      readonly declinedOptionIds: readonly string[];
    }
  | {
      readonly mode: "multi";
      readonly decision: "declined";
      readonly acceptedOptionIds: readonly [];
      readonly declinedOptionIds: readonly string[];
    };

export function getDefaultSelectedOptionId(card: DecisionCardItem): string | undefined {
  if (card.selectionMode !== "single") {
    return undefined;
  }
  const options = card.options ?? [];
  const recommended = options.find((opt) => opt.recommended === true);
  return recommended?.id ?? options[0]?.id;
}

export function getDefaultCheckedOptionIds(card: DecisionCardItem): readonly string[] {
  if (card.selectionMode !== "multi") {
    return [];
  }
  const options = card.options ?? [];
  const recommendedIds = options.filter((opt) => opt.recommended === true).map((opt) => opt.id);
  return recommendedIds.length > 0 ? recommendedIds : options.map((opt) => opt.id);
}

export function validateDecisionPayload(card: DecisionCardItem, payload: DecisionPayload): void {
  if (card.selectionMode !== payload.mode) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `Decision payload mode "${payload.mode}" does not match card mode "${card.selectionMode}".`,
      false,
    );
  }

  if (payload.mode === "binary") {
    return;
  }

  const options = card.options ?? [];
  const validOptionIds = new Set(options.map((opt) => opt.id));

  if (payload.mode === "single") {
    if (payload.decision === "declined") {
      return;
    }
    if (!validOptionIds.has(payload.selectedOptionId)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Unknown single-choice option "${payload.selectedOptionId}".`,
        false,
      );
    }
    return;
  }

  if (payload.decision === "declined" && payload.acceptedOptionIds.length > 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Declined multi-select payload cannot include accepted options.",
      false,
    );
  }

  if (payload.decision === "accepted" && payload.acceptedOptionIds.length === 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "At least one option must be selected when accepting a multi-select card.",
      false,
    );
  }

  const seen = new Set<string>();
  for (const id of payload.acceptedOptionIds) {
    if (!validOptionIds.has(id) || seen.has(id)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Invalid or duplicate accepted option "${id}".`,
        false,
      );
    }
    seen.add(id);
  }

  for (const id of payload.declinedOptionIds) {
    if (!validOptionIds.has(id) || seen.has(id)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Invalid or overlapping declined option "${id}".`,
        false,
      );
    }
    seen.add(id);
  }

  if (seen.size !== validOptionIds.size) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "Multi-select payload must classify every option in the card.",
      false,
    );
  }
}

export function buildAcceptPayload(
  card: DecisionCardItem,
  selectedOptionId: string | undefined,
  checkedOptionIds: readonly string[],
): DecisionPayload {
  if (card.selectionMode === "binary") {
    const payload: DecisionPayload = { mode: "binary", decision: "accepted" };
    validateDecisionPayload(card, payload);
    return payload;
  }

  if (card.selectionMode === "single") {
    if (selectedOptionId === undefined) {
      throw new DomainError("VALIDATION_ERROR", "Select one option before confirming.", false);
    }
    const payload: DecisionPayload = {
      mode: "single",
      decision: "accepted",
      selectedOptionId,
    };
    validateDecisionPayload(card, payload);
    return payload;
  }

  const options = card.options ?? [];
  const validOptionIds = new Set(options.map((opt) => opt.id));
  const acceptedSet = new Set<string>();
  for (const id of checkedOptionIds) {
    if (!validOptionIds.has(id) || acceptedSet.has(id)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        `Invalid or duplicate multi-select option "${id}".`,
        false,
      );
    }
    acceptedSet.add(id);
  }
  const acceptedOptionIds = options.filter((opt) => acceptedSet.has(opt.id)).map((opt) => opt.id);
  const declinedOptionIds = options.filter((opt) => !acceptedSet.has(opt.id)).map((opt) => opt.id);

  const payload: DecisionPayload = {
    mode: "multi",
    decision: "accepted",
    acceptedOptionIds,
    declinedOptionIds,
  };
  validateDecisionPayload(card, payload);
  return payload;
}

export function buildDeclinePayload(card: DecisionCardItem): DecisionPayload {
  if (card.selectionMode === "binary") {
    return { mode: "binary", decision: "declined" };
  }
  if (card.selectionMode === "single") {
    return { mode: "single", decision: "declined" };
  }
  const declinedOptionIds = (card.options ?? []).map((opt) => opt.id);
  return {
    mode: "multi",
    decision: "declined",
    acceptedOptionIds: [],
    declinedOptionIds,
  };
}

export function isBoardViewState(value: string | null): value is BoardViewState {
  if (value === null) {
    return false;
  }
  return BOARD_VIEW_STATES.some((entry) => entry === value);
}
