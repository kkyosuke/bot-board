import { didParentMutationApply, type GuardedMutationOutcome } from "@/db";
import { type ErrorCode } from "@/domain";

export type FinalizeTriggerSource = "queue" | "cron" | "on_demand";

export interface SystemJobSummary {
  readonly source: FinalizeTriggerSource;
  readonly outcome: GuardedMutationOutcome;
  readonly errorCode?: ErrorCode;
}

export function buildSystemJobSummary(
  source: FinalizeTriggerSource,
  parentChanges: number,
): SystemJobSummary {
  return {
    source,
    outcome: didParentMutationApply(parentChanges),
  };
}
