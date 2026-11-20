import { type CardType, type DecisionCardStatus } from "./decision-card";
import { DomainError } from "./errors";

export const TASK_STATUSES = [
  "ready",
  "running",
  "waiting_human",
  "done",
  "blocked",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ON_DECLINE_POLICIES = ["revise", "block"] as const;
export type OnDeclinePolicy = (typeof ON_DECLINE_POLICIES)[number];

export const BOT_RECORD_RESULT_OUTCOMES = ["success", "failed", "blocked", "ready"] as const;
export type BotRecordResultOutcome = (typeof BOT_RECORD_RESULT_OUTCOMES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

export function assertCanClaimTask(taskStatus: TaskStatus, isWorkspacePaused: boolean): void {
  if (isWorkspacePaused) {
    throw new DomainError("WORKSPACE_PAUSED", "Workspace is currently paused.", true);
  }
  if (taskStatus !== "ready") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Task in status "${taskStatus}" cannot be claimed (must be "ready").`,
      false,
    );
  }
}

export function assertCanSubmitProposal(taskStatus: TaskStatus): void {
  if (taskStatus !== "running") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Proposals can only be submitted while task is "running" (current: "${taskStatus}").`,
      false,
    );
  }
}

export function assertCanSupersedeProposal(params: {
  readonly taskStatus: TaskStatus;
  readonly targetCardStatus: DecisionCardStatus;
  readonly groupCardStatuses: readonly DecisionCardStatus[];
}): void {
  if (params.taskStatus !== "waiting_human" && params.taskStatus !== "running") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot supersede proposal when task status is "${params.taskStatus}".`,
      false,
    );
  }

  if (params.targetCardStatus === "provisional") {
    throw new DomainError(
      "INVALID_TRANSITION",
      "Cannot supersede a proposal while the target card is provisional.",
      true,
    );
  }

  if (params.targetCardStatus !== "pending" && params.targetCardStatus !== "deferred") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Only "pending" or "deferred" cards can be superseded (current: "${params.targetCardStatus}").`,
      false,
    );
  }

  if (params.groupCardStatuses.some((status) => status === "provisional")) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "Cannot supersede a proposal while any card in its group is provisional.",
      true,
    );
  }

  if (params.groupCardStatuses.some((status) => status === "accepted")) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "Cannot supersede a proposal in a group that already has an accepted card.",
      false,
    );
  }
}

export function resolveTaskStatusOnRecordResult(params: {
  readonly taskStatus: TaskStatus;
  readonly outcome: BotRecordResultOutcome;
  readonly requiresApproval: boolean;
}): TaskStatus {
  if (params.taskStatus !== "running") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Cannot record result for task in status "${params.taskStatus}" (must be "running").`,
      false,
    );
  }

  if (params.outcome === "success") {
    if (params.requiresApproval) {
      throw new DomainError(
        "INVALID_TRANSITION",
        "Tasks with requires_approval=true cannot transition to done without an accepted deliverable card.",
        false,
      );
    }
    return "done";
  }

  if (params.outcome === "failed") {
    return "failed";
  }

  if (params.outcome === "blocked") {
    return "blocked";
  }

  return "ready";
}

export function assertCanRetryTask(taskStatus: TaskStatus): "ready" {
  if (taskStatus !== "failed" && taskStatus !== "blocked") {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Only "failed" or "blocked" tasks can be retried (current: "${taskStatus}").`,
      false,
    );
  }
  return "ready";
}

export function resolveTaskStatusAfterDecisionFinalized(params: {
  readonly cardType: CardType;
  readonly decisionResult: "accepted" | "declined";
  readonly onDeclinePolicy: OnDeclinePolicy;
  readonly remainingUndecidedInGroup: number;
}): TaskStatus {
  if (!Number.isInteger(params.remainingUndecidedInGroup) || params.remainingUndecidedInGroup < 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "remainingUndecidedInGroup must be a non-negative integer.",
      false,
    );
  }

  if (params.decisionResult === "accepted") {
    return params.cardType === "deliverable" ? "done" : "ready";
  }

  if (params.remainingUndecidedInGroup > 0) {
    return "waiting_human";
  }

  return params.onDeclinePolicy === "block" ? "blocked" : "ready";
}

export function resolveTaskStatusWhenCardsInactive(remainingActiveCards: number): TaskStatus {
  if (!Number.isInteger(remainingActiveCards) || remainingActiveCards < 0) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "remainingActiveCards must be a non-negative integer.",
      false,
    );
  }
  return remainingActiveCards === 0 ? "ready" : "waiting_human";
}
