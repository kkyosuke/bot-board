import { assertModelTimeoutWithinLease, type BoundedModelStepOptions } from "@/adapters";
import {
  type D1BotVerificationInput,
  type VerifiedBotContext,
  verifyBotConnectionContext,
} from "@/auth/bot";
import { type BotScope } from "@/domain";
import { assertBotWriteAccess } from "@/services/bot";
import { buildSystemJobSummary, type SystemJobSummary } from "@/services/system";

export const WORKER_QUEUE_NAMES = ["decision-finalize", "bot-work", "bot-work-dlq"] as const;

export type WorkerQueueName = (typeof WORKER_QUEUE_NAMES)[number];

export function authorizeWorkerStep(
  record: D1BotVerificationInput,
  requiredScope: BotScope,
  stepOptions: BoundedModelStepOptions,
): VerifiedBotContext {
  const ctx = verifyBotConnectionContext(record);
  assertBotWriteAccess(ctx, record.workspaceId, requiredScope);
  assertModelTimeoutWithinLease(stepOptions);
  return ctx;
}

export function recordFinalizeQueueOutcome(parentChanges: number): SystemJobSummary {
  return buildSystemJobSummary("queue", parentChanges);
}
