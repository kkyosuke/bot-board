import {
  type D1Database,
  type ExecutionContext,
  type MessageBatch,
  type Queue,
  type RateLimit,
  type ScheduledController,
} from "@cloudflare/workers-types";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  assertModelTimeoutWithinLease,
  type BoundedModelStepOptions,
  createGrokModelAdapter,
  type ModelAdapter,
} from "@/adapters";
import { createLazyOAuthJwtVerifierFromD1 } from "@/auth/better-auth";
import {
  type D1BotVerificationInput,
  parseBotScopes,
  type VerifiedBotContext,
  verifyBotConnectionContext,
} from "@/auth/bot";
import { type AppDatabase, createD1Database, type D1LikeDatabase, schema } from "@/db";
import { type BotScope } from "@/domain";
import { handleWorkerHttpRequest } from "@/server/http-runtime";
import { createCloudflareRateLimiter } from "@/server/rate-limit";
import { assertBotWriteAccess } from "@/services/bot";
import {
  type BotWorkQueueProducer,
  buildSystemJobSummary,
  type CronMaintenanceReport,
  type DecisionFinalizeQueueProducer,
  finalizeDecisionCard,
  handleBotWorkDlqMessage,
  handleBotWorkTask,
  runScheduledMaintenance,
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

export interface WorkerScheduledControllerLike {
  readonly cron: string;
  readonly scheduledTime: number;
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
  readonly XAI_MODEL?: string;
  readonly XAI_API_URL?: string;
  readonly MODEL_ADAPTER?: ModelAdapter;
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

export type AssertScheduledControllerCompatible =
  ScheduledController extends WorkerScheduledControllerLike ? true : never;

const workerLogger = createLogger("worker");

const decisionFinalizeMessageSchema = z
  .object({
    card_id: z.string().trim().min(1).max(128),
  })
  .strict();

const botWorkMessageSchema = z
  .object({
    decision_id: z.string().trim().min(1).max(128).optional(),
    task_id: z.string().trim().min(1).max(128),
    workspace_id: z.string().trim().min(1).max(128),
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

export interface BotWorkBatchEnv {
  readonly DB: D1LikeDatabase;
  readonly XAI_API_KEY?: string;
  readonly XAI_MODEL?: string;
  readonly XAI_API_URL?: string;
  readonly MODEL_ADAPTER?: ModelAdapter;
}

function resolveWorkerModelAdapter(env: BotWorkBatchEnv): ModelAdapter {
  if (env.MODEL_ADAPTER !== undefined) {
    return env.MODEL_ADAPTER;
  }
  return createGrokModelAdapter({
    apiKey: env.XAI_API_KEY ?? "",
    ...(env.XAI_API_URL !== undefined ? { endpointUrl: env.XAI_API_URL } : {}),
    ...(env.XAI_MODEL !== undefined ? { model: env.XAI_MODEL } : {}),
  });
}

async function resolveActiveWorkerBotContext(
  db: AppDatabase,
  workspaceId: string,
  preferredBotId: string | null,
): Promise<VerifiedBotContext | null> {
  const workspace = await db.orm
    .select({
      id: schema.workspaces.id,
      ownerUserId: schema.workspaces.ownerUserId,
      isPaused: schema.workspaces.isPaused,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();

  if (workspace === undefined || workspace.isPaused) {
    return null;
  }

  const activeWorkers = await db.orm
    .select()
    .from(schema.botConnections)
    .where(
      and(
        eq(schema.botConnections.workspaceId, workspaceId),
        eq(schema.botConnections.channelType, "worker_bearer"),
        eq(schema.botConnections.status, "active"),
      ),
    )
    .orderBy(asc(schema.botConnections.createdAt), asc(schema.botConnections.id))
    .all();

  if (activeWorkers.length === 0) {
    return null;
  }

  const parsedCandidates = activeWorkers.map((row) => ({
    row,
    scopes: parseBotScopes(row.scopes),
  }));

  const preferred =
    preferredBotId !== null
      ? parsedCandidates.find(
          (c) =>
            c.row.id === preferredBotId &&
            c.scopes.includes("tasks:write") &&
            c.scopes.includes("proposals:write"),
        )
      : undefined;

  const chosen =
    preferred ??
    parsedCandidates.find(
      (c) => c.scopes.includes("tasks:write") && c.scopes.includes("proposals:write"),
    ) ??
    parsedCandidates.find((c) => c.scopes.includes("tasks:write"));

  if (chosen === undefined) {
    return null;
  }

  return verifyBotConnectionContext({
    botConnectionId: chosen.row.id,
    workspaceId: workspace.id,
    workspaceOwnerUserId: workspace.ownerUserId,
    isWorkspacePaused: workspace.isPaused,
    channelType: "worker_bearer",
    status: "active",
    connectionScopes: chosen.scopes,
  });
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

export async function handleBotWorkBatch(
  batch: MessageBatch,
  env: BotWorkBatchEnv,
  options?: {
    readonly nowMs?: number;
    readonly leaseDurationSeconds?: number;
    readonly stepTimeoutMs?: number;
  },
): Promise<void> {
  const db = createD1Database(env.DB);
  const adapter = resolveWorkerModelAdapter(env);

  for (const message of batch.messages) {
    const parsed = botWorkMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      workerLogger.warn("Dropping malformed bot-work queue message", {
        messageId: message.id,
      });
      message.ack();
      continue;
    }

    try {
      const taskRow = await db.orm
        .select({ assignedBotId: schema.tasks.assignedBotId })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, parsed.data.task_id),
            eq(schema.tasks.workspaceId, parsed.data.workspace_id),
          ),
        )
        .get();

      const botCtx = await resolveActiveWorkerBotContext(
        db,
        parsed.data.workspace_id,
        taskRow?.assignedBotId ?? null,
      );

      if (botCtx === null) {
        workerLogger.info("Skipping bot-work message: workspace paused or no active worker bot", {
          workspaceId: parsed.data.workspace_id,
          taskId: parsed.data.task_id,
        });
        message.ack();
        continue;
      }

      const result = await handleBotWorkTask(db, botCtx, {
        taskId: parsed.data.task_id,
        ...(parsed.data.decision_id !== undefined ? { decisionId: parsed.data.decision_id } : {}),
        adapter,
        ...(options?.leaseDurationSeconds !== undefined
          ? { leaseDurationSeconds: options.leaseDurationSeconds }
          : {}),
        ...(options?.stepTimeoutMs !== undefined ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
        ...(options?.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
      });

      if (result.outcome === "retry") {
        workerLogger.warn("Scheduling bot-work retry after transient failure", {
          taskId: parsed.data.task_id,
          delaySeconds: result.delaySeconds,
          reason: result.reason,
        });
        message.retry({ delaySeconds: Math.max(1, result.delaySeconds) });
        continue;
      }

      workerLogger.info("Processed bot-work message", {
        taskId: parsed.data.task_id,
        outcome: result.outcome,
      });
      message.ack();
    } catch (error) {
      workerLogger.error("Unhandled transient error in bot-work consumer; scheduling retry", {
        error,
        taskId: parsed.data.task_id,
      });
      message.retry({ delaySeconds: 15 });
    }
  }
}

export async function handleBotWorkDlqBatch(
  batch: MessageBatch,
  env: { readonly DB: D1LikeDatabase },
  nowMs?: number,
): Promise<void> {
  const db = createD1Database(env.DB);
  for (const message of batch.messages) {
    const parsed = botWorkMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      workerLogger.warn("Dropping malformed bot-work-dlq queue message", {
        messageId: message.id,
      });
      message.ack();
      continue;
    }

    try {
      const outcome = await handleBotWorkDlqMessage(db, {
        workspaceId: parsed.data.workspace_id,
        taskId: parsed.data.task_id,
        ...(parsed.data.decision_id !== undefined ? { decisionId: parsed.data.decision_id } : {}),
        ...(nowMs !== undefined ? { nowMs } : {}),
      });
      workerLogger.warn("Recorded bot-work-dlq failure (BOT-03)", {
        taskId: parsed.data.task_id,
        applied: outcome.applied,
      });
      message.ack();
    } catch (error) {
      workerLogger.error("Transient failure recording bot-work-dlq message; retrying", {
        error,
        taskId: parsed.data.task_id,
      });
      message.retry({ delaySeconds: 10 });
    }
  }
}

export async function handleScheduledTrigger(
  controller: WorkerScheduledControllerLike,
  env: DecisionFinalizeBatchEnv,
): Promise<CronMaintenanceReport> {
  const nowMs = controller.scheduledTime > 0 ? controller.scheduledTime : Date.now();
  const db = createD1Database(env.DB);
  workerLogger.info("Running worker scheduled trigger", {
    cron: controller.cron,
    scheduledTime: nowMs,
  });
  return await runScheduledMaintenance(db, {
    nowMs,
    botWorkQueue: env.BOT_WORK_QUEUE,
  });
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
        getMcpPort: () => {
          const db = createD1Database(env.DB);
          const betterAuthUrl = env.BETTER_AUTH_URL?.trim() ?? "";
          const betterAuthSecret = env.BETTER_AUTH_SECRET?.trim() ?? "";
          const verifyOAuthJwt =
            betterAuthUrl !== "" && betterAuthSecret.length >= 16
              ? createLazyOAuthJwtVerifierFromD1(db, {
                  baseUrl: betterAuthUrl,
                  secret: betterAuthSecret,
                  ...(env.TRUSTED_ORIGINS !== undefined
                    ? { trustedOrigins: env.TRUSTED_ORIGINS }
                    : {}),
                  ...(env.OWNER_GITHUB_ID !== undefined
                    ? { ownerGithubId: env.OWNER_GITHUB_ID }
                    : {}),
                  enableMcpOAuth: true,
                })
              : undefined;
          return createMcpBotServicePort(db, {
            ...(verifyOAuthJwt !== undefined ? { verifyOAuthJwt } : {}),
          });
        },
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

    if (batch.queue === "bot-work-dlq" || batch.queue.endsWith("-bot-work-dlq")) {
      await handleBotWorkDlqBatch(batch, env);
      return;
    }

    if (batch.queue === "bot-work" || batch.queue.endsWith("-bot-work")) {
      await handleBotWorkBatch(batch, env);
      return;
    }

    workerLogger.warn("Received unknown worker queue batch; acking", {
      queue: batch.queue,
      messageCount: batch.messages.length,
    });
    for (const message of batch.messages) {
      message.ack();
    }
  },

  async scheduled(
    controller: WorkerScheduledControllerLike,
    env: WorkerRuntimeEnv,
    _ctx: WorkerExecutionContextLike,
  ): Promise<void> {
    await handleScheduledTrigger(controller, env);
  },
};

export default workerHandler;
