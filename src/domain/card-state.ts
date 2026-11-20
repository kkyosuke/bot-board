import { type DecisionCardStatus } from "./decision-card";
import { DomainError } from "./errors";
import { type OnDeclinePolicy } from "./task-state";

export const DECISION_RECORD_STATUSES = ["provisional", "canceled", "finalized"] as const;
export type DecisionRecordStatus = (typeof DECISION_RECORD_STATUSES)[number];

function assertPositiveIntegerVersion(expectedVersion: number, entityLabel: string): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new DomainError(
      "VALIDATION_ERROR",
      `${entityLabel} expected_version must be a positive integer.`,
      false,
    );
  }
}

export function assertExpectedVersion(
  expectedVersion: number,
  currentVersion: number,
  entityLabel = "Resource",
): void {
  assertPositiveIntegerVersion(expectedVersion, entityLabel);
  if (expectedVersion !== currentVersion) {
    throw new DomainError(
      "VERSION_CONFLICT",
      `${entityLabel} version conflict (expected ${expectedVersion}, actual ${currentVersion}).`,
      false,
      { currentVersion },
    );
  }
}

export function assertDecisionCardNotFinalized(status: DecisionCardStatus): void {
  if (status === "accepted" || status === "declined") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Decision card in finalized status "${status}" is immutable.`,
      false,
    );
  }
}

export function assertCardIsFinalizedForBot(
  cardStatus: DecisionCardStatus,
  decisionStatus: DecisionRecordStatus,
): void {
  if (decisionStatus !== "finalized" || (cardStatus !== "accepted" && cardStatus !== "declined")) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "DEC-01: Provisional or unfinalized decisions must never be exposed to Bot/Worker execution.",
      false,
    );
  }
}

export function assertGroupDeclinePolicyConsistency(policies: readonly OnDeclinePolicy[]): void {
  if (policies.length <= 1) {
    return;
  }
  const first = policies[0];
  if (policies.some((policy) => policy !== first)) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "All proposals within the same selection_group_id must share the same on_decline_policy.",
      false,
    );
  }
}

export function hasVersionMismatch(params: {
  readonly targetTaskVersion: number;
  readonly currentTaskVersion: number;
  readonly targetArtifactVersion?: number | null;
  readonly currentArtifactVersion?: number | null;
}): boolean {
  if (params.targetTaskVersion !== params.currentTaskVersion) {
    return true;
  }
  if (
    params.targetArtifactVersion !== undefined &&
    params.targetArtifactVersion !== null &&
    params.targetArtifactVersion !== params.currentArtifactVersion
  ) {
    return true;
  }
  return false;
}

export type CardDecideEvaluation =
  { readonly outcome: "ok" } | { readonly outcome: "expired" } | { readonly outcome: "stale" };

export function evaluateCardDecidePreconditions(params: {
  readonly cardStatus: DecisionCardStatus;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly nowMs: number;
  readonly expiresAtMs: number | null;
  readonly targetTaskVersion: number;
  readonly currentTaskVersion: number;
  readonly targetArtifactVersion?: number | null;
  readonly currentArtifactVersion?: number | null;
  readonly hasGroupLock: boolean;
  readonly replacementCardId?: string | null;
}): CardDecideEvaluation {
  assertPositiveIntegerVersion(params.expectedVersion, "DecisionCard");

  // DEC-03 (1): Check superseded BEFORE version comparison because supersede_proposal increments card.version
  if (params.cardStatus === "superseded") {
    throw new DomainError(
      "STALE_PROPOSAL",
      "Decision card was superseded by a newer proposal.",
      false,
      params.replacementCardId ? { replacementCardId: params.replacementCardId } : undefined,
    );
  }

  assertExpectedVersion(params.expectedVersion, params.currentVersion, "DecisionCard");

  if (params.cardStatus !== "pending") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot decide card in status "${params.cardStatus}" (must be "pending").`,
      false,
    );
  }

  if (params.hasGroupLock) {
    throw new DomainError(
      "GROUP_LOCKED",
      "Another option in this selection group is already provisionally accepted or accepted.",
      true,
    );
  }

  if (params.expiresAtMs !== null && params.expiresAtMs <= params.nowMs) {
    return { outcome: "expired" };
  }

  if (
    hasVersionMismatch({
      targetTaskVersion: params.targetTaskVersion,
      currentTaskVersion: params.currentTaskVersion,
      targetArtifactVersion: params.targetArtifactVersion ?? null,
      currentArtifactVersion: params.currentArtifactVersion ?? null,
    })
  ) {
    return { outcome: "stale" };
  }

  return { outcome: "ok" };
}

export function assertCanUndoCard(params: {
  readonly cardStatus: DecisionCardStatus;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly nowMs: number;
  readonly provisionalUntilMs: number | null;
}): void {
  assertExpectedVersion(params.expectedVersion, params.currentVersion, "DecisionCard");
  assertDecisionCardNotFinalized(params.cardStatus);

  if (params.cardStatus !== "provisional") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot undo card in status "${params.cardStatus}" (must be "provisional").`,
      false,
    );
  }

  if (params.provisionalUntilMs === null || params.nowMs >= params.provisionalUntilMs) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "The 5-second undo window has already elapsed.",
      false,
    );
  }
}

export type CardFinalizeEvaluation = "noop" | "expired" | "stale" | "accepted" | "declined";

export function evaluateCardFinalizeOutcome(params: {
  readonly cardStatus: DecisionCardStatus;
  readonly provisionalResult: "accepted" | "declined" | null;
  readonly nowMs: number;
  readonly provisionalUntilMs: number | null;
  readonly expiresAtMs: number | null;
  readonly targetTaskVersion: number;
  readonly currentTaskVersion: number;
  readonly targetArtifactVersion?: number | null;
  readonly currentArtifactVersion?: number | null;
}): CardFinalizeEvaluation {
  if (
    params.cardStatus !== "provisional" ||
    params.provisionalResult === null ||
    params.provisionalUntilMs === null ||
    params.nowMs < params.provisionalUntilMs
  ) {
    return "noop";
  }

  if (params.expiresAtMs !== null && params.expiresAtMs <= params.nowMs) {
    return "expired";
  }

  if (
    hasVersionMismatch({
      targetTaskVersion: params.targetTaskVersion,
      currentTaskVersion: params.currentTaskVersion,
      targetArtifactVersion: params.targetArtifactVersion ?? null,
      currentArtifactVersion: params.currentArtifactVersion ?? null,
    })
  ) {
    return "stale";
  }

  return params.provisionalResult;
}

export function assertCanDeferCard(params: {
  readonly cardStatus: DecisionCardStatus;
  readonly targetStatus: "pending" | "deferred";
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly hasGroupLock: boolean;
}): void {
  assertExpectedVersion(params.expectedVersion, params.currentVersion, "DecisionCard");

  if (params.targetStatus === "deferred" && params.cardStatus !== "pending") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Only "pending" cards can be deferred (current: "${params.cardStatus}").`,
      false,
    );
  }

  if (params.targetStatus === "pending" && params.cardStatus !== "deferred") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Only "deferred" cards can be restored to pending (current: "${params.cardStatus}").`,
      false,
    );
  }

  if (params.hasGroupLock) {
    throw new DomainError(
      "GROUP_LOCKED",
      "Cannot defer or restore card while another option in its group is accepted.",
      true,
    );
  }
}
