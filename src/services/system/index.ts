import { didParentMutationApply, type GuardedMutationOutcome } from "@/db";
import { type ErrorCode } from "@/domain";
import { type FinalizeTriggerSource } from "@/services/system/finalize";

export {
  checkWorkspaceBudget,
  getUtcDayStartMs,
  getWorkspaceBudgetUsage,
  recordWorkerStepExecutedEvent,
  WORKER_STEP_EVENT_ACTION,
  type WorkspaceBudgetEvaluation,
} from "@/services/system/budget";
export {
  type CronMaintenanceOptions,
  type CronMaintenanceReport,
  expireOverdueDecisionCards,
  redispatchUnconsumedDecisions,
  releaseExpiredWorkLeases,
  runScheduledMaintenance,
} from "@/services/system/cron";
export {
  buildStaleReconfirmationFollowUps,
  finalizeDecisionCard,
  type FinalizeDecisionCardOptions,
  type FinalizeDecisionCardResult,
  finalizeExpiredProvisionalCards,
  type FinalizeResultKind,
  type FinalizeTriggerSource,
  findReplacementCardIdForProposal,
  type ReconfirmationBuildResult,
} from "@/services/system/finalize";
export {
  type ActorType,
  assertNonEmptyRequestId,
  buildInsertIdempotencyKeySql,
  canonicalJsonHash,
  generateEntityId,
  generateLeaseToken,
  type IdempotencyKey,
  isIdempotencyUniqueViolation,
  lookupIdempotentResponse,
  runWithIdempotencyRaceGuard,
  sha256Hex,
} from "@/services/system/idempotency";
export {
  type BotWorkQueuePayload,
  type BotWorkQueueProducer,
  type DecisionFinalizeQueuePayload,
  type DecisionFinalizeQueueProducer,
  type QueueSendOptions,
} from "@/services/system/queues";
export {
  type BotWorkStepOutcome,
  DEFAULT_WORKER_LEASE_SECONDS,
  DEFAULT_WORKER_STEP_TIMEOUT_MS,
  type HandleBotWorkDlqInput,
  handleBotWorkDlqMessage,
  handleBotWorkTask,
  type HandleBotWorkTaskInput,
} from "@/services/system/worker-step";

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
