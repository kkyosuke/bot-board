import { didParentMutationApply, type GuardedMutationOutcome } from "@/db";
import { type ErrorCode } from "@/domain";
import { type FinalizeTriggerSource } from "@/services/system/finalize";

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
