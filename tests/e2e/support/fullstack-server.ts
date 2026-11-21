import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { type Message, type MessageBatch } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { createLocalScenarioModelAdapter } from "@/adapters";
import { ensureOwnerWorkspace } from "@/auth/better-auth";
import { type D1LikeDatabase, schema } from "@/db";
import { createSqliteDatabase, type SqliteAppDatabase } from "@/db/sqlite";
import {
  type BotWorkQueuePayload,
  type DecisionFinalizeQueuePayload,
  type QueueSendOptions,
} from "@/services/system";
import { createLogger } from "@/shared/logger";
import workerHandler, {
  handleBotWorkBatch,
  handleBotWorkDlqBatch,
  handleDecisionFinalizeBatch,
  handleScheduledTrigger,
  type WorkerRuntimeEnv,
} from "@/worker";

const logger = createLogger("fullstack-server");

function resolvePort(): number {
  const raw = process.env["FULLSTACK_PORT"]?.trim();
  if (raw === undefined || raw === "") {
    return 4174;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid FULLSTACK_PORT: "${raw}" (expected integer 1..65535)`);
  }
  return parsed;
}

const ENABLE_TEST_CONTROLS = process.env["FULLSTACK_TEST_CONTROLS"] === "1";
const PORT = resolvePort();
const HOST = "127.0.0.1";
const PUBLIC_HOST = ENABLE_TEST_CONTROLS ? HOST : "localhost";
const BASE_URL = `http://${PUBLIC_HOST}:${PORT}`;
const DB_PATH = process.env["FULLSTACK_DB_PATH"]?.trim() || ":memory:";
const AUTH_SECRET =
  process.env["BETTER_AUTH_SECRET"] ?? "local-fullstack-secret-key-0123456789abcdef";
const OWNER_EMAIL = (process.env["OWNER_EMAIL"] ?? "owner@fullstack.local").trim().toLowerCase();
const FORCE_LOCAL_ADAPTER = process.env["FULLSTACK_USE_LOCAL_ADAPTER"] === "1";
const CLIENT_DIST_DIR = join(import.meta.dir, "../../../dist/client");
const RESOLVED_CLIENT_DIST_DIR = resolve(CLIENT_DIST_DIR);

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

type NormalizedSqlParam = string | number | null | Uint8Array;

function normalizeParam(v: unknown): NormalizedSqlParam {
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "string" || typeof v === "number" || v instanceof Uint8Array) {
    return v;
  }
  if (v instanceof Date) {
    return v.getTime();
  }
  return JSON.stringify(v);
}

function readSingleInteger(db: SqliteAppDatabase, sql: string): number {
  const rows = db.sqlite.query(sql).values();
  const value = rows[0]?.[0];
  return typeof value === "number" ? value : 0;
}

interface AtomicD1PreparedStatement {
  readonly __sql: string;
  readonly __params: readonly NormalizedSqlParam[];
  bind(...values: unknown[]): AtomicD1PreparedStatement;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
  raw(): Promise<unknown[][]>;
}

function createSqliteBackedD1(db: SqliteAppDatabase): D1LikeDatabase {
  const buildStmt = (
    sqlText: string,
    params: readonly NormalizedSqlParam[] = [],
  ): AtomicD1PreparedStatement => ({
    __sql: sqlText,
    __params: params,
    bind(...values: unknown[]) {
      return buildStmt(sqlText, values.map(normalizeParam));
    },
    async run() {
      const res = await db.executor.query(sqlText, params, "run");
      return { meta: { changes: res.changes } };
    },
    async raw(): Promise<unknown[][]> {
      const res = await db.executor.query(sqlText, params, "all");
      return res.rows.map((row): unknown[] => {
        if (Array.isArray(row)) {
          const typed: readonly unknown[] = row;
          return [...typed];
        }
        return [row];
      });
    },
  });

  return {
    prepare(sqlText: string) {
      return buildStmt(sqlText);
    },
    batch(statements) {
      const extracted: {
        readonly sql: string;
        readonly params: readonly NormalizedSqlParam[];
      }[] = [];
      for (const s of statements) {
        if (s === null || typeof s !== "object") {
          throw new Error("Invalid prepared statement passed to D1 batch()");
        }
        const sqlVal: unknown = Reflect.get(s, "__sql");
        const paramsVal: unknown = Reflect.get(s, "__params");
        if (typeof sqlVal !== "string" || !Array.isArray(paramsVal)) {
          throw new Error("Prepared statement missing __sql or __params in D1 batch()");
        }
        const typedParams: readonly unknown[] = paramsVal;
        extracted.push({ sql: sqlVal, params: typedParams.map(normalizeParam) });
      }

      const executeBatch = db.sqlite.transaction(
        (
          items: readonly {
            readonly sql: string;
            readonly params: readonly NormalizedSqlParam[];
          }[],
        ) => {
          const batchResults: {
            readonly results: readonly Record<string, unknown>[];
            readonly meta: { readonly changes: number };
          }[] = [];
          for (const item of items) {
            const stmt = db.sqlite.query(item.sql);
            if (stmt.columnNames.length === 0) {
              const runRes = stmt.run(...item.params);
              batchResults.push({
                results: [],
                meta: { changes: runRes.changes },
              });
            } else {
              const beforeTotal = readSingleInteger(db, "SELECT total_changes()");
              const rawObjs: unknown[] = stmt.all(...item.params);
              const afterTotal = readSingleInteger(db, "SELECT total_changes()");
              const changes =
                afterTotal > beforeTotal ? readSingleInteger(db, "SELECT changes()") : 0;
              const records: Record<string, unknown>[] = [];
              for (const rowObj of rawObjs) {
                if (rowObj !== null && typeof rowObj === "object" && !Array.isArray(rowObj)) {
                  records.push(Object.fromEntries(Object.entries(rowObj)));
                }
              }
              batchResults.push({
                results: records,
                meta: { changes },
              });
            }
          }
          return batchResults;
        },
      );

      return Promise.resolve(executeBatch(extracted));
    },
    async exec(sqlText: string) {
      await db.executor.exec(sqlText);
      return { count: 1, duration: 0 };
    },
  };
}

async function signBetterAuthCookieValue(sessionToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionToken));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return encodeURIComponent(`${sessionToken}.${sigB64}`);
}

interface QueuedItem<T> {
  readonly payload: T;
  readonly availableAtMs: number;
}

function buildQueueBatch<T>(queueName: string, payloads: readonly T[], nowMs: number) {
  const retried: { readonly payload: T; readonly delaySeconds: number }[] = [];
  const messages: Message[] = payloads.map((body, idx) => ({
    id: `local-${queueName}-${nowMs}-${idx}`,
    timestamp: new Date(nowMs),
    body,
    attempts: 1,
    ack() {},
    retry(options?: { readonly delaySeconds?: number }) {
      retried.push({ payload: body, delaySeconds: options?.delaySeconds ?? 0 });
    },
  }));

  const batch: MessageBatch = {
    queue: queueName,
    messages,
    metadata: {
      metrics: {
        backlogCount: messages.length,
        backlogBytes: messages.length * 64,
        oldestMessageTimestamp: new Date(nowMs),
      },
    },
    ackAll() {},
    retryAll() {},
  };

  return { batch, retried };
}

function takeDueItems<T>(queue: QueuedItem<T>[], effectiveNowMs: number): T[] {
  const due: T[] = [];
  const remaining: QueuedItem<T>[] = [];
  for (const item of queue) {
    if (item.availableAtMs <= effectiveNowMs) {
      due.push(item.payload);
    } else {
      remaining.push(item);
    }
  }
  queue.splice(0, queue.length, ...remaining);
  return due;
}

interface FullStackState {
  sqliteDb: SqliteAppDatabase;
  d1: D1LikeDatabase;
  finalizeQueueItems: QueuedItem<DecisionFinalizeQueuePayload>[];
  botWorkQueueItems: QueuedItem<BotWorkQueuePayload>[];
  dlqQueueItems: QueuedItem<BotWorkQueuePayload>[];
  ownerUserId: string;
  workspaceId: string;
  ownerCookieName: string;
  ownerCookieValue: string;
}

const flushBodySchema = z
  .object({
    advanceMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

const pushDlqBodySchema = z
  .object({
    task_id: z.string().trim().min(1).max(128),
    decision_id: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const bumpTaskBodySchema = z
  .object({
    task_id: z.string().trim().min(1).max(128),
  })
  .strict();

async function createFreshState(): Promise<FullStackState> {
  const sqliteDb = createSqliteDatabase(DB_PATH);
  await sqliteDb.applyMigrations();
  const d1 = createSqliteBackedD1(sqliteDb);

  if (!ENABLE_TEST_CONTROLS) {
    return {
      sqliteDb,
      d1,
      finalizeQueueItems: [],
      botWorkQueueItems: [],
      dlqQueueItems: [],
      ownerUserId: "",
      workspaceId: "",
      ownerCookieName: "better-auth.session_token",
      ownerCookieValue: "",
    };
  }

  const nowMs = Date.now();
  const ownerUserId = "user-fullstack-owner";
  const sessionId = `session-fs-${crypto.randomUUID()}`;
  const sessionToken = `sess_fs_${crypto.randomUUID().replace(/-/g, "")}`;

  await sqliteDb.orm
    .insert(schema.user)
    .values({
      id: ownerUserId,
      name: "Full-Stack Owner",
      email: OWNER_EMAIL,
      emailVerified: true,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .onConflictDoNothing();

  await sqliteDb.orm
    .insert(schema.account)
    .values({
      id: "acc-fullstack-cred",
      accountId: ownerUserId,
      providerId: "credential",
      userId: ownerUserId,
      createdAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    })
    .onConflictDoNothing();

  await sqliteDb.orm.insert(schema.session).values({
    id: sessionId,
    token: sessionToken,
    userId: ownerUserId,
    expiresAt: new Date(nowMs + 86_400_000),
    createdAt: new Date(nowMs),
    updatedAt: new Date(nowMs),
  });

  const workspaceId = await ensureOwnerWorkspace(sqliteDb, ownerUserId, nowMs);
  const ownerCookieValue = await signBetterAuthCookieValue(sessionToken);

  return {
    sqliteDb,
    d1,
    finalizeQueueItems: [],
    botWorkQueueItems: [],
    dlqQueueItems: [],
    ownerUserId,
    workspaceId,
    ownerCookieName: "better-auth.session_token",
    ownerCookieValue,
  };
}

function serveStaticAsset(request: Request): Response {
  const url = new URL(request.url);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (decodedPath.includes("\0")) {
    return new Response("Bad Request", { status: 400 });
  }
  const relativePath = (decodedPath === "/" ? "index.html" : decodedPath).replace(/^\/+/, "");
  const candidatePath = resolve(RESOLVED_CLIENT_DIST_DIR, relativePath);
  if (
    candidatePath !== RESOLVED_CLIENT_DIST_DIR &&
    !candidatePath.startsWith(`${RESOLVED_CLIENT_DIST_DIR}${sep}`)
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
    const candidateFile = Bun.file(candidatePath);
    const ext = extname(candidatePath);
    return new Response(candidateFile, {
      status: 200,
      headers: {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  // SPA fallback for client routes (/board, /history, /settings, /sign-in, /consent)
  const indexPath = join(RESOLVED_CLIENT_DIST_DIR, "index.html");
  if (existsSync(indexPath) && statSync(indexPath).isFile()) {
    return new Response(Bun.file(indexPath), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response("Client bundle not built. Run `bun run build` first.", { status: 500 });
}

function buildWorkerEnv(state: FullStackState): WorkerRuntimeEnv {
  const workerLlmProvider = process.env["WORKER_LLM_PROVIDER"]?.trim();
  const xaiKey = process.env["XAI_API_KEY"]?.trim() ?? "";
  const xaiModel = process.env["XAI_MODEL"]?.trim();
  const xaiApiUrl = process.env["XAI_API_URL"]?.trim();
  const geminiKey = process.env["GEMINI_API_KEY"]?.trim() ?? "";
  const geminiModel = process.env["GEMINI_MODEL"]?.trim();
  const geminiApiUrl = process.env["GEMINI_API_URL"]?.trim();
  const metaKey = process.env["META_MODEL_API_KEY"]?.trim() ?? "";
  const metaModel = process.env["META_MODEL"]?.trim();
  const metaApiUrl = process.env["META_API_URL"]?.trim();
  const hasRealProviderKey = xaiKey !== "" || geminiKey !== "" || metaKey !== "";
  const useProductionAdapterPath =
    !FORCE_LOCAL_ADAPTER &&
    (hasRealProviderKey || (workerLlmProvider !== undefined && workerLlmProvider !== ""));

  return {
    DB: state.d1,
    DECISION_FINALIZE_QUEUE: {
      send(msg: DecisionFinalizeQueuePayload, opts?: QueueSendOptions) {
        const delayMs = Math.max(0, (opts?.delaySeconds ?? 0) * 1000);
        state.finalizeQueueItems.push({ payload: msg, availableAtMs: Date.now() + delayMs });
        return Promise.resolve();
      },
    },
    BOT_WORK_QUEUE: {
      send(msg: BotWorkQueuePayload, opts?: QueueSendOptions) {
        const delayMs = Math.max(0, (opts?.delaySeconds ?? 0) * 1000);
        state.botWorkQueueItems.push({ payload: msg, availableAtMs: Date.now() + delayMs });
        return Promise.resolve();
      },
    },
    BOT_WORK_DLQ: {
      send(msg: BotWorkQueuePayload, opts?: QueueSendOptions) {
        const delayMs = Math.max(0, (opts?.delaySeconds ?? 0) * 1000);
        state.dlqQueueItems.push({ payload: msg, availableAtMs: Date.now() + delayMs });
        return Promise.resolve();
      },
    },
    ASSETS: {
      fetch(input: Request | string) {
        const req = typeof input === "string" ? new Request(input) : input;
        return Promise.resolve(serveStaticAsset(req));
      },
    },
    BETTER_AUTH_SECRET: AUTH_SECRET,
    BETTER_AUTH_URL: BASE_URL,
    TRUSTED_ORIGINS: BASE_URL,
    OWNER_EMAIL,
    // When any provider API key or WORKER_LLM_PROVIDER is supplied (and not forced local),
    // let src/worker/index.ts resolve the production adapter identically to Cloudflare Workers.
    ...(useProductionAdapterPath
      ? {
          ...(workerLlmProvider !== undefined && workerLlmProvider !== ""
            ? { WORKER_LLM_PROVIDER: workerLlmProvider }
            : {}),
          ...(xaiKey !== "" ? { XAI_API_KEY: xaiKey } : {}),
          ...(xaiModel !== undefined && xaiModel !== "" ? { XAI_MODEL: xaiModel } : {}),
          ...(xaiApiUrl !== undefined && xaiApiUrl !== "" ? { XAI_API_URL: xaiApiUrl } : {}),
          ...(geminiKey !== "" ? { GEMINI_API_KEY: geminiKey } : {}),
          ...(geminiModel !== undefined && geminiModel !== "" ? { GEMINI_MODEL: geminiModel } : {}),
          ...(geminiApiUrl !== undefined && geminiApiUrl !== ""
            ? { GEMINI_API_URL: geminiApiUrl }
            : {}),
          ...(metaKey !== "" ? { META_MODEL_API_KEY: metaKey } : {}),
          ...(metaModel !== undefined && metaModel !== "" ? { META_MODEL: metaModel } : {}),
          ...(metaApiUrl !== undefined && metaApiUrl !== "" ? { META_API_URL: metaApiUrl } : {}),
        }
      : {
          MODEL_ADAPTER: createLocalScenarioModelAdapter(),
        }),
    APP_ENV: "local-fullstack",
  };
}

let state = await createFreshState();
let isDrainingQueues = false;

async function flushAllQueues(advanceMs: number) {
  if (isDrainingQueues) {
    return { finalizedProcessed: 0, botWorkProcessed: 0, dlqProcessed: 0 };
  }
  isDrainingQueues = true;
  try {
    const effectiveNowMs = Date.now() + advanceMs;
    const env = buildWorkerEnv(state);

    let finalizedProcessed = 0;
    let botWorkProcessed = 0;
    let dlqProcessed = 0;

    // Drain due finalize -> bot-work -> dlq items (bounded max 5 rounds)
    for (let round = 0; round < 5; round += 1) {
      let didWork = false;

      const dueFinalize = takeDueItems(state.finalizeQueueItems, effectiveNowMs);
      if (dueFinalize.length > 0) {
        const { batch, retried } = buildQueueBatch(
          "decision-finalize",
          dueFinalize,
          effectiveNowMs,
        );
        await handleDecisionFinalizeBatch(batch, env, effectiveNowMs);
        finalizedProcessed += dueFinalize.length;
        for (const r of retried) {
          state.finalizeQueueItems.push({
            payload: r.payload,
            availableAtMs: effectiveNowMs + Math.max(0, r.delaySeconds) * 1000,
          });
        }
        didWork = true;
      }

      const dueBotWork = takeDueItems(state.botWorkQueueItems, effectiveNowMs);
      if (dueBotWork.length > 0) {
        const { batch, retried } = buildQueueBatch("bot-work", dueBotWork, effectiveNowMs);
        await handleBotWorkBatch(batch, env, { nowMs: effectiveNowMs });
        botWorkProcessed += dueBotWork.length;
        for (const r of retried) {
          state.botWorkQueueItems.push({
            payload: r.payload,
            availableAtMs: effectiveNowMs + Math.max(0, r.delaySeconds) * 1000,
          });
        }
        didWork = true;
      }

      const dueDlq = takeDueItems(state.dlqQueueItems, effectiveNowMs);
      if (dueDlq.length > 0) {
        const { batch, retried } = buildQueueBatch("bot-work-dlq", dueDlq, effectiveNowMs);
        await handleBotWorkDlqBatch(batch, env, effectiveNowMs);
        dlqProcessed += dueDlq.length;
        for (const r of retried) {
          state.dlqQueueItems.push({
            payload: r.payload,
            availableAtMs: effectiveNowMs + Math.max(0, r.delaySeconds) * 1000,
          });
        }
        didWork = true;
      }

      if (!didWork) {
        break;
      }
    }

    return { finalizedProcessed, botWorkProcessed, dlqProcessed };
  } finally {
    isDrainingQueues = false;
  }
}

// In interactive `bun run dev:full` mode (without test controls), run live background Queue & Cron loops
// so 5s finalization, autonomous bot-work execution, and 1-minute Cron recovery operate continuously.
if (!ENABLE_TEST_CONTROLS) {
  setInterval(() => {
    void flushAllQueues(0).catch((err: unknown) => {
      logger.error("Background queue drain error", { error: err });
    });
  }, 500);

  setInterval(() => {
    const env = buildWorkerEnv(state);
    void handleScheduledTrigger({ cron: "* * * * *", scheduledTime: Date.now() }, env).catch(
      (err: unknown) => {
        logger.error("Background cron trigger error", { error: err });
      },
    );
  }, 60_000);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (ENABLE_TEST_CONTROLS && url.pathname.startsWith("/__fullstack/")) {
      if (url.pathname === "/__fullstack/reset" && request.method === "POST") {
        if (DB_PATH !== ":memory:") {
          return Response.json(
            { error: "/__fullstack/reset is only permitted with :memory: FULLSTACK_DB_PATH" },
            { status: 400 },
          );
        }
        state.sqliteDb.close();
        state = await createFreshState();
        return Response.json({
          ownerUserId: state.ownerUserId,
          workspaceId: state.workspaceId,
          ownerCookieName: state.ownerCookieName,
          ownerCookieValue: state.ownerCookieValue,
        });
      }

      if (url.pathname === "/__fullstack/flush-queues" && request.method === "POST") {
        const text = await request.text();
        let raw: unknown = {};
        if (text.trim() !== "") {
          try {
            raw = JSON.parse(text);
          } catch {
            return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
          }
        }
        const parsed = flushBodySchema.safeParse(raw);
        if (!parsed.success) {
          return Response.json({ error: "Invalid flush-queues payload" }, { status: 400 });
        }
        const summary = await flushAllQueues(parsed.data.advanceMs ?? 0);
        return Response.json(summary);
      }

      if (url.pathname === "/__fullstack/run-cron" && request.method === "POST") {
        const text = await request.text();
        let raw: unknown = {};
        if (text.trim() !== "") {
          try {
            raw = JSON.parse(text);
          } catch {
            return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
          }
        }
        const parsed = flushBodySchema.safeParse(raw);
        if (!parsed.success) {
          return Response.json({ error: "Invalid run-cron payload" }, { status: 400 });
        }
        const env = buildWorkerEnv(state);
        const report = await handleScheduledTrigger(
          { cron: "* * * * *", scheduledTime: Date.now() + (parsed.data.advanceMs ?? 0) },
          env,
        );
        return Response.json(report);
      }

      if (url.pathname === "/__fullstack/push-dlq" && request.method === "POST") {
        const raw: unknown = await request.json().catch(() => null);
        const parsed = pushDlqBodySchema.safeParse(raw);
        if (!parsed.success) {
          return Response.json({ error: "Invalid push-dlq payload" }, { status: 400 });
        }
        state.dlqQueueItems.push({
          payload: {
            workspace_id: state.workspaceId,
            task_id: parsed.data.task_id,
            ...(parsed.data.decision_id !== undefined
              ? { decision_id: parsed.data.decision_id }
              : {}),
          },
          availableAtMs: Date.now(),
        });
        const summary = await flushAllQueues(0);
        return Response.json(summary);
      }

      if (url.pathname === "/__fullstack/bump-task-version" && request.method === "POST") {
        const raw: unknown = await request.json().catch(() => null);
        const parsed = bumpTaskBodySchema.safeParse(raw);
        if (!parsed.success) {
          return Response.json({ error: "Invalid bump-task-version payload" }, { status: 400 });
        }
        const task = await state.sqliteDb.orm
          .select({ version: schema.tasks.version })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, parsed.data.task_id))
          .get();
        if (task === undefined) {
          return Response.json({ error: "Task not found" }, { status: 404 });
        }
        await state.sqliteDb.orm
          .update(schema.tasks)
          .set({ version: task.version + 1, updatedAt: Date.now() })
          .where(eq(schema.tasks.id, parsed.data.task_id));
        return Response.json({ task_id: parsed.data.task_id, version: task.version + 1 });
      }

      return Response.json({ error: "Unknown test control endpoint" }, { status: 404 });
    }

    const env = buildWorkerEnv(state);
    const pendingTasks: Promise<unknown>[] = [];
    const response = await workerHandler.fetch(request, env, {
      waitUntil(promise: Promise<unknown>) {
        pendingTasks.push(promise);
      },
    });
    if (pendingTasks.length > 0) {
      await Promise.allSettled(pendingTasks);
    }
    return response;
  },
});

logger.info("Local full-stack bot-board server listening", {
  url: BASE_URL,
  listen: `http://${server.hostname}:${server.port}`,
  testControls: ENABLE_TEST_CONTROLS,
});
