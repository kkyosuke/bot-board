import {
  type D1Database,
  type ExecutionContext,
  type MessageBatch,
  type Queue,
  type RateLimit,
  type ScheduledController,
} from "@cloudflare/workers-types";
import { z } from "zod";

import { assertModelTimeoutWithinLease, type BoundedModelStepOptions } from "@/adapters";
import {
  type D1BotVerificationInput,
  type VerifiedBotContext,
  verifyBotConnectionContext,
} from "@/auth/bot";
import { createD1Database, type D1LikeDatabase } from "@/db";
import { type BotScope } from "@/domain";
import { handleWorkerHttpRequest } from "@/server/http-runtime";
import { createCloudflareRateLimiter } from "@/server/rate-limit";
import { assertBotWriteAccess } from "@/services/bot";
import {
  type BotWorkQueueProducer,
  buildSystemJobSummary,
  type DecisionFinalizeQueueProducer,
  finalizeDecisionCard,
  type SystemJobSummary,
} from "@/services/system";
import { createLogger } from "@/shared/logger";
import { createMcpBotServicePort } from "@/worker/mcp-port";

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

export interface WorkerExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerRuntimeEnv {
  readonly DB: D1LikeDatabase;
  readonly DECISION_FINALIZE_QUEUE: DecisionFinalizeQueueProducer;
  readonly BOT_WORK_QUEUE: BotWorkQueueProducer;
  readonly BOT_WORK_DLQ: BotWorkQueueProducer;
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

export interface WorkerEnv extends WorkerRuntimeEnv {
  readonly DB: D1Database;
  readonly DECISION_FINALIZE_QUEUE: Queue<DecisionFinalizeQueueMessage>;
  readonly BOT_WORK_QUEUE: Queue<BotWorkQueueMessage>;
  readonly BOT_WORK_DLQ: Queue<BotWorkQueueMessage>;
}

export type AssertExecutionContextCompatible = ExecutionContext extends WorkerExecutionContextLike
  ? true
  : never;

const workerLogger = createLogger("worker");

const decisionFinalizeMessageSchema = z
  .object({
    card_id: z.string().trim().min(1).max(128),
  })
  .strict();

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

export interface DecisionFinalizeBatchEnv {
  readonly DB: D1LikeDatabase;
  readonly BOT_WORK_QUEUE: BotWorkQueueProducer;
}

export async function handleDecisionFinalizeBatch(
  batch: MessageBatch,
  env: DecisionFinalizeBatchEnv,
  nowMs?: number,
): Promise<void> {
  const db = createD1Database(env.DB);
  for (const message of batch.messages) {
    const parsed = decisionFinalizeMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      workerLogger.warn("Dropping malformed decision-finalize queue message", {
        messageId: message.id,
      });
      message.ack();
      continue;
    }

    try {
      const effectiveNowMs = nowMs ?? Date.now();
      const result = await finalizeDecisionCard(db, parsed.data.card_id, {
        source: "queue",
        nowMs: effectiveNowMs,
        botWorkQueue: env.BOT_WORK_QUEUE,
      });
      if (result.result === "not_due") {
        const delaySeconds = Math.max(1, result.retryAfterSeconds ?? 1);
        workerLogger.info("Provisional window not yet elapsed; deferring finalize retry", {
          cardId: parsed.data.card_id,
          delaySeconds,
        });
        message.retry({ delaySeconds });
        continue;
      }
      workerLogger.info("Processed decision-finalize message", {
        cardId: parsed.data.card_id,
        result: result.result,
        applied: result.outcome.applied,
      });
      message.ack();
    } catch (error) {
      workerLogger.error("Transient failure in decision-finalize consumer; scheduling retry", {
        error,
        cardId: parsed.data.card_id,
      });
      message.retry({ delaySeconds: 5 });
    }
  }
}

const workerHandler = {
  async fetch(
    request: Request,
    env: WorkerRuntimeEnv,
    ctx: WorkerExecutionContextLike,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.well-known/")) {
      const rateLimiter =
        env.API_RATE_LIMITER !== undefined
          ? createCloudflareRateLimiter(env.API_RATE_LIMITER)
          : undefined;
      return await handleWorkerHttpRequest(request, {
        db: env.DB,
        getMcpPort: () => createMcpBotServicePort(createD1Database(env.DB)),
        finalizeQueue: env.DECISION_FINALIZE_QUEUE,
        botWorkQueue: env.BOT_WORK_QUEUE,
        waitUntil: (promise) => {
          ctx.waitUntil(promise);
        },
        ...(rateLimiter !== undefined ? { rateLimiter } : {}),
        ...(env.BETTER_AUTH_SECRET !== undefined
          ? { betterAuthSecret: env.BETTER_AUTH_SECRET }
          : {}),
        ...(env.BETTER_AUTH_URL !== undefined ? { betterAuthUrl: env.BETTER_AUTH_URL } : {}),
        ...(env.TRUSTED_ORIGINS !== undefined ? { trustedOrigins: env.TRUSTED_ORIGINS } : {}),
        ...(env.GITHUB_CLIENT_ID !== undefined ? { githubClientId: env.GITHUB_CLIENT_ID } : {}),
        ...(env.GITHUB_CLIENT_SECRET !== undefined
          ? { githubClientSecret: env.GITHUB_CLIENT_SECRET }
          : {}),
        ...(env.OWNER_GITHUB_ID !== undefined ? { ownerGithubId: env.OWNER_GITHUB_ID } : {}),
      });
    }

    if (env.ASSETS !== undefined) {
      return await env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },

  async queue(
    batch: MessageBatch,
    env: WorkerRuntimeEnv,
    _ctx: WorkerExecutionContextLike,
  ): Promise<void> {
    if (batch.queue === "decision-finalize" || batch.queue.endsWith("-decision-finalize")) {
      await handleDecisionFinalizeBatch(batch, env);
      return;
    }

    workerLogger.info("Received worker queue batch", {
      queue: batch.queue,
      messageCount: batch.messages.length,
    });
    for (const message of batch.messages) {
      message.ack();
    }
  },

  scheduled(
    controller: ScheduledController,
    _env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    workerLogger.info("Received worker scheduled trigger", {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
    return Promise.resolve();
  },
};

export default workerHandler;
