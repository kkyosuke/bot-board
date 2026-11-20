import {
  type D1Database,
  type ExecutionContext,
  type MessageBatch,
  type Queue,
  type RateLimit,
  type ScheduledController,
} from "@cloudflare/workers-types";

import { assertModelTimeoutWithinLease, type BoundedModelStepOptions } from "@/adapters";
import {
  type D1BotVerificationInput,
  type VerifiedBotContext,
  verifyBotConnectionContext,
} from "@/auth/bot";
import { type BotScope } from "@/domain";
import { createApp } from "@/server/app";
import { assertBotWriteAccess } from "@/services/bot";
import { buildSystemJobSummary, type SystemJobSummary } from "@/services/system";
import { createLogger } from "@/shared/logger";

export const WORKER_QUEUE_NAMES = ["decision-finalize", "bot-work", "bot-work-dlq"] as const;

export type WorkerQueueName = (typeof WORKER_QUEUE_NAMES)[number];

export interface DecisionFinalizeQueueMessage {
  readonly card_id: string;
}

export interface BotWorkQueueMessage {
  readonly decision_id?: string;
  readonly task_id: string;
  readonly workspace_id: string;
}

export interface WorkerAssetsFetcher {
  fetch(input: Request | string): Promise<Response>;
}

export interface WorkerEnv {
  readonly DB: D1Database;
  readonly DECISION_FINALIZE_QUEUE: Queue<DecisionFinalizeQueueMessage>;
  readonly BOT_WORK_QUEUE: Queue<BotWorkQueueMessage>;
  readonly BOT_WORK_DLQ: Queue<BotWorkQueueMessage>;
  readonly API_RATE_LIMITER?: RateLimit;
  readonly ASSETS?: WorkerAssetsFetcher;
  readonly BETTER_AUTH_SECRET?: string;
  readonly BETTER_AUTH_URL?: string;
  readonly TRUSTED_ORIGINS?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly OWNER_GITHUB_ID?: string;
  readonly XAI_API_KEY?: string;
  readonly APP_ENV?: string;
}

const workerLogger = createLogger("worker");

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

const workerHandler = {
  async fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) {
      const app = createApp();
      return await app.fetch(request);
    }

    if (env.ASSETS !== undefined) {
      return await env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },

  queue(batch: MessageBatch, _env: WorkerEnv, _ctx: ExecutionContext): Promise<void> {
    workerLogger.info("Received worker queue batch", {
      queue: batch.queue,
      messageCount: batch.messages.length,
    });
    for (const message of batch.messages) {
      message.ack();
    }
    return Promise.resolve();
  },

  scheduled(
    controller: ScheduledController,
    _env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    workerLogger.info("Executed scheduled cron tick", {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
    return Promise.resolve();
  },
};

export default workerHandler;
